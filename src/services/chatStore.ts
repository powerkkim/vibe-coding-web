import type { Message } from './ai'
import { driveAccount, DriveAuthError, driveMinutesLeft, hasFileScope, isDriveConfigured, isDriveConnected, isDriveExpired, listFiles, readFile, removeFile, waitForRenewal, writeFile } from './drive'
import { backupForget, backupGet, backupGetAll, backupPut, localDelete, localGet, localGetAll, localPut } from './localStore'

/**
 * 대화 저장소
 *
 * - VITE_CHAT_SERVER_URL 이 있으면: Cloudflare Worker + R2 (worker/ 참고, 원본 구성)
 * - 없으면: Google 드라이브 appDataFolder (services/drive.ts). 저장 위치는 로그인한 Google 계정 기준이다.
 *
 * 아래는 Worker 방식 설명이다.
 *
 * 대화 1건 = 메시지 + 그 대화에서 만든 프로젝트 파일. Anthropic API 키별로 서버에 저장되어 다른 기기에서도 보인다.
 * 서버 주소는 빌드 시 VITE_CHAT_SERVER_URL 로 받는다. 키가 바뀌면 이전 키로 저장한 대화는 보이지 않는다.
 * 모든 함수는 실패 시(네트워크 오류, 서버 오류, 키 거부) reject 한다. 호출 측에서 사용자에게 알린다.
 */

export interface StoredChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  projectFiles: Record<string, string>
  projectType: 'html' | 'react' | 'vue'
  // 이 대화가 import·export 로 연결한 저장소. 이 필드가 생기기 전에 저장된 대화에는 없다.
  githubRepo?: GithubRepo | null
  // 속한 프로젝트(projectStore). 없으면 프로젝트 밖 대화
  projectId?: string | null
}

export type GithubRepo = { owner: string; repo: string; branch: string }

export type ChatSummary = Pick<StoredChat, 'id' | 'title' | 'updatedAt'> & { projectId?: string | null }
const summary = (c: StoredChat): ChatSummary => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.projectId ? { projectId: c.projectId } : {}) })

export const SERVER_URL = import.meta.env.VITE_CHAT_SERVER_URL

/** 404 는 호출 측이 판단하도록 그대로 돌려준다. 그 밖의 실패(키 거부 401 포함)·네트워크 오류는 reject 한다. */
async function request(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!SERVER_URL) throw new Error('VITE_CHAT_SERVER_URL 이 설정되지 않았습니다')
  const res = await fetch(`${SERVER_URL}/api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${apiKey}` } })
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  return res
}

/** 대화를 Google 드라이브에 저장하는지(서버 주소가 없을 때) */
export const USE_DRIVE = !SERVER_URL

/**
 * 드라이브 방식의 저장 규칙
 * - 연결됨: 드라이브에 저장한다.
 * - 연결 전·토큰 만료: 이 브라우저(IndexedDB)에 '대기'로 저장한다.
 * - 다시 연결되면 대기 중인 대화를 드라이브로 올리고(더 최신일 때만) 브라우저에서 지운다.
 * - 목록은 드라이브 + 대기 중 대화를 합쳐 보여준다. 만료 중에는 마지막으로 받은 드라이브 목록(캐시)을 함께 보여준다.
 */
export const usingLocal = () => USE_DRIVE && !isDriveConnected()

/** 목록 항목. pending: 아직 드라이브에 올라가지 않음, driveOnly: 드라이브에만 있어 열려면 연결이 필요함 */
export type ChatListItem = ChatSummary & { pending?: boolean; driveOnly?: boolean }

// 대화 id → 드라이브 파일 id. 목록을 받을 때 채운다.
const driveIds = new Map<string, string>()
const PREFIX = 'chat-'
const fileName = (id: string) => `${PREFIX}${id}.json`
const LIST_CACHE_KEY = 'vibe_gdrive_list_cache'

function readListCache(): ChatSummary[] {
  try { return JSON.parse(localStorage.getItem(LIST_CACHE_KEY) ?? '[]') } catch { return [] }
}
function writeListCache(list: ChatSummary[]) {
  try { localStorage.setItem(LIST_CACHE_KEY, JSON.stringify(list.slice(0, 500))) } catch { /* 무시 */ }
}
/** 연결 해제 시 마지막 드라이브 목록을 지운다(다른 계정으로 바꿀 수 있으므로). */
export function clearDriveListCache() {
  try { localStorage.removeItem(LIST_CACHE_KEY) } catch { /* 무시 */ }
}
function updateListCache(fn: (list: ChatSummary[]) => ChatSummary[]) {
  writeListCache(fn(readListCache()))
}

