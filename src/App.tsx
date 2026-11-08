/**
 * 메인 애플리케이션 컴포넌트
 * 
 * 기능:
 * - AI 챗 인터페이스 (좌측)
 * - 코드 미리보기 패널 (우측)
 * - 리얼타임 코드 스트리밍 및 렌더링
 * - Claude API (Anthropic) 기반 코드 생성
 * - 프로젝트 타입 자동 감지 (HTML, React, Vue)
 * - 드래그 가능한 패널 리사이저
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { PanelLeft, GripVertical } from './icons'
import Sidebar from './components/Sidebar'  // 좌측 대화 목록
import { chatTitle, clearDriveListCache, deleteChat, listChats, loadChat, saveChat, savePendingNow, USE_DRIVE } from './services/chatStore'
import { connectDrive, disconnectDrive, driveAccount, DriveAuthError, isDriveConfigured, isDriveConnected, isDriveExpired, onDriveChange } from './services/drive'
import type { GithubRepo } from './services/chatStore'
import type { ChatListItem as ChatSummary, StoredChat } from './services/chatStore'
import { useEscapeKey } from './hooks/useEscapeKey'
import Header from './components/Header'  // 상단 헤더 (로고, 설정, API 키)
import ChatPanel from './components/ChatPanel'  // 좌측 채팅 패널
import PreviewPanel from './components/PreviewPanel'  // 우측 코드 미리보기 패널
import type { PanelTab } from './components/PreviewPanel'
// AI 서비스 함수들 (스트리밍, 파싱, 모델 정보)
import { streamCode, resumeCode, cancelGeneration, parseVibe, MODELS, DEFAULT_MODEL_OPTIONS } from './services/ai'
import type { ClientToolResult, ModelOptions, WebSource } from './services/ai'
import { runEditorCommand } from './services/textEditor'
import { runMemoryCommand } from './services/memoryStore'
import type { Message, MessageImage, TokenUsage } from './services/ai'
import { addUsage, estimateCost, loadBalance, loadUsage, resetUsage, setBalance } from './services/usage'
import type { Balance } from './services/usage'

/**
 * HTML 마크업 판별 함수
 * AI 응답이 HTML 구조를 포함하는지 정규식으로 확인
 * 주요 HTML 태그의 존재 여부로 판단
 */
function isLikelyMarkup(text: string): boolean {
  return /<!doctype|<html|<body|<main|<div|<section|<script|<style/i.test(text)
}

/**
 * 생성된 프로젝트 유효성 검증 함수
 * 프로젝트 타입별 필수 파일이 모두 존재하는지 확인
 * - HTML: index.html + HTML 마크업 구조
 * - React: package.json + src/main.jsx(tsx) + src/App.jsx(tsx)
 * - Vue: package.json + src/main.js(ts) + src/App.vue
 */
type ProjectType = 'html' | 'react' | 'vue'

// 리파인 응답은 바뀐 파일만 담을 수 있으므로, 같은 종류의 프로젝트면 요청 직전 파일 위에 합친다. 종류가 바뀌면 응답 파일로 교체한다.
/**
 * 응답 파일을 현재 프로젝트 위에 합친다. 모델은 바뀐 파일만 출력한다.
 * 유형이 바뀌었더라도 응답만으로 완성된 프로젝트가 아니면(바뀐 파일 일부만 온 경우) 기존 프로젝트에 합친다.
 */
function mergeFiles(base: { files: Record<string, string>; type: ProjectType }, files: Record<string, string>, type: ProjectType) {
  if (type === base.type || Object.keys(base.files).length === 0) return { ...base.files, ...files }
  return isValidGeneratedProject(files, type) ? files : { ...base.files, ...files }
}
/** mergeFiles 결과의 프로젝트 유형 */
function mergedType(base: { files: Record<string, string>; type: ProjectType }, files: Record<string, string>, type: ProjectType): ProjectType {
  if (type === base.type || Object.keys(base.files).length === 0) return type
  return isValidGeneratedProject(files, type) ? type : base.type
}

function isValidGeneratedProject(files: Record<string, string>, projectType: 'html' | 'react' | 'vue'): boolean {
  if (Object.keys(files).length === 0) return false
  if (projectType === 'html') {
    return Boolean(files['index.html']) && isLikelyMarkup(files['index.html'])
  }
  if (projectType === 'react') {
    const hasMain = Boolean(files['src/main.jsx'] || files['src/main.tsx'])
    const hasApp = Boolean(files['src/App.jsx'] || files['src/App.tsx'])
    return Boolean(files['package.json']) && hasMain && hasApp
  }
  const hasMain = Boolean(files['src/main.js'] || files['src/main.ts'])
  return Boolean(files['package.json']) && hasMain && Boolean(files['src/App.vue'])
}

/**
 * 파일 세트의 핑거프린트(지문) 생성 함수
 * 파일 이름과 크기로 고유한 문자열을 생성하여
 * 실시간 패치 시 파일 변경 여부를 빠르게 감지
 * 예: \"index.html:2048|style.css:512|app.js:1024\"
 */
function fingerprintFiles(files: Record<string, string>): string {
  const names = Object.keys(files).sort()
  return names.map((name) => `${name}:${files[name]?.length ?? 0}`).join('|')
}

/**
 * 상수: 실시간 패치 업데이트 쓰로틀 시간
 * 스트리밍 중 150ms 이상 간격으로만 Preview 업데이트
 * 과도한 리렌더링 방지를 위한 성능 최적화
 */
const REALTIME_PATCH_THROTTLE_MS = 150

// 이미지만 보내고 글을 비웠을 때 대신 보내는 요청
const IMAGE_ONLY_PROMPT = '이 이미지를 설명해 주세요'

// 파일 편집처럼 연속으로 바뀌는 변경을 한 번에 저장하기 위한 대기 시간
const SAVE_DELAY_MS = 500

// index.css 의 모바일 미디어 쿼리(max-width: 767px)와 같은 경계를 쓴다.
const MOBILE_QUERY = '(max-width: 767px)'

