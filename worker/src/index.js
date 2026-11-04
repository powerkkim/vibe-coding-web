import { DurableObject } from 'cloudflare:workers'

/**
 * 대화 저장 API (Cloudflare Worker + R2)
 *
 * GET    /api/chats         → ChatSummary[] (최근 수정 순)
 * GET    /api/chats/:id      → StoredChat JSON | 404
 * PUT    /api/chats/:id      본문 = StoredChat JSON, 헤더 X-Chat-Title(URI 인코딩)·X-Chat-Updated-At
 * DELETE /api/chats/:id
 *
 * POST   /api/generations/:id          본문 = Anthropic Messages 요청(stream: true). 응답 = Anthropic SSE 그대로
 * GET    /api/generations/:id?offset=N  N 바이트 이후의 SSE 를 끝까지(생성 중이면 생성이 끝날 때까지) 흘려준다 | 404
 * DELETE /api/generations/:id          진행 중인 생성을 멈춘다
 * 생성은 Durable Object(Generation)가 Anthropic 에 요청하고 원문을 쌓아 두므로, 브라우저가 끊겨도 끝까지 받는다.
 *
 * 인증: Authorization: Bearer <Anthropic API 키>. Anthropic 이 받아 주는 키면 통과하고,
 * 대화는 chats/<sha256(키)>/ 아래에 저장한다. 키 원문은 저장하지 않는다.
 * API 키는 추측할 수 없는 길이라 느린 해시 없이 SHA-256 만으로 충분하다.
 *
 * 무료 요금제는 요청당 CPU 10ms 이므로 대화 본문은 파싱하지 않고 R2 로 그대로 흘려보낸다.
 * 목록에 필요한 제목·수정 시각은 R2 customMetadata 에 따로 둬서 목록 조회 때 본문을 열지 않는다.
 */

// crypto.randomUUID() 형식을 포함한다. 경로 문자('/', '.')는 허용하지 않는다.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// 대화에는 base64 이미지가 들어간다. 무료 요금제 요청 크기 한도(100MB)보다 작게 둔다.
const MAX_BODY_BYTES = 50 * 1024 * 1024
// R2 customMetadata 는 키·값 합계 2KB 까지다. 제목은 이 길이에서 자른다.
const MAX_TITLE_LENGTH = 200

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 확인된 키 해시 → 만료 시각. Worker 인스턴스 메모리라 인스턴스마다 따로 있고, 재시작하면 비워진다.
const verified = new Map()
const VERIFY_TTL_MS = 10 * 60 * 1000

/**
 * Anthropic API 키의 SHA-256 해시를 사용자 식별자로 돌려준다. 키가 없거나 Anthropic 이 거부하면 null.
 * 모델 목록 조회는 토큰을 쓰지 않는다.
 * Anthropic 쪽 장애(429·5xx)는 키 거부와 구분해 예외로 던진다. 그래야 클라이언트가 키를 틀린 것으로 보지 않는다.
 */
async function authenticate(request) {
  const key = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!key) return null
  const hash = await sha256Hex(key)
  if ((verified.get(hash) ?? 0) > Date.now()) return hash
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`Anthropic 키 확인 실패: HTTP ${res.status}`)
  verified.set(hash, Date.now() + VERIFY_TTL_MS)
  return hash
}

