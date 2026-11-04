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
let saved: Saved | null = readSaved()
const listeners = new Set<(connected: boolean) => void>()

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
  listeners.forEach((fn) => fn(isDriveConnected()))
}

export function isDriveConfigured() { return !!GOOGLE_CLIENT_ID }
export function isDriveConnected() { return !!saved && saved.expiresAt > Date.now() + 60_000 }
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

/**
 * 토큰을 받는다. 사용자 클릭 안에서 호출해야 팝업이 막히지 않는다.
 * 처음엔 동의 화면이, 이후엔(같은 계정) 짧은 팝업만 뜨고 바로 닫힌다.
 */
export async function connectDrive(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('VITE_GOOGLE_CLIENT_ID 가 설정되지 않았습니다')
  await loadGis()
  await new Promise<void>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r: TokenResponse) => {
        if (!r.access_token) return reject(new Error(r.error_description || r.error || '드라이브 연결이 거부됐습니다'))
        setSaved({ token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 })
        resolve()
      },
      error_callback: (e: { type: string; message?: string }) => reject(new Error(e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : e.message || e.type)),
    })
    client.requestAccessToken({ prompt: saved ? '' : undefined })
  })
}

export function disconnectDrive() {
  const t = saved?.token
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

export interface DriveFileMeta { id: string; name: string; appProperties?: Record<string, string> }

/** appDataFolder 안에서 이름이 prefix 로 시작하는 파일 전부 */
export async function listFiles(prefix: string): Promise<DriveFileMeta[]> {
  const out: DriveFileMeta[] = []
  let pageToken = ''
  do {
    const q = encodeURIComponent(`name contains '${prefix}' and trashed = false`)
    const res = await driveFetch(`${API}/files?spaces=appDataFolder&q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${pageToken ? `&pageToken=${pageToken}` : ''}`)
    const body = await res.json() as { files: DriveFileMeta[]; nextPageToken?: string }
    out.push(...body.files.filter((f) => f.name.startsWith(prefix)))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return out
}

export async function findFile(name: string): Promise<DriveFileMeta | undefined> {
  return (await listFiles(name)).find((f) => f.name === name)
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
