import { useRef, useState } from 'react'
import { FolderGit2, Loader2, X, KeyRound, ExternalLink } from '../icons'
import { fetchRepoFiles, detectProjectType } from '../services/github'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDialogFocus } from '../hooks/useDialogFocus'

/**
 * ImportModal 컴포넌트: GitHub 프로젝트 가져오기
 * 
 * 기능:
 * - GitHub 토큰 입력/저장
 * - 저장소 주소 입력 (owner/repo 형식)
 * - 선택 사항: 브랜치명 입력 (기본값: main)
 * - 저장소 파일 가져오기
 * - 프로젝트 타입 자동 감지 (HTML/React/Vue)
 * - 가져온 파일들을 메인 에디터로 로드
 */
interface Props {
  onClose: () => void
  onSuccess: (files: Record<string, string>, projectType: 'html' | 'react' | 'vue', owner: string, repo: string, branch: string) => void
}

export default function ImportModal({ onClose, onSuccess }: Props) {
  useEscapeKey(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState(() => localStorage.getItem('vibe_gh_token') || '')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  const backdropPressRef = useRef(false)

  const handleImport = async () => {
    if (!url.trim()) return
    setStatus('loading')
    setError('')
    setProgress('저장소 정보 가져오는 중...')
    try {
      if (token.trim()) localStorage.setItem('vibe_gh_token', token.trim())
      const { files, owner, repo, branch } = await fetchRepoFiles(url.trim(), token.trim() || undefined)
      setProgress(`${Object.keys(files).length}개 파일 로드 완료!`)
      const projectType = detectProjectType(files)
      onSuccess(files, projectType, owner, repo, branch)
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류')
      setStatus('error')
      setProgress('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(20,20,19,0.4)', backdropFilter: 'blur(4px)' }}
      onMouseDown={e => { backdropPressRef.current = e.target === e.currentTarget }}
      onMouseUp={e => {
        if (backdropPressRef.current && e.target === e.currentTarget) onClose()
        backdropPressRef.current = false
      }}
      onMouseLeave={() => { backdropPressRef.current = false }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="GitHub 에서 가져오기"
        className="w-full max-w-[420px] shadow-2xl flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 24 }}
        onMouseDown={() => { backdropPressRef.current = false }}
      >
        {/* Header */}
        <div className="flex items-center justify-between" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border-s)' }}>
          <div className="flex items-center gap-2">
            <FolderGit2 style={{ width: 14, height: 14, color: 'var(--accent)' }} />
            <span style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>
              GitHub 에서 가져오기
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="icon-btn"
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* URL */}
        <div className="flex flex-col gap-1.5">
          <label style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            GitHub 저장소 주소
          </label>
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleImport()}
            placeholder="https://github.com/owner/repo"
            className="px-3 py-2 outline-none"
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--accent-bd)',
              color: 'var(--txt)',
              caretColor: 'var(--accent)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--accent-bd)')}
          />
          <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            브랜치 지정: .../tree/branch-name
          </p>
        </div>

        {/* Token (optional) */}
        <div className="flex flex-col gap-1.5">
          <label style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            GitHub 토큰 (비공개 저장소나 요청 한도 초과 방지용, 선택)
          </label>
          <div className="flex items-center gap-2 px-3 py-2"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <KeyRound style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--txt-3)' }} />
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx (선택)"
              className="flex-1 bg-transparent outline-none"
              style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
            />
          </div>
          <a
            href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=VibeCoding"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1"
            style={{ color: 'var(--accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
          >
            <ExternalLink style={{ width: 10, height: 10 }} /> repo · workflow 권한으로 토큰 만들기
          </a>
        </div>

        {/* Progress / Error */}
        {progress && status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-2"
            style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent-bd)', color: 'var(--accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
            {progress}
          </div>
        )}
        {error && (
          <p className="px-3 py-2 whitespace-pre-wrap"
            style={{ color: 'var(--err)', background: 'var(--err-bg)', border: '1px solid var(--err-bd)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            {error}
          </p>
        )}

        {/* Button */}
        <button
          onClick={handleImport}
          disabled={!url.trim() || status === 'loading'}
          className="flex items-center justify-center gap-2 transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', height: 36, fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', border: 'none', cursor: 'pointer' }}
        >
          {status === 'loading' ? (
            <><Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> 불러오는 중...</>
          ) : (
            <><FolderGit2 style={{ width: 14, height: 14 }} /> 불러오기</>
          )}
        </button>
      </div>
    </div>
  )
}
