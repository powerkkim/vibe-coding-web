import { useState, useRef, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Eye, Code2, Copy, Check, ExternalLink, FileCode2, RefreshCw, FileText, FileJson, Palette, GitFork, FolderGit2, KeyRound, History, Download, X, Ellipsis, ChevronLeft, ChevronRight } from '../icons'
import JSZip from 'jszip'
import ExportModal from './ExportModal'
import ImportModal from './ImportModal'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { fetchDeploymentUrl, deployToGitHubPages } from '../services/github'
import type { GithubRepo } from '../services/chatStore'
import { highlightCode } from '../services/highlight'
import { PREVIEW_SANDBOX, withStorageShim, openSandboxedTab } from '../services/previewSandbox'

/**
 * PreviewPanel 컴포넌트: 우측 코드/미리보기 패널
 * 
 * 주요 기능:
 * - 두 개 탭: Preview (미리보기), Code (코드 보기)
 * - HTML: 로컬 blob URL로 즉시 렌더링
 * - React/Vue: GitHub Pages 배포 후 배포 URL로 렌더링
 * - 파일 트리 뷰 (좌측, 너비 조정 가능)
 * - 코드 하이라이팅 및 복사 기능
 * - GitHub 프로젝트 import/export
 * - GitHub Pages 자동 배포 및 배포 히스토리
 */
interface Props {
  files: Record<string, string>
  projectType: 'html' | 'react' | 'vue'
  isLoading: boolean
  onImport: (files: Record<string, string>, projectType: 'html' | 'react' | 'vue') => void
  onFilesChange: (files: Record<string, string>) => void
  // 현재 대화에 연결된 저장소. 대화별로 App 이 저장하고, import·export 성공 시 onGithubRepoChange 로 바꾼다.
  githubRepo: GithubRepo | null
  onGithubRepoChange: (repo: GithubRepo) => void
  // seq 가 바뀔 때마다 tab 으로 전환한다. 같은 탭을 다시 요청해도 반영되도록 seq 를 둔다.
  focus: { tab: PanelTab; seq: number }
  // 캔버스 닫기(✕). 닫으면 App 이 대화를 화면 가운데로 돌린다.
  onClose: () => void
  // 파일 사본 버전 중 지금 띄운 위치(0부터)와 전체 수. 위치를 바꾸면 App 이 확인 후 그 버전으로 되돌린다.
  version: { pos: number; total: number }
  onVersionChange: (pos: number) => void
  // '파일' 탭: 이 대화의 결과물·첨부·실행 결과 파일 모음(ChatFiles)
  filesTab: ReactNode
  filesCount: number
}

export type PanelTab = 'preview' | 'code' | 'files'

type DeploymentHistoryItem = { owner: string; repo: string; branch: string; url: string; deployedAt: number }

type Tab = PanelTab

const DEPLOY_HISTORY_KEY = 'vibe_deploy_history'

