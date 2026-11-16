/**
 * 웹 푸시: 앱을 닫아도 답변 완료·오류를 알린다.
 * 이 기기의 푸시 구독을 Worker(PushRegistry)에 API 키 기준으로 등록한다. 생성 요청에 대화 id·제목을 실어 보내면,
 * 생성이 끝날 때 받고 있는 앱이 없을 때만 Worker 가 등록된 모든 기기로 푸시를 보낸다(앱이 열려 있으면 앱이 직접 알린다).
 * 서버에 VAPID 키가 설정되지 않았으면(501) 조용히 꺼진 채로 둔다.
 */
import { GEN_URL } from './ai'
const KEY = 'vibe_push'

export const pushSupported = () =>
  !!GEN_URL && typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator && typeof Notification !== 'undefined'

export function pushEnabled(): boolean {
  try { return pushSupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted' } catch { return false }
}

function toBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function post(apiKey: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${GEN_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? navigator.serviceWorker.ready : null
}

/**
 * 켜기: 이 기기를 구독하고 서버에 등록한다. 알림 권한은 먼저 받아 둬야 한다(notify.ts).
 * 반환: 'on' | 'unavailable'(서버 미설정·미지원) | 'error'
 */
export async function enablePush(apiKey: string): Promise<'on' | 'unavailable' | 'error'> {
  if (!pushSupported() || !apiKey || Notification.permission !== 'granted') return 'unavailable'
  try {
    const keyRes = await fetch(`${GEN_URL}/api/push/key`)
    if (keyRes.status === 501) return 'unavailable'
    if (!keyRes.ok) return 'error'
    const { publicKey } = (await keyRes.json()) as { publicKey: string }
    const reg = await registration()
    if (!reg) return 'unavailable'
    let sub = await reg.pushManager.getSubscription()
    // 서버 키가 바뀌었으면 예전 구독으로는 못 받는다 → 새로 구독한다.
    const current = sub?.options.applicationServerKey
    if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))) !== btoa(String.fromCharCode(...toBytes(publicKey)))) {
      await sub.unsubscribe().catch(() => {})
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) })
    const res = await post(apiKey, '/api/push/subscribe', { subscription: sub.toJSON() })
    if (res.status === 501) return 'unavailable'
    if (!res.ok) return 'error'
    localStorage.setItem(KEY, '1')
    return 'on'
  } catch {
    return 'error'
  }
}

/** 끄기: 서버에서 지우고 이 기기의 구독을 해제한다. */
export async function disablePush(apiKey: string): Promise<void> {
  try { localStorage.removeItem(KEY) } catch { /* 무시 */ }
  if (!pushSupported()) return
  try {
    const sub = await (await registration())?.pushManager.getSubscription()
    if (!sub) return
    if (apiKey) await post(apiKey, '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe()
  } catch { /* 무시 */ }
}

/** 앱 시작·API 키 변경 때 켜 둔 구독을 다시 등록한다(키가 바뀌면 다른 사용자로 저장되므로). */
export async function resyncPush(apiKey: string): Promise<void> {
  if (pushEnabled() && apiKey) await enablePush(apiKey)
}

/** 생성 요청에 실을 알림 정보(대화 id·제목). 헤더라 URL 인코딩하고 제목은 짧게 자른다. */
export function notifyHeader(chatId: string, title: string): string {
  return encodeURIComponent(JSON.stringify({ chatId, title: title.slice(0, 40) }))
}
