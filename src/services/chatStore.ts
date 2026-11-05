import type { Message } from './ai'
import { DriveAuthError, isDriveConnected, listFiles, readFile, removeFile, waitForRenewal, writeFile } from './drive'
import { localDelete, localGet, localGetAll, localPut } from './localStore'

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
}

export type GithubRepo = { owner: string; repo: string; branch: string }

export type ChatSummary = Pick<StoredChat, 'id' | 'title' | 'updatedAt'>

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
    best.set(id, { id, title: f.appProperties?.title ?? '', updatedAt })
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
  const props = { title: fitBytes(chat.title, 110), updatedAt: String(chat.updatedAt) }
  const fid = await writeFile(fileName(chat.id), JSON.stringify(chat), props, await driveId(chat.id))
  driveIds.set(chat.id, fid)
  updateListCache((l) => [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt }, ...l.filter((c) => c.id !== chat.id)])
}

/** 브라우저에 대기 중인 대화를 드라이브로 올린다. 드라이브 쪽이 더 최신이면 올리지 않고 브라우저 사본만 지운다. */
async function syncPending(remote: ChatSummary[]): Promise<ChatSummary[]> {
  const pending = await localGetAll<StoredChat>()
  if (pending.length === 0) return remote
  const remoteById = new Map(remote.map((c) => [c.id, c]))
  for (const chat of pending) {
    const r = remoteById.get(chat.id)
    if (!r || chat.updatedAt > r.updatedAt) {
      await driveSave(chat)
      remoteById.set(chat.id, { id: chat.id, title: chat.title, updatedAt: chat.updatedAt })
    }
    await localDelete(chat.id)
  }
  const list = [...remoteById.values()].sort(byRecent)
  writeListCache(list)
  return list
}

/** 최근 수정 순 목록. 서버가 정렬해 준다. */
export async function listChats(apiKey: string): Promise<ChatListItem[]> {
  if (USE_DRIVE) {
    if (!usingLocal()) return syncPending(await driveList())
    // 연결 전·만료: 대기 중(브라우저) + 마지막으로 본 드라이브 목록
    const pending = (await localGetAll<StoredChat>()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt, pending: true }))
    const ids = new Set(pending.map((c) => c.id))
    const cached = readListCache().filter((c) => !ids.has(c.id)).map((c) => ({ ...c, driveOnly: true }))
    return [...pending, ...cached].sort(byRecent)
  }
  return (await request(apiKey, '/chats')).json()
}

export async function loadChat(apiKey: string, id: string): Promise<StoredChat | undefined> {
  if (USE_DRIVE) {
    // 클릭과 동시에 살며시 재로그인이 시작됐을 수 있다. 끝나길 기다렸다가 연결 상태로 연다.
    await waitForRenewal()
    const local = await localGet<StoredChat>(id)
    if (local || usingLocal()) {
      // 드라이브에만 있는 대화를 만료 중에 열려고 하면 다시 연결하라고 알린다.
      if (!local && readListCache().some((c) => c.id === id)) throw new DriveAuthError()
      return local
    }
    const fid = await driveId(id)
    const text = fid ? await readFile(fid) : undefined
    return text ? JSON.parse(text) : undefined
  }
  const res = await request(apiKey, `/chats/${encodeURIComponent(id)}`)
  return res.status === 404 ? undefined : res.json()
}

/**
 * 저장 위치를 돌려준다. 'local' 이면 브라우저에 대기 저장된 것(다시 연결·새로고침 때 드라이브로 올라감).
 * 드라이브 저장이 실패하면(턴 도중 토큰 만료로 401, 네트워크 오류 등) 버리지 않고 브라우저에 대기 저장한다.
 * 예전엔 이 경우 저장이 실패한 채 다시 시도하지 않아, 그 턴 내용이 어디에도 남지 않을 수 있었다.
 */
export async function saveChat(apiKey: string, chat: StoredChat): Promise<'drive' | 'local' | 'server'> {
  if (USE_DRIVE) {
    await waitForRenewal()
    if (usingLocal()) { await localPut(chat); return 'local' }
    try {
      await driveSave(chat)
      await localDelete(chat.id)   // 예전 대기본이 있으면 정리
      return 'drive'
    } catch {
      await localPut(chat)
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
  if (USE_DRIVE) localPut(chat).catch(() => {})
}

export async function deleteChat(apiKey: string, id: string): Promise<void> {
  if (USE_DRIVE) {
    await waitForRenewal()
    await localDelete(id)
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
