import { useRef, useState } from 'react'
import { GitFork, Loader2, X, ExternalLink, KeyRound } from '../icons'
import { createRepoWithFiles, updateRepoWithFiles } from '../services/github'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDialogFocus } from '../hooks/useDialogFocus'

/**
 * ExportModal 컴포넌트: GitHub 프로젝트 내보내기
 * 
 * 기능:
 * - GitHub 토큰 입력/저장
 * - 저장소 이름 입력
 * - 신규 저장소 생성 또는 기존 저장소 업데이트
 * - 배포 진행률 표시
 * - 생성/업데이트 완료 후 GitHub URL로 이동
 */
interface Props {
  files: Record<string, string>
  githubRepo?: { owner: string; repo: string; branch: string } | null
  onClose: () => void
  onSuccess: (owner: string, repo: string, branch: string, token: string) => void
}

export default function ExportModal({ files, githubRepo: githubRepoProp, onClose, onSuccess }: Props) {
  useEscapeKey(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  // 현재 대화에 연결된 저장소만 쓴다. 없으면 새 저장소를 만든다.
  const resolvedRepo = githubRepoProp ?? null
  const [useExisting, setUseExisting] = useState(!!resolvedRepo)
  const githubRepo = useExisting ? resolvedRepo : null
  const [token, setToken] = useState(() => localStorage.getItem('vibe_gh_token') || '')
  // When an existing repo is detected, pre-fill its name to avoid accidental new-name collision
  const [repoName, setRepoName] = useState(() =>
    resolvedRepo ? resolvedRepo.repo : 'vibe-app-' + Date.now().toString(36)
  )
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')
  const canExport = !!token.trim() && (githubRepo ? true : !!repoName.trim())
  const backdropPressRef = useRef(false)

  const handleExport = async () => {
    if (!canExport || status === 'loading') return
    setStatus('loading')
    setError('')
    try {
      const cleanToken = token.trim()
      localStorage.setItem('vibe_gh_token', cleanToken)
      if (githubRepo) {
        const { owner, repo, branch } = await updateRepoWithFiles(
          cleanToken,
          githubRepo.owner,
          githubRepo.repo,
          githubRepo.branch,
          files,
        )
        onSuccess(owner, repo, branch, cleanToken)
      } else {
        const { owner, repo, branch } = await createRepoWithFiles(cleanToken, repoName.trim(), files)
        onSuccess(owner, repo, branch, cleanToken)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류')
      setStatus('error')
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
        aria-label="GitHub 로 내보내기"
        className="w-full max-w-96 shadow-2xl flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 24 }}
        onMouseDown={() => { backdropPressRef.current = false }}
      >
        {/* Header */}
        <div className="flex items-center justify-between" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border-s)' }}>
          <div className="flex items-center gap-2">
            <GitFork style={{ width: 14, height: 14, color: 'var(--accent)' }} />
            <span style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>GitHub 로 내보내기</span>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="icon-btn"
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Token */}
        <div className="flex flex-col gap-1.5">
          <label style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            GitHub 개인 액세스 토큰
          </label>
          <div className="flex items-center gap-2 px-3 py-2"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <KeyRound style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--txt-3)' }} />
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx"
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

        {/* Repo target */}
        {resolvedRepo ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>대상 저장소</label>
              <button
                onClick={() => setUseExisting(v => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--txt-3)' }}
              >
                {useExisting ? '+ 새 저장소 만들기' : '← 기존 저장소 사용'}
              </button>
            </div>
            {useExisting ? (
              <div
                className="flex items-center gap-2 px-3 py-2"
                style={{ background: 'var(--bg)', border: '1px solid var(--ok-bd)', color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
              >
                <GitFork style={{ width: 11, height: 11, color: 'var(--ok)', flexShrink: 0 }} />
                <span>{resolvedRepo.owner}/{resolvedRepo.repo}</span>
                <span style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-sm)' }}>({resolvedRepo.branch})</span>
              </div>
            ) : (
              <input
                type="text"
                value={repoName}
                onChange={e => setRepoName(e.target.value.replace(/[^a-zA-Z0-9._-]/g, '-'))}
                className="px-3 py-2 outline-none"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent-bd)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>저장소 이름</label>
            <input
              type="text"
              value={repoName}
              onChange={e => setRepoName(e.target.value.replace(/[^a-zA-Z0-9._-]/g, '-'))}
              className="px-3 py-2 outline-none"
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent-bd)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>
        )}

        {/* File count */}
        <div className="px-3 py-2" style={{ background: 'var(--bg)', color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
          {Object.keys(files).length} files: {Object.keys(files).join(', ')}
        </div>

        {error && (
          <p className="px-3 py-2" style={{ color: 'var(--err)', background: 'var(--err-bg)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            {error}
          </p>
        )}

        <button
          onClick={handleExport}
          disabled={!canExport || status === 'loading'}
          className="flex items-center justify-center gap-2 transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', height: 36, fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', border: 'none', cursor: 'pointer' }}
        >
          {status === 'loading' ? (
            <><Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> {githubRepo ? '저장소 업데이트 중...' : '저장소 만드는 중...'}</>
          ) : (
            <><GitFork style={{ width: 14, height: 14 }} /> {githubRepo ? `${resolvedRepo?.owner}/${resolvedRepo?.repo} 에 푸시` : '저장소 만들고 내보내기'}</>
          )}
        </button>
      </div>
    </div>
  )
}