function fitBytes(text: string, max: number): string {
  const enc = new TextEncoder()
  let out = ''
  for (const ch of text) {
    if (enc.encode(out + ch).length > max) break
    out += ch
  }
  return out
}

const byRecent = (a: ChatSummary, b: ChatSummary) => b.updatedAt - a.updatedAt

/** 드라이브 파일 목록 → 대화 요약. 같은 대화 파일이 여러 개면(예전 버전에서 생긴 중복) 가장 최신 것을 쓴다. */
async function driveList(): Promise<ChatSummary[]> {
  const files = await listFiles(PREFIX)
  const best = new Map<string, ChatSummary>()
  driveIds.clear()
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue
    const id = f.name.slice(PREFIX.length, -'.json'.length)
    const updatedAt = Number(f.appProperties?.updatedAt ?? 0) || Date.parse(f.modifiedTime ?? '') || 0
    const prev = best.get(id)
    if (prev && prev.updatedAt >= updatedAt) continue
    best.set(id, { id, title: f.appProperties?.title ?? '', updatedAt, ...(f.appProperties?.projectId ? { projectId: f.appProperties.projectId } : {}) })
    driveIds.set(id, f.id)
  }
  const list = [...best.values()].sort(byRecent)
  writeListCache(list)
  return list
}

async function driveId(id: string): Promise<string | undefined> {
  if (!driveIds.has(id)) await driveList()
  return driveIds.get(id)
}

async function driveSave(chat: StoredChat) {
  // appProperties 는 키+값 124바이트 한도라 제목을 짧게 자른다.
  // projectId 는 목록에서 프로젝트별로 묶기 위해 함께 둔다(빈 값이면 프로젝트 밖).
  const props = { title: fitBytes(chat.title, 110), updatedAt: String(chat.updatedAt), projectId: chat.projectId ?? '' }
  const fid = await writeFile(fileName(chat.id), JSON.stringify(chat), props, await driveId(chat.id))
  driveIds.set(chat.id, fid)
  updateListCache((l) => [summary(chat), ...l.filter((c) => c.id !== chat.id)])
}

/** 브라우저에 대기 중인 대화를 드라이브로 올린다. 드라이브 쪽이 더 최신이면 올리지 않고 브라우저 사본만 지운다. */
async function syncPending(remote: ChatSummary[]): Promise<ChatSummary[]> {
  // 다른 계정으로 연결했을 때 쌓인 대기본은 건드리지 않는다(그 계정으로 다시 연결하면 올라간다).
  const pending = (await localGetAll<LocalCopy>()).filter(sameAccount)
  if (pending.length === 0) return remote
  const remoteById = new Map(remote.map((c) => [c.id, c]))
  for (const { synced: _s, account: _a, ...chat } of pending) {
    const r = remoteById.get(chat.id)
    if (!r || chat.updatedAt > r.updatedAt) {
      await driveSave(chat)
      remoteById.set(chat.id, summary(chat))
    }
    await backupChat(chat, true)
    await localDelete(chat.id)
  }
  const list = [...remoteById.values()].sort(byRecent)
  writeListCache(list)
  return list
}

/**
 * 백업 복구: 드라이브에 올라가지 못한 백업(synced=false: 생성 도중 브라우저가 닫힘, 저장 직후 탭 종료 등)만 다시 올린다.
 * 이미 올라간 백업은 드라이브가 기준이다. 드라이브에 없으면 다른 기기에서 지운 것이므로 백업도 지운다.
 * 다른 계정에서 만든 백업은 건드리지 않는다.
 */
async function recoverFromBackup(remote: ChatSummary[]): Promise<ChatSummary[]> {
  const backups = (await backupGetAll<LocalCopy>().catch(() => [] as LocalCopy[])).filter(sameAccount)
  if (!backups.length) return remote
  const byId = new Map(remote.map((c) => [c.id, c]))
  let changed = false
  for (const { synced, account: _a, ...b } of backups) {
    const r = byId.get(b.id)
    if (synced) {
      if (!r) await backupForget(b.id).catch(() => {})
      continue
    }
    try {
      await driveSave(b)
      await backupChat(b, true)
      byId.set(b.id, { ...summary(b), updatedAt: Math.max(b.updatedAt, r?.updatedAt ?? 0) })
      changed = true
    } catch { /* 다음에 다시 시도 */ }
  }
  if (!changed) return remote
  const list = [...byId.values()].sort(byRecent)
  writeListCache(list)
  return list
}

