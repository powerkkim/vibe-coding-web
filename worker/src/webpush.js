/**
 * 웹 푸시 보내기 (RFC 8291 aes128gcm 암호화 + RFC 8292 VAPID). 외부 라이브러리 없이 WebCrypto 만 쓴다.
 *
 * VAPID 키: 비밀값 VAPID_JWK = P-256 개인키 JWK(JSON, kty/crv/x/y/d). 공개키는 x·y 로 만든다.
 * 만들기: `node worker/scripts/vapid.mjs` → 출력한 JSON 을 레포 Secret VAPID_JWK 에 넣는다(worker.yml 이 Worker 비밀값으로 넣음).
 */

const enc = new TextEncoder()
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0))

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}

/** VAPID 키를 읽는다. 없거나 잘못됐으면 null. */
export function vapidKeys(env) {
  if (!env.VAPID_JWK) return null
  try {
    const jwk = JSON.parse(env.VAPID_JWK)
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null
    return { jwk, publicKey: b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))) }
  } catch { return null }
}

/** VAPID 인증 헤더 값(vapid t=..., k=...). 12시간 유효. */
async function vapidAuth(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', { ...keys.jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // WebCrypto ECDSA 서명은 r||s(64바이트) 형식이라 JWS ES256 에 그대로 쓴다.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`))
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`
}

/** 페이로드를 구독의 공개키로 암호화한다(aes128gcm, 레코드 1개). */
export async function encryptPayload(subscription, payload) {
  const uaPublic = unb64u(subscription.keys.p256dh)
  const authSecret = unb64u(subscription.keys.auth)
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256))

  // IKM = HKDF(auth_secret, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, shared)
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16)
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 마지막 레코드 구분자 0x02
  const plain = concat(enc.encode(payload), new Uint8Array([2]))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain))
  const rs = new Uint8Array([0, 0, 0x10, 0])  // 레코드 크기 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

/**
 * 푸시 1건을 보낸다. 반환: 'ok' | 'gone'(구독 만료 → 지울 것) | 'error'
 * subject: VAPID 연락처(https: 주소 또는 mailto:).
 */
export async function sendPush(subscription, payload, keys, subject) {
  try {
    const body = await encryptPayload(subscription, payload)
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(subscription.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body,
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    if (!res.ok) { console.error('push', res.status, await res.text().catch(() => '')); return 'error' }
    return 'ok'
  } catch (e) {
    console.error('push', e)
    return 'error'
  }
}
