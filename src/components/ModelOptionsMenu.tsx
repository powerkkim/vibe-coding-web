import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from '../icons'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { MODELS } from '../services/ai'
import type { ModelOptions } from '../services/ai'
import { loadMemory, saveMemory } from '../services/memoryStore'
import type { MemoryFiles } from '../services/memoryStore'

/**
 * 모델 선택 옆 옵션 버튼과 팝오버. v0.8.0 부터 '생각 요약 보기'만 고른다(나머지는 권장값 고정, ai.effectiveOptions).
 * 이 파일의 MemoryManager(기억 보기·편집)는 사이드바의 메모리 안내에서 연다.
 */
interface Props {
  model: string
  options: ModelOptions
  onChange: (options: ModelOptions) => void
  disabled?: boolean
}

/** 기본값과 다른 옵션이 있는지(버튼에 점 표시). 지금은 생각 요약 보기만 고를 수 있다. */
export function isCustomized(o: ModelOptions): boolean {
  return o.showThinking
}

export default function ModelOptionsMenu({ model, options, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEscapeKey(() => setOpen(false), open)

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const info = MODELS.find((m) => m.id === model)
  const customized = isCustomized(options)

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="icon-btn relative"
        aria-label="모델 옵션"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={disabled ? '생성 중에는 바꿀 수 없습니다' : '모델 옵션'}
      >
        <SlidersHorizontal style={{ width: 17, height: 17 }} />
        {customized && (
          <span aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: '50%', background: '#2b5fd9', border: '1.5px solid var(--bg-panel)' }} />
        )}
      </button>

      {open && (
        <div role="dialog" aria-label={`${info?.label ?? ''} 옵션`} className="mopt">
          <div className="mopt-head"><span>{info?.label.replace('Claude ', '')} 옵션</span></div>
          <section>
            <label className="mopt-row">
              <span>
                <span className="mopt-label">생각 요약 보기</span>
                <span className="mopt-desc">답변이 나오기 전까지 모델이 무엇을 생각하는지 요약해서 보여줍니다.</span>
              </span>
              <input type="checkbox" className="mopt-switch" checked={options.showThinking}
                onChange={(e) => onChange({ ...options, showThinking: e.target.checked })} />
            </label>
          </section>
        </div>
      )}
    </div>
  )
}

/** 메모리 도구가 저장한 기억(/memories/…)을 보고 고치고 지운다. */
export function MemoryManager({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<MemoryFiles | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState('')
  useEscapeKey(onClose, true)
  useEffect(() => { loadMemory().then((f) => { setFiles(f); const first = Object.keys(f).sort()[0]; if (first) { setSel(first); setDraft(f[first]) } }) }, [])
  const pick = (k: string) => { setSel(k); setDraft(files?.[k] ?? ''); setMsg('') }
  const save = async () => {
    if (!files || !sel) return
    const next = { ...files, [sel]: draft }
    await saveMemory(next); setFiles(next); setMsg('저장했습니다')
  }
  const remove = async () => {
    if (!files || !sel) return
    const next = { ...files }; delete next[sel]
    await saveMemory(next); setFiles(next)
    const first = Object.keys(next).sort()[0] ?? null
    setSel(first); setDraft(first ? next[first] : ''); setMsg('지웠습니다')
  }
  return (
    <div role="dialog" aria-modal="true" aria-label="기억 관리" className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)', padding: 16 }} onClick={onClose}>
      <div className="mopt" style={{ position: 'static', width: 'min(640px, 100%)', maxHeight: 'min(80dvh, 640px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="mopt-head">
          <span>기억 관리</span>
          <button className="mopt-reset" onClick={onClose}>닫기</button>
        </div>
        <p className="mopt-desc" style={{ margin: 0 }}>Claude가 기억해 둔 내용입니다. 잘못 기억한 건 고치거나 지우세요. 드라이브에 연결돼 있으면 다른 기기와 함께 씁니다.</p>
        {files === null ? <p className="mopt-desc">불러오는 중…</p> : Object.keys(files).length === 0 ? (
          <p className="mopt-desc">아직 기억한 내용이 없습니다. 대화에서 "나는 Vue 3와 다크모드를 선호해, 기억해 줘"처럼 말해 보세요.</p>
        ) : (
          <>
            <div className="mopt-seg" role="tablist" aria-label="기억 파일">
              {Object.keys(files).sort().map((k) => (
                <button key={k} role="tab" aria-selected={k === sel} aria-checked={k === sel} onClick={() => pick(k)}>{k.replace('/memories/', '')}</button>
              ))}
            </div>
            <textarea aria-label="기억 내용" value={draft} onChange={(e) => setDraft(e.target.value)} rows={10}
              style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-panel)', color: 'var(--txt)', fontSize: 'var(--fs-sm)', fontFamily: 'ui-monospace, monospace', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className="sidebar-new" onClick={save}>저장</button>
              <button className="mopt-reset" onClick={remove}>이 파일 지우기</button>
              <span className="mopt-desc" role="status" style={{ margin: 0 }}>{msg}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