/** 최근 수정 순 목록. 서버가 정렬해 준다. */
export async function listChats(apiKey: string): Promise<ChatListItem[]> {
  if (USE_DRIVE) {
    if (!usingLocal()) return recoverFromBackup(await syncPending(await driveList()))
    // 연결 전·만료: 대기 중(브라우저) + 마지막으로 본 드라이브 목록
    const pending = (await localGetAll<LocalCopy>()).filter(sameAccount).map((c) => ({ ...summary(c), pending: true }))
    const ids = new Set(pending.map((c) => c.id))
    // 백업에 있는 대화는 연결 없이도 열 수 있으므로 '드라이브에만 있음'으로 흐리게 두지 않는다.
    const backups = (await backupGetAll<LocalCopy>().catch(() => [] as LocalCopy[])).filter(sameAccount)
    const backed = new Map(backups.map((b) => [b.id, b]))
    const cached = readListCache().filter((c) => !ids.has(c.id)).map((c) => {
      const b = backed.get(c.id)
      return b ? { id: c.id, title: b.title, updatedAt: Math.max(c.updatedAt, b.updatedAt) } : { ...c, driveOnly: true }
    })
    const cachedIds = new Set(cached.map((c) => c.id))
    const backupOnly = backups.filter((b) => !ids.has(b.id) && !cachedIds.has(b.id)).map(summary)
    return [...pending, ...cached, ...backupOnly].sort(byRecent)
  }
  return (await request(apiKey, '/chats')).json()
}

export async function loadChat(apiKey: string, id: string): Promise<StoredChat | undefined> {
  if (USE_DRIVE) {
    // 클릭과 동시에 살며시 재로그인이 시작됐을 수 있다. 끝나길 기다렸다가 연결 상태로 연다.
    await waitForRenewal()
    const raw = await backupGet<LocalCopy>(id).catch(() => undefined)
    const backup = raw && sameAccount(raw) ? raw : undefined
    const local = await localGet<StoredChat>(id)
    if (local || usingLocal()) {
      const best = newest(local, backup)
      // 드라이브에만 있는(백업도 없는) 대화를 만료 중에 열려고 하면 다시 연결하라고 알린다.
      if (!best && readListCache().some((c) => c.id === id)) throw new DriveAuthError()
      return best
    }
    let remote: StoredChat | undefined
    try {
      const fid = await driveId(id)
      const text = fid ? await readFile(fid) : undefined
      remote = text ? JSON.parse(text) : undefined
    } catch (e) {
      // 드라이브를 못 읽어도 백업이 있으면 그걸로 연다.
      if (backup) return backup
      throw e
    }
    // 올라가지 못한 백업만 드라이브보다 우선한다(올라간 백업은 드라이브가 기준).
    if (backup && !backup.synced && (!remote || backup.updatedAt > remote.updatedAt)) {
      driveSave(backup).then(() => backupChat(backup, true)).catch(() => {})
      return backup
    }
    return remote ?? backup
  }
  const res = await request(apiKey, `/chats/${encodeURIComponent(id)}`)
  return res.status === 404 ? undefined : res.json()
}

/**
 * 저장 위치를 돌려준다. 'local' 이면 브라우저에 대기 저장된 것(다시 연결·새로고침 때 드라이브로 올라감).
 * 드라이브 저장이 실패하면(턴 도중 토큰 만료로 401, 네트워크 오류 등) 버리지 않고 브라우저에 대기 저장한다.
 * 예전엔 이 경우 저장이 실패한 채 다시 시도하지 않아, 그 턴 내용이 어디에도 남지 않을 수 있었다.
 */
/**
 * 브라우저 사본(대기·백업) 표시.
 * synced: 드라이브에 이 내용이 올라갔음 → 복구 때 다시 올리지 않는다(다른 기기에서 지운 대화가 되살아나거나, 기기 시계 차이로
 *         오래된 사본이 새 내용을 덮는 것을 막는다). 올라가지 못한 사본(synced=false)만 복구 대상이다.
 * account: 만들 때 연결돼 있던(또는 마지막으로 연결했던) Google 계정. 다른 계정의 드라이브로 올리지 않는다.
 */
type LocalCopy = StoredChat & { synced?: boolean; account?: string }
const currentAccount = () => driveAccount()?.email
/** 이 사본을 지금 계정에 올려도 되는가: 계정 없이 만든 것(처음 연결 전)이거나 같은 계정 */
const sameAccount = (c: LocalCopy) => !c.account || c.account === currentAccount()

