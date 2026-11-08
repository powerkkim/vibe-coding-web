import { isDriveConnected, listFiles, readFile, writeFile } from './drive'
import type { ClientToolResult } from './ai'

/**
 * 메모리 도구 저장소 (Anthropic memory_20250818, 앱이 실행하는 도구)
 *
 * Claude 가 보내는 /memories/... 경로의 파일 명령을 여기서 실행한다. 기억은 Google 계정 단위로 따라다니도록
 * 드라이브 앱 폴더의 memory.json 하나에 { 경로: 내용 } 으로 저장하고, 연결 전·만료 중에는 브라우저(localStorage)에
 * '대기'로 두었다가 연결되면 합쳐서 올린다(대화 저장과 같은 규칙).
 */

export type MemoryFiles = Record<string, string>

const ROOT = '/memories'
const LOCAL_KEY = 'vibe_memory'
const DIRTY_KEY = 'vibe_memory_dirty'
const DRIVE_NAME = 'memory.json'

function readLocal(): MemoryFiles {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') ?? {} } catch { return {} }
}
function writeLocal(files: MemoryFiles, dirty: boolean) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(files))
    if (dirty) localStorage.setItem(DIRTY_KEY, '1')
    else localStorage.removeItem(DIRTY_KEY)
  } catch { /* 저장 불가 브라우저: 이번 세션만 */ }
}
const isDirty = () => { try { return localStorage.getItem(DIRTY_KEY) === '1' } catch { return false } }

async function driveFile() {
  return (await listFiles(DRIVE_NAME)).find((f) => f.name === DRIVE_NAME)
}

/** 현재 기억 전체. 연결돼 있으면 드라이브 것을 받고, 브라우저에 대기 중인 변경이 있으면 합쳐서(브라우저 우선) 올린다. */
export async function loadMemory(): Promise<MemoryFiles> {
  const local = readLocal()
  if (!isDriveConnected()) return local
  try {
    const f = await driveFile()
    const remote: MemoryFiles = f ? JSON.parse((await readFile(f.id)) || '{}') : {}
    if (isDirty()) {
      const merged = { ...remote, ...local }
      await writeFile(DRIVE_NAME, JSON.stringify(merged), { kind: 'memory' }, f?.id)
      writeLocal(merged, false)
      return merged
    }
    writeLocal(remote, false)
    return remote
  } catch {
    return local
  }
}

/** 기억 전체를 저장한다. 드라이브 저장이 안 되면 브라우저에 대기로 남긴다. */
export async function saveMemory(files: MemoryFiles): Promise<void> {
  writeLocal(files, true)
  if (!isDriveConnected()) return
  try {
    const f = await driveFile()
    await writeFile(DRIVE_NAME, JSON.stringify(files), { kind: 'memory' }, f?.id)
    writeLocal(files, false)
  } catch { /* 대기로 남김 */ }
}

// ── 경로 검증 ────────────────────────────────────────────────
/** /memories 아래의 정규화된 경로. 밖으로 나가는 경로(../, 인코딩 포함)는 거부한다. */
function safePath(raw: unknown): string {
  let p = String(raw ?? '')
  try { p = decodeURIComponent(p) } catch { /* 그대로 */ }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (!p.startsWith(ROOT)) throw new Error(`The path ${raw} is invalid. Paths must start with ${ROOT}`)
  const parts: string[] = []
  for (const seg of p.split('/').filter(Boolean)) {
    if (seg === '.') continue
    if (seg === '..') throw new Error(`The path ${raw} is invalid.`)
    parts.push(seg)
  }
  const out = `/${parts.join('/')}`
  if (out !== ROOT && !out.startsWith(`${ROOT}/`)) throw new Error(`The path ${raw} is invalid.`)
  return out.replace(/\/$/, '') || ROOT
}

const isDir = (files: MemoryFiles, path: string) => path === ROOT || Object.keys(files).some((k) => k.startsWith(`${path}/`))
const numbered = (text: string, start = 1) => text.split('\n').map((l, i) => `${String(i + start).padStart(6)}\t${l}`).join('\n')
const human = (n: number) => (n < 1024 ? `${n}` : `${(n / 1024).toFixed(1)}K`)

