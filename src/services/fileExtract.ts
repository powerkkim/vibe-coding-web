/**
 * 첨부 파일 → 메시지에 실을 문서(MessageDoc)
 *
 * - PDF: base64 그대로(Claude 가 글·표·그림까지 읽는다). 10MB 까지
 * - 오피스(docx·xlsx·pptx)·한글(hwpx): 브라우저에서 글을 뽑아 텍스트로(표는 마크다운, 시트는 CSV)
 * - 그 밖의 파일: 내용이 글자면 텍스트로(UTF-8, 안 되면 EUC-KR). 바이너리(압축·실행·음악·영상 등)는 거절
 * 텍스트는 TEXT_LIMIT 글자까지만 싣고, 넘으면 잘랐다고 적는다. 저장 형식은 드라이브 첨부와 같은 MessageDoc 이다.
 */
import type { MessageDoc } from './ai'

export const PDF_LIMIT = 10 * 1024 * 1024
export const TEXT_LIMIT = 100_000
/** 읽기 전에 거절할 원본 크기(오피스·텍스트). 글만 뽑으면 훨씬 작아지지만 너무 크면 브라우저가 느려진다. */
const RAW_LIMIT = 30 * 1024 * 1024
export const MAX_DOCS_PER_MESSAGE = 10
/**
 * 한 요청에 실을 수 있는 첨부(이미지·PDF·글)의 대략적인 합계 한도. API 요청 크기 한도(32MB)보다 여유 있게 둔다.
 * 이전 메시지의 첨부도 매 턴 다시 보내므로 대화 전체로 센다.
 */
export const REQUEST_ATTACH_LIMIT = 24 * 1024 * 1024

/** 메시지들의 첨부가 요청에서 차지하는 대략적인 바이트(base64·글자 길이) */
export function attachmentBytes(msgs: { images?: { data: string }[]; docs?: MessageDoc[] }[]): number {
  return msgs.reduce((n, m) => n + (m.images ?? []).reduce((a, i) => a + i.data.length, 0) + (m.docs ?? []).reduce((a, d) => a + (d.data?.length ?? 0) + (d.text?.length ?? 0) * 2, 0), 0)
}

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip',
}

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()

// 내용이 바이너리라 읽을 수 없는 형식. 안내 문구를 붙여 거절한다.
const BINARY_HINT: Record<string, string> = {
  hwp: 'HWP 는 한글에서 HWPX 나 PDF 로 저장해 첨부해 주세요',
  doc: '옛 Word(.doc)는 .docx 나 PDF 로 저장해 첨부해 주세요',
  xls: '옛 Excel(.xls)은 .xlsx 나 CSV 로 저장해 첨부해 주세요',
  ppt: '옛 PowerPoint(.ppt)는 .pptx 나 PDF 로 저장해 첨부해 주세요',
}
const BINARY_EXT = /^(zip|7z|rar|gz|tgz|bz2|xz|tar|exe|dll|msi|bin|iso|dmg|apk|jar|class|so|o|a|mp3|wav|flac|aac|ogg|m4a|mp4|mov|avi|mkv|webm|wmv|psd|ai|sketch|fig|ttf|otf|woff2?|db|sqlite|mdb|accdb|pyc)$/

/** 사람이 읽을 크기 */
export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** 앞부분에 NUL 바이트가 있으면 바이너리로 본다(UTF-16 BOM 은 예외). */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** 글자 파일 디코딩: BOM → UTF-8(엄격) → EUC-KR(윈도우 한글 파일) 순서 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    try { return new TextDecoder('euc-kr').decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
  }
}

// ── XML 도우미(네임스페이스 접두어와 상관없이 태그의 local name 으로 찾는다) ──
const parseXml = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
const byLocal = (root: Element | Document, name: string) => Array.from(root.getElementsByTagNameNS('*', name))
const attr = (el: Element, name: string) => el.getAttribute(name) ?? el.getAttributeNS('*', name) ?? Array.from(el.attributes).find((a) => a.localName === name)?.value ?? null

async function loadZip(blob: Blob) {
  const { default: JSZip } = await import('jszip')
  return JSZip.loadAsync(blob)
}
type Zip = Awaited<ReturnType<typeof loadZip>>
const zipText = async (zip: Zip, path: string) => (await zip.file(path)?.async('string')) ?? ''
const byNumber = (re: RegExp) => (a: string, b: string) => Number(a.match(re)?.[1] ?? 0) - Number(b.match(re)?.[1] ?? 0)