const newest = (a?: StoredChat, b?: StoredChat) => (!a ? b : !b ? a : b.updatedAt > a.updatedAt ? b : a)

/** 최근 대화 백업에만 쓴다(드라이브·대기 저장과 별개). 생성 도중 받은 부분을 몇 초마다 남길 때 쓴다. */
export function backupChat(chat: StoredChat, synced = false) {
  const copy: LocalCopy = { ...chat, synced, account: currentAccount() }
  return backupPut(copy).catch(() => {})
}

export async function saveChat(apiKey: string, chat: StoredChat): Promise<'drive' | 'local' | 'server'> {
  // 어디에 저장하든 먼저 이 브라우저의 최근 대화 백업에 남긴다(가장 빠르고 실패할 일이 적다). 올라가면 synced 로 바꾼다.
  await backupChat(chat)
  if (USE_DRIVE) {
    await waitForRenewal()
    const pending: LocalCopy = { ...chat, account: currentAccount() }
    if (usingLocal()) { await localPut(pending); return 'local' }
    try {
      await driveSave(chat)
      await backupChat(chat, true)
      await localDelete(chat.id)   // 예전 대기본이 있으면 정리
      return 'drive'
    } catch {
      await localPut(pending)
      return 'local'
    }
  }
  await request(apiKey, `/chats/${encodeURIComponent(chat.id)}`, {
    method: 'PUT',
    // 서버는 본문을 파싱하지 않으므로 목록용 제목·수정 시각을 헤더로 함께 보낸다.
    headers: { 'Content-Type': 'application/json', 'X-Chat-Title': encodeURIComponent(chat.title), 'X-Chat-Updated-At': String(chat.updatedAt) },
    body: JSON.stringify(chat),
  })
  return 'server'
}

/** 탭을 닫는 순간 저장되지 않은 대화를 브라우저에 대기 저장한다(드라이브 요청은 닫히면서 끊길 수 있어서). 다음 실행 때 드라이브로 올라간다. */
export function savePendingNow(chat: StoredChat) {
  backupChat(chat)
  if (USE_DRIVE) localPut({ ...chat, account: currentAccount() } as LocalCopy).catch(() => {})
}

export async function deleteChat(apiKey: string, id: string): Promise<void> {
  if (USE_DRIVE) {
    await waitForRenewal()
    await localDelete(id)
    await backupForget(id).catch(() => {})
    if (usingLocal()) {
      if (readListCache().some((c) => c.id === id)) throw new DriveAuthError()
      return
    }
    // 예전 버전에서 생긴 중복 파일까지 모두 지운다.
    const files = (await listFiles(fileName(id))).filter((f) => f.name === fileName(id))
    for (const f of files) await removeFile(f.id)
    driveIds.delete(id)
    updateListCache((l) => l.filter((c) => c.id !== id))
    return
  }
  await request(apiKey, `/chats/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 첫 질문 앞부분을 제목으로 쓴다. */
export function chatTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.trim() ?? ''
  const line = first.split('\n')[0]
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || '새 대화'
}

/** app_status 도구가 돌려주는 저장 상태(영문). Claude 는 앱 상태를 직접 볼 수 없어 이 도구로 묻는다. */
export async function storageStatusLine(): Promise<string> {
  if (!USE_DRIVE) return 'Chats are saved to the chat server.'
  const pending = (await localGetAll<LocalCopy>().catch(() => [] as LocalCopy[])).filter(sameAccount).length
  const wait = pending ? ` ${pending} chat(s) are waiting in this browser to be uploaded.` : ''
  if (!isDriveConfigured()) return 'Google Drive is not configured (no client ID); chats are saved only in this browser (IndexedDB) and can be lost if browser data is cleared.'
  if (isDriveConnected()) return `Google Drive is connected as ${driveAccount()?.email ?? 'unknown account'}; every chat is saved automatically to its hidden app folder and listed in the left sidebar. ${hasFileScope() ? 'Visible-file saving is allowed: project files go to "My Drive/Vibe Coding/<project>".' : 'Visible-file saving (Vibe Coding folder) is not allowed yet; the user must press "권한 추가".'} Sign-in valid for about ${driveMinutesLeft()} more minutes (renews silently on the next click).${wait}`
  if (isDriveExpired()) return `Google Drive sign-in for ${driveAccount()?.email} has expired; chats are kept in this browser for now and upload automatically after reconnecting (any click reconnects).${wait}`
  return `Google Drive is not connected; chats are saved only in this browser and can be lost if browser data is cleared.${wait}`
}
