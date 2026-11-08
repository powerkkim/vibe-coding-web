import { DRIVE_API, DRIVE_UPLOAD, driveRequest, hasFileScope } from './drive'

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
