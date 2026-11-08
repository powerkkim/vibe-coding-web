import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from '../icons'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { DEFAULT_MODEL_OPTIONS, EFFORTS, MAX_TOKEN_CHOICES, MODELS } from '../services/ai'
import type { ModelOptions } from '../services/ai'
import { loadMemory, saveMemory } from '../services/memoryStore'
import type { MemoryFiles } from '../services/memoryStore'

/**
 * 모델 선택 옆 옵션 버튼과 팝오버.
 * 노력 수준(effort) · 빠른 모드 · 최대 출력 · 생각 요약 보기를 모델별로 정한다.
 * 기본값과 다른 옵션이 있으면 버튼에 점을 찍어 알려준다.
 */
interface Props {
  model: string
  options: ModelOptions
  onChange: (options: ModelOptions) => void
  disabled?: boolean
}

const fmtTokens = (n: number) => `${Math.round(n / 1000)}K`

export function isCustomized(o: ModelOptions): boolean {
  const d = DEFAULT_MODEL_OPTIONS
  return !!o.effort || o.fast || o.maxTokens !== d.maxTokens || o.showThinking || !!o.advisorModel
    || o.webSearch !== d.webSearch || o.webFetch !== d.webFetch || o.codeExecution !== d.codeExecution || o.memory !== d.memory || o.textEditor !== d.textEditor
}

