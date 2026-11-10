import type { Message } from '../services/ai'
import { OutputFiles } from './ChatPanel'

/**
 * 캔버스 '파일' 탭: 이 대화에서 나온 파일 모음
 * - 결과물(답변별 버전) → 누르면 그 버전 미리보기
 * - 첨부(이미지·문서) → 누르면 그 메시지로 이동
 * - 코드 실행 결과 파일 → 내려받기·드라이브 저장
 */
interface Props {
  messages: Message[]
  onOpenAnswer: (index: number) => void
  onSaveOutputToDrive?: (id: string) => Promise<string>
}

const fmtSize = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`)
const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + '…' : s)

export function chatFileCount(messages: Message[]): number {
  return messages.reduce((n, m) => n + (m.snapshot ? 1 : 0) + (m.images?.length ?? 0) + (m.docs?.length ?? 0) + (m.outputs?.length ?? 0), 0)
}

export default function ChatFiles({ messages, onOpenAnswer, onSaveOutputToDrive }: Props) {
  // 답변 앞의 사용자 질문(버전 이름으로 쓴다)
  const askOf = (i: number) => { for (let k = i - 1; k >= 0; k--) if (messages[k].role === 'user') return messages[k].content; return '' }
  const versions = messages.flatMap((m, i) => (m.snapshot ? [{ i, n: Object.keys(m.snapshot).length }] : []))
  const attachments = messages.flatMap((m, i) => [
    ...(m.images ?? []).map((img, k) => ({ i, key: `img${i}-${k}`, icon: '🖼️', name: `이미지 ${k + 1}`, meta: img.mediaType.replace('image/', '').toUpperCase(), thumb: `data:${img.mediaType};base64,${img.data}` })),
    ...(m.docs ?? []).map((d, k) => ({ i, key: `doc${i}-${k}`, icon: d.kind === 'pdf' ? '📕' : '📄', name: d.name, meta: fmtSize(d.size), thumb: '' })),
  ])
  const outputs = messages.flatMap((m, i) => (m.outputs?.length ? [{ i, ids: m.outputs }] : []))
  const jump = (i: number) => {
    const el = document.querySelector(`[data-msg-index="${i}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('msg-flash')
    setTimeout(() => el?.classList.remove('msg-flash'), 1200)
  }
  const empty = !versions.length && !attachments.length && !outputs.length
  return (
    <div className="chat-files">
      {empty && <p className="chat-files-empty">이 대화에는 아직 파일이 없어요.</p>}
      {versions.length > 0 && (
        <section>
          <h3>결과물 <span>{versions.length}</span></h3>
          <ul>
            {versions.map((v, n) => (
              <li key={v.i}><button onClick={() => onOpenAnswer(v.i)} title="이 버전 미리보기">
                <span className="cf-icon">🧩</span>
                <span className="cf-name">v{n + 1} · {short(askOf(v.i)) || '결과물'}</span>
                <span className="cf-meta">파일 {v.n}개</span>
              </button></li>
            ))}
          </ul>
        </section>
      )}
      {attachments.length > 0 && (
        <section>
          <h3>첨부 <span>{attachments.length}</span></h3>
          <ul>
            {attachments.map((a) => (
              <li key={a.key}><button onClick={() => jump(a.i)} title="첨부한 메시지로 이동">
                {a.thumb ? <img src={a.thumb} alt="" className="cf-thumb" /> : <span className="cf-icon">{a.icon}</span>}
                <span className="cf-name">{a.name}</span>
                <span className="cf-meta">{a.meta}</span>
              </button></li>
            ))}
          </ul>
        </section>
      )}
      {outputs.length > 0 && (
        <section>
          <h3>실행 결과 파일 <span>{outputs.reduce((n, o) => n + o.ids.length, 0)}</span></h3>
          {outputs.map((o) => <OutputFiles key={o.i} ids={o.ids} onSaveToDrive={onSaveOutputToDrive} />)}
        </section>
      )}
    </div>
  )
}
