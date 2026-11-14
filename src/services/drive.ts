/**
 * Google 드라이브 저장소 (Cloudflare Worker 대신)
 *
 * 브라우저에서 Google Identity Services(GIS)로 액세스 토큰을 받아 Drive REST API 를 직접 호출한다.
 * 범위
 * - drive.appdata: 대화·메모리 저장용 숨김 폴더(appDataFolder). 사용자 눈에 안 보인다.
 * - drive.file: 앱이 만든 파일·폴더만 '내 드라이브'에 보이게 만들고 고칠 수 있다(프로젝트 파일 내보내기, driveExport.ts).
 *   사용자의 다른 드라이브 파일은 둘 다 보지 못한다. 둘 다 Google 기준 비민감 범위라 별도 심사가 없다.
 * 대화 1건 = appDataFolder 안의 chat-<id>.json 파일 1개. 목록용 제목·수정 시각은 appProperties 에 둬서 본문을 열지 않는다.
 *
 * 필요한 설정: VITE_GOOGLE_CLIENT_ID (Google Cloud 콘솔 → OAuth 클라이언트 ID, 웹 애플리케이션).
 * 클라이언트 ID 는 공개돼도 되는 값이다(승인된 자바스크립트 원본에서만 동작).
 */

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || ''

const SCOPE_APPDATA = 'https://www.googleapis.com/auth/drive.appdata'
const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file'
// drive.file 을 한 번 허용받았으면 이후 재로그인에도 함께 요청한다(이미 동의했으므로 동의 화면 없이 지나간다).
const FILE_SCOPE_KEY = 'vibe_gdrive_file_scope'
const fileScopeConsented = () => { try { return localStorage.getItem(FILE_SCOPE_KEY) === '1' } catch { return false } }
const TOKEN_KEY = 'vibe_gdrive_token'
// 연결했던 Google 계정. 토큰이 만료돼도 남겨 두고, 다시 연결할 때 같은 계정으로 계정 선택 없이 바로 붙인다.
// '연결 해제'를 눌렀을 때만 지운다.
const ACCOUNT_KEY = 'vibe_gdrive_account'
// 로그인 유지: 서버(worker)가 구글 갱신 토큰을 암호화해 돌려주면 여기에 둔다(서버만 풀 수 있다).
// 있으면 1시간 토큰이 끝나기 전에 팝업 없이 새 토큰을 받는다. 없거나 서버가 안 되면 예전 방식(팝업 재로그인)으로 동작한다.
const REFRESH_KEY = 'vibe_gdrive_refresh'
const AUTH_URL = ((import.meta.env.VITE_AUTH_SERVER_URL as string | undefined) || (import.meta.env.VITE_GENERATION_SERVER_URL as string | undefined) || '').trim().replace(/\/+$/, '')
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

/** 연결이 필요하다(토큰 없음·만료). 화면에서 '드라이브 연결' 버튼을 띄운다. */
export class DriveAuthError extends Error {
  constructor() { super('Google 드라이브 연결이 필요합니다') }
}

interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string; refresh?: string }
interface CodeResponse { code?: string; scope?: string; error?: string; error_description?: string }
interface CodeClient { requestCode: () => void }
interface TokenClient { requestAccessToken: (o?: { prompt?: string }) => void; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }
declare global {
  interface Window { google?: { accounts: { oauth2: { initTokenClient: (c: Record<string, unknown>) => TokenClient; initCodeClient: (c: Record<string, unknown>) => CodeClient; revoke: (t: string, cb?: () => void) => void } } } }
}

