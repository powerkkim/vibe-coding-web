import { DRIVE_API, DRIVE_UPLOAD, driveRequest, hasFileScope, hasReadScope } from './drive'

/**
 * 내 드라이브에 '보이는' 파일로 내보내기 (drive.file 권한)
 *
 *   내 드라이브/Vibe Coding/<대화 제목> (<id 앞 6자리>)/index.html, src/App.vue, result.csv …
 *
 * drive.file 은 앱이 만든 파일만 보이므로, 폴더·파일은 appProperties(vibeRoot, chatId)와 이름으로 다시 찾는다.
 * 그래서 기기가 달라도 같은 폴더를 이어 쓴다. 이미 같은 내용을 올린 파일은 다시 올리지 않는다(이번 실행 동안).
 */

const FOLDER = 'application/vnd.google-apps.folder'
const ROOT_NAME = 'Vibe Coding'

export class FileScopeError extends Error {
  constructor() { super('드라이브에 파일로 저장하려면 권한 추가가 필요합니다') }
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const folderIds = new Map<string, string>()          // `${parentId}/${name}` → id, 'root' → Vibe Coding id, `chat:${id}` → 프로젝트 폴더 id
const fileIds = new Map<string, string>()            // `${parentId}/${name}` → id
const uploaded = new Map<string, string>()           // `${chatId}:${path}` → 마지막으로 올린 내용 지문

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Google 드라이브 HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function findOne(query: string, fields = 'id'): Promise<Record<string, string> | undefined> {
  const res = await driveRequest(`${DRIVE_API}/files?q=${encodeURIComponent(`${query} and trashed = false`)}&pageSize=1&fields=files(${fields})`)
  return (await json<{ files: Record<string, string>[] }>(res)).files[0]
}

async function createFolder(name: string, parent: string, appProperties?: Record<string, string>): Promise<string> {
  const res = await driveRequest(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent], ...(appProperties ? { appProperties } : {}) }),
  })
  return (await json<{ id: string }>(res)).id
}

async function rootFolder(): Promise<string> {
  const cached = folderIds.get('root')
  if (cached) return cached
  const found = await findOne(`appProperties has { key='vibeRoot' and value='1' } and mimeType = '${FOLDER}'`)
  const id = found?.id ?? await createFolder(ROOT_NAME, 'root', { vibeRoot: '1' })
  folderIds.set('root', id)
  return id
}

const safeName = (t: string) => (t.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 50) || '새 프로젝트')

/** 대화(프로젝트)용 폴더. chatId 로 찾으므로 제목이 바뀌어도 같은 폴더를 쓴다. */
export async function projectFolder(chatId: string, title: string): Promise<string> {
  const key = `chat:${chatId}`
  const cached = folderIds.get(key)
  if (cached) return cached
  const root = await rootFolder()
  const found = await findOne(`appProperties has { key='chatId' and value='${q(chatId)}' } and mimeType = '${FOLDER}'`)
  const id = found?.id ?? await createFolder(`${safeName(title)} (${chatId.slice(0, 6)})`, root, { chatId })
  folderIds.set(key, id)
  return id
}

