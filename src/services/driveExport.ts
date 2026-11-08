import { currentAccessToken, DRIVE_API, DRIVE_UPLOAD, driveRequest, hasFileScope } from './drive'
import type { MessageDoc, MessageImage } from './ai'
import { readImage } from './image'

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

// 대화 → 소속 프로젝트(App 이 대화를 열거나 옮길 때 알려 준다). 프로젝트 대화는 'Vibe Coding/<프로젝트>/<대화>/' 에 저장된다.
const chatProjects = new Map<string, { id: string; name: string } | undefined>()
export function bindChatProject(chatId: string, project?: { id: string; name: string }) {
  const prev = chatProjects.get(chatId)
  chatProjects.set(chatId, project)
  if (prev?.id !== project?.id) folderIds.delete(`chat:${chatId}`)   // 다음 저장 때 위치를 다시 확인(필요하면 폴더 이동)
}

/** 프로젝트 폴더('Vibe Coding/<프로젝트 이름>'). projectId 로 찾으므로 이름을 바꿔도 같은 폴더를 쓴다. */
async function projectRoot(project: { id: string; name: string }): Promise<string> {
  const key = `project:${project.id}`
  const cached = folderIds.get(key)
  if (cached) return cached
  const root = await rootFolder()
  const found = await findOne(`appProperties has { key='vibeProjectId' and value='${q(project.id)}' } and mimeType = '${FOLDER}'`)
  const id = found?.id ?? await createFolder(safeName(project.name), root, { vibeProjectId: project.id })
  folderIds.set(key, id)
  return id
}