// 채팅 패널 너비 범위: 최소 200px, 최대 화면 너비의 60%. 키보드 조절은 한 번에 20px.
const CHAT_MIN_WIDTH = 200
const CHAT_KEY_STEP = 20
function clampChatWidth(width: number): number {
  return Math.max(CHAT_MIN_WIDTH, Math.min(width, window.innerWidth * 0.6))
}

/**
 * App 컴포넌트
 * 전체 애플리케이션의 메인 컴포넌트
 */
export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [projectFiles, setProjectFiles] = useState<Record<string, string>>({})
  const projectFilesRef = useRef<Record<string, string>>({})
  const [projectType, setProjectType] = useState<'html' | 'react' | 'vue'>('html')
  const [githubRepo, setGithubRepo] = useState<GithubRepo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)
  const [lastCost, setLastCost] = useState(0)
  const [usageTotals, setUsageTotals] = useState(loadUsage)
  // 요청 1건이 끝날 때마다 호출된다. 화면의 '이번' 값을 바꾸고 오늘·누적 합계에 더한다.
  const [balance, setBalanceState] = useState<Balance | null>(() => loadBalance())
  const handleBalanceChange = (amount: number | null) => setBalanceState(setBalance(amount))
  const recordUsage = (usage: TokenUsage) => {
    setTokenUsage(usage)
    setLastCost(estimateCost(activeModel, usage))
    setUsageTotals(addUsage(activeModel, usage))
    setBalanceState(loadBalance())
  }
  // 대화에서 선택된 답변 위치와, 캔버스 탭 전환 요청
  const [answerIndex, setAnswerIndex] = useState<number | null>(null)
  // 캔버스에 띄운 버전(파일 사본이 있는 답변의 메시지 위치). null 이면 최신 버전이다.
  const [versionIndex, setVersionIndex] = useState<number | null>(null)
  // 캔버스 ✕ 로 닫았는지. 새 요청·결과물 카드·대화 전환 때 다시 연다.
  const [canvasClosed, setCanvasClosed] = useState(false)
  const [panelFocus, setPanelFocus] = useState<{ tab: PanelTab; seq: number }>({ tab: 'preview', seq: 0 })
  const focusPanel = (tab: PanelTab) => setPanelFocus((prev) => ({ tab, seq: prev.seq + 1 }))
  const envKey = (import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined)?.trim() || ''
  const [activeApiKey, setActiveApiKey] = useState(() => envKey || localStorage.getItem('vibe_api_key_anthropic') || '')
  // 저장된 모델이 현재 MODELS 에 없으면(이전 버전의 값 등) 기본 모델로 되돌린다.
  const [activeModel, setActiveModel] = useState(() => {
    const saved = localStorage.getItem('vibe_model')
    return saved && MODELS.some((m) => m.id === saved) ? saved : MODELS[0].id
  })
  const bufferRef = useRef('')
  // 진행 중인 생성 요청. 중지 버튼이 abort() 한다.
  const abortRef = useRef<AbortController | null>(null)
  // 진행 중인 요청의 서버 생성 id. 중지 버튼이 서버 쪽 생성도 멈춘다.
  const generationIdRef = useRef<string | null>(null)
  // 진행 중인 요청 직전의 프로젝트. 응답 파일을 이 위에 합친다.
  const baseProjectRef = useRef<{ files: Record<string, string>; type: ProjectType }>({ files: {}, type: 'html' })
  const lastRealtimePatchRef = useRef('')
  const lastRealtimePatchAtRef = useRef(0)
  const realtimePatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRealtimePatchRef = useRef<{
    files: Record<string, string>
    projectType: 'html' | 'react' | 'vue'
    fingerprint: string
  } | null>(null)

  // Resizable chat panel state
  // 드래그 가능한 패널 리사이저 상태
  // chatWidth: 채팅 패널의 현재 너비(px)
  // isDragging: 드래그 중 여부 플래그
  // startX: 드래그 시작 시 마우스 X 좌표
  // startWidth: 드래그 시작 시 초기 패널 너비
  const [chatWidth, setChatWidth] = useState(440)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // 모바일에서는 채팅/미리보기를 탭으로 하나씩 보여준다.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const [mobileTab, setMobileTab] = useState<'chat' | 'preview'>('chat')
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 테마: 저장된 선택이 있으면 그것을, 없으면 OS 설정을 따른다. <html data-theme> 으로 index.css 토큰이 바뀐다.
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('vibe_theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  // 첫 화면이 잘못된 테마로 깜빡이지 않도록 그리기 전에 적용한다.
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('vibe_theme', next)
  }

  // 대화 목록: 데스크톱은 펼친 상태가 기본이고 접은 상태를 기억한다. 모바일은 닫힌 서랍으로 시작한다.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    !window.matchMedia(MOBILE_QUERY).matches && localStorage.getItem('vibe_sidebar') !== 'closed')
  const toggleSidebar = () => {
    if (!isMobile) localStorage.setItem('vibe_sidebar', sidebarOpen ? 'closed' : 'open')
    setSidebarOpen(!sidebarOpen)
  }
  useEscapeKey(() => setSidebarOpen(false), isMobile && sidebarOpen)

  // 저장된 대화. chatId 가 null 이면 아직 저장 전인 새 대화다.
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const chatCreatedAtRef = useRef(0)
  // 사용자가 보낸 요청이나 파일 수정으로 바뀐 내용이 있을 때만 저장한다. 대화를 불러온 직후에는 저장하지 않는다.
  const unsavedRef = useRef(false)
  const [storageError, setStorageError] = useState('')
  // 대화를 바꿀 때 PreviewPanel 을 새로 마운트해 배포 상태 등 내부 상태를 비운다(예전 새로고침과 같은 효과).
  const [sessionKey, setSessionKey] = useState(0)

  // 한 번 불러오거나 저장한 대화. 새로고침하면 비워진다.
  const chatCacheRef = useRef(new Map<string, StoredChat>())
  // 지금 불러오는 중인 대화 id. 사이드바에 선택 표시와 "불러오는 중"을 바로 띄운다.
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null)
  // 키가 바뀌면 다른 사용자의 대화이므로 보관본을 비운다.
  useEffect(() => { chatCacheRef.current.clear() }, [activeApiKey])

  // Google 드라이브 저장 방식이면 드라이브 연결 상태가 저장소 사용 가능 여부다. Worker 방식이면 API 키가 있어야 한다.
  const [driveConnected, setDriveConnected] = useState(() => isDriveConnected())
  const [driveBusy, setDriveBusy] = useState(false)
  useEffect(() => onDriveChange(setDriveConnected), [])
  // 드라이브 방식은 연결 전에도 브라우저(IndexedDB)에 저장하므로 항상 쓸 수 있다.
  const storageReady = USE_DRIVE ? true : !!activeApiKey
  const storageFailMessage = (fallback: string) => (e: unknown) =>
    setStorageError(e instanceof DriveAuthError ? '드라이브 연결이 만료됐어요. 왼쪽 아래 \'다시 연결\'을 누르면 열 수 있어요' : fallback)
  const handleConnectDrive = async () => {
    setDriveBusy(true)
    try {
      await connectDrive()
      setStorageError('')
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : 'Google 드라이브에 연결하지 못했습니다')
    } finally {
      setDriveBusy(false)
    }
  }
  const handleDisconnectDrive = () => {
    disconnectDrive()
    clearDriveListCache()
    chatCacheRef.current.clear()
  }
  // 저장 위치(브라우저 ↔ 드라이브)가 바뀌면 보관본을 비우고 목록을 다시 받는다(아래 목록 effect).
  useEffect(() => { chatCacheRef.current.clear() }, [driveConnected])

  useEffect(() => {
    if (!storageReady) return
    listChats(activeApiKey).then(setChats).catch(storageFailMessage('대화 목록을 불러오지 못했습니다'))
  }, [activeApiKey, storageReady, driveConnected])

  // 새로고침해도 마지막에 열어 둔 대화를 다시 연다. 저장소를 쓸 수 있게 된 첫 시점에 한 번만 연다.
  // 아래 기억 effect 가 키를 지우기 전에 읽어 둔다.
  const lastChatIdRef = useRef(localStorage.getItem('vibe_chat_id'))
  useEffect(() => {
    const lastId = lastChatIdRef.current
    if (!storageReady || !lastId) return
    lastChatIdRef.current = null
    handleSelectChat(lastId)
  }, [storageReady])

  // 열린 대화 id 를 기억한다. 새 대화(null)면 지워서 다음 로드가 새 대화로 시작하게 한다.
  useEffect(() => {
    if (chatId) localStorage.setItem('vibe_chat_id', chatId)
    else localStorage.removeItem('vibe_chat_id')
  }, [chatId])

  // 대화를 지금 상태의 프로젝트와 함께 저장하고 목록 맨 위로 올린다. 실패하면 reject 한다.
  const storeChat = async (id: string, msgs: Message[]) => {
    const chat = {
      id,
      title: chatTitle(msgs),
      createdAt: chatCreatedAtRef.current,
      updatedAt: Date.now(),
      messages: msgs,
      projectFiles,
      projectType,
      githubRepo,
    }
    chatCacheRef.current.set(chat.id, chat)
    const where = await saveChat(activeApiKey, chat)
    // 연결된 상태인데 브라우저에 저장됐다 = 드라이브 저장이 실패해 대기 저장으로 돌린 것
    setStorageError(where === 'local' && isDriveConnected() ? '드라이브 저장에 실패해 이 브라우저에 임시 저장했어요. 새로고침하면 다시 올립니다' : '')
    setChats((prev) => [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, ...(where === 'local' ? { pending: true } : {}) }, ...prev.filter((c) => c.id !== chat.id)])
  }

  // 저장 대기(0.5초) 중에 탭을 닫으면 그 내용을 브라우저에 대기 저장해 둔다.
  useEffect(() => {
    const onHide = () => {
      if (!chatId || messages.length === 0 || !unsavedRef.current) return
      savePendingNow({ id: chatId, title: chatTitle(messages), createdAt: chatCreatedAtRef.current, updatedAt: Date.now(), messages, projectFiles, projectType, githubRepo })
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [chatId, messages, projectFiles, projectType, githubRepo])

  // 응답이 끝났거나 코드 탭에서 파일을 고친 뒤 SAVE_DELAY_MS 동안 변화가 없으면 저장한다. 생성 중에는 저장하지 않는다(시작 시 저장은 handleSend 가 한다).
  useEffect(() => {
    if (!storageReady || !chatId || isLoading || messages.length === 0 || !unsavedRef.current) return
    const timer = setTimeout(() => {
      storeChat(chatId, messages)
        .then(() => { unsavedRef.current = false })
        .catch(storageFailMessage('대화를 저장하지 못했습니다 (저장소에 연결할 수 없음)'))
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [storageReady, chatId, isLoading, messages, projectFiles, projectType, githubRepo])

  // 생성 중 응답은 이 페이지가 직접 받고 있어서 새로고침·탭 닫기 시 끊기고 저장되지 않는다. 떠나기 전에 브라우저 확인창을 띄운다.
  useEffect(() => {
    if (!isLoading) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isLoading])

  /**
   * 드래그 시작 핸들러
   * 마우스 클릭 시 드래그 초기 상태 저장
   * 커서를 col-resize로 변경하고 텍스트 선택 방지
   */
  const onMouseDown = useCallback((e: React.PointerEvent) => {
    // 포인터를 손잡이에 묶어 둔다. 미리보기 iframe 위로 가도 이동·놓기 이벤트가 손잡이로 온다.
    e.currentTarget.setPointerCapture(e.pointerId)
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = chatWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [chatWidth])

  /**
   * 마우스 이동 핸들러
   * 드래그 중일 때만 활성화되어 패널 너비를 실시간으로 계산 및 업데이트
   * 최소 200px 이상, 최대 화면 너비 60% 범위로 제한
   */
  const onMouseMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    const delta = e.clientX - startX.current
    setChatWidth(clampChatWidth(startWidth.current + delta))
  }, [])

  // 드래그 대신 손잡이에 포커스를 두고 ←/→ 로 너비를 조절한다.
  const onResizerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.key === 'ArrowLeft' ? -CHAT_KEY_STEP : CHAT_KEY_STEP
    setChatWidth((w) => clampChatWidth(w + step))
  }

  /**
   * 마우스 릴리즈 핸들러
   * 드래그 종료 시 드래그 상태 해제 및 커서/텍스트 선택 복원
   */
  const onMouseUp = useCallback(() => {
    isDragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])
  const applyRealtimePatch = useCallback((
    files: Record<string, string>,
    pType: 'html' | 'react' | 'vue',
    fingerprint: string,
  ) => {
    lastRealtimePatchRef.current = fingerprint
    lastRealtimePatchAtRef.current = Date.now()
    const merged = mergeFiles(baseProjectRef.current, files, pType)
    projectFilesRef.current = merged
    setProjectFiles(merged)
    setProjectType(pType)
  }, [])

  const flushPendingRealtimePatch = useCallback(() => {
    const pending = pendingRealtimePatchRef.current
    if (!pending) return
    pendingRealtimePatchRef.current = null
    applyRealtimePatch(pending.files, pending.projectType, pending.fingerprint)
  }, [applyRealtimePatch])

  useEffect(() => {
    return () => {
      if (realtimePatchTimerRef.current) {
        clearTimeout(realtimePatchTimerRef.current)
        realtimePatchTimerRef.current = null
      }
    }
  }, [])
  const handleApiKeyChange = (key: string) => {
    setActiveApiKey(key)
    localStorage.setItem('vibe_api_key_anthropic', key)
  }

  const handleModelChange = (nextModel: string) => {
    setActiveModel(nextModel)
    localStorage.setItem('vibe_model', nextModel)
  }

  // 모델 옵션(노력 수준·빠른 모드·최대 출력·생각 요약). 모델마다 따로 기억한다.
  const [allModelOptions, setAllModelOptions] = useState<Record<string, ModelOptions>>(() => {
    try { return JSON.parse(localStorage.getItem('vibe_model_options') ?? '{}') ?? {} } catch { return {} }
  })
  const modelOptions: ModelOptions = { ...DEFAULT_MODEL_OPTIONS, ...allModelOptions[activeModel] }
  const handleModelOptionsChange = (next: ModelOptions) => {
    const all = { ...allModelOptions, [activeModel]: next }
    setAllModelOptions(all)
    try { localStorage.setItem('vibe_model_options', JSON.stringify(all)) } catch { /* 이번 세션만 유지 */ }
  }
  // 웹 검색 출처(url 기준, 인용된 것 우선)
  const sourcesRef = useRef(new Map<string, WebSource>())
  const handleSource = (src: WebSource) => {
    const prev = sourcesRef.current.get(src.url)
    if (!prev || (src.cited && !prev.cited)) sourcesRef.current.set(src.url, src)
  }
  // 도구 진행 상황(검색어·읽는 URL·실행 명령·파일 수정 등)을 생각 요약 칸에 한 줄씩 붙인다.
  const handleActivity = (line: string) => handleThinking(`${thinkingRef.current && !thinkingRef.current.endsWith('\n') ? '\n' : ''}${line}\n`)
  // 코드 실행이 만든 파일(Files API id)
  const outputFilesRef = useRef<string[]>([])
  // 텍스트 에디터로 이번 턴에 바뀐 파일
  const editedRef = useRef(new Set<string>())
  /** 앱이 실행하는 도구: 텍스트 에디터는 현재 프로젝트 사본에, 메모리는 드라이브/브라우저 기억에 적용한다. */
  const runClientTool = async (name: string, input: Record<string, unknown>): Promise<ClientToolResult> => {
    if (name === 'memory') return runMemoryCommand(input)
    if (name === 'str_replace_based_edit_tool') {
      const base = baseProjectRef.current
      const { result, next, changed } = runEditorCommand(projectFilesRef.current, input)
      if (next && changed) {
        // 이후 스트리밍 파일 반영(mergeFiles)도 이 수정본 위에 쌓이도록 기준 프로젝트를 함께 갱신한다.
        baseProjectRef.current = { files: next, type: base.type }
        projectFilesRef.current = next
        setProjectFiles(next)
        editedRef.current.add(changed)
      }
      return result
    }
    return { content: `Error: unknown tool ${name}`, isError: true }
  }
  // 생각 요약을 받으면 본문이 나오기 전의 빈 답변 자리에 붙인다.
  const thinkingRef = useRef('')
  const handleThinking = (text: string) => {
    thinkingRef.current += text
    const thinking = thinkingRef.current
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role !== 'assistant') return prev
      const updated = [...prev]
      updated[updated.length - 1] = { ...last, thinking }
      return updated
    })
  }
  /**
   * AI 코드 생성 메인 로직
   * 
   * 처리 흐름:
   * 1. 유효성 검증 (API 키 존재, 로딩 중 아님, 레이트 리미트 확인)
   * 2. 사용자 메시지를 채팅 히스토리에 추가
   * 3. streamCode() async generator로 AI 스트리밍 시작
   * 4. 스트리밍 청크를 parseVibe()로 파싱하여 파일과 설명 추출
   * 5. 실시간 패치 적용 (150ms 쓰로틀)
   *    - 스트리밍 중 코드를 PreviewPanel에 즉시 반영
   *    - 과도한 렌더링 방지를 위해 쓰로틀링 적용
   * 6. 최종 코드와 설명을 메시지에 저장
   * 7. 형식 오류 처리 (자동 재생성)
   *    - <VIBE_FILE>, <VIBE_TYPE>, <VIBE_EXPLANATION> 형식 검증
   *    - 필수 파일 부족 시 AI에 재생성 요청
   * 8. 에러 처리
   *    - 에러 메시지를 채팅에 표시 (429·5xx 는 시작을 2회 다시 시도한 뒤 도달)
   */
  // 끼어들어 말하기: 생성 중에 보내면 지금 답변을 멈추고(받은 부분은 남김) 멈춤 처리가 끝난 뒤 새 메시지를 보낸다.
  const interruptRef = useRef<{ prompt: string; images: MessageImage[] } | null>(null)
  const handleInterrupt = (prompt: string, images: MessageImage[] = []) => {
    interruptRef.current = { prompt, images }
    handleStop()
  }
  useEffect(() => {
    if (isLoading || !interruptRef.current) return
    const next = interruptRef.current
    interruptRef.current = null
    handleSend(next.prompt, next.images)
  }, [isLoading])

  const handleSend = async (prompt: string, images: MessageImage[] = [], base: Message[] = messages) => {
    if (!activeApiKey) return
    if (isLoading) return handleInterrupt(prompt, images)
    // 새 요청의 결과물을 바로 보도록 닫아 둔 캔버스를 다시 연다.
    setCanvasClosed(false)
    // 이미지만 보내고 글을 비우면 기본 요청을 넣는다. API 는 빈 텍스트 블록을 받지 않는다.
    const userMsg: Message = {
      role: 'user',
      content: prompt || IMAGE_ONLY_PROMPT,
      ...(images.length > 0 ? { images } : {}),
    }
    const history = [...base, userMsg]
    const generationId = crypto.randomUUID()
    // 새 대화의 첫 요청이면 이때 저장용 id 를 만든다.
    const id = chatId ?? crypto.randomUUID()
    if (!chatId) {
      setChatId(id)
      chatCreatedAtRef.current = Date.now()
    }
    // 브라우저를 닫아도 다시 열었을 때 이어 받도록 생성 id 를 담은 채로 바로 저장한다. 응답이 끝나면 저장 effect 가 결과로 덮어쓴다.
    storeChat(id, [...history, { role: 'assistant', content: '', files: {}, generationId }])
      .catch(storageFailMessage('대화를 저장하지 못했습니다 (저장소에 연결할 수 없음)'))
    await runGeneration(history, generationId, { files: projectFilesRef.current, type: projectType }, false)
  }

  /**
   * 생성 응답을 받아 대화와 프로젝트에 반영한다. resume 이면 새로 요청하지 않고 서버에 남은 생성을 처음부터 받는다.
   * base 는 요청 직전의 프로젝트다. 응답 파일을 이 위에 합치고, 중지·오류 시 이 상태로 되돌린다.
   */
  const runGeneration = async (history: Message[], generationId: string, base: { files: Record<string, string>; type: ProjectType }, resume: boolean) => {
    setMessages(history)
    setIsLoading(true)
    bufferRef.current = ''
    thinkingRef.current = ''
    sourcesRef.current = new Map()
    outputFilesRef.current = []
    editedRef.current = new Set()
    lastRealtimePatchRef.current = ''
    lastRealtimePatchAtRef.current = 0
    pendingRealtimePatchRef.current = null
    if (realtimePatchTimerRef.current) {
      clearTimeout(realtimePatchTimerRef.current)
      realtimePatchTimerRef.current = null
    }
    const placeholder: Message = { role: 'assistant', content: '', files: {} }
    setMessages([...history, placeholder])
    unsavedRef.current = true
    // 중지하면 스트리밍 중 반영된 일부 파일 대신 이 상태로 되돌린다.
    const prevFiles = base.files
    const prevType = base.type
    baseProjectRef.current = base
    const controller = new AbortController()
    abortRef.current = controller
    generationIdRef.current = generationId
    // 응답이 끝난 이유(onUsage 로 마지막에 한 번 온다). 잘린 응답이면 형식 보정 대신 '이어서 생성'을 안내한다.
    let stopReason: string | undefined
    const onUsage = (usage: TokenUsage) => { stopReason = usage.stopReason; recordUsage(usage) }
    let panelFocused = false
    // 생성 중 화면이 저절로 꺼져 연결이 끊기지 않게 한다. 미지원 브라우저·거부 시에는 없이 진행한다.
    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null)
    try {
      const chunks = resume
        ? resumeCode(activeApiKey, generationId, onUsage, controller.signal)
        : streamCode(activeApiKey, activeModel, history, Object.keys(prevFiles).length ? prevFiles : undefined, onUsage, controller.signal, generationId, modelOptions, handleThinking, {
            onActivity: handleActivity,
            onSource: handleSource,
            onFile: (id) => { if (!outputFilesRef.current.includes(id)) outputFilesRef.current.push(id) },
            onClientTool: runClientTool,
          })
      for await (const chunk of chunks) {
        bufferRef.current += chunk
        // 응답이 시작되면 진행 중인 답변을 현재 답변으로 표시한다. 본문은 대화에 바로 나온다.
        if (!panelFocused && bufferRef.current.trim()) {
          panelFocused = true
          setAnswerIndex(history.length)
        }
        const parsedChunk = parseVibe(bufferRef.current)
        const { explanation } = parsedChunk

        // Real-time patch: update code preview while streaming
        if (Object.keys(parsedChunk.files).length > 0) {
          const nextFingerprint = fingerprintFiles(parsedChunk.files)
          if (nextFingerprint !== lastRealtimePatchRef.current) {
            const elapsed = Date.now() - lastRealtimePatchAtRef.current
            if (elapsed >= REALTIME_PATCH_THROTTLE_MS) {
              applyRealtimePatch(parsedChunk.files, parsedChunk.projectType, nextFingerprint)
            } else {
              pendingRealtimePatchRef.current = {
                files: parsedChunk.files,
                projectType: parsedChunk.projectType,
                fingerprint: nextFingerprint,
              }
              if (!realtimePatchTimerRef.current) {
                const wait = Math.max(0, REALTIME_PATCH_THROTTLE_MS - elapsed)
                realtimePatchTimerRef.current = setTimeout(() => {
                  realtimePatchTimerRef.current = null
                  flushPendingRealtimePatch()
                }, wait)
              }
            }
          }
        }

        setMessages((prev) => {
          const updated = [...prev]
          // VIBE 태그가 없으면 일반 대화 답변이므로 받은 텍스트를 그대로 보여준다.
          updated[updated.length - 1] = {
            role: 'assistant',
            content: explanation || (bufferRef.current.includes('<VIBE_') ? '생성 중...' : bufferRef.current),
            files: {},
            ...(thinkingRef.current ? { thinking: thinkingRef.current } : {}),
          }
          return updated
        })
      }

      flushPendingRealtimePatch()

      let parsed = parseVibe(bufferRef.current)
      // max_tokens: 출력 한도에 걸려 잘림 → 이어서 생성 가능. model_context_window_exceeded: 컨텍스트가 가득 참 → 이어서 생성 불가.
      const truncated: Message['truncated'] = stopReason === 'max_tokens' ? 'output'
        : stopReason === 'model_context_window_exceeded' ? 'context' : undefined

        // Auto-repair response format if model didn't generate valid code structure
      // 코드를 만들려다(<VIBE_FILE> 존재) 구조가 깨진 경우에만 보정한다. 태그가 없으면 일반 대화 답변이다.
      // 잘린 응답은 보정해도 같은 한도에 또 걸리므로 보정하지 않는다(원문 전체를 다시 보내 비용만 두 배가 된다).
      if (!truncated && bufferRef.current.includes('<VIBE_FILE') && !isValidGeneratedProject(mergeFiles(baseProjectRef.current, parsed.files, parsed.projectType), parsed.projectType)) {
        const repairPrompt = [
          '아래 원문 응답은 형식이 깨졌거나 코드가 부족합니다.',
          '반드시 <VIBE_FILE>, <VIBE_TYPE>, <VIBE_EXPLANATION> 형식으로만 다시 출력하세요.',
          '실제 실행 가능한 완성 코드(디자인+기능 포함)로 생성하고 설명문만 보내지 마세요.',
          '',
          '[원문 응답 시작]',
          bufferRef.current,
          '[원문 응답 끝]',
        ].join('\n')

        setMessages((prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            role: 'assistant',
            content: '응답 형식 보정 중... (코드 구조 자동 재생성)',
            files: {},
          }
          return updated
        })

        // 보정 요청은 이어 받기 대상이 아니라 대화에 id 를 남기지 않는다. 중지 버튼은 이 id 로 서버 생성을 멈춘다.
        const repairId = crypto.randomUUID()
        generationIdRef.current = repairId
        let repairedRaw = ''
        for await (const chunk of streamCode(
          activeApiKey,
          activeModel,
          [{ role: 'user', content: repairPrompt }],
          Object.keys(prevFiles).length ? prevFiles : undefined,
          recordUsage,
          controller.signal,
          repairId,
          modelOptions,
        )) {
          repairedRaw += chunk
        }

        const repaired = parseVibe(repairedRaw)
        if (isValidGeneratedProject(mergeFiles(baseProjectRef.current, repaired.files, repaired.projectType), repaired.projectType)) {
          parsed = repaired
          bufferRef.current = repairedRaw
        }
      }

      const { explanation } = parsed
      // 텍스트 에디터로 고친 파일도 이번 답변의 결과물로 친다(되돌리기 지점·'파일 N개' 표시).
      const files = { ...Object.fromEntries([...editedRef.current].map((n) => [n, baseProjectRef.current.files[n] ?? ''])), ...parsed.files }
      // 끝까지 받은(닫는 태그가 있는) 파일만 parseVibe 가 돌려주므로 잘린 응답이어도 완성된 파일은 반영한다.
      const pType = mergedType(baseProjectRef.current, files, parsed.projectType)
      if (Object.keys(files).length > 0) {
        const merged = mergeFiles(baseProjectRef.current, files, parsed.projectType)
        projectFilesRef.current = merged
        setProjectFiles(merged)
        setProjectType(pType)
      }
      const doneNames = Object.keys(files)
      const truncatedNote = truncated === 'output'
        ? `⚠️ 출력 한도(${Math.round(modelOptions.maxTokens / 1000)}K 토큰)에 도달해 응답이 잘렸습니다.` +
          (doneNames.length ? `  \n완성된 파일: ${doneNames.join(', ')}` : '') +
          `  \n'이어서 생성'을 누르거나, 모델 옵션에서 최대 출력을 늘려 다시 시도하세요.`
        : truncated === 'context'
          ? '⚠️ 대화가 모델의 컨텍스트 한도를 가득 채워 응답이 잘렸습니다. 새 대화에서 이어 가세요.'
          : ''
      const body = explanation || (bufferRef.current.includes('<VIBE_')
        ? (truncated ? '' : '완성됐습니다! 코드 탭에서 소스를 확인할 수 있어요.')
        : bufferRef.current.trim())
      setMessages((prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: [body, truncatedNote].filter(Boolean).join('\n\n'),
          ...(truncated ? { truncated } : {}),
          // 인용된 출처를 앞에, 최대 10개
          ...(sourcesRef.current.size ? { sources: [...sourcesRef.current.values()].sort((a, b) => Number(b.cited) - Number(a.cited)).slice(0, 10) } : {}),
          ...(outputFilesRef.current.length ? { outputs: [...outputFilesRef.current] } : {}),
          files,
          // 파일을 만든 답변만 되돌리기 지점이 된다.
          ...(Object.keys(files).length > 0 ? { snapshot: projectFilesRef.current, projectType: pType } : {}),
        }
        return updated
      })
    } catch (err: unknown) {
      pendingRealtimePatchRef.current = null
      if (realtimePatchTimerRef.current) {
        clearTimeout(realtimePatchTimerRef.current)
        realtimePatchTimerRef.current = null
      }
      if (controller.signal.aborted) {
        projectFilesRef.current = prevFiles
        setProjectFiles(prevFiles)
        setProjectType(prevType)
        const { explanation } = parseVibe(bufferRef.current)
        const partial = explanation || (bufferRef.current.includes('<VIBE_') ? '' : bufferRef.current.trim())
        setMessages((prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: `${partial ? `${partial}\n\n` : ''}(생성을 중지했습니다)`, files: {} }
          return updated
        })
        return
      }
      // 스트리밍 중 반쯤 반영된 코드는 깨져 있으므로 요청 전으로 되돌리고, 받은 본문만 남긴다.
      projectFilesRef.current = prevFiles
      setProjectFiles(prevFiles)
      setProjectType(prevType)
      const { explanation } = parseVibe(bufferRef.current)
      const partial = explanation || (bufferRef.current.includes('<VIBE_') ? '' : bufferRef.current.trim())
      const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다'
      setMessages((prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'assistant', content: `${partial ? `${partial}\n\n` : ''}오류: ${message}`, files: {}, failed: true }
        return updated
      })
    } finally {
      wakeLock?.release().catch(() => {})
      generationIdRef.current = null
      pendingRealtimePatchRef.current = null
      if (realtimePatchTimerRef.current) {
        clearTimeout(realtimePatchTimerRef.current)
        realtimePatchTimerRef.current = null
      }
      abortRef.current = null
      // 완료·오류·중지 모두 이 응답을 답변 탭에 연다.
      setAnswerIndex(history.length)
      setVersionIndex(null)
      setIsLoading(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    const id = generationIdRef.current
    if (id) cancelGeneration(activeApiKey, id).catch(() => setStorageError('서버에서 진행 중인 생성을 멈추지 못했습니다'))
  }

  // 출력 한도에서 잘린 답변을 이어서 만든다. 완성된 파일은 이미 프로젝트에 반영돼 있고(현재 파일로 함께 전달),
  // 모델에는 잘린 파일과 아직 못 만든 파일만 출력하게 한다.
  const handleContinue = () => {
    handleSend('끊긴 부분부터 이어서 만들어 줘. 이미 완성된 파일은 다시 출력하지 말고, 끊긴 파일과 아직 만들지 못한 파일만 전체 내용으로 출력해 줘.', [], messages)
  }

  // 실패한 마지막 질문·답 한 쌍을 빼고 같은 질문을 다시 보낸다.
  const handleRetry = () => {
    const question = messages[messages.length - 2]
    if (question?.role !== 'user') return
    handleSend(question.content, question.images ?? [], messages.slice(0, -2))
  }

  /**
   * 프로젝트 가져오기 핸들러
   * GitHub에서 가져온 프로젝트를 UI에 로드
   */
  const handleImportProject = (importedFiles: Record<string, string>, importedType: 'html' | 'react' | 'vue') => {
    projectFilesRef.current = importedFiles
    setProjectFiles(importedFiles)
    setProjectType(importedType)
    unsavedRef.current = true
  }

  const handleGithubRepoChange = (repo: GithubRepo) => {
    setGithubRepo(repo)
    unsavedRef.current = true
  }

  // 화면을 빈 대화 상태로 되돌린다. 저장소는 건드리지 않는다.
  const resetConversation = () => {
    setMessages([])
    projectFilesRef.current = {}
    setProjectFiles({})
    setProjectType('html')
    setGithubRepo(null)
    setAnswerIndex(null)
    setVersionIndex(null)
    setTokenUsage(null)
    setLastCost(0)
    setSessionKey((k) => k + 1)
    setCanvasClosed(false)
    unsavedRef.current = false
  }

  // 생성 중에는 전환하지 않는다. 진행 중인 응답이 다른 대화에 섞이지 않게 하기 위함이다.
  const handleNewChat = () => {
    if (isLoading) return
    resetConversation()
    setChatId(null)
    setMobileTab('chat')
    if (isMobile) setSidebarOpen(false)
  }

  const handleSelectChat = async (id: string) => {
    if (isLoading || id === chatId || loadingChatId) return
    setLoadingChatId(id)
    try {
      const chat = chatCacheRef.current.get(id) ?? await loadChat(activeApiKey, id)
      if (!chat) {
        setChats((prev) => prev.filter((c) => c.id !== id))
        setStorageError('대화를 찾을 수 없습니다')
        return
      }
      resetConversation()
      setChatId(chat.id)
      chatCreatedAtRef.current = chat.createdAt
      setMessages(chat.messages)
      projectFilesRef.current = chat.projectFiles
      setProjectFiles(chat.projectFiles)
      setProjectType(chat.projectType)
      setGithubRepo(chat.githubRepo ?? null)
      const lastAnswer = chat.messages.map((m) => m.role).lastIndexOf('assistant')
      setAnswerIndex(lastAnswer >= 0 ? lastAnswer : null)
      setVersionIndex(null)
      focusPanel('preview')
      setMobileTab('chat')
      if (isMobile) setSidebarOpen(false)
      chatCacheRef.current.set(chat.id, chat)
      // 생성 도중 닫힌 대화면 서버에 남은 생성을 이어 받는다.
      const last = chat.messages[chat.messages.length - 1]
      if (last?.role === 'assistant' && last.generationId) {
        runGeneration(chat.messages.slice(0, -1), last.generationId, { files: chat.projectFiles, type: chat.projectType }, true)
      }
    } catch (e) {
      storageFailMessage('대화를 불러오지 못했습니다')(e)
    } finally {
      setLoadingChatId(null)
    }
  }

  const handleDeleteChat = async (id: string) => {
    if (isLoading) return
    const title = chats.find((c) => c.id === id)?.title ?? '이 대화'
    if (!window.confirm(`'${title}' 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return
    try {
      await deleteChat(activeApiKey, id)
      chatCacheRef.current.delete(id)
      setChats((prev) => prev.filter((c) => c.id !== id))
      if (id === chatId) handleNewChat()
    } catch {
      setStorageError('대화를 삭제하지 못했습니다')
    }
  }

  // 대화의 결과물 카드를 누르면 캔버스를 미리보기로 연다. 모바일은 캔버스 탭으로 넘어간다.
  const handleOpenAnswer = (index: number) => {
    setAnswerIndex(index)
    setCanvasClosed(false)
    focusPanel('preview')
    setMobileTab('preview')
  }

  // 답변 시점의 파일 사본으로 현재 프로젝트를 바꾼다. 코드 탭에서 직접 고친 내용도 함께 사라지므로 먼저 확인받는다.
  const handleRestore = (index: number) => {
    const { snapshot, projectType: pType } = messages[index] ?? {}
    if (isLoading || !snapshot || !pType) return
    if (!window.confirm('현재 파일(코드 탭에서 직접 고친 내용 포함)이 이 답변 시점의 버전으로 바뀝니다. 되돌릴까요?')) return
    projectFilesRef.current = snapshot
    setProjectFiles(snapshot)
    setProjectType(pType)
    unsavedRef.current = true
    setVersionIndex(index)
  }

  // 파일 사본이 있는 답변을 순서대로 v1, v2… 로 센다.
  const versions = messages.flatMap((m, i) => (m.snapshot ? [i] : []))
  const versionPos = versionIndex !== null && versions.includes(versionIndex) ? versions.indexOf(versionIndex) : versions.length - 1

  const handleFilesChange = (nextFiles: Record<string, string>) => {
    projectFilesRef.current = nextFiles
    setProjectFiles(nextFiles)
    unsavedRef.current = true
  }

  // 결과물(파일)이 생기기 전이나 ✕ 로 닫았을 때는 오른쪽 패널을 숨기고 대화를 화면 가운데에 둔다.
  const canvasOpen = Object.keys(projectFiles).length > 0 && !canvasClosed

  const sidebar = (
    <Sidebar
      chats={chats}
      activeId={chatId}
      loadingId={loadingChatId}
      busy={isLoading}
      error={storageError}
      onSelect={handleSelectChat}
      onNew={handleNewChat}
      onDelete={handleDeleteChat}
      onClose={toggleSidebar}
      drive={USE_DRIVE ? { configured: isDriveConfigured(), connected: driveConnected, expired: !driveConnected && isDriveExpired(), account: driveAccount()?.email, busy: driveBusy, onConnect: handleConnectDrive, onDisconnect: handleDisconnectDrive } : undefined}
    />
  )

  return (
    <div
      className="flex flex-col h-dvh overflow-hidden"
    >
      {/* 모바일: 대화 목록을 화면 왼쪽 서랍으로 띄운다. 바깥을 누르거나 Esc 로 닫는다. */}
      {isMobile && sidebarOpen && (
        <div className="fixed inset-0 z-40 flex" style={{ background: 'rgba(20,20,19,0.4)' }}
          onClick={(e) => e.target === e.currentTarget && setSidebarOpen(false)}>
          <div className="h-full" style={{ boxShadow: '4px 0 16px rgba(0,0,0,0.2)' }}>{sidebar}</div>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* 데스크톱: 접으면 펼치기 버튼만 담은 레일을 남긴다. */}
        {!isMobile && (sidebarOpen
          ? <div className="flex-shrink-0">{sidebar}</div>
          : <div className="sidebar-rail">
              <button onClick={toggleSidebar} className="icon-btn" aria-label="대화 목록 펼치기" aria-expanded={false}>
                <PanelLeft style={{ width: 18, height: 18 }} />
              </button>
            </div>)}
        {/* 모바일에서도 두 패널을 모두 마운트해 둔다. 탭 전환으로 입력 중인 내용·배포 상태가 사라지지 않게 하기 위함이다. */}
        <div className={`flex flex-col min-w-0 ${isMobile || !canvasOpen ? 'flex-1' : ''} ${isMobile && canvasOpen && mobileTab !== 'chat' ? 'hidden' : ''}`}>
          <Header
            apiKey={activeApiKey}
            model={activeModel}
            modelOptions={modelOptions}
            onModelOptionsChange={handleModelOptionsChange}
            onApiKeyChange={handleApiKeyChange}
            onModelChange={handleModelChange}
            isEnvKey={Boolean(envKey)}
            isMobile={isMobile}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
            theme={theme}
            onToggleTheme={toggleTheme}
            onNewChat={handleNewChat}
            busy={isLoading}
          />
          {/* ChatPanel 은 가로 줄 안에서 너비를 잡도록 짜여 있어 남은 높이를 채우는 가로 줄로 감싼다. */}
          <div className="flex flex-1 min-h-0">
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onStop={handleStop}
            onRetry={handleRetry}
            onContinue={handleContinue}
            isLoading={isLoading}
            hasApiKey={!!activeApiKey}
            width={isMobile || !canvasOpen ? undefined : chatWidth}
            tokenUsage={tokenUsage}
            balance={balance}
            onBalanceChange={handleBalanceChange}
            lastCost={lastCost}
            usageTotals={usageTotals}
            onResetUsage={() => setUsageTotals(resetUsage())}
            activeAnswerIndex={answerIndex}
            onOpenAnswer={handleOpenAnswer}
            onRestore={handleRestore}
          />
          </div>
        </div>
        {/* Drag handle */}
        {!isMobile && canvasOpen && <div
          onPointerDown={onMouseDown}
          onPointerMove={onMouseMove}
          onPointerUp={onMouseUp}
          onPointerCancel={onMouseUp}
          onKeyDown={onResizerKeyDown}
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="채팅 패널 너비 조절 (←/→)"
          aria-valuenow={Math.round(chatWidth)}
          aria-valuemin={CHAT_MIN_WIDTH}
          className="chat-resizer"
        >
          <span className="chat-resizer-grip" aria-hidden="true"><GripVertical style={{ width: 12, height: 12 }} /></span>
        </div>}
        {/* Code preview panel */}
        <div className={`flex flex-1 min-w-0 ${(isMobile && mobileTab !== 'preview') || !canvasOpen ? 'hidden' : ''}`}>
          <PreviewPanel
            key={sessionKey}
            files={projectFiles}
            projectType={projectType}
            isLoading={isLoading}
            onImport={handleImportProject}
            onFilesChange={handleFilesChange}
            githubRepo={githubRepo}
            onGithubRepoChange={handleGithubRepoChange}
            focus={panelFocus}
            onClose={() => (isMobile ? setMobileTab('chat') : setCanvasClosed(true))}
            version={{ pos: versionPos, total: versions.length }}
            onVersionChange={(pos) => handleRestore(versions[pos])}
          />
        </div>
      </div>
    </div>
  )
}