/** Word 문단 하나의 글자(탭·줄바꿈 포함) */
function wordParagraph(p: Element): string {
  let out = ''
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 't') out += c.textContent ?? ''
      else if (c.localName === 'tab') out += '\t'
      else if (c.localName === 'br' || c.localName === 'cr') out += '\n'
      else if (c.localName !== 'pPr' && c.localName !== 'rPr') walk(c)
    }
  }
  walk(p)
  return out
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

export async function extractDocx(blob: Blob): Promise<string> {
  const zip = await loadZip(blob)
  const doc = parseXml(await zipText(zip, 'word/document.xml'))
  const body = byLocal(doc, 'body')[0]
  if (!body) throw new Error('Word 문서 내용을 찾지 못했어요')
  const lines: string[] = []
  // 내용 컨트롤(sdt) 안의 문단·표도 본문처럼 읽는다.
  const blocks = (parent: Element): Element[] => Array.from(parent.children).flatMap((c) =>
    c.localName === 'sdt' ? byLocal(c, 'sdtContent').slice(0, 1).flatMap(blocks) : [c])
  for (const el of blocks(body)) {
    if (el.localName === 'p') {
      const style = byLocal(el, 'pStyle')[0]
      const level = Number(attr(style ?? el, 'val')?.match(/^(?:Heading|제목)\s?(\d)/i)?.[1] ?? 0)
      const text = wordParagraph(el)
      lines.push(level && text.trim() ? `${'#'.repeat(Math.min(level, 6))} ${text.trim()}` : text)
    } else if (el.localName === 'tbl') {
      const rows = byLocal(el, 'tr').map((tr) => byLocal(tr, 'tc').map((tc) => cell(byLocal(tc, 'p').map(wordParagraph).join(' '))))
      if (!rows.length) continue
      const width = Math.max(...rows.map((r) => r.length))
      const row = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`
      lines.push('', row(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(row), '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 엑셀 열 이름(A, B, … AA) → 0부터 번호 */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export async function extractXlsx(blob: Blob): Promise<string> {
  const zip = await loadZip(blob)
  const shared = byLocal(parseXml(await zipText(zip, 'xl/sharedStrings.xml')), 'si').map((si) => byLocal(si, 't').map((t) => t.textContent ?? '').join(''))
  const rels = new Map(byLocal(parseXml(await zipText(zip, 'xl/_rels/workbook.xml.rels')), 'Relationship').map((r) => [attr(r, 'Id') ?? '', attr(r, 'Target') ?? '']))
  const sheets = byLocal(parseXml(await zipText(zip, 'xl/workbook.xml')), 'sheet').map((s) => {
    const target = rels.get(attr(s, 'id') ?? '') ?? ''
    return { name: attr(s, 'name') ?? 'Sheet', path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` }
  })
  const parts: string[] = []
  for (const sheet of sheets) {
    const xml = parseXml(await zipText(zip, sheet.path))
    const rows: string[] = []
    for (const r of byLocal(xml, 'row')) {
      const values: string[] = []
      for (const c of byLocal(r, 'c')) {
        const i = colIndex(attr(c, 'r') ?? '')
        const t = attr(c, 't')
        const v = byLocal(c, 'v')[0]?.textContent ?? ''
        const value = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? byLocal(c, 't').map((x) => x.textContent ?? '').join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v
        values[i] = csv(value)
      }
      if (values.some((v) => v)) rows.push(Array.from(values, (v) => v ?? '').join(','))
    }
    parts.push(`## 시트: ${sheet.name}\n${rows.join('\n') || '(빈 시트)'}`)
  }
  return parts.join('\n\n')
}

export async function extractPptx(blob: Blob): Promise<string> {
  const zip = await loadZip(blob)
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort(byNumber(/slide(\d+)\.xml$/))
  const parts: string[] = []
  for (const [i, path] of slides.entries()) {
    const xml = parseXml(await zipText(zip, path))
    const paras = byLocal(xml, 'p').map((p) => byLocal(p, 't').map((t) => t.textContent ?? '').join('')).filter((t) => t.trim())
    parts.push(`## 슬라이드 ${i + 1}\n${paras.join('\n') || '(글 없음)'}`)
  }
  return parts.join('\n\n')
}