async function listChats(env, user) {
  const prefix = `chats/${user}/`
  const list = []
  let cursor
  do {
    const page = await env.BUCKET.list({ prefix, cursor, include: ['customMetadata'] })
    for (const object of page.objects) {
      list.push({
        id: object.key.slice(prefix.length, -'.json'.length),
        title: object.customMetadata?.title ?? '',
        updatedAt: Number(object.customMetadata?.updatedAt ?? 0),
      })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

// 생성 원문을 이 크기마다 SQLite 행 하나로 쌓는다. 행 한도(2MB)보다 충분히 작다.
const FLUSH_BYTES = 64 * 1024
// 끝난 생성 원문은 하루 뒤 지운다. 클라이언트는 그 전에 결과를 대화로 저장한다.
const KEEP_MS = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()

/** 생성이 비정상으로 끝났을 때 원문 끝에 붙이는 Anthropic 형식의 error 이벤트. 클라이언트는 이걸 받으면 이어 받지 않고 오류로 끝낸다. */
function errorEvent(message) {
  return encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'generation_error', message } })}\n\n`)
}

/**
 * 생성 1건. 이름은 `<사용자 해시>:<생성 id>` 라 다른 사용자의 생성은 열 수 없다.
 * CPU 한도(무료 요금제 10ms) 때문에 받은 바이트는 디코딩하지 않고 그대로 쌓고 흘려보낸다.
 * meta: started(시작 시각), done(끝남). 인스턴스가 재시작돼 진행 중이던 fetch 를 잃으면 끝나지 않은 채 남으므로 그때는 오류로 닫는다.
 */
export class Generation extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS chunk (seq INTEGER PRIMARY KEY, body BLOB)')
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
    // 아직 행으로 쌓지 않은 바이트와, 실시간으로 받는 중인 클라이언트들
    this.pending = []
    this.pendingBytes = 0
    this.subscribers = new Set()
    this.controller = null
  }

  meta(k) {
    return this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v
  }

  setMeta(k, v) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', k, String(v))
  }

  async fetch(request) {
    if (request.method === 'POST') return this.start(request)
    if (request.method === 'DELETE') {
      this.controller?.abort()
      return new Response(null, { status: 204 })
    }
    if (!this.meta('started')) return new Response(null, { status: 404 })
    const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0)
    if (!Number.isInteger(offset) || offset < 0) return new Response(null, { status: 400 })
    return this.stream(offset)
  }

  async start(request) {
    if (this.meta('started')) return new Response(null, { status: 409 })
    // 응답 헤더를 기다리는 중에도 DELETE 로 멈출 수 있게 먼저 둔다.
    this.controller = new AbortController()
    const headers = { 'x-api-key': request.headers.get('x-api-key'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    const beta = request.headers.get('anthropic-beta')
    if (beta) headers['anthropic-beta'] = beta
    let res
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: request.body, signal: this.controller.signal })
    } catch (e) {
      this.controller = null
      throw e
    }
    // 실패 응답은 기록하지 않고 그대로 돌려준다. 같은 id 로 다시 시작할 수 있다.
    if (!res.ok) {
      this.controller = null
      return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
    }
    this.setMeta('started', Date.now())
    this.pump(res.body)
    return this.stream(0)
  }

  /** 끝날 때까지 받아 쌓는다. 응답을 기다리는 동안은 바깥으로 나간 fetch 가 이 객체를 살려 둔다. */
  async pump(body) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.append(value)
      }
    } catch (e) {
      this.append(errorEvent(this.controller.signal.aborted ? '생성을 중지했습니다' : `생성 중 연결이 끊겼습니다: ${e.message}`))
    }
    this.finish()
  }

  append(bytes) {
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
    for (const writer of this.subscribers) writer.write(bytes).catch(() => this.subscribers.delete(writer))
    if (this.pendingBytes >= FLUSH_BYTES) this.flush()
  }

  flush() {
    if (!this.pendingBytes) return
    const row = new Uint8Array(this.pendingBytes)
    let at = 0
    for (const bytes of this.pending) {
      row.set(bytes, at)
      at += bytes.length
    }
    this.ctx.storage.sql.exec('INSERT INTO chunk (body) VALUES (?)', row)
    this.pending = []
    this.pendingBytes = 0
  }

  finish() {
    this.flush()
    this.setMeta('done', 1)
    this.controller = null
    for (const writer of this.subscribers) writer.close().catch(() => {})
    this.subscribers.clear()
    this.ctx.storage.setAlarm(Date.now() + KEEP_MS)
  }

  /** offset 바이트 이후를 흘려준다. 쌓인 것 → 아직 쌓지 않은 것 → 이후 실시간 순서라 빠지거나 겹치는 바이트가 없다. */
  stream(offset) {
    if (!this.meta('done') && !this.controller) {
      this.append(errorEvent('서버가 재시작되어 생성이 중단되었습니다'))
      this.finish()
    }
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    let at = 0
    const send = (bytes) => {
      if (at + bytes.length > offset) writer.write(bytes.subarray(Math.max(0, offset - at))).catch(() => {})
      at += bytes.length
    }
    for (const { body } of this.ctx.storage.sql.exec('SELECT body FROM chunk ORDER BY seq')) send(new Uint8Array(body))
    for (const bytes of this.pending) send(bytes)
    if (this.meta('done')) writer.close().catch(() => {})
    else this.subscribers.add(writer)
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }

  async alarm() {
    await this.ctx.storage.deleteAll()
  }
}

async function handle(request, env) {
  const { pathname } = new URL(request.url)
  const user = await authenticate(request)
  if (!user) return new Response(null, { status: 401 })

  if (pathname === '/api/chats' && request.method === 'GET') return Response.json(await listChats(env, user))

  const generation = pathname.match(/^\/api\/generations\/([^/]+)$/)
  if (generation) {
    const id = decodeURIComponent(generation[1])
    if (!ID_PATTERN.test(id)) return new Response(null, { status: 400 })
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return new Response(null, { status: 405 })
    const headers = new Headers({ 'x-api-key': request.headers.get('Authorization').replace(/^Bearer /, '') })
    const beta = request.headers.get('anthropic-beta')
    if (beta) headers.set('anthropic-beta', beta)
    const stub = env.GENERATION.get(env.GENERATION.idFromName(`${user}:${id}`))
    return stub.fetch(new Request(request.url, { method: request.method, headers, body: request.body }))
  }

  const match = pathname.match(/^\/api\/chats\/([^/]+)$/)
  if (!match) return new Response(null, { status: 404 })
  const id = decodeURIComponent(match[1])
  if (!ID_PATTERN.test(id)) return new Response(null, { status: 400 })
  const key = `chats/${user}/${id}.json`

  if (request.method === 'GET') {
    const object = await env.BUCKET.get(key)
    if (!object) return new Response(null, { status: 404 })
    return new Response(object.body, { headers: { 'Content-Type': 'application/json' } })
  }
  if (request.method === 'PUT') {
    const length = Number(request.headers.get('Content-Length'))
    const updatedAt = Number(request.headers.get('X-Chat-Updated-At'))
    let title
    try {
      title = decodeURIComponent(request.headers.get('X-Chat-Title') ?? '').slice(0, MAX_TITLE_LENGTH)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!length || length > MAX_BODY_BYTES || !Number.isFinite(updatedAt)) return new Response(null, { status: 400 })
    await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { title, updatedAt: String(updatedAt) },
    })
    return new Response(null, { status: 204 })
  }
  if (request.method === 'DELETE') {
    await env.BUCKET.delete(key)
    return new Response(null, { status: 204 })
  }
  return new Response(null, { status: 405 })
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin')
    const cors = {}
    if (origin && env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).includes(origin)) {
      cors['Access-Control-Allow-Origin'] = origin
      cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Chat-Title, X-Chat-Updated-At, Anthropic-Beta'
      cors['Access-Control-Allow-Methods'] = 'GET, PUT, POST, DELETE, OPTIONS'
      cors['Vary'] = 'Origin'
      // 사전 확인(OPTIONS) 결과를 하루 동안 재사용하게 해 요청마다 왕복 한 번을 줄인다. 브라우저마다 상한이 있다(Chrome 2시간).
      cors['Access-Control-Max-Age'] = '86400'
    }
    let response
    try {
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await handle(request, env)
    } catch (e) {
      console.error(e)
      response = new Response(null, { status: 500 })
    }
    // Response.json 등으로 만든 응답은 헤더가 불변이라 복사본에 CORS 헤더를 붙인다.
    response = new Response(response.body, response)
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value)
    return response
  },
}
