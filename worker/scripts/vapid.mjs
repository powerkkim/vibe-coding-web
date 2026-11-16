// 웹 푸시용 VAPID 키(P-256 개인키 JWK)를 만든다. 한 번만 만들고, 출력한 한 줄을 GitHub 레포 Secret VAPID_JWK 에 넣는다.
// 키를 바꾸면 기존 알림 구독은 모두 무효가 되고, 각 기기에서 알림을 한 번 다시 켜야 한다.
// 실행: node worker/scripts/vapid.mjs
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', privateKey)
console.log(JSON.stringify({ kty, crv, x, y, d }))
