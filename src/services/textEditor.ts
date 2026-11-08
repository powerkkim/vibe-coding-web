import type { ClientToolResult } from './ai'

/**
 * 텍스트 에디터 도구 (Anthropic text_editor_20250728, 앱이 실행하는 도구)
 *
 * Claude 의 view / str_replace / create / insert 명령을 현재 프로젝트 파일(메모리 상의 사본)에 적용한다.
 * 파일 전체를 다시 출력하지 않고 바뀐 부분만 보내게 해서 수정 요청의 출력 토큰을 줄이는 것이 목적이다.
 */

/** 경로를 프로젝트 파일 이름으로 정규화한다("/src/App.vue", "./src/App.vue" → "src/App.vue"). 밖으로 나가는 경로는 거부. */
export function normalizeProjectPath(raw: unknown): string {
  const p = String(raw ?? '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/+/g, '/')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`Invalid path: ${raw}`)
  return p.replace(/\/$/, '')
}

const numbered = (text: string, start = 1) => text.split('\n').map((l, i) => `${i + start}: ${l}`).join('\n')

/**
 * 명령 하나를 실행하고 바뀐 파일 목록을 돌려준다.
 * files 는 바꾸지 않고, 바뀌었으면 next 에 새 객체를 준다.
 */
export function runEditorCommand(
  files: Record<string, string>,
  input: Record<string, unknown>,
  maxChars = 20_000,
): { result: ClientToolResult; next?: Record<string, string>; changed?: string } {
  const cmd = String(input.command ?? '')
  const err = (content: string) => ({ result: { content, isError: true } })
  let path: string
  try { path = normalizeProjectPath(input.path) } catch (e) { return err(`Error: ${(e as Error).message}`) }

  switch (cmd) {
    case 'view': {
      if (!path || !(path in files)) {
        // 디렉터리(또는 루트)면 그 아래 파일 목록
        const prefix = path ? `${path}/` : ''
        const list = Object.keys(files).filter((k) => k.startsWith(prefix)).sort()
        if (list.length) return { result: { content: list.join('\n') } }
        return err(`Error: The path ${path || '/'} does not exist.`)
      }
      const lines = files[path].split('\n')
      const range = Array.isArray(input.view_range) ? (input.view_range as number[]) : null
      const start = range ? Math.max(1, range[0]) : 1
      const end = range && range[1] !== -1 ? range[1] : lines.length
      let text = numbered(lines.slice(start - 1, end).join('\n'), start)
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n... (truncated; use view_range to see more)`
      return { result: { content: text } }
    }
    case 'str_replace': {
      if (!(path in files)) return err(`Error: The file ${path} does not exist.`)
      const oldStr = String(input.old_str ?? '')
      const text = files[path]
      const count = oldStr ? text.split(oldStr).length - 1 : 0
      if (count === 0) return err(`Error: No match found for replacement in ${path}. old_str must match exactly, including whitespace.`)
      if (count > 1) return err(`Error: Found ${count} matches for replacement text in ${path}. Please provide more context to make a unique match.`)
      // replace 의 $ 패턴 해석을 피하려고 함수로 바꾼다.
      const next = text.replace(oldStr, () => String(input.new_str ?? ''))
      return { result: { content: 'Successfully replaced text at exactly one location.' }, next: { ...files, [path]: next }, changed: path }
    }
    case 'create': {
      if (!path) return err('Error: A file path is required.')
      return { result: { content: `File created successfully at: ${path}` }, next: { ...files, [path]: String(input.file_text ?? '') }, changed: path }
    }
    case 'insert': {
      if (!(path in files)) return err(`Error: The file ${path} does not exist.`)
      const lines = files[path].split('\n')
      const at = Number(input.insert_line)
      if (!Number.isInteger(at) || at < 0 || at > lines.length) return err(`Error: insert_line ${input.insert_line} is out of range [0, ${lines.length}].`)
      lines.splice(at, 0, ...String(input.insert_text ?? '').split('\n'))
      return { result: { content: `Successfully inserted text in ${path}.` }, next: { ...files, [path]: lines.join('\n') }, changed: path }
    }
    default:
      return err(`Error: Unknown command ${cmd}`)
  }
}