async function subFolder(parent: string, name: string): Promise<string> {
  const key = `${parent}/${name}`
  const cached = folderIds.get(key)
  if (cached) return cached
  const found = await findOne(`name = '${q(name)}' and '${parent}' in parents and mimeType = '${FOLDER}'`)
  const id = found?.id ?? await createFolder(name, parent)
  folderIds.set(key, id)
  return id
}

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', jsx: 'text/javascript',
  ts: 'text/plain', tsx: 'text/plain', vue: 'text/plain', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  svg: 'image/svg+xml', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
}
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** parent 폴더에 name 파일을 만들거나(없으면) 내용을 바꾼다(있으면). */
async function upsert(parent: string, name: string, content: string | Blob): Promise<string> {
  const key = `${parent}/${name}`
  let id = fileIds.get(key)
  if (!id) id = (await findOne(`name = '${q(name)}' and '${parent}' in parents and mimeType != '${FOLDER}'`))?.id
  const mime = mimeOf(name)
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content
  if (id) {
    const res = await driveRequest(`${DRIVE_UPLOAD}/files/${id}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': mime }, body: blob })
    if (res.status !== 404) { await json(res); fileIds.set(key, id); return id }
    fileIds.delete(key)   // 사용자가 지운 파일 → 새로 만든다
  }
  const boundary = `vibe${crypto.randomUUID()}`
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: mime })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ])
  const res = await driveRequest(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
  const created = (await json<{ id: string }>(res)).id
  fileIds.set(key, created)
  return created
}

/** 'src/components/A.vue' 처럼 경로가 있으면 하위 폴더를 만들어 그 안에 저장한다. */
async function upsertPath(folder: string, path: string, content: string | Blob) {
  const parts = path.split('/').filter((p) => p && p !== '.' && p !== '..')
  const name = parts.pop()
  if (!name) throw new Error(`잘못된 파일 경로: ${path}`)
  let parent = folder
  for (const dir of parts) parent = await subFolder(parent, dir)
  return upsert(parent, name, content)
}

const fingerprint = (s: string) => `${s.length}:${[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)}`
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`

function requireScope() {
  if (!hasFileScope()) throw new FileScopeError()
}

/** 프로젝트 파일 전체를 내보낸다. 이번 실행에서 같은 내용으로 이미 올린 파일은 건너뛴다. 폴더 주소와 올린 개수를 돌려준다. */
export async function exportProject(chatId: string, title: string, files: Record<string, string>): Promise<{ url: string; uploaded: number }> {
  requireScope()
  const folder = await projectFolder(chatId, title)
  let n = 0
  for (const [path, content] of Object.entries(files)) {
    const key = `${chatId}:${path}`
    const fp = fingerprint(content)
    if (uploaded.get(key) === fp) continue
    await upsertPath(folder, path, content)
    uploaded.set(key, fp)
    n++
  }
  return { url: folderUrl(folder), uploaded: n }
}

/** 파일 하나(텍스트 또는 바이너리)를 프로젝트 폴더에 저장한다. */
export async function saveToProject(chatId: string, title: string, path: string, content: string | Blob): Promise<string> {
  requireScope()
  const folder = await projectFolder(chatId, title)
  await upsertPath(folder, path, content)
  return folderUrl(folder)
}

/** Vibe Coding 폴더(또는 프로젝트 폴더) 안의 목록. drive.file 이라 앱이 만든 것만 보인다. */
export async function listFolder(chatId?: string, title?: string): Promise<{ url: string; items: string[] }> {
  requireScope()
  const folder = chatId ? await projectFolder(chatId, title ?? '') : await rootFolder()
  const res = await driveRequest(`${DRIVE_API}/files?q=${encodeURIComponent(`'${folder}' in parents and trashed = false`)}&pageSize=200&orderBy=folder,name&fields=files(name,mimeType,modifiedTime)`)
  const files = (await json<{ files: { name: string; mimeType: string; modifiedTime: string }[] }>(res)).files
  return { url: folderUrl(folder), items: files.map((f) => `${f.mimeType === FOLDER ? '📁 ' : ''}${f.name}`) }
}

// ── 읽기 ────────────────────────────────────────────────────
/** 프로젝트 폴더 안 파일(경로) 내용을 텍스트로 읽는다. */
export async function readFromProject(chatId: string, title: string, path: string): Promise<string> {
  requireScope()
  const parts = path.split('/').filter((p) => p && p !== '.' && p !== '..')
  const name = parts.pop()
  if (!name) throw new Error(`잘못된 파일 경로: ${path}`)
  let parent = await projectFolder(chatId, title)
  for (const dir of parts) {
    const f = await findOne(`name = '${q(dir)}' and '${parent}' in parents and mimeType = '${FOLDER}'`)
    if (!f) throw new Error(`폴더가 없습니다: ${dir}`)
    parent = f.id
  }
  const file = await findOne(`name = '${q(name)}' and '${parent}' in parents and mimeType != '${FOLDER}'`, 'id,mimeType')
  if (!file) throw new Error(`파일이 없습니다: ${path}`)
  return (await fetchContent(file.id, file.mimeType)).text()
}

// ── 드라이브 전체 읽기(drive.readonly) ───────────────────────
// 검색·폴더 탐색·읽기는 드라이브 전체에서 하고, 쓰기는 Vibe Coding 폴더에서만 한다(A안: 가져와서 사본을 고친다).
export class ReadScopeError extends Error {
  constructor() { super('드라이브 전체를 읽으려면 권한 추가가 필요합니다') }
}
function requireRead() {
  if (!hasReadScope()) throw new ReadScopeError()
}

export interface DriveItem { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; isFolder: boolean }
const ITEM_FIELDS = 'files(id,name,mimeType,modifiedTime,size)'
const toItem = (f: Record<string, string>): DriveItem => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size, isFolder: f.mimeType === FOLDER })

/** 이름·본문으로 드라이브 전체 검색(휴지통 제외, 최근 수정 순, 최대 30개) */
export async function searchDrive(text: string): Promise<DriveItem[]> {
  requireRead()
  const t = q(text.trim())
  if (!t) return []
  const query = `(name contains '${t}' or fullText contains '${t}') and trashed = false`
  const res = await driveRequest(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&pageSize=30&orderBy=modifiedTime desc&fields=${ITEM_FIELDS}`)
  return (await json<{ files: Record<string, string>[] }>(res)).files.map(toItem)
}

/** 폴더 안 목록. folderId 가 없으면 '내 드라이브' 최상위 */
export async function browseDrive(folderId = 'root'): Promise<DriveItem[]> {
  requireRead()
  const query = `'${q(folderId)}' in parents and trashed = false`
  const res = await driveRequest(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&pageSize=200&orderBy=folder,name&fields=${ITEM_FIELDS}`)
  return (await json<{ files: Record<string, string>[] }>(res)).files.map(toItem)
}

async function metadata(id: string): Promise<DriveItem> {
  const res = await driveRequest(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,size`)
  return toItem(await json<Record<string, string>>(res))
}

const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/markdown', ext: 'md' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', ext: 'txt' },
}

/** 파일 내용. Google 문서·시트·슬라이드는 텍스트(마크다운·CSV)로 내보내서 받는다. */
async function fetchContent(id: string, mimeType?: string): Promise<Blob> {
  const exp = mimeType ? GOOGLE_EXPORT[mimeType] : undefined
  if (mimeType?.startsWith('application/vnd.google-apps.') && !exp) throw new Error('이 Google 형식은 읽을 수 없습니다(문서·시트·슬라이드만 가능)')
  const url = exp ? `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}` : `${DRIVE_API}/files/${id}?alt=media`
  const res = await driveRequest(url)
  if (!res.ok) throw new Error(`파일을 읽지 못했습니다 (HTTP ${res.status})`)
  return res.blob()
}

const TEXT_EXT = /\.(html?|css|js|mjs|jsx|ts|tsx|vue|json|md|txt|csv|svg|xml|ya?ml)$/i
const isTextLike = (name: string, mimeType: string) => TEXT_EXT.test(name) || mimeType.startsWith('text/') || mimeType in GOOGLE_EXPORT || mimeType === 'application/json'
/** 읽기·가져오기로 대화(프로젝트)에 넣는 텍스트 최대 크기. 넘으면 폴더에 복사만 한다(토큰 절약). */
export const IMPORT_TEXT_LIMIT = 200_000

/** 드라이브 파일을 텍스트로 읽는다(복사하지 않음). 텍스트가 아니면 오류. */
export async function readDriveFile(id: string, maxChars = 30_000): Promise<{ item: DriveItem; text: string; truncated: boolean }> {
  requireRead()
  const item = await metadata(id)
  if (item.isFolder) throw new Error(`${item.name} 은(는) 폴더입니다`)
  if (!isTextLike(item.name, item.mimeType)) throw new Error(`${item.name} 은(는) 텍스트 파일이 아니라 읽을 수 없습니다(가져오기로 프로젝트 폴더에 복사는 가능)`)
  const text = await (await fetchContent(id, item.mimeType)).text()
  return { item, text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

export interface ImportedFile { path: string; text?: string; size: number; source: string }

/**
 * 가져오기(A안): 드라이브 파일을 프로젝트 폴더의 imports/ 로 '복사'한다. 원본은 건드리지 않는다.
 * 텍스트 파일이면 내용도 돌려준다 → 앱이 프로젝트 파일에 넣어 Claude 가 고칠 수 있고, 고친 결과는 자동 저장으로 사본에 반영된다.
 */
export async function importDriveFile(chatId: string, title: string, id: string): Promise<ImportedFile> {
  requireRead()
  requireScope()
  const item = await metadata(id)
  if (item.isFolder) throw new Error(`${item.name} 은(는) 폴더라 가져올 수 없습니다`)
  const exp = GOOGLE_EXPORT[item.mimeType]
  const name = exp && !item.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${item.name}.${exp.ext}` : item.name
  const blob = await fetchContent(id, item.mimeType)
  const path = `imports/${name.replace(/[\\/]+/g, '_')}`
  await saveToProject(chatId, title, path, blob)
  const isText = isTextLike(name, item.mimeType) && blob.size <= IMPORT_TEXT_LIMIT
  return { path, size: blob.size, source: item.name, ...(isText ? { text: await blob.text() } : {}) }
}
