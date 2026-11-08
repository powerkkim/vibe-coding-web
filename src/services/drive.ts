/**
 * Google 드라이브 저장소 (Cloudflare Worker 대신)
 *
 * 브라우저에서 Google Identity Services(GIS)로 액세스 토큰을 받아 Drive REST API 를 직접 호출한다.
 * 범위는 drive.appdata 하나뿐이라, 이 앱이 만든 숨김 폴더(appDataFolder)만 읽고 쓴다. 사용자의 다른 드라이브 파일은 보지 못한다.
 * 대화 1건 = appDataFolder 안의 chat-<id>.json 파일 1개. 목록용 제목·수정 시각은 appProperties 에 둬서 본문을 열지 않는다.
 *
 * 필요한 설정: VITE_GOOGLE_CLIENT_ID (Google Cloud 콘솔 → OAuth 클라이언트 ID, 웹 애플리케이션).
 * 클라이언트 ID 는 공개돼도 되는 값이다(승인된 자바스크립트 원본에서만 동작).
 */

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || ''

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const TOKEN_KEY = 'vibe_gdrive_token'
// 연결했던 Google 계정. 토큰이 만료돼도 남겨 두고, 다시 연결할 때 같은 계정으로 계정 선택 없이 바로 붙인다.
// '연결 해제'를 눌렀을 때만 지운다.
const ACCOUNT_KEY = 'vibe_gdrive_account'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

/** 연결이 필요하다(토큰 없음·만료). 화면에서 '드라이브 연결' 버튼을 띄운다. */
export class DriveAuthError extends Error {
  constructor() { super('Google 드라이브 연결이 필요합니다') }
}

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { requestAccessToken: (o?: { prompt?: string }) => void; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }
declare global {
  interface Window { google?: { accounts: { oauth2: { initTokenClient: (c: Record<string, unknown>) => TokenClient; revoke: (t: string, cb?: () => void) => void } } } }
}

type Saved = { token: string; expiresAt: number }
export type DriveAccount = { email: string; name?: string }
let saved: Saved | null = readSaved()
let account: DriveAccount | null = readAccount()
const listeners = new Set<(connected: boolean) => void>()
let expiryTimer: ReturnType<typeof setTimeout> | undefined
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
let waiting: { resolve: () => void; reject: (e: Error) => void } | null = null
let renewing: Promise<void> | null = null

function onToken(r: TokenResponse) {
  const w = waiting
  waiting = null
  if (!r.access_token) return w?.reject(new Error(r.error_description || r.error || '드라이브 연결이 거부됐습니다'))
  const token = { token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 }
  // 어느 계정에 붙었는지 확인해 기억한다(목록 표시·다음 재연결의 login_hint). 실패해도 연결은 유지한다.
  fetch(`${API}/about?fields=user(emailAddress,displayName)`, { headers: { Authorization: `Bearer ${token.token}` } })
    .then((res) => (res.ok ? res.json() : null))
    .then((b: { user?: { emailAddress?: string; displayName?: string } } | null) => {
      if (b?.user?.emailAddress) setAccount({ email: b.user.emailAddress, name: b.user.displayName })
    })
    .catch(() => {})
    .finally(() => { setSaved(token); w?.resolve() })
}

function ensureClient(): TokenClient | null {
  if (!window.google?.accounts?.oauth2 || !GOOGLE_CLIENT_ID) return null
  if (!client || clientHint !== account?.email) {
    clientHint = account?.email
    client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
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
export async function connectDrive(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('VITE_GOOGLE_CLIENT_ID 가 설정되지 않았습니다')
  if (renewing) return renewing
  // 스크립트가 아직 없으면 불러온 뒤 연다(첫 연결). 이때는 팝업이 막힐 수 있어 미리 로드해 둔다(아래 자동 갱신).
  const c = ensureClient() ?? (await loadGis(), ensureClient())
  if (!c) throw new Error('Google 로그인 스크립트를 불러오지 못했습니다')
  return requestToken(c, account ? '' : 'select_account')
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
  const c = ensureClient()
  if (!c) return
  lastAttempt = Date.now()
  requestToken(c, '').catch(() => {})
}

function installAutoRenew() {
  if (typeof window === 'undefined' || !GOOGLE_CLIENT_ID) return
  // 로그인 팝업을 클릭 안에서 바로 열 수 있게 스크립트를 미리 받아 둔다(늦게 받으면 팝업이 차단될 수 있다).
  loadGis().then(() => ensureClient()).catch(() => {})
  // 사용자 활성화로 인정되는 이벤트: 마우스는 pointerdown, 터치는 pointerup, 그리고 키 입력.
  document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') maybeRenew() }, true)
  document.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') maybeRenew() }, true)
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') maybeRenew() }, true)
}
installAutoRenew()

export function disconnectDrive() {
  const t = saved?.token
  setAccount(null)
  setSaved(null)
  if (t) window.google?.accounts.oauth2.revoke(t)
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isDriveConnected()) throw new DriveAuthError()
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${saved!.token}` } })
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
