import { driveAccount, isDriveConnected, listFiles, readFile, writeFile } from './drive'

/**
 * 프로젝트 (Claude 의 프로젝트와 비슷하게)
 *
 * 프로젝트 = 이름 + 지침 + 공유 자료(텍스트 파일)를 가진 대화 묶음.
 * - 프로젝트 안의 모든 대화는 지침과 공유 자료를 시스템 프롬프트로 함께 받는다(캐시되어 매 턴 비용이 작다).
 * - 드라이브에서는 'Vibe Coding/<프로젝트 이름>/' 아래에 대화별 폴더가 생긴다(driveExport.projectFolder).
 * - 프로젝트 목록은 드라이브 숨김 폴더의 projects.json 하나에 저장하고, 연결 전·만료 중에는 브라우저에 대기로 두었다가 합친다.
 * 대화가 어느 프로젝트에 속하는지는 대화 쪽(StoredChat.projectId)에 적는다.
 */

export interface KnowledgeFile {
  id: string          // 드라이브 파일 id(없으면 직접 붙여 넣은 자료)
  name: string
  mimeType?: string
  size: number
  text: string        // 공유 자료는 텍스트만(문서·시트는 마크다운·CSV 로 변환해 넣는다)
}

export interface Project {
  id: string
  name: string
  instructions: string
  knowledge: KnowledgeFile[]
  createdAt: number
  updatedAt: number
}

const LOCAL_KEY = 'vibe_projects'
const DIRTY_KEY = 'vibe_projects_dirty'
const DRIVE_NAME = 'projects.json'
/** 공유 자료 한도: 파일당·전체 글자 수(시스템 프롬프트에 매번 실리므로 너무 크면 비용이 커진다) */
export const KNOWLEDGE_FILE_LIMIT = 100_000
export const KNOWLEDGE_TOTAL_LIMIT = 300_000

function readLocal(): Project[] {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]') ?? [] } catch { return [] }
}
function writeLocal(list: Project[], dirty: boolean) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list))
    if (dirty) localStorage.setItem(DIRTY_KEY, driveAccount()?.email ?? '*')
    else localStorage.removeItem(DIRTY_KEY)
  } catch { /* 저장 불가: 이번 세션만 */ }
}
const isDirty = () => {
  try {
    const v = localStorage.getItem(DIRTY_KEY)
    return !!v && (v === '*' || v === driveAccount()?.email)
  } catch { return false }
}

async function driveFile() {
  return (await listFiles(DRIVE_NAME)).find((f) => f.name === DRIVE_NAME)
}

/** 프로젝트 목록. 연결돼 있으면 드라이브 것을 받고, 대기 중 변경이 있으면 합쳐서(같은 id 는 최근 수정 우선) 올린다. */
export async function loadProjects(): Promise<Project[]> {
  const local = readLocal()
  if (!isDriveConnected()) return local
  try {
    const f = await driveFile()
    const remote: Project[] = f ? JSON.parse((await readFile(f.id)) || '[]') : []
    if (!isDirty()) { writeLocal(remote, false); return remote }
    const byId = new Map(remote.map((p) => [p.id, p]))
    for (const p of local) {
      const r = byId.get(p.id)
      if (!r || p.updatedAt >= r.updatedAt) byId.set(p.id, p)
    }
    const merged = [...byId.values()]
    await writeFile(DRIVE_NAME, JSON.stringify(merged), { kind: 'projects' }, f?.id)
    writeLocal(merged, false)
    return merged
  } catch {
    return local
  }
}

/** 목록 전체를 저장한다. 드라이브 저장이 안 되면 브라우저에 대기로 남긴다. */
export async function saveProjects(list: Project[]): Promise<void> {
  writeLocal(list, true)
  if (!isDriveConnected()) return
  try {
    const f = await driveFile()
    await writeFile(DRIVE_NAME, JSON.stringify(list), { kind: 'projects' }, f?.id)
    writeLocal(list, false)
  } catch { /* 대기로 남김 */ }
}

export function newProject(name: string): Project {
  const now = Date.now()
  return { id: crypto.randomUUID(), name: name.trim() || '새 프로젝트', instructions: '', knowledge: [], createdAt: now, updatedAt: now }
}

/** 프로젝트 지침·공유 자료를 시스템 프롬프트 블록으로. 없으면 빈 문자열. */
export function projectContext(p: Project | undefined): string {
  if (!p) return ''
  const parts = [`# Project: ${p.name}`, 'This conversation belongs to the project above. Follow its instructions and use its knowledge files when relevant.']
  if (p.instructions.trim()) parts.push(`## Project instructions\n${p.instructions.trim()}`)
  if (p.knowledge.length) {
    parts.push('## Project knowledge files')
    for (const k of p.knowledge) parts.push(`<knowledge_file name="${k.name.replace(/"/g, "'")}">\n${k.text}\n</knowledge_file>`)
  }
  return parts.join('\n\n')
}

export const knowledgeChars = (p: Project) => p.knowledge.reduce((n, k) => n + k.text.length, 0)