export default function ModelOptionsMenu({ model, options, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
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
  const set = (patch: Partial<ModelOptions>) => onChange({ ...options, ...patch })
  const defaultLabel = EFFORTS.find((e) => e.id === info?.defaultEffort)?.label ?? ''
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
          <div className="mopt-head">
            <span>{info?.label.replace('Claude ', '')} 옵션</span>
            {customized && <button className="mopt-reset" onClick={() => onChange(DEFAULT_MODEL_OPTIONS)}>기본값으로</button>}
          </div>

          <section>
            <h3 className="mopt-label">노력 수준</h3>
            <p className="mopt-desc">높을수록 더 깊게 생각해서 품질이 좋아지지만 느리고 토큰을 더 씁니다.</p>
            <div className="mopt-seg" role="radiogroup" aria-label="노력 수준">
              <button role="radio" aria-checked={!options.effort} onClick={() => set({ effort: undefined })}>
                기본<small>{defaultLabel}</small>
              </button>
              {EFFORTS.map((e) => (
                <button key={e.id} role="radio" aria-checked={options.effort === e.id} onClick={() => set({ effort: e.id })}>
                  {e.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <label className="mopt-row">
              <span>
                <span className="mopt-label">빠른 모드</span>
                <span className="mopt-desc">
                  {info?.fast
                    ? `출력 속도가 빨라지는 대신 단가가 2배입니다 (입력 $${info.fast.inputPerMTok} / 출력 $${info.fast.outputPerMTok}, 100만 토큰당).`
                    : '이 모델은 빠른 모드를 지원하지 않습니다 (Opus 5.5 전용).'}
                </span>
              </span>
              <input type="checkbox" className="mopt-switch" checked={!!info?.fast && options.fast} disabled={!info?.fast}
                onChange={(e) => set({ fast: e.target.checked })} />
            </label>
          </section>

          <section>
            <h3 className="mopt-label">도구</h3>
            <p className="mopt-desc">켠 도구만 요청에 실립니다. 꺼 두면 그 도구 설명 토큰도 들지 않아요.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {TOOL_ROWS.map((t) => (
                <label key={t.key} className="mopt-row">
                  <span>
                    <span className="mopt-label" style={{ fontWeight: 500 }}>{t.label}</span>
                    <span className="mopt-desc">{t.desc}</span>
                  </span>
                  <input type="checkbox" className="mopt-switch" checked={options[t.key]}
                    onChange={(e) => set({ [t.key]: e.target.checked } as Partial<ModelOptions>)} />
                </label>
              ))}
              {options.memory && (
                <button className="mopt-reset" style={{ alignSelf: 'flex-start' }} onClick={() => { setOpen(false); setMemoryOpen(true) }}>기억 보기·편집</button>
              )}
              <div>
                <span className="mopt-label" style={{ fontWeight: 500 }}>어드바이저 (베타)</span>
                <span className="mopt-desc">어려운 설계 판단만 상위 모델에 물어봅니다. 조언은 그 모델 단가로 과금(한 턴 최대 3회).</span>
                {info?.advisors?.length ? (
                  <div className="mopt-seg" role="radiogroup" aria-label="어드바이저 모델">
                    <button role="radio" aria-checked={!options.advisorModel} onClick={() => set({ advisorModel: undefined })}>끔</button>
                    {info.advisors.map((id) => (
                      <button key={id} role="radio" aria-checked={options.advisorModel === id} onClick={() => set({ advisorModel: id })}>
                        {MODELS.find((m) => m.id === id)?.label.replace('Claude ', '') ?? id}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="mopt-desc">이 모델보다 상위 모델이 목록에 없어 쓸 수 없습니다.</span>
                )}
              </div>
            </div>
          </section>

          <section>
            <label className="mopt-row">
              <span>
                <span className="mopt-label">생각 요약 보기</span>
                <span className="mopt-desc">답변이 나오기 전까지 모델이 무엇을 생각하는지 요약해서 보여줍니다.</span>
              </span>
              <input type="checkbox" className="mopt-switch" checked={options.showThinking}
                onChange={(e) => set({ showThinking: e.target.checked })} />
            </label>
          </section>

          <section>
            <h3 className="mopt-label">최대 출력</h3>
            <p className="mopt-desc">생각과 답변을 합친 한도입니다. 큰 프로젝트가 중간에 끊기면 늘리세요.</p>
            <div className="mopt-seg" role="radiogroup" aria-label="최대 출력 토큰">
              {MAX_TOKEN_CHOICES.map((n) => (
                <button key={n} role="radio" aria-checked={options.maxTokens === n} onClick={() => set({ maxTokens: n })}>
                  {fmtTokens(n)}
                </button>
              ))}
            </div>
          </section>

          <p className="mopt-desc" style={{ margin: 0 }}>
            대화 도중 노력 수준·빠른 모드·도구·생각 요약을 바꾸면 대화 이력 캐시가 초기화되어, 바로 다음 요청의 입력 비용이 한 번 늘어납니다.
          </p>
        </div>
      )}
      {memoryOpen && <MemoryManager onClose={() => setMemoryOpen(false)} />}
    </div>
  )
}

type ToolKey = 'webSearch' | 'webFetch' | 'codeExecution' | 'memory' | 'textEditor'
const TOOL_ROWS: { key: ToolKey; label: string; desc: string }[] = [
  { key: 'webSearch', label: '웹 검색', desc: '최신 라이브러리·문서·데이터가 필요할 때 검색하고 출처를 보여줍니다. 1회 $0.01 + 결과 토큰 (한 턴 최대 5회).' },
  { key: 'webFetch', label: '웹 페치', desc: '대화에 넣은 URL(문서·참고 사이트·PDF)을 읽어 반영합니다. 추가 요금 없이 읽은 내용의 토큰만 (페이지당 최대 3만 토큰).' },
  { key: 'textEditor', label: '부분 수정 (텍스트 에디터)', desc: '수정 요청 때 파일 전체를 다시 쓰지 않고 바뀐 부분만 고칩니다. 출력 토큰이 크게 줄어 수정이 많을수록 이득 (요청마다 도구 설명 약 1천 토큰).' },
  { key: 'memory', label: '메모리', desc: '취향·규칙(스택, 디자인 등)을 기억해 다음 대화에도 반영합니다. 드라이브(연결 시)에 저장. 매 턴 기억 확인 왕복이 1번 늘어납니다.' },
  { key: 'codeExecution', label: '코드 실행', desc: '샌드박스에서 Python·Bash 로 데이터 분석·계산·검증을 하고 결과 파일을 받을 수 있습니다. 월 1,550시간 무료, 이후 시간당 $0.05.' },
]

/** 메모리 도구가 저장한 기억(/memories/…)을 보고 고치고 지운다. */
function MemoryManager({ onClose }: { onClose: () => void }) {
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
        <p className="mopt-desc" style={{ margin: 0 }}>Claude가 메모리 도구로 저장한 내용입니다. 잘못 기억한 건 고치거나 지우세요. 드라이브에 연결돼 있으면 다른 기기와 함께 씁니다.</p>
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