export async function extractHwpx(blob: Blob): Promise<string> {
  const zip = await loadZip(blob)
  const sections = Object.keys(zip.files).filter((p) => /^Contents\/section\d+\.xml$/i.test(p)).sort(byNumber(/section(\d+)\.xml$/i))
  if (!sections.length) throw new Error('HWPX 본문을 찾지 못했어요')
  const parts: string[] = []
  for (const path of sections) {
    const xml = parseXml(await zipText(zip, path))
    // 표 안 문단도 hp:p 라서 바깥 문단과 겹치지 않게, 글자(hp:t)를 직접 가진 문단만 쓴다.
    for (const p of byLocal(xml, 'p')) {
      const runs = Array.from(p.children).filter((c) => c.localName === 'run')
      const text = runs.flatMap((r) => Array.from(r.children).filter((c) => c.localName === 't').map((t) => t.textContent ?? '')).join('')
      if (text.trim()) parts.push(text)
    }
  }
  return parts.join('\n')
}

const EXTRACTORS: Record<string, { mime: string; run: (b: Blob) => Promise<string> }> = {
  docx: { mime: MIME.docx, run: extractDocx },
  xlsx: { mime: MIME.xlsx, run: extractXlsx },
  xlsm: { mime: MIME.xlsx, run: extractXlsx },
  pptx: { mime: MIME.pptx, run: extractPptx },
  hwpx: { mime: MIME.hwpx, run: extractHwpx },
}
const EXTRACT_BY_MIME: Record<string, (b: Blob) => Promise<string>> = { [MIME.docx]: extractDocx, [MIME.xlsx]: extractXlsx, [MIME.pptx]: extractPptx }

/** 오피스·한글 파일인지(이름 또는 MIME). 드라이브 첨부에서도 쓴다. */
export function officeExtractor(name: string, mime?: string): ((b: Blob) => Promise<string>) | undefined {
  return EXTRACTORS[ext(name)]?.run ?? (mime ? EXTRACT_BY_MIME[mime] : undefined)
}

function textDoc(name: string, text: string, size: number, mimeType?: string): MessageDoc {
  const cut = text.length > TEXT_LIMIT
  const body = cut ? `${text.slice(0, TEXT_LIMIT)}\n\n... (파일이 길어 앞 ${TEXT_LIMIT.toLocaleString()}자만 실었습니다. 전체 ${text.length.toLocaleString()}자)` : text
  return { name, kind: 'text', size, text: body, ...(mimeType ? { mimeType } : {}) }
}

/**
 * 내 기기에서 고른 파일 하나 → 문서. 이미지는 여기서 다루지 않는다(image.ts).
 * 읽을 수 없는 형식은 사용자에게 보여줄 한국어 메시지로 Error 를 던진다.
 */
export async function readLocalDoc(file: File): Promise<MessageDoc> {
  const e = ext(file.name)
  if (file.type === 'application/pdf' || e === 'pdf') {
    if (file.size > PDF_LIMIT) throw new Error(`${file.name}: PDF 는 ${fmtBytes(PDF_LIMIT)}까지 첨부할 수 있어요 (${fmtBytes(file.size)}). 필요한 부분만 나눠 주세요`)
    return { name: file.name, kind: 'pdf', size: file.size, data: await blobBase64(file), mimeType: 'application/pdf' }
  }
  if (BINARY_HINT[e]) throw new Error(`${file.name}: ${BINARY_HINT[e]}`)
  if (file.size > RAW_LIMIT) throw new Error(`${file.name}: 파일이 너무 커요 (${fmtBytes(file.size)}, 최대 ${fmtBytes(RAW_LIMIT)})`)
  const office = EXTRACTORS[e]
  if (office) {
    let text: string
    try { text = await office.run(file) } catch { throw new Error(`${file.name}: 파일 내용을 읽지 못했어요 (손상됐거나 암호가 걸린 파일일 수 있어요)`) }
    return textDoc(file.name, text || '(글자가 없는 문서)', file.size, office.mime)
  }
  if (BINARY_EXT.test(e) || /^(audio|video)\//.test(file.type) || file.type === 'application/zip') {
    throw new Error(`${file.name}: 이 형식은 내용을 읽을 수 없어요 (PDF·문서·시트·슬라이드·텍스트·코드·이미지만)`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (looksBinary(bytes)) throw new Error(`${file.name}: 글자로 된 파일이 아니라 읽을 수 없어요`)
  return textDoc(file.name, decodeText(bytes), file.size, file.type || undefined)
}
