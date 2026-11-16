// Vibe Coding — 서비스워커(PWA 앱 화면 캐시)
// 미리보기 파일을 앱 주소(/preview/)에서 내주던 기능은 없앴다. 앱과 같은 출처로 실행되어 미리보기 격리(sandbox)를 피해 갈 수 있기 때문이다.
const BASE = new URL('.', self.location.href).pathname  // e.g. '/vibe-coding-web/'

// 앱 화면 캐시(PWA). 버전을 올리면 이전 캐시를 지운다.
const CACHE = 'vibe-app-v2'
const SHELL = [BASE, BASE + 'manifest.webmanifest', BASE + 'icons/icon-192.png', BASE + 'icons/favicon.svg']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}))
  self.skipWaiting()
})
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
  await self.clients.claim()
})()))

self.addEventListener('fetch', event => appShell(event, new URL(event.request.url)))

/**
 * 같은 사이트의 앱 파일만 캐시한다. Anthropic·Google·GitHub API 같은 외부 요청은 건드리지 않는다.
 * - 페이지(index.html): 네트워크 우선 → 실패하면 캐시(오프라인에서도 열림). 새 배포가 바로 반영된다.
 * - /assets/ (파일명에 해시가 붙은 JS·CSS·폰트): 캐시 우선. 내용이 바뀌면 이름이 바뀌므로 안전하다.
 * - 나머지 정적 파일(아이콘 등): 캐시를 먼저 주고 뒤에서 갱신.
 */
function appShell(event, url) {
  const req = event.request
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req)
        const cache = await caches.open(CACHE)
        cache.put(BASE, res.clone())
        return res
      } catch {
        return (await caches.match(BASE)) || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(req)
    const hashed = url.pathname.startsWith(BASE + 'assets/')
    if (hit && hashed) return hit
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone())
      return res
    })
    if (hit) { event.waitUntil(network.catch(() => {})); return hit }
    return network
  })())
}

// 답변 완료 알림을 누르면 열려 있는 앱 창을 앞으로 가져와 그 대화를 열게 한다. 창이 없으면 앱을 새로 연다.
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const chatId = event.notification.data && event.notification.data.chatId
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find(w => new URL(w.url).pathname.startsWith(BASE))
    if (win) {
      await win.focus().catch(() => {})
      if (chatId) win.postMessage({ type: 'OPEN_CHAT', chatId })
    } else {
      // 앱이 꺼져 있으면 그 대화를 열도록 주소에 대화 id 를 붙인다(앱이 읽고 지운다).
      await self.clients.openWindow(chatId ? `${BASE}?chat=${encodeURIComponent(chatId)}` : BASE)
    }
  })())
})

// 웹 푸시: 앱이 꺼져 있을 때 서버(Worker)가 답변 완료·오류를 알린다. 내용은 서버가 이 기기의 키로 암호화해 보낸다.
// 앱이 열려 있으면 서버가 보내지 않는다(앱이 직접 알린다). 푸시를 받으면 반드시 알림을 띄워야 한다(브라우저 규칙).
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* 형식이 다르면 기본 문구 */ }
  const chatId = typeof data.chatId === 'string' ? data.chatId : ''
  event.waitUntil(self.registration.showNotification(data.title || '답변이 완료됐어요', {
    body: data.body || '',
    tag: chatId ? `vibe-${chatId}` : 'vibe',
    icon: BASE + 'icons/icon-192.png',
    data: { chatId },
  }))
})