/** 프로젝트 이름을 바꾸면 드라이브 폴더 이름도 바꾼다(폴더가 아직 없으면 아무것도 안 함). */
export async function renameProjectFolder(project: { id: string; name: string }) {
  if (!hasFileScope()) return
  const found = await findOne(`appProperties has { key='vibeProjectId' and value='${q(project.id)}' } and mimeType = '${FOLDER}'`)
  if (!found) return
  await json(await driveRequest(`${DRIVE_API}/files/${found.id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: safeName(project.name) }) }))
}

/** 대화를 다른 프로젝트로 옮겼을 때, 이미 있는 대화 폴더만 새 위치로 옮긴다(없으면 아무것도 만들지 않는다). */
export async function moveChatFolder(chatId: string): Promise<void> {
  if (!hasFileScope()) return
  const found = await findOne(`appProperties has { key='chatId' and value='${q(chatId)}' } and mimeType = '${FOLDER}'`, 'id,parents')
  if (!found) return
  const project = chatProjects.get(chatId)
  const parent = project ? await projectRoot(project) : await rootFolder()
  const parents = (found.parents as unknown as string[] | undefined) ?? []
  if (!parents.includes(parent)) {
    await json(await driveRequest(`${DRIVE_API}/files/${found.id}?addParents=${parent}&removeParents=${parents.join(',')}&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
  }
  folderIds.set(`chat:${chatId}`, found.id)
}

/**
 * 대화용 폴더. chatId 로 찾으므로 제목이 바뀌어도 같은 폴더를 쓴다.
 * 프로젝트 대화면 프로젝트 폴더 아래에 두고, 대화를 다른 프로젝트로 옮겼으면 폴더도 옮긴다.
 */
export async function projectFolder(chatId: string, title: string): Promise<string> {
  const key = `chat:${chatId}`
  const cached = folderIds.get(key)
  if (cached) return cached
  const project = chatProjects.get(chatId)
  const parent = project ? await projectRoot(project) : await rootFolder()
  const found = await findOne(`appProperties has { key='chatId' and value='${q(chatId)}' } and mimeType = '${FOLDER}'`, 'id,parents')
  let id = found?.id
  if (id && found?.parents && !found.parents.includes(parent)) {
    const remove = (found.parents as unknown as string[]).join(',')
    await json(await driveRequest(`${DRIVE_API}/files/${id}?addParents=${parent}&removeParents=${remove}&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
  }
  id ??= await createFolder(`${safeName(title)} (${chatId.slice(0, 6)})`, parent, { chatId })
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

// ── 가져오기(A안): 사용자가 선택창에서 고른 파일을 프로젝트 폴더로 '복사'한다. 원본은 건드리지 않는다. ──
const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/markdown', ext: 'md' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', ext: 'txt' },
}

/** 파일 내용. Google 문서·시트·슬라이드는 텍스트(마크다운·CSV)로 내보내서 받는다. */
async function fetchContent(id: string, mimeType?: string): Promise<Blob> {
  const exp = mimeType ? GOOGLE_EXPORT[mimeType] : undefined
  if (mimeType?.startsWith('application/vnd.google-apps.') && !exp) throw new Error('이 Google 형식은 가져올 수 없습니다(문서·시트·슬라이드만 가능)')
  const url = exp ? `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}` : `${DRIVE_API}/files/${id}?alt=media`
  const res = await driveRequest(url)
  if (!res.ok) throw new Error(`파일을 읽지 못했습니다 (HTTP ${res.status})`)
  return res.blob()
}

const TEXT_EXT = /\.(html?|css|js|mjs|jsx|ts|tsx|vue|json|md|txt|csv|svg|xml|ya?ml)$/i
/** 프로젝트에 넣을 텍스트 파일 최대 크기. 이보다 크면 폴더에 복사만 하고 대화에는 넣지 않는다(토큰 절약). */
export const IMPORT_TEXT_LIMIT = 200_000

export interface ImportedFile { path: string; text?: string; size: number; source: string }

/**
 * 고른 파일을 프로젝트 폴더의 imports/ 아래로 복사한다.
 * 텍스트 파일이면 내용도 돌려준다 → 앱이 프로젝트 파일에 넣어 Claude 가 읽고 고칠 수 있게 하고, 고친 결과는 자동 저장으로 사본에 반영된다.
 */
export async function importPicked(chatId: string, title: string, picked: { id: string; name: string; mimeType?: string }): Promise<ImportedFile> {
  requireScope()
  const exp = picked.mimeType ? GOOGLE_EXPORT[picked.mimeType] : undefined
  const name = exp && !picked.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${picked.name}.${exp.ext}` : picked.name
  const blob = await fetchContent(picked.id, picked.mimeType)
  const path = `imports/${cleanFileName(name)}`
  await saveToProject(chatId, title, path, blob)
  const isText = TEXT_EXT.test(name) && blob.size <= IMPORT_TEXT_LIMIT
  return { path, size: blob.size, source: picked.name, ...(isText ? { text: await blob.text() } : {}) }
}

// ── Google 선택창(Picker) ───────────────────────────────────
// Picker 는 개발자 API 키와 앱 ID(Cloud 프로젝트 번호)가 필요하다. 둘 다 공개돼도 되는 값이다(리퍼러 제한 권장).
const PICKER_KEY = (import.meta.env.VITE_GOOGLE_API_KEY as string | undefined)?.trim() || ''
const APP_ID = (import.meta.env.VITE_GOOGLE_APP_ID as string | undefined)?.trim() || ''
export const isPickerConfigured = () => !!PICKER_KEY && !!APP_ID

/** 선택창에서 고른 파일(내용은 아직 받지 않음) */
export type PickerDoc = { id: string; name: string; mimeType?: string; sizeBytes?: number }
type Gapi = { load: (lib: string, cb: () => void) => void }
type PickerNS = {
  DocsView: new (viewId?: unknown) => { setIncludeFolders: (b: boolean) => unknown; setSelectFolderEnabled: (b: boolean) => unknown }
  ViewId: { DOCS: unknown }
  Action: { PICKED: string; CANCEL: string }
  PickerBuilder: new () => Record<string, (...a: unknown[]) => unknown>
}
let pickerLoading: Promise<void> | null = null
function loadPicker(): Promise<void> {
  const w = window as unknown as { gapi?: Gapi; google?: { picker?: PickerNS } }
  if (w.google?.picker) return Promise.resolve()
  pickerLoading ??= new Promise((resolve, reject) => {
    const done = () => w.gapi!.load('picker', () => resolve())
    if (w.gapi) return done()
    const s = document.createElement('script')
    s.src = 'https://apis.google.com/js/api.js'
    s.async = true
    s.onload = done
    s.onerror = () => { pickerLoading = null; reject(new Error('Google 선택창을 불러오지 못했습니다')) }
    document.head.appendChild(s)
  })
  return pickerLoading
}

/** 선택창을 띄워 파일 하나를 고르게 한다. 취소하면 null. */
export async function pickDriveFile(): Promise<PickerDoc | null> {
  if (!isPickerConfigured()) throw new Error('Google 선택창 설정(VITE_GOOGLE_API_KEY, VITE_GOOGLE_APP_ID)이 없습니다')
  requireScope()
  const token = currentAccessToken()
  if (!token) throw new FileScopeError()
  await loadPicker()
  const picker = (window as unknown as { google: { picker: PickerNS } }).google.picker
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setIncludeFolders(true)
    let b = new picker.PickerBuilder()
    b = b.addView(view) as typeof b
    b = b.setOAuthToken(token) as typeof b
    b = b.setDeveloperKey(PICKER_KEY) as typeof b
    b = b.setAppId(APP_ID) as typeof b
    b = b.setTitle('첨부할 파일 선택') as typeof b
    b = b.setCallback((data: { action: string; docs?: PickerDoc[] }) => {
      if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve(data.docs[0])
      else if (data.action === picker.Action.CANCEL) resolve(null)
    }) as typeof b
    ;(b.build() as { setVisible: (v: boolean) => void }).setVisible(true)
  })
}

// ── 첨부(사진 첨부와 같은 방식) ───────────────────────────────
// 고를 때는 이름·종류·크기만 받아 칩으로 보여주고, 메시지를 보낼 때 내용을 받아 그 메시지에 싣는다. 폴더는 만들지 않는다.
const PDF_LIMIT = 10 * 1024 * 1024            // PDF 를 메시지에 직접 싣는 최대 크기
const TEXT_INLINE_LIMIT = 100_000              // 텍스트를 직접 싣는 최대 글자 수. 넘으면 이름만 알리고 필요할 때 읽게 한다.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 보낼 때: 첨부 파일 내용을 받아 이미지 또는 문서로 만든다. */
export async function loadAttachment(ref: PickerDoc): Promise<{ image?: MessageImage; doc?: MessageDoc }> {
  const mime = ref.mimeType ?? ''
  if (IMAGE_TYPES.includes(mime)) {
    const blob = await fetchContent(ref.id, mime)
    return { image: await readImage(new File([blob], ref.name, { type: mime })) }
  }
  if (mime === 'application/pdf') {
    if ((ref.sizeBytes ?? 0) > PDF_LIMIT) return { doc: { name: ref.name, kind: 'ref', size: ref.sizeBytes ?? 0, driveId: ref.id, mimeType: mime } }
    const blob = await fetchContent(ref.id, mime)
    if (blob.size > PDF_LIMIT) return { doc: { name: ref.name, kind: 'ref', size: blob.size, driveId: ref.id, mimeType: mime } }
    return { doc: { name: ref.name, kind: 'pdf', size: blob.size, data: await blobBase64(blob), driveId: ref.id, mimeType: mime } }
  }
  const exp = GOOGLE_EXPORT[mime]
  const name = exp && !ref.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${ref.name}.${exp.ext}` : ref.name
  if (!exp && !TEXT_EXT.test(ref.name) && !mime.startsWith('text/') && mime !== 'application/json') {
    throw new Error(`${ref.name}: 이 형식은 첨부할 수 없어요 (PDF·이미지·텍스트·Google 문서/시트/슬라이드만)`)
  }
  const text = await (await fetchContent(ref.id, mime)).text()
  if (text.length > TEXT_INLINE_LIMIT) return { doc: { name, kind: 'ref', size: text.length, driveId: ref.id, mimeType: mime } }
  return { doc: { name, kind: 'text', size: text.length, text, driveId: ref.id, mimeType: mime } }
}

/** 큰 첨부를 필요할 때 읽는다(텍스트만, 최대 maxChars). */
export async function readAttachmentText(doc: MessageDoc, maxChars = 30_000): Promise<string> {
  if (!doc.driveId) throw new Error('드라이브 파일 정보가 없습니다')
  if (doc.mimeType === 'application/pdf') throw new Error('PDF 가 커서(10MB 초과) 읽을 수 없습니다. 필요한 부분만 나눠 첨부해 주세요')
  const text = await (await fetchContent(doc.driveId, doc.mimeType)).text()
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... (truncated, ${text.length} chars total)` : text
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** 파일 이름 정리: 경로 구분자·제어문자 → '_', 이어진 점은 하나로, 앞뒤 점·공백 제거 */
export function cleanFileName(name: string): string {
  const n = name.replace(/[\\/\u0000-\u001f]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[\s.]+|[\s.]+$/g, '')
  return n || 'file'
}
