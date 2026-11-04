import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from '../icons'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { DEFAULT_MODEL_OPTIONS, EFFORTS, MAX_TOKEN_CHOICES, MODELS } from '../services/ai'
import type { ModelOptions } from '../services/ai'

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
  return !!o.effort || o.fast || o.maxTokens !== DEFAULT_MODEL_OPTIONS.maxTokens || o.showThinking
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
        </div>
      )}
    </div>
  )
}
