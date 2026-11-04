// Vibe Coding — Virtual File System Service Worker
const BASE = new URL('.', self.location.href).pathname  // e.g. '/vibe-coding-web/'
const PREVIEW_PREFIX = BASE + 'preview/'

let files = {}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

// Receive files from main thread
self.addEventListener('message', event => {
  if (event.data?.type === 'SET_FILES') {
    files = { ...event.data.files }
    event.ports[0]?.postMessage({ ok: true })
  }
})

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  ts: 'application/javascript; charset=utf-8',
  jsx: 'application/javascript; charset=utf-8',
  tsx: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (!url.pathname.startsWith(PREVIEW_PREFIX)) return

  const filename = decodeURIComponent(url.pathname.slice(PREVIEW_PREFIX.length)) || 'index.html'

  if (!(filename in files)) {
    // Return blank page (200) so browser doesn't fall back to the SPA
    event.respondWith(new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#0d0d14"></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    ))
    return
  }

  const ext = filename.split('.').pop()?.toLowerCase() || 'txt'
  const contentType = CONTENT_TYPES[ext] || 'text/plain; charset=utf-8'

  event.respondWith(
    new Response(files[filename], {
      status: 200,
      headers: { 'Content-Type': contentType },
    })
  )
})