function loadDeployHistory(): DeploymentHistoryItem[] {
  try {
    const raw = localStorage.getItem(DEPLOY_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as DeploymentHistoryItem[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => !!item && !!item.url && !!item.owner && !!item.repo)
      .sort((a, b) => b.deployedAt - a.deployedAt)
      .slice(0, 30)
  } catch {
    return []
  }
}

function saveDeployHistory(items: DeploymentHistoryItem[]): void {
  localStorage.setItem(DEPLOY_HISTORY_KEY, JSON.stringify(items.slice(0, 30)))
}

function upsertDeployHistory(items: DeploymentHistoryItem[], next: DeploymentHistoryItem): DeploymentHistoryItem[] {
  const filtered = items.filter((i) => !(i.owner === next.owner && i.repo === next.repo && i.url === next.url))
  return [next, ...filtered].sort((a, b) => b.deployedAt - a.deployedAt).slice(0, 30)
}

/** Inline CSS/JS into a single self-contained HTML for HTML projects */
// Bundle CSS and JS files into HTML for static HTML projects
function bundleFiles(files: Record<string, string>): string {
  let html = files['index.html'] || ''

  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+\.css)["'][^>]*\/?>/gi, (_m: string, href: string) => {
    const css = files[href.replace(/^\.\//, '')]
    return css ? `<style>\n${css}\n</style>` : _m
  })
  html = html.replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]+rel=["']stylesheet["'][^>]*\/?>/gi, (_m: string, href: string) => {
    const css = files[href.replace(/^\.\//, '')]
    return css ? `<style>\n${css}\n</style>` : _m
  })
  html = html.replace(/<script([^>]*)src=["']([^"']+\.(js|mjs))["']([^>]*)><\/script>/gi, (_m: string, pre: string, src: string, _ext: string, post: string) => {
    const js = files[src.replace(/^\.\//, '')]
    return js ? `<script${pre}${post}>\n${js}\n</script>` : _m
  })

  // bare module specifier가 있는 경우 importmap으로 CDN 주소 매핑 (브라우저 호환)
  const hasBareImport = /import\s+.*from\s+['"](?!https?:\/\/|\/|\.\/|\.\.\/)/.test(html)
  if (hasBareImport && !html.includes('<script type="importmap"')) {
    const importMap = JSON.stringify({
      imports: {
        'vue': 'https://unpkg.com/vue@3/dist/vue.esm-browser.js',
        'react': 'https://esm.sh/react@18',
        'react-dom': 'https://esm.sh/react-dom@18',
        'react-dom/client': 'https://esm.sh/react-dom@18/client',
        'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime',
      }
    }, null, 2)
    html = html.replace('<head>', `<head>\n  <script type="importmap">\n  ${importMap}\n  </script>`)
  }

  return html
}

function fileIcon(name: string) {
  if (name.endsWith('.css')) return <Palette style={{ width: 12, height: 12, color: '#60a5fa' }} className="shrink-0" />
  if (name.endsWith('.json')) return <FileJson style={{ width: 12, height: 12, color: '#fbbf24' }} className="shrink-0" />
  if (name.endsWith('.vue')) return <FileCode2 style={{ width: 12, height: 12, color: '#42d392' }} className="shrink-0" />
  if (name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.jsx') || name.endsWith('.tsx'))
    return <FileText style={{ width: 12, height: 12, color: '#f59e0b' }} className="shrink-0" />
  return <FileCode2 style={{ width: 12, height: 12, color: 'var(--ok)' }} className="shrink-0" />
}

function PixelMiniBar() {
  return (
    <span className="inline-flex gap-1 ml-1" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <span
          key={i}
          className="pixel-loader-cell"
          style={{ width: 4, height: 4, animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  )
}

function PixelLoadingBar({
  size = 'md',
  label,
  subLabel,
}: {
  size?: 'sm' | 'md' | 'lg'
  label?: string
  subLabel?: string
}) {
  const cells = 3
  const cellSize = size === 'sm' ? 5 : size === 'lg' ? 9 : 7
  return (
    <div className="flex flex-col items-center gap-2">
      {label && (
        <p style={{ color: 'var(--txt)', fontFamily: 'var(--display-font)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>
          {label}
        </p>
      )}
      <div className="flex items-center gap-1.5 px-2 py-1">
        {Array.from({ length: cells }).map((_, i) => (
          <span
            key={i}
            className="pixel-loader-cell"
            style={{
              width: cellSize,
              height: cellSize,
              animationDelay: `${i * 160}ms`,
            }}
          />
        ))}
      </div>
      {subLabel && (
        <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
          {subLabel}
        </p>
      )}
    </div>
  )
}

export default function PreviewPanel({ files, projectType, isLoading, onImport, onFilesChange, githubRepo, onGithubRepoChange, focus, onClose, version, onVersionChange, filesTab, filesCount }: Props) {
  const [tab, setTab] = useState<Tab>('preview')
  // ⋯ 메뉴(다운로드·가져오기·배포 URL·배포 기록). 바깥 클릭과 Esc 로 닫는다.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  useEscapeKey(() => setMenuOpen(false), menuOpen)
  useEffect(() => {
    if (!menuOpen) return
    // 메뉴 버튼을 누른 것은 버튼의 onClick 이 토글하므로 바깥 클릭으로 치지 않는다.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  useEffect(() => {
    if (focus.seq > 0) setTab(focus.tab)
  }, [focus])
  const [selectedFile, setSelectedFile] = useState('index.html')
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const isImportRef = useRef(false)
  const isEditRef = useRef(false)
  const [showExport, setShowExport] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [deployUrl, setDeployUrl] = useState<string | null>(null)
  const [deployStatus, setDeployStatus] = useState('')
  const [deployError, setDeployError] = useState('')
  const [deployStep, setDeployStep] = useState<'idle' | 'checking' | 'deploying' | 'needs-token' | 'deploy-error' | 'deploy-done'>('idle')
  const [deployToken, setDeployToken] = useState(() => localStorage.getItem('vibe_gh_token') || '')
  const [deployUrlCopied, setDeployUrlCopied] = useState(false)
  const [deployHistory, setDeployHistory] = useState<DeploymentHistoryItem[]>(() => loadDeployHistory())
  const deployAbortRef = useRef(false)
  const deployTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // deployStep ref: useEffect가 deployStep 변경에 반응하지 않도록 ref로 읽음
  const deployStepRef = useRef(deployStep)
  useEffect(() => { deployStepRef.current = deployStep }, [deployStep])
  const [fileListWidth, setFileListWidth] = useState(220)
  const [saveLabel, setSaveLabel] = useState<'자동 저장' | '저장됨'>('자동 저장')
  const saveBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codeTabRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(220)

  const fileNames = Object.keys(files).sort((a, b) => {
    const order = ['index.html', 'package.json', 'vite.config.js']
    const ai = order.indexOf(a), bi = order.indexOf(b)
    if (ai >= 0 && bi < 0) return -1
    if (bi >= 0 && ai < 0) return 1
    const ext = (f: string) => f.split('.').pop() || ''
    const extOrder = ['html', 'json', 'js', 'jsx', 'tsx', 'ts', 'css']
    return (extOrder.indexOf(ext(a)) - extOrder.indexOf(ext(b))) || a.localeCompare(b)
  })

  const hasFiles = fileNames.length > 0

  // 파일 이름의 '/' 는 JSZip 이 폴더로 만든다(src/App.jsx → src 폴더).
  const downloadZip = async () => {
    try {
      const zip = new JSZip()
      for (const [name, content] of Object.entries(files)) zip.file(name, content)
      const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'vibe-project.zip'
      a.click()
      // 클릭 직후 바로 해제하면 일부 브라우저(Safari)에서 다운로드가 시작되기 전에 URL 이 사라진다.
      setTimeout(() => URL.revokeObjectURL(url))
    } catch (err) {
      alert(`ZIP 파일을 만들지 못했어요: ${err instanceof Error ? err.message : err}`)
    }
  }

  // HTML 프로젝트는 파일을 하나로 묶어 격리된 iframe(srcDoc)에서 바로 실행한다. 격리 이유는 services/previewSandbox.ts 참고.
  const previewHtml = useMemo(() => {
    if (!hasFiles || !files['index.html'] || projectType === 'react' || projectType === 'vue') return ''
    return withStorageShim(bundleFiles(files))
  }, [files, projectType])

  const previewSrc = previewHtml || deployUrl || ''

  useEffect(() => {
    if (hasFiles) {
      if (isImportRef.current) {
        isImportRef.current = false
        setSelectedFile(fileNames[0] || 'index.html')
        return
      }
      // 새 파일 생성/업데이트 시 deployUrl 리셋 (배포중·완료 상태는 유지)
      // deployStepRef 사용: 이 effect가 deployStep 변경에 재실행되지 않도록
      const step = deployStepRef.current
      if (step !== 'deploying' && step !== 'deploy-done') {
        setDeployUrl(null)
      }
      // 편집기에서 직접 고친 변경이면 보던 파일을 유지한다.
      if (isEditRef.current) isEditRef.current = false
      else setSelectedFile(fileNames[0] || 'index.html')
    }
  }, [files])

  useEffect(() => {
    return () => {
      if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current)
      if (saveBadgeTimerRef.current) clearTimeout(saveBadgeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const containerWidth = codeTabRef.current?.clientWidth || 0
      const minWidth = 140
      const maxWidth = Math.max(minWidth, Math.floor(containerWidth * 0.6))
      const nextWidth = dragStartWidthRef.current + (e.clientX - dragStartXRef.current)
      setFileListWidth(Math.min(maxWidth, Math.max(minWidth, nextWidth)))
    }

    const onMouseUp = () => {
      if (!resizingRef.current) return
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const startResizeFileList = (e: React.MouseEvent<HTMLDivElement>) => {
    resizingRef.current = true
    dragStartXRef.current = e.clientX
    dragStartWidthRef.current = fileListWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const selectedContent = files[selectedFile] || ''
  const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0)
  const selectedLineCount = Math.max(1, selectedContent.split('\n').length)
  const highlightedContent = useMemo(() => highlightCode(selectedContent, selectedFile), [selectedContent, selectedFile])
  const highlightRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const repoDeployHistory = useMemo(() => {
    if (!githubRepo) return []
    return deployHistory.filter((h) => h.owner === githubRepo.owner && h.repo === githubRepo.repo)
  }, [deployHistory, githubRepo])

  const persistDeployment = (owner: string, repo: string, branch: string, url: string) => {
    const next = upsertDeployHistory(deployHistory, {
      owner,
      repo,
      branch,
      url,
      deployedAt: Date.now(),
    })
    setDeployHistory(next)
    saveDeployHistory(next)
  }

  const formatHistoryTime = (ts: number) => {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${mi}`
  }

  const copyFile = async () => {
    await navigator.clipboard.writeText(selectedContent)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  const updateSelectedFileContent = (nextContent: string) => {
    if (!selectedFile) return
    const nextFiles = { ...files, [selectedFile]: nextContent }
    isEditRef.current = true
    onFilesChange(nextFiles)
    setSaveLabel('저장됨')
    if (saveBadgeTimerRef.current) clearTimeout(saveBadgeTimerRef.current)
    saveBadgeTimerRef.current = setTimeout(() => setSaveLabel('자동 저장'), 1500)
  }
  const copyDeployUrl = async () => {
    if (!deployUrl) return
    await navigator.clipboard.writeText(deployUrl)
    setDeployUrlCopied(true)
    setTimeout(() => setDeployUrlCopied(false), 2000)
  }
  const refresh = () => setIframeKey(k => k + 1)
  const openNew = () => {
    // 만든 코드는 새 탭에서도 격리해서 연다. 배포된 주소는 사용자가 직접 여는 실제 사이트라 그대로 연다.
    if (previewHtml) openSandboxedTab({ html: previewHtml })
    else if (deployUrl) window.open(deployUrl, '_blank', 'noopener,noreferrer')
    else if (githubRepo) window.open(`https://github.com/${githubRepo.owner}/${githubRepo.repo}/deployments`, '_blank')
  }

  const handleExportSuccess = async (owner: string, repo: string, branch: string, token: string) => {
    onGithubRepoChange({ owner, repo, branch })
    setDeployUrl(null)
    setDeployError('')
    setDeployStep('idle')
    setShowExport(false)
    setTab('preview')
    setIframeKey(k => k + 1)

    // React/Vue는 push 완료 직후 자동 배포 후 preview에 배포 URL 표시
    if (projectType === 'react' || projectType === 'vue') {
      await startDeploy(owner, repo, branch, token)
    }
  }

  const startDeploy = async (owner: string, repo: string, branch: string, token: string) => {
    localStorage.setItem('vibe_gh_token', token)
    setDeployToken(token)
    setDeployStep('deploying')
    setDeployError('')
    setDeployStatus('')
    deployAbortRef.current = false
    
    // 15분 안전 타임아웃 (배포가 무한 대기하는 것 방지)
    if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current)
    deployTimeoutRef.current = setTimeout(() => {
      if (deployStep === 'deploying') {
        deployAbortRef.current = true
        setDeployError('배포 타임아웃 (15분). 배포 상태를 확인하거나 다시 시도하세요.')
        setDeployStatus('')
        setDeployStep('idle')
      }
    }, 15 * 60 * 1000)
    
    try {
      const url = await deployToGitHubPages(token, owner, repo, branch, setDeployStatus)
      if (!deployAbortRef.current) {
        if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current)
        setDeployUrl(url)
        persistDeployment(owner, repo, branch, url)
        setDeployStatus('')
        setDeployStep('deploy-done')  // 배포 완료 → 미리보기 버튼 표시
      }
    } catch (err) {
      if (!deployAbortRef.current) {
        if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current)
        setDeployError(err instanceof Error ? err.message : '배포 실패')
        setDeployStatus('')
        setDeployStep('deploy-error')
      }
    }
  }
  
  const cancelDeploy = () => {
    deployAbortRef.current = true
    if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current)
    setDeployStep('idle')
    setDeployStatus('')
    setDeployError('배포가 취소되었습니다.')
  }

  const openPreviewFromDeploy = () => {
    // 배포 완료 화면 → iframe 미리보기로 전환
    setDeployStep('idle')
    setTab('preview')
    setIframeKey(k => k + 1)
  }

  const handleImportSuccess = async (importedFiles: Record<string, string>, importedType: 'html' | 'react' | 'vue', owner: string, repo: string, branch: string) => {
    isImportRef.current = true
    setShowImport(false)
    onGithubRepoChange({ owner, repo, branch })
    setDeployUrl(null)
    setDeployError('')
    setDeployStep('idle')
    onImport(importedFiles, importedType)
    setTab('preview')
    setIframeKey(k => k + 1)
    // HTML은 blob으로 바로 표시되므로 배포 URL 불필요
    if (importedType === 'react' || importedType === 'vue') {
      setDeployStep('checking')
      const token = localStorage.getItem('vibe_gh_token') || ''
      const url = await fetchDeploymentUrl(owner, repo, token || undefined)
      if (url) {
        setDeployUrl(url)
        persistDeployment(owner, repo, branch, url)
        setDeployStep('idle')
        setIframeKey(k => k + 1)
      } else if (token) {
        // 자동 배포 시작
        await startDeploy(owner, repo, branch, token)
      } else {
        // 토큰 없음 — 입력 요청
        setDeployStep('needs-token')
      }
    }
  }

  const handleCommitPush = () => {
    setShowExport(true)
  }

  const handleDeploy = async () => {
    if (projectType === 'html') {
      setTab('preview')
      setIframeKey(k => k + 1)
      return
    }

    setTab('preview')

    if (!githubRepo) {
      setDeployError('먼저 commit/push로 GitHub 저장소에 코드를 올려주세요.')
      setDeployStep('deploy-error')
      return
    }

    const token = (deployToken || localStorage.getItem('vibe_gh_token') || '').trim()
    if (!token) {
      setDeployStep('needs-token')
      return
    }

    await startDeploy(githubRepo.owner, githubRepo.repo, githubRepo.branch, token)
  }

  const TabBtn = ({ id, icon: Icon, label }: { id: Tab; icon: React.ElementType; label: string }) => (
    <button onClick={() => setTab(id)}
      role="tab"
      aria-selected={tab === id}
      className="flex items-center gap-1.5 transition-all"
      style={{
        height: 28,
        padding: '0 12px',
        borderRadius: 999,
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-sm)',
        fontWeight: tab === id ? 600 : 400,
        background: tab === id ? 'var(--bg-panel)' : 'transparent',
        boxShadow: tab === id ? '0 1px 2px rgba(20,20,19,0.08)' : 'none',
        border: 'none',
        color: tab === id ? 'var(--txt)' : 'var(--txt-2)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { if (tab !== id) e.currentTarget.style.color = 'var(--txt)' }}
      onMouseLeave={e => { if (tab !== id) e.currentTarget.style.color = 'var(--txt-2)' }}>
      <Icon style={{ width: 12, height: 12 }} />
      <span>{label}</span>
      {id === 'preview' && isLoading && (
        <PixelMiniBar />
      )}
    </button>
  )

  return (
    <div className="relative flex flex-col flex-1 min-w-0" style={{ background: 'var(--bg)', containerType: 'inline-size' }}>
      {/* 캔버스 머리줄: 닫기·탭·보기 도구는 왼쪽, GitHub·게시·⋯ 메뉴는 오른쪽 */}
      <div className="panel-toolbar flex items-center gap-1 flex-shrink-0"
        style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', height: 48, padding: '0 8px' }}>
        <button onClick={onClose} className="icon-btn" aria-label="캔버스 닫기">
          <X style={{ width: 16, height: 16 }} />
        </button>
        <div role="tablist" className="flex items-center gap-0.5"
          style={{ background: 'var(--bg-card)', padding: 3, borderRadius: 999 }}>
          {/* 컴포넌트(<TabBtn />)로 쓰면 렌더마다 새 타입이 되어 버튼이 다시 만들어지고, 스트리밍 중 클릭이 성립하지 않는다. */}
          {TabBtn({ id: 'preview', icon: Eye, label: '미리보기' })}
          {TabBtn({ id: 'code', icon: Code2, label: `코드${hasFiles ? ` ${fileNames.length}` : ''}` })}
          {TabBtn({ id: 'files', icon: FolderGit2, label: `파일${filesCount ? ` ${filesCount}` : ''}` })}
        </div>

        {version.total > 1 && (
          <div className="flex items-center" style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            <button onClick={() => onVersionChange(version.pos - 1)} disabled={isLoading || version.pos <= 0}
              className="icon-btn" aria-label="이전 버전">
              <ChevronLeft style={{ width: 16, height: 16 }} />
            </button>
            <span aria-live="polite" style={{ minWidth: 44, textAlign: 'center' }}>v{version.pos + 1} / {version.total}</span>
            <button onClick={() => onVersionChange(version.pos + 1)} disabled={isLoading || version.pos >= version.total - 1}
              className="icon-btn" aria-label="다음 버전">
              <ChevronRight style={{ width: 16, height: 16 }} />
            </button>
          </div>
        )}

        {previewSrc && tab === 'preview' && (
          <>
            <button onClick={refresh} className="icon-btn" aria-label="미리보기 새로고침">
              <RefreshCw style={{ width: 14, height: 14 }} />
            </button>
            <button onClick={openNew} className="icon-btn" aria-label="새 창에서 열기">
              <ExternalLink style={{ width: 14, height: 14 }} />
            </button>
          </>
        )}

        {hasFiles && tab === 'code' && (
          <button onClick={copyFile}
            className="flex items-center gap-1.5 transition-all"
            style={copied
              ? { color: 'var(--ok)', background: 'var(--ok-bg)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '2px 10px', border: 'none', borderRadius: 999, cursor: 'pointer' }
              : { color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '2px 10px', background: 'none', border: 'none', borderRadius: 999, cursor: 'pointer' }}
            onMouseEnter={e => { if (!copied) { e.currentTarget.style.color = 'var(--txt)'; e.currentTarget.style.background = 'var(--bg-hover)' } }}
            onMouseLeave={e => { if (!copied) { e.currentTarget.style.color = 'var(--txt-2)'; e.currentTarget.style.background = 'transparent' } }}
            title="파일 복사">
            {copied ? <Check style={{ width: 12, height: 12 }} /> : <Copy style={{ width: 12, height: 12 }} />}
            <span>{copied ? '복사됨' : '복사'}</span>
          </button>
        )}

        <div className="flex-1" />

        {isLoading && (
          <div className="flex items-center gap-1.5 mr-2"
            style={{ color: 'var(--accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            <PixelMiniBar />
            생성 중
          </div>
        )}

        {/* GitHub 커밋·푸시. 저장소가 연결돼 있으면 강조해서 보여준다. */}
        {hasFiles && (
          <button onClick={handleCommitPush}
            className="flex items-center gap-1.5 transition-all"
            style={githubRepo
              ? { color: 'var(--accent)', background: 'var(--accent-bg)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '0 12px', height: 32, borderRadius: 999, border: '1px solid var(--accent-bd)', cursor: 'pointer' }
              : { color: 'var(--txt)', background: 'none', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '0 12px', height: 32, borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer' }}
            onMouseEnter={e => { if (!githubRepo) e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={e => { if (!githubRepo) e.currentTarget.style.background = 'none' }}
            title="GitHub 에 커밋·푸시">
            <GitFork style={{ width: 12, height: 12 }} />
            <span>GitHub</span>
          </button>
        )}

        {hasFiles && (projectType === 'react' || projectType === 'vue') && (
          <button
            onClick={handleDeploy}
            disabled={deployStep === 'deploying'}
            className="flex items-center gap-1.5 transition-all disabled:opacity-50"
            style={{
              color: 'var(--on-accent)',
              background: 'var(--accent)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 600,
              padding: '0 14px',
              height: 32,
              borderRadius: 999,
              border: 'none',
              cursor: deployStep === 'deploying' ? 'default' : 'pointer',
            }}
            onMouseEnter={e => { if (deployStep !== 'deploying') e.currentTarget.style.background = 'var(--accent-h)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent)' }}
            title="GitHub Pages 에 게시"
          >
            <ExternalLink style={{ width: 12, height: 12 }} />
            <span>{deployStep === 'deploying' ? '게시 중...' : '게시'}</span>
          </button>
        )}

        <button ref={menuButtonRef} onClick={() => setMenuOpen((o) => !o)} className="icon-btn"
          aria-label="더보기" aria-haspopup="menu" aria-expanded={menuOpen}>
          <Ellipsis style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* ⋯ 메뉴. 모바일에서 머리줄이 가로 스크롤되면 그 안의 메뉴가 잘리므로 머리줄 밖(패널 기준)에 띄운다. */}
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label="더보기"
          style={{ position: 'absolute', right: 8, top: 52, zIndex: 30, minWidth: 240, maxWidth: 'calc(100% - 16px)', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 4 }}>
          {hasFiles && (
            <button role="menuitem" className="panel-menu-item" onClick={() => { setMenuOpen(false); void downloadZip() }}>
              <Download style={{ width: 14, height: 14 }} />ZIP 으로 다운로드
            </button>
          )}
          <button role="menuitem" className="panel-menu-item" onClick={() => { setMenuOpen(false); setShowImport(true) }}>
            <FolderGit2 style={{ width: 14, height: 14 }} />GitHub 에서 가져오기
          </button>
          {deployUrl && (
            <button role="menuitem" className="panel-menu-item" onClick={() => { void copyDeployUrl() }}>
              {deployUrlCopied ? <Check style={{ width: 14, height: 14 }} /> : <Copy style={{ width: 14, height: 14 }} />}
              {deployUrlCopied ? 'URL 복사됨' : '게시 URL 복사'}
            </button>
          )}
          {deployUrl && repoDeployHistory.length > 0 && (
            <label className="panel-menu-item" style={{ cursor: 'default' }}>
              <History style={{ width: 14, height: 14, flexShrink: 0 }} />
              <select
                value={deployUrl}
                onChange={e => { setDeployUrl(e.target.value); setIframeKey(k => k + 1) }}
                className="bg-transparent min-w-0 flex-1"
                style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', height: 28 }}
                aria-label="게시 기록"
              >
                {repoDeployHistory.map((item) => (
                  <option key={`${item.url}_${item.deployedAt}`} value={item.url}>
                    {formatHistoryTime(item.deployedAt)} · {item.url}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 relative overflow-hidden">

        {/* Preview tab */}
        <div className={`absolute inset-0 ${tab === 'preview' ? 'flex' : 'hidden'} flex-col`}>
          {isLoading && !previewSrc ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-7" style={{ background: 'var(--bg)', position: 'relative', overflow: 'hidden' }}>
              <div className="flex flex-col items-center gap-3" role="status">
                <span aria-hidden="true" style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: '2.5px solid var(--accent-bd)',
                  borderTopColor: 'var(--accent)',
                  animation: 'spin 0.9s linear infinite',
                }} />
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--display-font)', fontSize: 'var(--fs-lg)', fontWeight: 600 }}>
                  생성 중
                </p>
                <p style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-sm)' }}>
                  파일과 컴포넌트를 조립하고 있어요
                </p>
              </div>
            </div>
          ) : previewSrc ? (
            <iframe key={iframeKey} ref={iframeRef} sandbox={PREVIEW_SANDBOX}
              {...(previewHtml ? { srcDoc: previewHtml } : { src: previewSrc })}
              className="w-full h-full border-0" allow="fullscreen" title="미리보기" />
          ) : deployStep === 'checking' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <PixelLoadingBar size="md" label="배포 확인" subLabel="기존 배포 URL 확인 중..." />
            </div>
          ) : deployStep === 'deploying' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <PixelLoadingBar size="lg" label="배포 중" subLabel={deployStatus || '준비 중...'} />
              <div className="text-center flex flex-col gap-1.5">
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)' }}>
                  GitHub Pages 배포 중
                </p>
              </div>
              {githubRepo && (
                <a
                  href={`https://github.com/${githubRepo.owner}/${githubRepo.repo}/actions`}
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-1"
                  style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                >
                  <ExternalLink style={{ width: 10, height: 10 }} /> Actions 로그 보기
                </a>
              )}
              <button
                onClick={cancelDeploy}
                className="flex items-center gap-1.5 transition-all"
                style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '6px 12px', background: 'var(--bg-panel)', border: '1px solid var(--border)', cursor: 'pointer' }}
              >
                배포 취소
              </button>
            </div>
          ) : deployStep === 'deploy-error' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <div style={{
                width: 56, height: 56,
                background: 'var(--err-bg)',
                border: '1px solid var(--err-bd)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ExternalLink style={{ width: 24, height: 24, color: 'var(--err)' }} />
              </div>
              <div className="text-center">
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', marginBottom: 8 }}>
                  배포 실패
                </p>
                <p className="px-4 py-2 whitespace-pre-wrap"
                  style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', lineHeight: 1.6, maxWidth: 320, marginBottom: 12 }}>
                  {deployError}
                </p>
              </div>
              <div className="flex gap-2">
                {githubRepo && (
                  <a
                    href={`https://github.com/${githubRepo.owner}/${githubRepo.repo}/actions`}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1"
                    style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '6px 12px', background: 'var(--bg-panel)', border: '1px solid var(--border)', textDecoration: 'none' }}
                  >
                    <ExternalLink style={{ width: 10, height: 10 }} /> 로그 보기
                  </a>
                )}
                <button
                  onClick={() => {
                    if (githubRepo) {
                      startDeploy(githubRepo.owner, githubRepo.repo, githubRepo.branch, deployToken)
                    }
                  }}
                  className="flex items-center gap-1.5 transition-all"
                  style={{ color: 'var(--on-accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '6px 12px', background: 'var(--accent)', border: 'none', cursor: 'pointer' }}
                >
                  다시 배포
                </button>
              </div>
            </div>
          ) : deployStep === 'needs-token' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <div style={{
                width: 56, height: 56,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <KeyRound style={{ width: 24, height: 24, color: 'var(--txt-3)' }} />
              </div>
              <div className="text-center">
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', marginBottom: 6 }}>
                  GitHub 토큰 입력 후 자동 배포
                </p>
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', lineHeight: 1.7, maxWidth: 280 }}>
                  토큰을 입력하면 즉시 GitHub Pages 배포가 시작됩니다.
                </p>
              </div>
              <div className="flex flex-col gap-1.5" style={{ width: 280 }}>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ background: 'var(--bg)', border: `1px solid ${deployToken ? 'var(--ok-bd)' : 'var(--border)'}` }}>
                  <KeyRound style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--txt-3)' }} />
                  <input
                    type="password"
                    value={deployToken}
                    autoFocus
                    onChange={e => { setDeployToken(e.target.value); setDeployError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && deployToken.trim() && githubRepo) {
                        startDeploy(githubRepo.owner, githubRepo.repo, githubRepo.branch, deployToken.trim())
                      }
                    }}
                    placeholder="ghp_xxxxxxxxxxxx  (Enter로 배포 시작)"
                    className="flex-1 bg-transparent outline-none"
                    style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                  />
                </div>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=VibeCoding"
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-1"
                  style={{ color: 'var(--accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                >
                  <ExternalLink style={{ width: 10, height: 10 }} /> repo · workflow 권한으로 토큰 만들기
                </a>
              </div>
              {deployError && (
                <p className="px-3 py-2 whitespace-pre-wrap text-center"
                  style={{ color: 'var(--err)', background: 'var(--err-bg)', border: '1px solid var(--err-bd)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', maxWidth: 300, lineHeight: 1.6 }}>
                  {deployError}
                </p>
              )}
            </div>
          ) : deployStep === 'deploy-done' ? (
            /* 배포 완료 화면 — 미리보기 버튼 제공 */
            <div className="flex-1 flex flex-col items-center justify-center gap-5">
              <div style={{
                width: 56, height: 56,
                background: 'var(--ok-bg)',
                border: '1px solid var(--ok-bd)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Check style={{ width: 24, height: 24, color: 'var(--ok)' }} />
              </div>
              <div className="text-center">
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-lg)', marginBottom: 8 }}>
                  배포 완료!
                </p>
                {deployUrl && (
                  <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', lineHeight: 1.6, maxWidth: 320, wordBreak: 'break-all' }}>
                    {deployUrl}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={openPreviewFromDeploy}
                  className="flex items-center gap-2 transition-colors"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '8px 20px', border: 'none', cursor: 'pointer' }}
                >
                  <Eye style={{ width: 13, height: 13 }} /> 미리보기 열기
                </button>
                {deployUrl && (
                  <button
                    onClick={() => window.open(deployUrl, '_blank', 'noopener,noreferrer')}
                    className="flex items-center gap-1.5 transition-all"
                    style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '8px 14px', background: 'var(--bg-panel)', border: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    <ExternalLink style={{ width: 11, height: 11 }} /> 새 탭
                  </button>
                )}
              </div>
              {githubRepo && (
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                  {githubRepo.owner}/{githubRepo.repo} · {githubRepo.branch}
                </p>
              )}
            </div>
          ) : hasFiles && (projectType === 'react' || projectType === 'vue') ? (
            /* AI 생성 React/Vue — GitHub 내보내기 필요 */
            <div className="flex-1 flex flex-col items-center justify-center gap-5">
              <div style={{
                width: 56, height: 56,
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent-bd)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <GitFork style={{ width: 24, height: 24, color: 'var(--accent)' }} />
              </div>
              <div className="text-center">
                <p style={{ color: 'var(--txt)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', marginBottom: 8 }}>
                  {projectType === 'vue' ? 'Vue' : 'React'} 프로젝트가 만들어졌습니다
                </p>
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', lineHeight: 1.7, maxWidth: 260 }}>
                  {projectType === 'vue' ? 'Vue' : 'React'} 는 빌드가 필요합니다.<br />
                  GitHub 에 푸시하면 자동으로 배포한 뒤 미리보기를 엽니다.
                </p>
              </div>
              <button
                onClick={() => setShowExport(true)}
                className="flex items-center gap-2 transition-colors"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '8px 20px', border: 'none', cursor: 'pointer' }}>
                <GitFork style={{ width: 14, height: 14 }} /> GitHub 에 푸시하고 미리보기
              </button>
              <div className="flex flex-wrap gap-1.5 justify-center" style={{ maxWidth: 280 }}>
                {fileNames.slice(0, 6).map(name => (
                  <span key={name} style={{ background: 'var(--bg-panel)', color: 'var(--txt-3)', border: '1px solid var(--border-s)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', padding: '2px 8px' }}>
                    {name}
                  </span>
                ))}
                {fileNames.length > 6 && (
                  <span style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                    +{fileNames.length - 6} more
                  </span>
                )}
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-5">
              <div style={{
                width: 48, height: 48,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <FileCode2 style={{ width: 22, height: 22, color: 'var(--txt-3)' }} />
              </div>
              <div className="text-center">
                <p style={{ color: 'var(--txt-2)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)', fontWeight: 600, marginBottom: 6 }}>
                  아직 만든 화면이 없습니다
                </p>
                <p style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                  왼쪽 대화창에 만들고 싶은 것을 설명해 주세요
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Code tab */}
        <div className={`absolute inset-0 ${tab === 'files' ? 'flex' : 'hidden'} flex-col overflow-y-auto`}>
          {filesTab}
        </div>
        <div ref={codeTabRef} className={`absolute inset-0 ${tab === 'code' ? 'flex' : 'hidden'}`}>
          {hasFiles ? (
            <>
              <div className="flex flex-col flex-shrink-0 overflow-y-auto"
                style={{ width: fileListWidth, background: 'var(--bg-panel)' }}>
                <div className="px-3 py-2 select-none"
                  style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', letterSpacing: '0.1em', borderBottom: '1px solid var(--border-s)' }}>
                  파일
                </div>
                {fileNames.map(name => (
                  <button key={name} onClick={() => setSelectedFile(name)}
                    className="flex items-center gap-2 px-3 py-1.5 text-left w-full min-w-0 transition-colors"
                    style={selectedFile === name
                      ? { background: 'var(--accent-bg)', color: 'var(--txt)', borderRight: '2px solid var(--accent)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }
                      : { color: 'var(--txt-2)', borderRight: '2px solid transparent', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}
                    onMouseEnter={e => { if (selectedFile !== name) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseLeave={e => { if (selectedFile !== name) e.currentTarget.style.background = 'transparent' }}
                    title={name}>
                    {fileIcon(name)}
                    <span className="truncate min-w-0">{name}</span>
                  </button>
                ))}
              </div>
              <div
                onMouseDown={startResizeFileList}
                className="flex-shrink-0"
                style={{ width: 1, cursor: 'col-resize', background: 'var(--border)' }}
                title="끌어서 파일 목록 너비 조절"
              />
              <div className="flex-1 overflow-hidden" style={{ background: 'var(--bg)' }}>
                <div className="flex items-center justify-between px-3"
                  style={{ height: 28, borderBottom: '1px solid var(--border-s)', background: 'var(--bg-panel)' }}>
                  <span style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                    편집 중: {selectedFile}
                  </span>
                  <div className="flex items-center gap-2">
                    <span style={{ color: saveLabel === '저장됨' ? 'var(--ok)' : 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
                      {saveLabel}
                    </span>
                  </div>
                </div>
                <div className="flex h-full">
                  <div className="overflow-hidden select-none"
                    style={{ width: 56, borderRight: '1px solid var(--border-s)', background: 'var(--bg-panel)' }}>
                    {/* 편집기 스크롤을 따라간다. 줄높이(13px × 1.6)를 .code-editor-layer 와 같게 둬야 줄 번호가 맞고, 아래 여백은 편집기 가로 스크롤바 높이만큼 더 둔다. */}
                    <div ref={gutterRef} className="h-full overflow-hidden px-2 pt-2" style={{ paddingBottom: 24 }}>
                      {Array.from({ length: selectedLineCount }).map((_, i) => (
                        <div key={i}
                          style={{ color: 'var(--txt-3)', fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', lineHeight: 1.6, textAlign: 'right' }}>
                          {i + 1}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* 색칠한 pre 를 뒤에 깔고 글자를 투명하게 한 textarea 를 겹친다. 두 요소의 글꼴·줄높이·여백이 같아야 글자가 겹치고, 줄바꿈을 끄고(wrap=off) 스크롤을 맞춘다. */}
                  <div className="relative flex-1 min-w-0 h-full" style={{ background: 'var(--bg)' }}>
                    <pre ref={highlightRef} aria-hidden="true" className="code-editor-layer code-highlight"
                      style={{ position: 'absolute', inset: 0, margin: 0, overflow: 'hidden', pointerEvents: 'none', color: 'var(--txt-2)' }}
                      dangerouslySetInnerHTML={{ __html: highlightedContent + '\n' }} />
                    <textarea
                      value={selectedContent}
                      onChange={(e) => updateSelectedFileContent(e.target.value)}
                      onScroll={(e) => {
                        if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
                        if (!highlightRef.current) return
                        highlightRef.current.scrollTop = e.currentTarget.scrollTop
                        highlightRef.current.scrollLeft = e.currentTarget.scrollLeft
                      }}
                      spellCheck={false}
                      wrap="off"
                      className="code-editor-layer relative w-full h-full resize-none outline-none"
                      style={{ background: 'transparent', color: 'transparent', caretColor: 'var(--txt)' }}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center w-full h-full"
              style={{ color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
              아직 만든 코드가 없습니다
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className={`panel-statusbar ${tab === 'files' ? 'hidden' : 'flex'} items-center justify-between px-4 flex-shrink-0 select-none`}
        style={{ background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', height: 24, color: 'var(--txt-3)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--txt-2)' }}>vibe-coding-web</span>
          {hasFiles && (
            <>
              <span>/</span>
              <span style={{ color: 'var(--accent)' }}>
                {tab === 'code' ? selectedFile : 'index.html'}
              </span>
              {(projectType === 'react' || projectType === 'vue') && (
                <span style={{ background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 'var(--fs-xs)', padding: '1px 6px', border: '1px solid var(--accent-bd)' }}>
                  {projectType === 'vue' ? 'vue' : 'react'}
                </span>
              )}
            </>
          )}
          {isLoading && (
            <span className="flex items-center gap-1" style={{ color: 'var(--accent)' }}>
              <PixelMiniBar /> generating
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          {hasFiles && <span>{fileNames.length} files · {totalLines} lines</span>}
        </div>
      </div>

      {/* Export Modal */}
      {showExport && (
        <ExportModal
          files={files}
          githubRepo={githubRepo}
          onClose={() => setShowExport(false)}
          onSuccess={handleExportSuccess}
        />
      )}

      {/* Import Modal */}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onSuccess={handleImportSuccess}
        />
      )}
    </div>
  )
}