type Saved = { token: string; expiresAt: number; scope?: string }
export type DriveAccount = { email: string; name?: string }
let saved: Saved | null = readSaved()
let account: DriveAccount | null = readAccount()
let refreshBlob: string | null = (() => { try { return localStorage.getItem(REFRESH_KEY) } catch { return null } })()
function setRefresh(v: string | null) {
  refreshBlob = v
  try { if (v) localStorage.setItem(REFRESH_KEY, v); else localStorage.removeItem(REFRESH_KEY) } catch { /* 무시 */ }
}
/** 서버 로그인 유지를 쓸 수 있는가(서버 주소가 있고, 이번 세션에 서버가 '설정 안 됨'이라고 하지 않았다) */
let serverAuthOff = false
const serverAuth = () => !!AUTH_URL && !serverAuthOff
/** 팝업 없이 연결을 유지하고 있는가(갱신 토큰 보유) */
export function driveStaysSignedIn() { return !!refreshBlob }
/** 로그인 유지를 켤 수 있는가(서버가 있음) */
export function canDriveStaySignedIn() { return serverAuth() }
const listeners = new Set<(connected: boolean) => void>()
let expiryTimer: ReturnType<typeof setTimeout> | undefined
// 만료 5분 전 조용한 갱신 타이머(scheduleExpiry 가 모듈 시작 때 바로 쓰므로 위에 둔다)
let refreshTimer: ReturnType<typeof setTimeout> | undefined
scheduleExpiry()

function readAccount(): DriveAccount | null {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null') } catch { return null }
}
function setAccount(a: DriveAccount | null) {
  account = a
  try {
    if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a))
    else localStorage.removeItem(ACCOUNT_KEY)
  } catch { /* 무시 */ }
}

/** 토큰이 만료되는 순간 화면에 알린다(만료돼도 아무 이벤트가 없어, 예전엔 조용히 브라우저 저장으로 바뀌었다). */
function scheduleExpiry() {
  clearTimeout(expiryTimer)
  if (!saved) return
  const ms = saved.expiresAt - 60_000 - Date.now()
  expiryTimer = setTimeout(() => listeners.forEach((fn) => fn(isDriveConnected())), Math.max(0, Math.min(ms, 2 ** 31 - 1)))
  // 갱신 토큰이 있으면 만료 5분 전에 조용히 새 토큰을 받는다(팝업 없음, 사용자 동작 필요 없음).
  clearTimeout(refreshTimer)
  if (refreshBlob) refreshTimer = setTimeout(() => { silentRefresh().catch(() => {}) }, Math.max(0, Math.min(saved.expiresAt - 5 * 60_000 - Date.now(), 2 ** 31 - 1)))
}

function readSaved(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as Saved | null
    return v && v.expiresAt > Date.now() + 60_000 ? v : null
  } catch { return null }
}

function setSaved(v: Saved | null) {
  saved = v
  try {
    if (v) localStorage.setItem(TOKEN_KEY, JSON.stringify(v))
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* 저장 불가 브라우저는 메모리에만 둔다 */ }
  scheduleExpiry()
  listeners.forEach((fn) => fn(isDriveConnected()))
}

export function isDriveConfigured() { return !!GOOGLE_CLIENT_ID }
export function isDriveConnected() { return !!saved && saved.expiresAt > Date.now() + 60_000 }
/** 연결했던 적이 있는데 토큰이 만료된 상태. 화면에 '다시 연결'을 띄운다. */
export function isDriveExpired() { return !!account && !isDriveConnected() }
export function driveAccount() { return account }
/** Google 선택창(Picker)에 넘길 현재 토큰. 연결 안 됐으면 null */
export function currentAccessToken() { return isDriveConnected() ? saved!.token : null }
/** 지금 토큰에 drive.file(내 드라이브에 보이는 파일 저장) 권한이 있는가 */
export function hasFileScope() { return isDriveConnected() && !!saved?.scope?.includes(SCOPE_FILE) }
/** 토큰 남은 시간(분). 연결 안 됐으면 null */
export function driveMinutesLeft() { return saved ? Math.max(0, Math.round((saved.expiresAt - Date.now()) / 60_000)) : null }
export function onDriveChange(fn: (connected: boolean) => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

let gisLoading: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { gisLoading = null; reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다')) }
    document.head.appendChild(s)
  })
  return gisLoading
}