/** Claude 의 memory 명령 하나를 실행한다(문서의 반환 문구를 따른다). */
export async function runMemoryCommand(input: Record<string, unknown>): Promise<ClientToolResult> {
  const files = await loadMemory()
  const cmd = String(input.command ?? '')
  const err = (content: string): ClientToolResult => ({ content, isError: true })
  try {
    switch (cmd) {
      case 'view': {
        const path = safePath(input.path ?? ROOT)
        if (path in files) {
          const lines = files[path].split('\n')
          const range = Array.isArray(input.view_range) ? (input.view_range as number[]) : null
          const start = range ? Math.max(1, range[0]) : 1
          const end = range && range[1] !== -1 ? range[1] : lines.length
          return { content: `Here's the content of ${path} with line numbers:\n${numbered(lines.slice(start - 1, end).join('\n'), start)}` }
        }
        if (!isDir(files, path)) return err(`The path ${path} does not exist. Please provide a valid path.`)
        const entries = Object.entries(files)
          .filter(([k]) => k.startsWith(`${path}/`) && k.slice(path.length + 1).split('/').length <= 2)
          .map(([k, v]) => `${human(new Blob([v]).size)}\t${k}`)
        return { content: `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n${entries.join('\n') || '(empty)'}` }
      }
      case 'create': {
        const path = safePath(input.path)
        if (path === ROOT || isDir(files, path)) return err(`Error: ${path} is a directory`)
        await saveMemory({ ...files, [path]: String(input.file_text ?? '') })
        return { content: `File created successfully at: ${path}` }
      }
      case 'str_replace': {
        const path = safePath(input.path)
        if (!(path in files)) return err(`Error: The path ${path} does not exist. Please provide a valid path.`)
        const oldStr = String(input.old_str ?? '')
        const text = files[path]
        const count = oldStr ? text.split(oldStr).length - 1 : 0
        if (count === 0) return err(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`)
        if (count > 1) {
          const lines = text.split('\n').map((l, i) => (l.includes(oldStr.split('\n')[0]) ? i + 1 : 0)).filter(Boolean)
          return err(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(', ')}. Please ensure it is unique`)
        }
        const next = text.replace(oldStr, String(input.new_str ?? ''))
        await saveMemory({ ...files, [path]: next })
        return { content: `The memory file has been edited.\n${numbered(next)}` }
      }
      case 'insert': {
        const path = safePath(input.path)
        if (!(path in files)) return err(`Error: The path ${path} does not exist`)
        const lines = files[path].split('\n')
        const at = Number(input.insert_line)
        if (!Number.isInteger(at) || at < 0 || at > lines.length) return err(`Error: Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`)
        lines.splice(at, 0, ...String(input.insert_text ?? '').split('\n'))
        await saveMemory({ ...files, [path]: lines.join('\n') })
        return { content: `The file ${path} has been edited.` }
      }
      case 'delete': {
        const path = safePath(input.path)
        if (path === ROOT) return err('Error: Cannot delete the /memories root')
        if (!(path in files) && !isDir(files, path)) return err(`Error: The path ${path} does not exist`)
        const next = Object.fromEntries(Object.entries(files).filter(([k]) => k !== path && !k.startsWith(`${path}/`)))
        await saveMemory(next)
        return { content: `Successfully deleted ${path}` }
      }
      case 'rename': {
        const from = safePath(input.old_path)
        const to = safePath(input.new_path)
        if (from === ROOT || to === ROOT) return err('Error: Cannot rename the /memories root')
        if (!(from in files) && !isDir(files, from)) return err(`Error: The path ${from} does not exist`)
        if (to in files || isDir(files, to)) return err(`Error: The destination ${to} already exists`)
        const next: MemoryFiles = {}
        for (const [k, v] of Object.entries(files)) {
          if (k === from) next[to] = v
          else if (k.startsWith(`${from}/`)) next[to + k.slice(from.length)] = v
          else next[k] = v
        }
        await saveMemory(next)
        return { content: `Successfully renamed ${from} to ${to}` }
      }
      default:
        return err(`Error: Unknown command ${cmd}`)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}
