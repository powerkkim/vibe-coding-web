import { useRef, useState } from 'react'
import { ChevronDown, KeyRound, X, PanelLeft, Moon, Sun, SquarePen } from '../icons'
import logo from '../logo.png'
import { MODELS } from '../services/ai'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDialogFocus } from '../hooks/useDialogFocus'

interface Props {
  apiKey: string
  model: string
  onApiKeyChange: (key: string) => void
  onModelChange: (model: string) => void
  isEnvKey: boolean
  isMobile?: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  // 새 대화 시작. 페이지를 새로고침하지 않고 화면 상태만 비운다. 생성 중(busy)에는 막는다.
  onNewChat: () => void
  busy: boolean
}

const ENV_VAR = 'VITE_ANTHROPIC_API_KEY'

/**
 * Header 컴포넌트: 대화 칸 위 머리줄
 * - 왼쪽: Claude 모델 선택
 * - 오른쪽: API 키 설정 모달, 테마 전환, 새 대화
 * - 모바일/데스크톱 반응형 레이아웃
 */
export default function Header({ apiKey, model, onApiKeyChange, onModelChange, isEnvKey, isMobile, sidebarOpen, onToggleSidebar, theme, onToggleTheme, onNewChat, busy }: Props) {
  const [showModal, setShowModal] = useState(false)  // API 키 설정 모달 표시 여부
  const [draft, setDraft] = useState('')  // 임시 입력 값 (저장 전)
  useEscapeKey(() => setShowModal(false), showModal)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, showModal)

  // 모달 열기: 현재 API 키를 draft에 복사하고 모달 표시
  const open = () => { setDraft(apiKey); setShowModal(true) }

  // API 키 저장: draft 값을 부모 컴포넌트로 전송하고 모달 닫기
  const save = () => {
    onApiKeyChange(draft.trim())
    setShowModal(false)
  }

  const hasActiveKey = !!apiKey

  return (
    <>
      {/* 대화 칸 위 48px 한 줄. 왼쪽은 모델 선택, 오른쪽은 설정·새 대화. 모바일에서는 로고를 숨긴다. */}
      <header className="flex items-center justify-between flex-shrink-0 select-none gap-2 w-0 min-w-full"
        style={{ height: 48, padding: '0 8px', background: 'var(--bg-panel)' }}>
        <div className="flex items-center gap-1 min-w-0">
        {/* 펼쳐져 있을 때는 사이드바 안의 접기 버튼을 쓴다. */}
        {isMobile && !sidebarOpen && (
          <button onClick={onToggleSidebar} className="icon-btn" aria-label="대화 목록 펼치기" aria-expanded={false}>
            <PanelLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
          {!isMobile && <img src={logo} alt="Vibe Coding" width={28} height={28} style={{ marginLeft: 8 }} />}
          <div className="relative flex items-center min-w-0">
            <select
              value={model}
              onChange={e => onModelChange(e.target.value)}
              aria-label="모델 선택"
              className="appearance-none cursor-pointer transition-colors"
              style={{
                height: 40,
                padding: '0 28px 0 8px',
                fontSize: 'var(--fs-lg)',
                color: 'var(--txt-2)',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                maxWidth: '100%',
                textOverflow: 'ellipsis',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label.replace('Claude ', '')}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: 'var(--txt-3)' }} />
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={open}
            className="flex items-center gap-1.5 transition-colors"
            title={isEnvKey ? '.env.local에서 로드됨' : 'API 키 설정'}
            aria-label={hasActiveKey ? 'API 키' : 'API 키 필요'}
            style={{
              height: 32,
              padding: '0 12px',
              fontSize: 'var(--fs-sm)',
              color: 'var(--txt-2)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 999,
              cursor: 'pointer',
            }}
          >
            {/* 상태는 색 점과 문구를 함께 써서 색만으로 전달하지 않는다. */}
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: hasActiveKey ? 'var(--ok)' : 'var(--err)' }} />
            {isMobile
              ? <KeyRound style={{ width: 15, height: 15 }} aria-hidden="true" />
              : <span>{hasActiveKey ? 'API 키' : 'API 키 필요'}</span>}
          </button>

          <button onClick={onToggleTheme} className="icon-btn"
            aria-label={theme === 'dark' ? '라이트 테마로 전환' : '먹 테마로 전환'}>
            {theme === 'dark' ? <Sun style={{ width: 17, height: 17 }} /> : <Moon style={{ width: 17, height: 17 }} />}
          </button>

          <button onClick={onNewChat} disabled={busy} className="icon-btn"
            aria-label={busy ? '생성 중에는 새 대화를 시작할 수 없습니다' : '새 대화'}>
            <SquarePen style={{ width: 17, height: 17 }} />
          </button>
        </div>
      </header>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(20,20,19,0.4)', backdropFilter: 'blur(4px)' }}
          onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="API 키 설정"
            className="w-full max-w-md shadow-2xl overflow-hidden"
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
            {/* Modal title bar */}
            <div className="flex items-center justify-between px-5 py-3"
              style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-2">
                <KeyRound className="w-3.5 h-3.5" style={{ color: 'var(--txt-3)' }} />
                <span style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>
                  API 키 설정
                </span>
              </div>
              <button onClick={() => setShowModal(false)}
                aria-label="닫기"
                className="icon-btn">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
                  방법 1 (권장) — .env.local 파일에 저장
                </p>
                <div className="px-3 py-2.5" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--ok)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)' }}>
                  {ENV_VAR}=sk-ant-...
                </div>
              </div>
              <div>
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
                  방법 2 — 직접 입력 (브라우저에 저장, 대화 저장 시 서버로 전송)
                </p>
                <div>
                  <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                      Anthropic
                    </span>
                    {isEnvKey && (
                      <span style={{ color: 'var(--ok)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)' }}>
                        .env.local 로드됨
                      </span>
                    )}
                  </div>
                  <input type="password" value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && save()}
                    placeholder="sk-ant-..."
                    className="w-full px-3 py-2.5 transition-colors"
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--accent-bd)',
                      color: 'var(--txt)',
                      caretColor: 'var(--accent)',
                      fontFamily: 'var(--ui-font)',
                      fontSize: 'var(--fs-md)',
                    }}
                  />
                  <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', marginTop: 6 }}>
                    대화를 저장·불러올 때 이 키가 이 사이트의 저장 서버로 전송됩니다. 서버는 키가 유효한지만 확인하고 키를 저장하지 않습니다.
                  </p>
                </div>
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <button onClick={() => setShowModal(false)}
                  className="px-4 py-2 transition-colors"
                  style={{ background: 'var(--bg-card)', color: 'var(--txt-2)', border: '1px solid var(--border)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-card)')}>
                  취소
                </button>
                <button onClick={save}
                  className="px-4 py-2 font-medium transition-colors"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-h)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
                  저장
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