// ── 토큰 받기 ───────────────────────────────────────────────
// 토큰 클라이언트는 한 번 만들어 두고 재사용한다. 팝업은 사용자 동작(클릭·키 입력) '안에서 동기적으로' 열어야
// 브라우저가 막지 않으므로, 스크립트 로드·클라이언트 생성을 미리 끝내 두는 것이 '살며시 재로그인'의 핵심이다.
let client: TokenClient | null = null
let clientHint: string | undefined
let clientScope = ''
let waiting: { resolve: () => void; reject: (e: Error) => void } | null = null
let renewing: Promise<void> | null = null

/** 받은 액세스 토큰을 저장하고, 어느 계정인지 확인해 기억한다(목록 표시·다음 재연결의 login_hint). */
async function applyToken(r: TokenResponse): Promise<void> {
  const token = { token: r.access_token!, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000, scope: r.scope }
  if (r.scope?.includes(SCOPE_FILE)) { try { localStorage.setItem(FILE_SCOPE_KEY, '1') } catch { /* 무시 */ } }
  try {
    const res = await fetch(`${API}/about?fields=user(emailAddress,displayName)`, { headers: { Authorization: `Bearer ${token.token}` } })
    const b = res.ok ? await res.json() as { user?: { emailAddress?: string; displayName?: string } } : null
    if (b?.user?.emailAddress) {
      // 다른 계정으로 바뀌었으면 이전 계정의 갱신 토큰은 쓰지 않는다.
      if (account && account.email !== b.user.emailAddress && !r.refresh) setRefresh(null)
      setAccount({ email: b.user.emailAddress, name: b.user.displayName })
    }
  } catch { /* 연결은 유지 */ }
  if (r.refresh) setRefresh(r.refresh)
  setSaved(token)
}

function onToken(r: TokenResponse) {
  const w = waiting
  waiting = null
  if (!r.access_token) return w?.reject(new Error(r.error_description || r.error || '드라이브 연결이 거부됐습니다'))
  applyToken(r).then(() => w?.resolve(), () => w?.resolve())
}

// ── 서버 로그인 유지(코드 방식 + 갱신 토큰) ──────────────────────
async function authPost(action: 'exchange' | 'refresh', body: Record<string, unknown>): Promise<TokenResponse & { status: number }> {
  const res = await fetch(`${AUTH_URL}/api/auth/google/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({})) as TokenResponse
  if (res.status === 501) serverAuthOff = true   // 서버에 구글 비밀값이 없다 → 이번 세션은 예전 방식
  return { ...json, status: res.status }
}

let silentRefreshing: Promise<boolean> | null = null
/** 갱신 토큰으로 팝업 없이 새 토큰을 받는다. 성공하면 true. 권한이 끊겼으면 갱신 토큰을 지우고 false(예전 방식으로 돌아감). */
function silentRefresh(): Promise<boolean> {
  if (!refreshBlob || !serverAuth()) return Promise.resolve(false)
  silentRefreshing ??= (async () => {
    try {
      const r = await authPost('refresh', { refresh: refreshBlob })
      if (r.access_token) { await applyToken(r); return true }
      if (r.status === 401) setRefresh(null)   // invalid_grant: 사용자가 권한을 끊었거나 비밀번호를 바꿈
      return false
    } catch { return false } finally { silentRefreshing = null }
  })()
  return silentRefreshing
}

let codeClient: CodeClient | null = null
let codeClientKey = ''
let codeWaiting: { resolve: (r: CodeResponse) => void; reject: (e: Error) => void } | null = null
function ensureCodeClient(withFiles: boolean): CodeClient | null {
  if (!window.google?.accounts?.oauth2?.initCodeClient || !GOOGLE_CLIENT_ID) return null
  const scope = withFiles ? `${SCOPE_APPDATA} ${SCOPE_FILE}` : SCOPE_APPDATA
  const key = `${scope}|${account?.email ?? ''}`
  if (!codeClient || codeClientKey !== key) {
    codeClientKey = key
    codeClient = window.google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      include_granted_scopes: true,
      ux_mode: 'popup',
      ...(account ? { login_hint: account.email } : { select_account: true }),
      callback: (r: CodeResponse) => { const w = codeWaiting; codeWaiting = null; w?.resolve(r) },
      error_callback: (e: { type: string; message?: string }) => {
        const w = codeWaiting
        codeWaiting = null
        w?.reject(new Error(e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : e.type === 'popup_failed_to_open' ? '팝업이 차단됐습니다' : e.message || e.type))
      },
    })
  }
  return codeClient
}

/** 코드 방식 로그인(팝업 1번) → 서버가 토큰과 암호화한 갱신 토큰으로 바꿔 준다. 반드시 클릭 안에서 동기적으로 불러야 한다. */
function connectWithCode(c: CodeClient): Promise<void> {
  if (renewing) return renewing
  renewing = (async () => {
    const r = await new Promise<CodeResponse>((resolve, reject) => { codeWaiting = { resolve, reject }; c.requestCode() })
    if (!r.code) throw new Error(r.error_description || r.error || '드라이브 연결이 거부됐습니다')
    const t = await authPost('exchange', { code: r.code })
    if (!t.access_token) throw new Error(t.status === 501 ? 'SERVER_AUTH_OFF' : `드라이브 연결에 실패했습니다 (${t.error ?? t.status})`)
    await applyToken(t)
  })().finally(() => { renewing = null })
  return renewing
}

/**
 * withFiles: drive.file 도 요청할지. 처음 연결이거나 이미 동의했으면 함께, 예전에 숨김 폴더만 허용한 계정은
 * '권한 추가'를 눌렀을 때만 요청한다(클릭 없이 동의 화면이 뜨지 않게).
 */
function ensureClient(withFiles = !account || fileScopeConsented()): TokenClient | null {
  if (!window.google?.accounts?.oauth2 || !GOOGLE_CLIENT_ID) return null
  const scope = withFiles ? `${SCOPE_APPDATA} ${SCOPE_FILE}` : SCOPE_APPDATA
  if (!client || clientHint !== account?.email || clientScope !== scope) {
    clientHint = account?.email
    clientScope = scope
    client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      include_granted_scopes: true,
      ...(account ? { login_hint: account.email } : {}),
      callback: onToken,
      error_callback: (e: { type: string; message?: string }) => {
        const w = waiting
        waiting = null
        w?.reject(new Error(e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : e.type === 'popup_failed_to_open' ? '팝업이 차단됐습니다' : e.message || e.type))
      },
    })
  }
  return client
}

/** 팝업을 연다. 반드시 사용자 동작 처리 중에 동기적으로 불러야 한다. 이미 진행 중이면 그 결과를 함께 기다린다. */
function requestToken(c: TokenClient, prompt: string): Promise<void> {
  if (renewing) return renewing
  renewing = new Promise<void>((resolve, reject) => {
    waiting = { resolve, reject }
    c.requestAccessToken({ prompt })
  }).finally(() => { renewing = null })
  return renewing
}

/** 진행 중인 재로그인이 있으면 끝날 때까지 기다린다(성공·실패 무관). 만료 중 대화를 열 때 쓴다. */
export async function waitForRenewal(): Promise<void> {
  if (renewing) await renewing.catch(() => {})
}

/**
 * '드라이브 연결' / '다시 연결' 버튼.
 * GIS 토큰은 1시간짜리이고 갱신 토큰이 없다. 연결했던 계정이 있으면 login_hint + prompt '' 로
 * 동의·계정 선택 없이 팝업이 잠깐 떴다 닫힌다. 처음 연결이면 계정 선택을 띄운다.
 */
export async function connectDrive(opts: { withFiles?: boolean } = {}): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('VITE_GOOGLE_CLIENT_ID 가 설정되지 않았습니다')
  if (renewing) return renewing
  const withFiles = opts.withFiles ?? (!account || fileScopeConsented())
  // 1) 갱신 토큰이 있으면 팝업 없이 다시 붙는다(권한 추가가 아닐 때).
  if (refreshBlob && !(withFiles && !fileScopeConsented()) && await silentRefresh()) return
  // 2) 서버가 있으면 코드 방식으로 한 번 로그인해 갱신 토큰을 받는다(이후 1시간마다 다시 로그인하지 않음).
  if (serverAuth()) {
    const cc = ensureCodeClient(withFiles) ?? (await loadGis(), ensureCodeClient(withFiles))
    if (cc) {
      try {
        await connectWithCode(cc)
        if (withFiles && !hasFileScope()) throw new Error('드라이브 파일 저장 권한이 허용되지 않았습니다')
        return
      } catch (e) {
        // 서버에 구글 설정이 없으면 예전 방식으로 이어서 연결한다. 그 밖의 오류(창 닫힘 등)는 그대로 알린다.
        if (!(e instanceof Error && e.message === 'SERVER_AUTH_OFF')) throw e
      }
    }
  }
  // 3) 예전 방식(1시간 토큰, 팝업 재로그인)
  // 스크립트가 아직 없으면 불러온 뒤 연다(첫 연결). 이때는 팝업이 막힐 수 있어 미리 로드해 둔다(아래 자동 갱신).
  const c = ensureClient(withFiles) ?? (await loadGis(), ensureClient(withFiles))
  if (!c) throw new Error('Google 로그인 스크립트를 불러오지 못했습니다')
  // 권한 추가는 동의 화면이 필요하다. 그 외에는 기억한 계정으로 조용히.
  const upgrading = withFiles && !!account && !fileScopeConsented()
  await requestToken(c, upgrading ? 'consent' : account ? '' : 'select_account')
  if (withFiles && !hasFileScope()) throw new Error('드라이브 파일 저장 권한이 허용되지 않았습니다')
}

// ── 살며시 재로그인 ──────────────────────────────────────────
// 연결했던 계정이 있으면, 토큰이 10분 안에 만료되거나 이미 만료된 상태에서 사용자가 화면을 클릭·키 입력할 때
// 그 동작에 맞춰 조용히 토큰을 다시 받는다(브라우저에 Google 로그인이 살아 있으면 팝업이 잠깐 떴다 닫힘).
// 실패하면(로그인 만료·팝업 차단) 잠시 쉬었다가 다시 시도하고, 그동안은 '다시 연결' 버튼과 대기 저장으로 버틴다.
const RENEW_BEFORE_MS = 10 * 60_000
const RETRY_AFTER_MS = 2 * 60_000
let lastAttempt = 0

function maybeRenew() {
  if (!account || renewing || Date.now() - lastAttempt < RETRY_AFTER_MS) return
  const remaining = saved ? saved.expiresAt - Date.now() : -1
  if (remaining > RENEW_BEFORE_MS) return
  // 갱신 토큰이 있으면 팝업 없이(타이머가 놓쳤을 때 대비)
  if (refreshBlob && serverAuth()) { lastAttempt = Date.now(); silentRefresh().catch(() => {}); return }
  const c = ensureClient()
  if (!c) return
  lastAttempt = Date.now()
  requestToken(c, '').catch(() => {})
}

function installAutoRenew() {
  if (typeof window === 'undefined' || !GOOGLE_CLIENT_ID) return
  // 로그인 팝업을 클릭 안에서 바로 열 수 있게 스크립트를 미리 받아 둔다(늦게 받으면 팝업이 차단될 수 있다).
  loadGis().then(() => { ensureClient(); if (serverAuth()) ensureCodeClient(!account || fileScopeConsented()) }).catch(() => {})
  // 앱을 열었는데 토큰이 만료돼 있으면 갱신 토큰으로 바로 다시 붙는다(기다리는 쪽은 waitForRenewal).
  if (refreshBlob && account && !isDriveConnected() && serverAuth()) {
    renewing = silentRefresh().then(() => undefined).finally(() => { renewing = null })
  }
  // 화면이 다시 보일 때(폰에서 앱으로 돌아옴) 만료가 가까우면 조용히 갱신한다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && refreshBlob && saved && saved.expiresAt - Date.now() < RENEW_BEFORE_MS) silentRefresh().catch(() => {})
    else if (document.visibilityState === 'visible' && refreshBlob && !saved && account) silentRefresh().catch(() => {})
  })
  // 사용자 활성화로 인정되는 이벤트: 마우스는 pointerdown, 터치는 pointerup, 그리고 키 입력.
  document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') maybeRenew() }, true)
  document.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') maybeRenew() }, true)
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') maybeRenew() }, true)
}
installAutoRenew()

export function disconnectDrive() {
  const t = saved?.token
  setAccount(null)
  setRefresh(null)
  try { localStorage.removeItem(FILE_SCOPE_KEY) } catch { /* 무시 */ }
  setSaved(null)
  if (t) window.google?.accounts.oauth2.revoke(t)
}

/** 다른 모듈(driveExport)용 공개 요청 함수 */
export function driveRequest(url: string, init: RequestInit = {}) { return driveFetch(url, init) }
export const DRIVE_API = API
export const DRIVE_UPLOAD = UPLOAD

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // 만료됐어도 갱신 토큰이 있으면 팝업 없이 새로 받아 이어 간다.
  if (!isDriveConnected() && !(await silentRefresh())) throw new DriveAuthError()
  let res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${saved!.token}` } })
  if (res.status === 401 && await silentRefresh()) res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${saved!.token}` } })
  if (res.status === 401) { setSaved(null); throw new DriveAuthError() }
  if (!res.ok && res.status !== 404) throw new Error(`Google 드라이브 HTTP ${res.status}`)
  return res
}

export interface DriveFileMeta { id: string; name: string; appProperties?: Record<string, string>; modifiedTime?: string }

/**
 * appDataFolder 안에서 이름이 prefix 로 시작하는 파일 전부.
 * 검색어(q=name contains …)를 쓰지 않고 폴더 전체를 받아 걸러낸다. 이 폴더엔 이 앱 파일만 있어 양이 적고,
 * Drive 검색 색인은 방금 만든 파일을 바로 못 찾거나 '-' 같은 문자를 다르게 나눌 수 있어서다.
 * (예전 방식은 색인에 안 잡힌 파일이 목록에서 빠지고, 같은 대화를 저장할 때마다 새 파일이 생길 수 있었다.)
 */
export async function listFiles(prefix: string): Promise<DriveFileMeta[]> {
  const out: DriveFileMeta[] = []
  let pageToken = ''
  do {
    const res = await driveFetch(`${API}/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,appProperties,modifiedTime)${pageToken ? `&pageToken=${pageToken}` : ''}`)
    const body = await res.json() as { files: DriveFileMeta[]; nextPageToken?: string }
    out.push(...body.files.filter((f) => f.name.startsWith(prefix)))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return out
}

export async function readFile(fileId: string): Promise<string | undefined> {
  const res = await driveFetch(`${API}/files/${fileId}?alt=media`)
  return res.status === 404 ? undefined : res.text()
}

/** 같은 이름 파일이 있으면 덮어쓰고 없으면 만든다. */
export async function writeFile(name: string, content: string, appProperties: Record<string, string>, existingId?: string): Promise<string> {
  const meta = existingId ? { appProperties } : { name, parents: ['appDataFolder'], appProperties, mimeType: 'application/json' }
  const boundary = `vibe${crypto.randomUUID()}`
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`
  const url = existingId ? `${UPLOAD}/files/${existingId}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`
  const res = await driveFetch(url, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
  if (res.status === 404) throw new Error('Google 드라이브 파일을 찾을 수 없습니다')
  return ((await res.json()) as { id: string }).id
}

export async function removeFile(fileId: string): Promise<void> {
  await driveFetch(`${API}/files/${fileId}`, { method: 'DELETE' })
}
