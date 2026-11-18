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
import { backupChat, chatTitle, clearDriveListCache, storageStatusLine, deleteChat, listChats, loadChat, saveChat, savePendingNow, USE_DRIVE } from './services/chatStore'
import DriveConnectModal from './components/DriveConnectModal'
import ProjectModal from './components/ProjectModal'
import { createRepoWithFiles, updateRepoWithFiles } from './services/github'
import ChatFiles, { chatFileCount } from './components/ChatFiles'
import { loadProjects, newProject, projectContext, saveProjects } from './services/projectStore'
import type { Project } from './services/projectStore'
import { bindChatProject, exportProject, FileScopeError, cleanFileName, moveChatFolder, renameProjectFolder, importPicked, isPickerConfigured, listFolder, loadAttachment, pickDriveFile, readAttachmentText, readFromProject, saveToProject } from './services/driveExport'
import type { PickerDoc } from './services/driveExport'
import { downloadOutputFile } from './services/ai'
import { canDriveStaySignedIn, connectDrive, disconnectDrive, driveAccount, driveStaysSignedIn, hasFileScope, DriveAuthError, isDriveConfigured, isDriveConnected, isDriveExpired, onDriveChange } from './services/drive'
import type { GithubRepo } from './services/chatStore'
import type { ChatListItem as ChatSummary, StoredChat } from './services/chatStore'
import { useEscapeKey } from './hooks/useEscapeKey'
import { notifyEnabled, notifySupported, onNotificationOpen, setNotifyEnabled, showSystemNotification } from './services/notify'
import { disablePush, enablePush, notifyHeader, pushEnabled, pushSupported, resyncPush } from './services/push'
import { BROWSER_TOOL, browserOnForChat, detectExtension, isMobileDevice, MIN_EXTENSION_VERSION, runBrowserTool, setBrowserForChat, versionLess } from './services/browserExt'
import type { ConfirmRequest } from './services/browserExt'
import BrowserExtModal from './components/BrowserExtModal'
import MemoryGuideModal from './components/MemoryGuideModal'
import { attachmentBytes, REQUEST_ATTACH_LIMIT } from './services/fileExtract'
import { RELEASE_NOTE } from './releaseNote'
import { X } from './icons'
import Header from './components/Header'  // 상단 헤더 (로고, 설정, API 키)
import ChatPanel from './components/ChatPanel'  // 좌측 채팅 패널
import PreviewPanel from './components/PreviewPanel'  // 우측 코드 미리보기 패널
import type { PanelTab } from './components/PreviewPanel'
// AI 서비스 함수들 (스트리밍, 파싱, 모델 정보)
import { streamCode, resumeCode, cancelGeneration, parseVibe, hideConfirmTag, contextBudget, longPromptThreshold, isBuildRequest, USE_GENERATION_SERVER, MODELS, effectiveOptions, MEMORY_TOOL } from './services/ai'
import type { ClientToolResult, CodeMode, MessageDoc, ModelOptions, WebSource } from './services/ai'
import { runEditorCommand } from './services/textEditor'
import { loadMemory, memoryContext, runMemoryCommand } from './services/memoryStore'
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
// 앱 안 알림(토스트)이 떠 있는 시간
const TOAST_MS = 8000
// 탭 제목 원본(버전 포함). 새 답변이 있으면 앞에 개수를 붙인다.
const BASE_TITLE = document.title

/**
 * 진행 중인 생성 1건. 대화마다 하나씩, 여러 대화에서 동시에 돌 수 있다.
 * 생성 중인 대화의 메시지·파일은 화면(React 상태)이 아니라 이 객체가 원본이다.
 * 그 대화가 화면에 떠 있을 때만 화면에 반영하고, 뒤에서 끝나면 스스로 저장한다.
 */
interface Run {
  chatId: string
  /** 지금 서버에서 돌고 있는 생성 id(형식 보정 중에는 보정 요청의 id). 중지할 때 쓴다. */
  generationId: string
  controller: AbortController
  history: Message[]
  messages: Message[]
  files: Record<string, string>
  type: ProjectType
  githubRepo: GithubRepo | null
  projectId: string | null
  createdAt: number
  model: string
  /** 요청 직전의 프로젝트. 응답 파일을 이 위에 합친다. */
  base: { files: Record<string, string>; type: ProjectType }
  buffer: string
  thinking: string
  sources: Map<string, WebSource>
  outputFiles: string[]
  edited: Set<string>
  structuralChange: boolean
  turnUsage: { usage: TokenUsage; cost: number } | null
  contextTokens: number
  lastPatch: string
  lastPatchAt: number
  pendingPatch: { files: Record<string, string>; projectType: ProjectType; fingerprint: string } | null
  patchTimer: ReturnType<typeof setTimeout> | null
  /** 생성 중에 대화를 지웠다. 끝나도 저장하지 않는다. */
  discarded: boolean
}

// 이미지만 보내고 글을 비웠을 때 대신 보내는 요청
const IMAGE_ONLY_PROMPT = '이 이미지를 설명해 주세요'

// 파일 편집처럼 연속으로 바뀌는 변경을 한 번에 저장하기 위한 대기 시간
const SAVE_DELAY_MS = 500

// 앱이 직접 실행하는 도구(Claude 가 필요할 때만 호출). 내용이 고정이라 캐시되는 앞부분에 들어가 평소 비용이 거의 없다.
const APP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'app_status',
    description: "Returns this app's current state: where chats are saved (Google Drive connection and account, uploads waiting in the browser), the model, and which tools are on. Call only when the user asks about these.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'github',
    description: "Commits and pushes the current project files to the user's GitHub repository. Use it only when the user asks to commit, push, upload or save the code to GitHub. command \"status\" tells whether a GitHub token and repository are connected. command \"commit_push\" uploads every current project file to the connected repository (or creates a new repository named repo_name when none is connected); the app asks the user to confirm first. A GitHub token must be entered once in the app's \"API 키\" settings (top right, GitHub 토큰 field); if it is missing, tell the user to add it there.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['status', 'commit_push'] },
        repo_name: { type: 'string', description: 'commit_push only when no repository is connected: name of the new repository to create' },
        public: { type: 'boolean', description: 'commit_push when creating a new repository: true only if the user explicitly asks for a public repository. Default is private.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'project_files',
    description: "Reads, deletes or renames files of the current project (the files listed in the conversation). Use read to see a file whose content was not included (large files, imports/ data, or when only the file list was sent). Use delete/rename only when the user asks to remove or rename a file. To create or rewrite a file, use <VIBE_FILE> instead.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['list', 'read', 'delete', 'rename'] },
        path: { type: 'string', description: 'Project file path, e.g. "app.js" or "imports/data.csv"' },
        new_path: { type: 'string', description: 'New path for rename' },
        start_line: { type: 'integer', description: 'read: first line to return (1-based, default 1)' },
        max_lines: { type: 'integer', description: 'read: number of lines to return (default: whole file up to 60,000 chars)' },
      },
      required: ['command'],
    },
  },
  ...(USE_DRIVE && isDriveConfigured() ? [{
    name: 'drive_files',
    description: "Saves or lists VISIBLE files in the user's Google Drive under 'Vibe Coding/<this project>/'. Project files are already auto-saved there after each answer when auto-save is on. Use when the user asks to save something to Drive or to see what is in the Drive folder. Only files this app created are visible (not the user's other Drive folders).",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['save_project', 'save_text', 'save_outputs', 'list', 'read', 'pick', 'read_attachment', 'copy_to_project'], description: 'save_project: save all current project files now; save_text: save `content` as file `path`; save_outputs: save files produced by code execution in this chat; list: list the project folder (or the Vibe Coding root when scope is "root"); read: read file `path` from the project folder; pick: open the Google file picker and read a text file the user chooses; read_attachment: read a large attached Drive file by name (`path` = attachment name) when you actually need its content; copy_to_project: copy an attached Drive file into the project folder (imports/) and make it an editable project file — only when the user wants to edit or reuse it (the original is never modified)' },
        path: { type: 'string', description: 'File path for save_text/read, e.g. "report.md" or "imports/notes.txt"' },
        content: { type: 'string', description: 'Text content for save_text' },
        scope: { type: 'string', enum: ['project', 'root'], description: 'For list' },
      },
      required: ['command'],
    },
  }, {
    name: 'request_drive_connection',
    description: 'Shows the user a popup asking them to connect Google Drive. Use when the user wants chats saved to or loaded from Google Drive and Drive is not connected or expired.',
    input_schema: { type: 'object', properties: {} },
  }] : []),
]
// 생성 도중 받은 부분을 최근 대화 백업(IndexedDB)에 남기는 간격. 브라우저가 죽어도 여기까지는 복구된다.
const PARTIAL_BACKUP_MS = 4000

// index.css 의 모바일 미디어 쿼리(max-width: 767px)와 같은 경계를 쓴다.
const MOBILE_QUERY = '(max-width: 767px)'

// 채팅 패널 너비 범위: 최소 200px, 최대 화면 너비의 60%. 키보드 조절은 한 번에 20px.
const CHAT_MIN_WIDTH = 200
const CHAT_KEY_STEP = 20
/** 주소의 ?chat=<id> 를 읽고 주소에서 지운다(푸시 알림으로 앱을 열었을 때). */
function chatFromUrl(): string | null {
  try {
    const url = new URL(location.href)
    const id = url.searchParams.get('chat')
    if (!id) return null
    url.searchParams.delete('chat')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return /^[\w-]{1,64}$/.test(id) ? id : null
  } catch { return null }
}

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
  // 화면에 떠 있는 대화가 생성 중인지. 다른 대화의 생성은 runsRef 에 따로 있다.
  const [isLoading, setIsLoading] = useState(false)
  // 진행 중인 생성(대화 id → Run)과, 화면에 떠 있는 대화 id(생성 코드가 최신 값을 바로 읽도록 ref)
  const runsRef = useRef(new Map<string, Run>())
  const fgChatIdRef = useRef<string | null>(null)
  const isFg = (run: Run) => run.chatId === fgChatIdRef.current
  // 사이드바 표시용: 생성 중인 대화, 뒤에서 끝났지만 아직 열어 보지 않은 대화
  const [runningIds, setRunningIds] = useState<string[]>([])
  const [unreadIds, setUnreadIds] = useState<string[]>([])
  const syncRunning = () => setRunningIds([...runsRef.current.keys()])

  // ── 답변 완료 알림 ──
  // 다른 대화의 답변이 끝나면: 앱 안 알림(토스트) + 사이드바 점 + 탭 제목 개수. 화면을 보고 있지 않으면 시스템 알림(켠 경우)도 띄운다.
  const [toasts, setToasts] = useState<{ id: number; chatId: string; title: string; failed: boolean }[]>([])
  const toastSeqRef = useRef(0)
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id))
  const [notifyOn, setNotifyOn] = useState(notifyEnabled)
  // 화면의 대화가 끝났는데 사용자가 다른 탭·창을 보고 있었다. 돌아오면 지운다.
  const [attention, setAttention] = useState(false)
  // 알림에서 대화를 열 때 최신 handleSelectChat 을 부르기 위한 ref
  const selectChatRef = useRef<(id: string) => void>(() => {})
  const announceDone = (run: Run) => {
    const failed = !!run.messages[run.messages.length - 1]?.failed
    const title = chatTitle(run.messages)
    const away = document.visibilityState !== 'visible' || !document.hasFocus()
    if (!isFg(run)) {
      const id = ++toastSeqRef.current
      setToasts((prev) => [...prev.filter((t) => t.chatId !== run.chatId), { id, chatId: run.chatId, title, failed }].slice(-3))
      setTimeout(() => dismissToast(id), TOAST_MS)
    } else if (away) {
      setAttention(true)
    } else {
      return
    }
    showSystemNotification(run.chatId, failed ? '답변 생성 중 오류가 났어요' : '답변이 완료됐어요', title, (id) => selectChatRef.current(id))
  }
  useEffect(() => {
    const n = unreadIds.length + (attention ? 1 : 0)
    document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE
  }, [unreadIds.length, attention])
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') setAttention(false) }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    const off = onNotificationOpen((id) => selectChatRef.current(id))
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); off() }
  }, [])
  // 웹 푸시(앱을 닫아도 오는 알림): 알림을 켜면 함께 켠다. 서버에 푸시 설정이 없으면 앱이 열려 있을 때만 알린다.
  const [pushOn, setPushOn] = useState(pushEnabled)
  const toggleNotify = async (on: boolean) => {
    const ok = await setNotifyEnabled(on)
    setNotifyOn(ok)
    if (on && !ok) setStorageError('알림이 차단돼 있어요. 브라우저 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 켜 주세요')
    if (on && ok && pushSupported()) {
      const r = await enablePush(activeApiKeyRef.current)
      setPushOn(r === 'on')
      if (r === 'error') setStorageError('앱을 닫아도 오는 알림(푸시)을 켜지 못했어요. 앱이 열려 있는 동안의 알림은 켜졌어요')
    }
    if (!on) { await disablePush(activeApiKeyRef.current); setPushOn(false) }
  }
  // ── 브라우저 조작(크롬 확장) ──
  // 확장이 있으면 버전, 없으면 null. 창으로 돌아올 때마다 다시 확인한다(설치·삭제를 바로 반영).
  const [extVersion, setExtVersion] = useState<string | null>(null)
  const extVersionRef = useRef<string | null>(null)
  // 한 번 찾은 뒤에는 연달아 두 번 못 찾을 때만 '없음'으로 바꾼다(잠깐 응답이 늦어 버튼이 사라지지 않게).
  const extMissRef = useRef(0)
  const checkExtension = async () => {
    const v = await detectExtension()
    if (v) extMissRef.current = 0
    else if (extVersionRef.current && ++extMissRef.current < 2) return extVersionRef.current
    extVersionRef.current = v
    setExtVersion(v)
    return v
  }
  useEffect(() => {
    const check = () => { void checkExtension() }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  const [extModal, setExtModal] = useState(false)
  const [memoryGuide, setMemoryGuide] = useState(false)
  // 화면의 대화에서 browser 도구를 켰는지(대화마다, 기본 끔). 새 대화에서 켜면 첫 전송 때 그 대화에 기록한다.
  const [browserOn, setBrowserOnState] = useState(false)
  const browserOnRef = useRef(false)
  browserOnRef.current = browserOn
  // 위험한 동작·처음 여는 사이트 확인(채팅 위 카드). 여러 대화에서 동시에 올 수 있어 줄을 세운다.
  const [confirms, setConfirms] = useState<{ id: number; chatId: string; chatTitle: string; req: ConfirmRequest; resolve: (ok: boolean) => void }[]>([])
  const confirmSeqRef = useRef(0)
  const requestConfirm = (run: Run, req: ConfirmRequest) => new Promise<boolean>((resolve) => {
    const id = ++confirmSeqRef.current
    setConfirms((prev) => [...prev, { id, chatId: run.chatId, chatTitle: chatTitle(run.messages), req, resolve }])
    // 크롬 창을 보고 있으면 확인 카드를 못 볼 수 있어 시스템 알림도 띄운다(알림을 켠 경우).
    showSystemNotification(run.chatId, '브라우저 작업 확인이 필요해요', req.title, (cid) => selectChatRef.current(cid))
    // 생성을 멈추면 거절로 처리한다.
    run.controller.signal.addEventListener('abort', () => answerConfirm(id, false), { once: true })
  })
  const answerConfirm = (id: number, ok: boolean) => setConfirms((prev) => {
    const c = prev.find((x) => x.id === id)
    if (c) c.resolve(ok)
    return prev.filter((x) => x.id !== id)
  })
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)
  const [lastCost, setLastCost] = useState(0)
  const [usageTotals, setUsageTotals] = useState(loadUsage)
  // 요청 1건이 끝날 때마다 호출된다. 화면의 '이번' 값을 바꾸고 오늘·누적 합계에 더한다.
  const [balance, setBalanceState] = useState<Balance | null>(() => loadBalance())
  const handleBalanceChange = (amount: number | null) => setBalanceState(setBalance(amount))
  // 지금 대화가 차지한 컨텍스트(가장 최근 요청의 입력 전체 + 출력). 다음 턴에 이만큼이 다시 입력으로 간다.
  const [contextTokens, setContextTokens] = useState(0)
  const contextTokensRef = useRef(0)
  // 한 턴(질문 1개)이 도구 왕복으로 요청 여러 번이 될 수 있어, '이번' 표시는 턴 안에서 합산한다. 누적·잔액은 요청마다 더한다.
  const recordUsage = (run: Run, usage: TokenUsage) => {
    run.contextTokens = usage.promptTokens + usage.completionTokens
    const cost = estimateCost(run.model, usage)
    const prev = run.turnUsage
    const sum: TokenUsage = prev ? {
      ...usage,
      promptTokens: prev.usage.promptTokens + usage.promptTokens,
      cacheWriteTokens: prev.usage.cacheWriteTokens + usage.cacheWriteTokens,
      cacheWrite1hTokens: (prev.usage.cacheWrite1hTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0),
      cacheReadTokens: prev.usage.cacheReadTokens + usage.cacheReadTokens,
      completionTokens: prev.usage.completionTokens + usage.completionTokens,
      totalTokens: prev.usage.totalTokens + usage.totalTokens,
    } : usage
    run.turnUsage = { usage: sum, cost: (prev?.cost ?? 0) + cost }
    // 오늘·누적 합계와 잔액은 어느 대화의 요청이든 더한다. '이번' 값과 컨텍스트 게이지는 화면의 대화일 때만 바꾼다.
    setUsageTotals(addUsage(run.model, usage))
    setBalanceState(loadBalance())
    if (!isFg(run)) return
    contextTokensRef.current = run.contextTokens
    setContextTokens(run.contextTokens)
    setTokenUsage(sum)
    setLastCost(run.turnUsage.cost)
  }
  // 대화에서 선택된 답변 위치와, 캔버스 탭 전환 요청
  const [answerIndex, setAnswerIndex] = useState<number | null>(null)
  // 캔버스에 띄운 버전(파일 사본이 있는 답변의 메시지 위치). null 이면 최신 버전이다.
  const [versionIndex, setVersionIndex] = useState<number | null>(null)
  // 캔버스 ✕ 로 닫았는지. 새 요청·결과물 카드·대화 전환 때 다시 연다.
  const [canvasClosed, setCanvasClosed] = useState(false)
  // 코딩 모드(입력창 오른쪽 아래). 수동: 명확한 요청 없이는 코드를 만들지 않고 먼저 확인. 브라우저가 기억한다.
  const [codeMode, setCodeModeState] = useState<CodeMode>(() => { try { return localStorage.getItem('vibe_code_mode') === 'auto' ? 'auto' : 'manual' } catch { return 'manual' } })
  const setCodeMode = (m: CodeMode) => { setCodeModeState(m); try { localStorage.setItem('vibe_code_mode', m) } catch { /* 무시 */ } }
  const [panelFocus, setPanelFocus] = useState<{ tab: PanelTab; seq: number }>({ tab: 'preview', seq: 0 })
  const focusPanel = (tab: PanelTab) => setPanelFocus((prev) => ({ tab, seq: prev.seq + 1 }))
  const envKey = (import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined)?.trim() || ''
  const [activeApiKey, setActiveApiKey] = useState(() => envKey || localStorage.getItem('vibe_api_key_anthropic') || '')
  // 저장된 모델이 현재 MODELS 에 없으면(이전 버전의 값 등) 기본 모델로 되돌린다.
  const [activeModel, setActiveModel] = useState(() => {
    const saved = localStorage.getItem('vibe_model')
    return saved && MODELS.some((m) => m.id === saved) ? saved : MODELS[0].id
  })

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
  const [chatId, setChatIdState] = useState<string | null>(null)
  const setChatId = (id: string | null) => { fgChatIdRef.current = id; setChatIdState(id) }
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
  // 드라이브 연결 안내 팝업. welcome: 처음 실행(한 번도 연결 안 함), request: 챗봇이 연결을 요청함
  // 프로젝트 파일 자동 저장(내 드라이브 Vibe Coding 폴더). 기본 켬.
  const [driveAutoSave, setDriveAutoSave] = useState(() => { try { return localStorage.getItem('vibe_drive_autosave') !== '0' } catch { return true } })
  const toggleDriveAutoSave = (on: boolean) => { setDriveAutoSave(on); try { localStorage.setItem('vibe_drive_autosave', on ? '1' : '0') } catch { /* 무시 */ } }
  const [driveFolderUrl, setDriveFolderUrl] = useState<string | null>(null)
  const scopeAskedRef = useRef(false)
  const [driveModal, setDriveModal] = useState<'welcome' | 'request' | 'scope' | null>(() => {
    try {
      if (!USE_DRIVE || !isDriveConfigured() || isDriveConnected() || driveAccount()) return null
      return localStorage.getItem('vibe_drive_prompt_off') === '1' ? null : 'welcome'
    } catch { return null }
  })
  const [driveModalError, setDriveModalError] = useState('')
  const connectFromModal = async () => {
    setDriveModalError('')
    setDriveBusy(true)
    try {
      // 권한 추가 팝업이면 drive.file 동의 화면을 띄운다. 그 외에는 처음 연결(두 권한 함께) 또는 재연결.
      const wasScope = driveModal === 'scope'
      await connectDrive(wasScope ? { withFiles: true } : {})
      setStorageError('')
      setDriveModal(null)
      // 권한을 추가했으면 지금 프로젝트를 바로 드라이브 폴더에 저장한다.
      const id = fgChatIdRef.current
      if (wasScope && driveAutoSave && id && Object.keys(projectFilesRef.current).length) {
        exportProject(id, chatTitle(messages), projectFilesRef.current).then((r) => setDriveFolderUrl(r.url)).catch(() => {})
      }
    } catch (e) {
      setDriveModalError(e instanceof Error ? e.message : 'Google 드라이브에 연결하지 못했습니다')
    } finally {
      setDriveBusy(false)
    }
  }
  const closeDriveModal = (dontShowAgain: boolean) => {
    if (dontShowAgain) { try { localStorage.setItem('vibe_drive_prompt_off', '1') } catch { /* 무시 */ } }
    setDriveModal(null)
    setDriveModalError('')
  }

  const handleDisconnectDrive = () => {
    disconnectDrive()
    clearDriveListCache()
    chatCacheRef.current.clear()
  }
  // 저장 위치(브라우저 ↔ 드라이브)가 바뀌면 보관본을 비우고 목록을 다시 받는다(아래 목록 effect).
  useEffect(() => { chatCacheRef.current.clear() }, [driveConnected])

  useEffect(() => {
    loadProjects().then(setProjects).catch(() => {})
  }, [driveConnected])
  useEffect(() => {
    if (!storageReady) return
    listChats(activeApiKey).then(setChats).catch(storageFailMessage('대화 목록을 불러오지 못했습니다'))
  }, [activeApiKey, storageReady, driveConnected])

  // 새로고침해도 마지막에 열어 둔 대화를 다시 연다. 저장소를 쓸 수 있게 된 첫 시점에 한 번만 연다.
  // 아래 기억 effect 가 키를 지우기 전에 읽어 둔다.
  // 푸시 알림을 눌러 앱이 새로 열리면 주소의 ?chat=<id> 대화를 연다(주소에서는 지운다).
  const lastChatIdRef = useRef(chatFromUrl() ?? localStorage.getItem('vibe_chat_id'))
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
  // 대화를 바꾸면 그 대화의 브라우저 켜짐 상태를 불러온다. 새 대화(첫 전송 전)는 꺼진 채로 시작한다.
  const browserChatRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = browserChatRef.current
    browserChatRef.current = chatId
    // 새 대화에서 켠 뒤 첫 전송으로 id 가 생긴 경우는 켜진 상태를 그대로 둔다(runGeneration 이 기록).
    if (prev === null && chatId && browserOnRef.current) return
    setBrowserOnState(browserOnForChat(chatId))
  }, [chatId])
  const toggleBrowser = (on: boolean) => {
    setBrowserOnState(on)
    if (chatId) setBrowserForChat(chatId, on)
  }

  // 같은 대화의 저장이 겹치면(시작 시 저장 ↔ 끝난 뒤 저장) 드라이브에 파일이 둘 생기거나 옛 내용이 나중에 덮어쓸 수 있어, 대화별로 한 줄로 세운다.
  const saveQueueRef = useRef(new Map<string, Promise<unknown>>())
  const persistChat = (chat: StoredChat): Promise<void> => {
    chatCacheRef.current.set(chat.id, chat)
    const prev = saveQueueRef.current.get(chat.id) ?? Promise.resolve()
    const job = prev.catch(() => {}).then(async () => {
      const where = await saveChat(activeApiKey, chat)
      // 연결된 상태인데 브라우저에 저장됐다 = 드라이브 저장이 실패해 대기 저장으로 돌린 것
      setStorageError(where === 'local' && isDriveConnected() ? '드라이브 저장에 실패해 이 브라우저에 임시 저장했어요. 새로고침하면 다시 올립니다' : '')
      setChats((prevChats) => [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, projectId: chat.projectId, ...(where === 'local' ? { pending: true } : {}) }, ...prevChats.filter((c) => c.id !== chat.id)])
    })
    saveQueueRef.current.set(chat.id, job)
    job.catch(() => {}).finally(() => { if (saveQueueRef.current.get(chat.id) === job) saveQueueRef.current.delete(chat.id) })
    return job
  }
  // 화면의 대화를 지금 상태의 프로젝트와 함께 저장하고 목록 맨 위로 올린다. 실패하면 reject 한다.
  const storeChat = (id: string, msgs: Message[]) => persistChat({
    id,
    title: chatTitle(msgs),
    createdAt: chatCreatedAtRef.current,
    updatedAt: Date.now(),
    messages: msgs,
    projectFiles,
    projectType,
    githubRepo,
    projectId: chatProjectIdRef.current,
  })
  // 뒤에서 끝난 생성의 결과를 저장한다(화면 상태가 아니라 Run 이 가진 내용으로).
  const saveRun = (run: Run) => persistChat({
    id: run.chatId,
    title: chatTitle(run.messages),
    createdAt: run.createdAt,
    updatedAt: Date.now(),
    messages: run.messages,
    projectFiles: run.files,
    projectType: run.type,
    githubRepo: run.githubRepo,
    projectId: run.projectId,
  })
  // 화면의 대화를 떠나기 직전: 저장 대기(0.5초) 중인 변경이 있으면 지금 저장한다. 생성 중인 대화는 Run 이 끝날 때 저장한다.
  const leaveForeground = () => {
    interruptRef.current = null
    const id = fgChatIdRef.current
    if (!id || runsRef.current.has(id) || !unsavedRef.current || messages.length === 0) return
    unsavedRef.current = false
    storeChat(id, messages).catch(storageFailMessage('대화를 저장하지 못했습니다 (저장소에 연결할 수 없음)'))
  }

  // ── 프로젝트 ───────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([])
  // 지금 대화가 속한 프로젝트(새 대화면 '프로젝트에서 새 대화'로 정해진다). 저장·요청에서 바로 읽도록 ref 도 둔다.
  const [chatProjectId, setChatProjectIdState] = useState<string | null>(null)
  const chatProjectIdRef = useRef<string | null>(null)
  const setChatProjectId = (pid: string | null) => { chatProjectIdRef.current = pid; setChatProjectIdState(pid) }
  const [projectModal, setProjectModal] = useState<Project | 'new' | null>(null)
  const currentProject = projects.find((p) => p.id === chatProjectId)
  const updateProjects = (next: Project[]) => {
    setProjects(next)
    saveProjects(next).catch(() => {})
  }
  const handleSaveProject = (p: Project) => {
    const exists = projects.some((x) => x.id === p.id)
    const prev = projects.find((x) => x.id === p.id)
    updateProjects(exists ? projects.map((x) => (x.id === p.id ? p : x)) : [p, ...projects])
    if (prev && prev.name !== p.name) renameProjectFolder(p).catch(() => {})
    setProjectModal(null)
  }
  /** 프로젝트 삭제: 대화는 지우지 않고 프로젝트 밖으로 꺼낸다(드라이브 폴더도 그대로). */
  const handleDeleteProject = (p: Project) => {
    updateProjects(projects.filter((x) => x.id !== p.id))
    if (chatProjectId === p.id) setChatProjectId(null)
    setProjectModal(null)
  }
  /** 프로젝트 안에서 새 대화 */
  const handleNewChatInProject = (pid: string) => {
    leaveForeground()
    resetConversation()
    setChatId(null)
    setChatProjectId(pid)
    setMobileTab('chat')
    if (isMobile) setSidebarOpen(false)
  }
  /** 대화를 다른 프로젝트로 옮기거나(pid) 프로젝트에서 뺀다(null). */
  const handleMoveChat = async (id: string, pid: string | null) => {
    try {
      const chat = id === chatId
        ? null
        : chatCacheRef.current.get(id) ?? await loadChat(activeApiKey, id)
      // 생성 중인 대화면 끝날 때 저장되는 내용에도 반영한다.
      const running = runsRef.current.get(id)
      if (running) running.projectId = pid
      if (id === chatId) {
        setChatProjectId(pid)
        bindChatProject(id, projects.find((p) => p.id === pid))
        if (isDriveConnected()) moveChatFolder(id).catch(() => {})
        unsavedRef.current = true
        setChats((prev) => prev.map((c) => (c.id === id ? { ...c, projectId: pid } : c)))
        return
      }
      if (!chat) return
      const moved = { ...chat, projectId: pid }
      chatCacheRef.current.set(id, moved)
      bindChatProject(id, projects.find((p) => p.id === pid))
      if (isDriveConnected()) moveChatFolder(id).catch(() => {})
      await saveChat(activeApiKey, moved)
      setChats((prev) => prev.map((c) => (c.id === id ? { ...c, projectId: pid } : c)))
    } catch (e) {
      storageFailMessage('대화를 옮기지 못했습니다')(e)
    }
  }

  // 저장 대기(0.5초) 중에 탭을 닫으면 그 내용을 브라우저에 대기 저장해 둔다.
  useEffect(() => {
    const onHide = () => {
      if (!chatId || messages.length === 0 || !unsavedRef.current) return
      savePendingNow({ id: chatId, title: chatTitle(messages), createdAt: chatCreatedAtRef.current, updatedAt: Date.now(), messages, projectFiles, projectType, githubRepo, projectId: chatProjectIdRef.current })
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
    if (!runningIds.length) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [runningIds.length])

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
  // 생성 중인 대화의 메시지·파일을 바꾼다. 화면에 떠 있는 대화일 때만 화면에도 반영한다.
  const runSetMessages = (run: Run, next: Message[] | ((prev: Message[]) => Message[])) => {
    run.messages = typeof next === 'function' ? next(run.messages) : next
    if (isFg(run)) setMessages(run.messages)
  }
  const runSetFiles = (run: Run, files: Record<string, string>, type?: ProjectType) => {
    run.files = files
    if (type) run.type = type
    if (!isFg(run)) return
    projectFilesRef.current = files
    setProjectFiles(files)
    if (type) setProjectType(type)
  }
  const clearPatchTimer = (run: Run) => {
    run.pendingPatch = null
    if (run.patchTimer) { clearTimeout(run.patchTimer); run.patchTimer = null }
  }
  const applyRealtimePatch = (run: Run, files: Record<string, string>, pType: ProjectType, fingerprint: string) => {
    run.lastPatch = fingerprint
    run.lastPatchAt = Date.now()
    runSetFiles(run, mergeFiles(run.base, files, pType), pType)
    // 이번 답변이 실제로 파일을 만들거나 고칠 때만 닫아 둔 미리보기를 연다.
    if (isFg(run)) setCanvasClosed(false)
  }
  const flushPendingRealtimePatch = (run: Run) => {
    const pending = run.pendingPatch
    if (!pending) return
    run.pendingPatch = null
    applyRealtimePatch(run, pending.files, pending.projectType, pending.fingerprint)
  }
  const handleApiKeyChange = (key: string) => {
    setActiveApiKey(key)
    localStorage.setItem('vibe_api_key_anthropic', key)
  }
  // 푸시 구독은 API 키별로 저장된다. 앱 시작·키 변경 때 켜 둔 구독을 다시 등록한다.
  const activeApiKeyRef = useRef(activeApiKey)
  activeApiKeyRef.current = activeApiKey
  useEffect(() => {
    if (activeApiKey) resyncPush(activeApiKey).then(() => setPushOn(pushEnabled())).catch(() => {})
  }, [activeApiKey])

  const handleModelChange = (nextModel: string) => {
    setActiveModel(nextModel)
    localStorage.setItem('vibe_model', nextModel)
  }

  // 모델 옵션: v0.8.0 부터 '생각 요약 보기'만 고르고 나머지(도구·노력·출력 한도 등)는 권장값 고정(effectiveOptions). 모델마다 따로 기억한다.
  // 대화별 기억 스냅숏(이 세션 동안). 새로고침하면 다시 읽는다.
  const memorySnapRef = useRef(new Map<string, string>())
  const [allModelOptions, setAllModelOptions] = useState<Record<string, ModelOptions>>(() => {
    try { return JSON.parse(localStorage.getItem('vibe_model_options') ?? '{}') ?? {} } catch { return {} }
  })
  const modelOptions: ModelOptions = effectiveOptions(allModelOptions[activeModel])
  const handleModelOptionsChange = (next: ModelOptions) => {
    const all = { ...allModelOptions, [activeModel]: next }
    setAllModelOptions(all)
    try { localStorage.setItem('vibe_model_options', JSON.stringify(all)) } catch { /* 이번 세션만 유지 */ }
  }
  // 웹 검색 출처(url 기준, 인용된 것 우선)
  const handleSource = (run: Run, src: WebSource) => {
    const prev = run.sources.get(src.url)
    if (!prev || (src.cited && !prev.cited)) run.sources.set(src.url, src)
  }
  // 도구 진행 상황(검색어·읽는 URL·실행 명령·파일 수정 등)을 생각 요약 칸에 한 줄씩 붙인다.
  const handleActivity = (run: Run, line: string) => handleThinking(run, `${run.thinking && !run.thinking.endsWith('\n') ? '\n' : ''}${line}\n`)
  // Claude 의 GitHub 커밋·푸시 도구. 캔버스 GitHub 버튼에서 저장한 토큰과 연결 저장소를 쓴다. 푸시 전에 사용자 확인을 받는다.
  const runGithubTool = async (run: Run, input: Record<string, unknown>): Promise<ClientToolResult> => {
    let token = ''
    try { token = localStorage.getItem('vibe_gh_token') ?? '' } catch { /* 없음 */ }
    const repo = run.githubRepo
    const files = run.files
    const fileCount = Object.keys(files).length
    if (input.command === 'status') {
      return { content: `GitHub token: ${token ? 'saved' : 'missing (user must add it once in the top-right \"API 키\" settings, GitHub 토큰 field)'}; repository: ${repo ? `${repo.owner}/${repo.repo} (branch ${repo.branch})` : 'none connected'}; project files: ${fileCount}` }
    }
    if (input.command !== 'commit_push') return { content: `Unknown command ${String(input.command)}`, isError: true }
    if (!token) return { content: 'No GitHub token is saved. Ask the user to open the top-right "API 키" settings and enter a GitHub token in the "GitHub 토큰" field once (fine-grained token with Contents write, or classic token with repo scope); after that you can push.', isError: true }
    if (!fileCount) return { content: 'There are no project files to push yet.', isError: true }
    const newName = String(input.repo_name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!repo && !newName) return { content: 'No repository is connected. Ask the user for a repository name, then call commit_push with repo_name.', isError: true }
    const makePublic = input.public === true
    const target = repo ? `${repo.owner}/${repo.repo} (${repo.branch} 브랜치)` : `새 ${makePublic ? '공개' : '비공개'} 저장소 '${newName}'`
    // 다른 대화를 보고 있을 때도 뜰 수 있어 어느 대화의 요청인지 함께 알려 준다.
    if (!window.confirm(`${isFg(run) ? '' : `'${chatTitle(run.messages)}' 대화에서 요청했어요.\n`}GitHub ${target}에 파일 ${fileCount}개를 커밋·푸시할까요?`)) {
      return { content: 'The user declined the push. Nothing was uploaded.' }
    }
    try {
      const res = repo
        ? await updateRepoWithFiles(token, repo.owner, repo.repo, repo.branch, files)
        : await createRepoWithFiles(token, newName, files, !makePublic)
      run.githubRepo = { owner: res.owner, repo: res.repo, branch: res.branch }
      if (isFg(run)) setGithubRepo(run.githubRepo)
      return { content: `Pushed ${fileCount} files to ${res.owner}/${res.repo} (${res.branch}): ${res.url}` }
    } catch (e) {
      return { content: `GitHub push failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }

  const runProjectFiles = (run: Run, input: Record<string, unknown>): ClientToolResult => {
    const files = run.files
    const path = String(input.path ?? '').replace(/^\/+/, '')
    const command = String(input.command ?? '')
    const apply = (next: Record<string, string>) => {
      run.base = { files: next, type: run.base.type }
      runSetFiles(run, next)
      run.structuralChange = true
    }
    if (command === 'list') {
      const names = Object.keys(files)
      return { content: names.length ? names.map((n) => `${n} (${files[n].split('\n').length} lines, ${files[n].length} chars)`).join('\n') : 'No project files yet.' }
    }
    if (!(path in files)) return { content: `No project file "${path}". Files: ${Object.keys(files).join(', ') || 'none'}`, isError: true }
    if (command === 'read') {
      const lines = files[path].split('\n')
      const start = Math.max(1, Number(input.start_line) || 1)
      const count = Number(input.max_lines) > 0 ? Number(input.max_lines) : lines.length
      let text = lines.slice(start - 1, start - 1 + count).join('\n')
      const cut = text.length > 60_000
      if (cut) text = text.slice(0, 60_000)
      return { content: `${path} (lines ${start}-${Math.min(lines.length, start - 1 + count)} of ${lines.length})\n${text}${cut ? '\n…(truncated at 60,000 chars; read the rest with start_line)' : ''}` }
    }
    if (command === 'delete') {
      const next = { ...files }
      delete next[path]
      apply(next)
      return { content: `Deleted ${path}.` }
    }
    if (command === 'rename') {
      const raw = String(input.new_path ?? '').replace(/^\/+/, '')
      const to = raw.split('/').map(cleanFileName).join('/')
      if (!raw) return { content: 'new_path is required.', isError: true }
      if (to in files) return { content: `"${to}" already exists.`, isError: true }
      const next: Record<string, string> = {}
      for (const [n, c] of Object.entries(files)) next[n === path ? to : n] = c
      apply(next)
      return { content: `Renamed ${path} to ${to}.` }
    }
    return { content: `Unknown command ${command}`, isError: true }
  }
  /** 드라이브 파일 첨부: 선택창에서 고른 파일 정보만 돌려준다(내용은 보낼 때 받는다, 폴더도 만들지 않는다). */
  const pickForAttachment = async (): Promise<PickerDoc | null> => {
    if (!isDriveConnected()) { setDriveModal('request'); throw new Error('드라이브 연결이 필요해요') }
    if (!hasFileScope()) { setDriveModal('scope'); throw new Error('드라이브 파일 권한 추가가 필요해요') }
    return pickDriveFile()
  }
  /** 대화에 첨부된 문서 중 이름이 맞는 것(가장 최근) */
  const findDoc = (msgs: Message[], name: string): MessageDoc | undefined =>
    [...msgs].reverse().flatMap((m) => m.docs ?? []).find((d) => d.name === name || d.name.startsWith(name))

  /** 앱이 실행하는 도구: 텍스트 에디터는 현재 프로젝트 사본에, 메모리는 드라이브/브라우저 기억에 적용한다. */
  const runClientTool = async (run: Run, name: string, input: Record<string, unknown>): Promise<ClientToolResult> => {
    const messages = run.messages
    if (name === 'user_memory' || name === 'memory') return runMemoryCommand(input)
    if (name === 'app_status') {
      const on = (Object.entries({ 'web search': modelOptions.webSearch, 'web fetch': modelOptions.webFetch, 'partial edit (text editor)': modelOptions.textEditor, memory: modelOptions.memory, 'code execution': modelOptions.codeExecution }) as [string, boolean][])
        .filter(([, v]) => v).map(([k]) => k)
      return { content: `${await storageStatusLine()} Model: ${run.model}. Tools on: ${on.join(', ') || 'none'}${modelOptions.advisorModel ? `, advisor (${modelOptions.advisorModel})` : ''}.` }
    }
    if (name === 'drive_files') {
      if (!isDriveConnected()) { setDriveModal('request'); return { content: 'Google Drive is not connected. A connect popup is now shown; ask the user to connect and then try again.', isError: true } }
      if (!hasFileScope()) { setDriveModal('scope'); return { content: 'Saving visible files needs one more Google permission. A popup asking the user to allow it is now shown; ask them to press it, then try again.', isError: true } }
      const id = run.chatId
      const showFolder = (url: string) => { if (isFg(run)) setDriveFolderUrl(url) }
      const title = chatTitle(messages.length ? messages : [{ role: 'user', content: '새 프로젝트' }])
      const cmd = String(input.command ?? '')
      if (cmd === 'list') {
        const r = await listFolder(input.scope === 'root' ? undefined : id, title)
        return { content: `${r.url}\n${r.items.join('\n') || '(empty)'}` }
      }
      if (cmd === 'read') {
        const path = String(input.path ?? '').trim()
        if (!path) return { content: 'path is required', isError: true }
        const text = await readFromProject(id, title, path)
        return { content: text.length > 30_000 ? `${text.slice(0, 30_000)}\n... (truncated)` : text }
      }
      if (cmd === 'pick') {
        // 선택창 설정이 빠졌을 때 '관리자에게 요청하라' 대신 빠진 설정을 정확히 안내하게 한다(이 앱은 보통 사용자 본인이 운영한다).
        if (!isPickerConfigured()) return { content: 'The Google file picker is not set up in this deployment yet, so existing Drive files cannot be picked. The user is most likely the app owner; tell them exactly what is missing: (1) enable "Google Picker API" in Google Cloud Console, (2) create an API key restricted to the website https://powerkkim.github.io/* and to Google Picker API, (3) add GitHub repository Variables GOOGLE_API_KEY (that key) and GOOGLE_APP_ID (the Cloud project number), (4) re-run the "Deploy to GitHub Pages" workflow. Files already in the Vibe Coding folder can still be read with the read command.', isError: true }
        const picked = await pickForAttachment()
        if (!picked) return { content: 'The user cancelled the file picker.' }
        const { doc } = await loadAttachment(picked).catch((e: unknown) => { throw e })
        if (doc?.kind === 'text') return { content: `Picked "${doc.name}":\n${(doc.text ?? '').slice(0, 30_000)}` }
        return { content: `Picked "${picked.name}". PDFs, images and large files must be attached with the Drive button in the message box so they are sent with the message; ask the user to attach it there.` }
      }
      if (cmd === 'read_attachment') {
        const d = findDoc(messages, String(input.path ?? input.name ?? ''))
        if (!d) return { content: 'No attachment with that name in this chat.', isError: true }
        return { content: await readAttachmentText(d) }
      }
      if (cmd === 'copy_to_project') {
        // A안: 첨부한 드라이브 파일을 프로젝트 폴더 imports/ 로 복사하고(원본은 그대로) 텍스트면 프로젝트 파일에 넣어 고칠 수 있게 한다.
        const d = findDoc(messages, String(input.path ?? input.name ?? ''))
        if (!d?.driveId) return { content: 'No Drive attachment with that name in this chat.', isError: true }
        const r = await importPicked(id, title, { id: d.driveId, name: d.name, mimeType: d.mimeType })
        if (r.text !== undefined) {
          const next = { ...run.files, [r.path]: r.text }
          run.base = { files: next, type: run.base.type }
          runSetFiles(run, next)
          if (isFg(run)) setCanvasClosed(false)
          return { content: `Copied "${d.name}" into the project folder as ${r.path}; it is now a project file you can edit (the original is untouched).` }
        }
        return { content: `Copied "${d.name}" into the project folder as ${r.path} (binary, so it is not editable as text).` }
      }
      if (cmd === 'save_project') {
        const r = await exportProject(id, title, run.files)
        showFolder(r.url)
        return { content: `Saved project files to ${r.url} (${r.uploaded} file(s) updated, unchanged ones skipped).` }
      }
      if (cmd === 'save_text') {
        const path = String(input.path ?? '').trim()
        if (!path) return { content: 'path is required', isError: true }
        const url = await saveToProject(id, title, path, String(input.content ?? ''))
        showFolder(url)
        return { content: `Saved ${path} to ${url}` }
      }
      if (cmd === 'save_outputs') {
        const ids = [...new Set([...messages.flatMap((m) => m.outputs ?? []), ...run.outputFiles])]
        if (!ids.length) return { content: 'There are no code execution output files in this chat.' }
        const saved: string[] = []
        let url = ''
        for (const fid of ids) {
          const { name: fname, blob } = await downloadOutputFile(fid)
          url = await saveToProject(id, title, `outputs/${fname}`, blob)
          saved.push(fname)
        }
        showFolder(url)
        return { content: `Saved ${saved.join(', ')} to ${url} (outputs/).` }
      }
      return { content: `Unknown command ${cmd}`, isError: true }
    }
    if (name === 'request_drive_connection') {
      if (isDriveConnected()) return { content: `Google Drive is already connected as ${driveAccount()?.email ?? 'the user'}; chats are saved automatically.` }
      if (!isDriveConfigured()) return { content: 'Google Drive is not configured in this deployment (no client ID), so it cannot be connected.', isError: true }
      setDriveModal('request')
      return { content: 'A popup asking the user to connect Google Drive is now shown. Tell them to press "Google 드라이브 연결" in it; this chat and earlier ones will then be saved to Drive automatically.' }
    }
    if (name === 'browser') {
      // 연결 판정이 잠깐 '없음'이어도 실제 호출을 시도한다. 정말 없으면 runBrowserTool 이 연결 안 됨 오류를 돌려준다.
      return runBrowserTool(input, (req) => requestConfirm(run, req), (line) => handleActivity(run, line))
    }
    if (name === 'project_files') return runProjectFiles(run, input)
    if (name === 'github') return runGithubTool(run, input)
    if (name === 'str_replace_based_edit_tool') {
      const { result, next, changed } = runEditorCommand(run.files, input)
      if (next && changed) {
        // 이후 스트리밍 파일 반영(mergeFiles)도 이 수정본 위에 쌓이도록 기준 프로젝트를 함께 갱신한다.
        run.base = { files: next, type: run.base.type }
        runSetFiles(run, next)
        if (isFg(run)) setCanvasClosed(false)
        run.edited.add(changed)
      }
      return result
    }
    return { content: `Error: unknown tool ${name}`, isError: true }
  }
  // 생각 요약을 받으면 본문이 나오기 전의 빈 답변 자리에 붙인다.
  const handleThinking = (run: Run, text: string) => {
    run.thinking += text
    const thinking = run.thinking
    runSetMessages(run, (prev) => {
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
  type Pending = { prompt: string; images: MessageImage[]; driveFiles: PickerDoc[]; docs: MessageDoc[] }
  const interruptRef = useRef<Pending | null>(null)
  const handleInterrupt = (prompt: string, images: MessageImage[] = [], driveFiles: PickerDoc[] = [], docs: MessageDoc[] = []) => {
    // 멈춤 처리가 끝나기 전에 또 보내면 덮어쓰지 않고 이어 붙인다. 첨부(드라이브·내 기기 파일)도 함께 넘긴다.
    const prev = interruptRef.current
    interruptRef.current = prev
      ? { prompt: [prev.prompt, prompt].filter(Boolean).join('\n\n'), images: [...prev.images, ...images], driveFiles: [...prev.driveFiles, ...driveFiles], docs: [...prev.docs, ...docs] }
      : { prompt, images, driveFiles, docs }
    if (!prev) handleStop()
  }
  // 대화를 바꾸면 leaveForeground 가 대기 중인 끼어들기를 비운다(다른 대화로 보내지지 않게).
  useEffect(() => {
    if (isLoading || !interruptRef.current) return
    const next = interruptRef.current
    interruptRef.current = null
    handleSend(next.prompt, next.images, messages, next.driveFiles, next.docs)
  }, [isLoading])

  const [attachError, setAttachError] = useState('')
  const handleSend = async (prompt: string, images: MessageImage[] = [], base: Message[] = messages, driveFiles: PickerDoc[] = [], localDocs: MessageDoc[] = []) => {
    if (!activeApiKey) return
    if (isLoading) return handleInterrupt(prompt, images, driveFiles, localDocs)
    // 내 기기 첨부는 고를 때 이미 읽어 둔 문서다. 드라이브 첨부는 보낼 때 내용을 받는다: 이미지는 사진 첨부와 같게, PDF·문서는 문서 블록으로.
    let docs: MessageDoc[] = [...localDocs]
    if (driveFiles.length) {
      setAttachError('')
      try {
        const loaded = await Promise.all(driveFiles.map(loadAttachment))
        images = [...images, ...loaded.flatMap((l) => (l.image ? [l.image] : []))]
        docs = [...docs, ...loaded.flatMap((l) => (l.doc ? [l.doc] : []))]
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : '첨부 파일을 받지 못했어요')
        return
      }
    }
    // 첨부가 쌓여 요청이 API 한도를 넘을 것 같으면 보내기 전에 막는다(이전 메시지의 첨부도 매번 다시 보낸다).
    const attachTotal = attachmentBytes([...base, { images, docs }])
    if ((images.length || docs.length) && attachTotal > REQUEST_ATTACH_LIMIT) {
      setAttachError(`이 대화에 쌓인 첨부가 너무 커요(약 ${Math.round(attachTotal / 1024 / 1024)}MB, 한도 ${REQUEST_ATTACH_LIMIT / 1024 / 1024}MB). 새 대화에서 첨부하거나 파일을 나눠 주세요`)
      return
    }
    // 이미지만 보내고 글을 비우면 기본 요청을 넣는다. API 는 빈 텍스트 블록을 받지 않는다.
    const userMsg: Message = {
      role: 'user',
      content: prompt || (docs.length ? '첨부한 파일을 확인해 줘.' : IMAGE_ONLY_PROMPT),
      ...(images.length > 0 ? { images } : {}),
      ...(docs.length > 0 ? { docs } : {}),
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
    await runGeneration({
      chatId: id, history, generationId, resume: false,
      base: { files: projectFilesRef.current, type: projectType },
      githubRepo, projectId: chatProjectIdRef.current, createdAt: chatCreatedAtRef.current,
    })
  }

  /**
   * 생성 응답을 받아 대화와 프로젝트에 반영한다. resume 이면 새로 요청하지 않고 서버에 남은 생성을 처음부터 받는다.
   * base 는 요청 직전의 프로젝트다. 응답 파일을 이 위에 합치고, 중지·오류 시 이 상태로 되돌린다.
   */
  const runGeneration = async (init: {
    chatId: string; history: Message[]; generationId: string; resume: boolean
    base: { files: Record<string, string>; type: ProjectType }
    githubRepo: GithubRepo | null; projectId: string | null; createdAt: number
  }) => {
    const { history, generationId, base, resume } = init
    // 중계 서버를 쓰면 생성 중인 답변에 생성 번호를 남긴다. 앱이 꺼졌다가 다시 열리면 이 번호로 서버에서 이어받는다.
    const genMark = USE_GENERATION_SERVER ? { generationId } : {}
    const placeholder: Message = { role: 'assistant', content: '', files: {}, ...genMark }
    const controller = new AbortController()
    const run: Run = {
      chatId: init.chatId, generationId, controller, history,
      messages: [...history, placeholder],
      files: base.files, type: base.type,
      githubRepo: init.githubRepo, projectId: init.projectId, createdAt: init.createdAt || Date.now(),
      model: activeModel, base,
      buffer: '', thinking: '', sources: new Map(), outputFiles: [], edited: new Set(), structuralChange: false,
      turnUsage: null, contextTokens: 0,
      lastPatch: '', lastPatchAt: 0, pendingPatch: null, patchTimer: null,
      discarded: false,
    }
    runsRef.current.set(run.chatId, run)
    syncRunning()
    // 화면의 대화에서 브라우저를 켜 두었으면 이 대화에 기록하고 browser 도구를 싣는다(확장이 있을 때만).
    if (isFg(run) && browserOnRef.current) setBrowserForChat(run.chatId, true)
    // 브라우저를 켠 대화인데 확장을 못 찾은 상태면 보내기 전에 한 번 더 찾아본다.
    if (browserOnForChat(run.chatId) && !extVersionRef.current) await checkExtension()
    const useBrowser = !!extVersionRef.current && browserOnForChat(run.chatId)
    // 기억은 대화마다 처음 한 번 읽어 고정한다. 대화 중 새로 저장한 기억은 다음 대화부터 들어간다(바꾸면 캐시가 깨진다).
    let memoryText = memorySnapRef.current.get(run.chatId)
    if (memoryText === undefined) {
      // 드라이브가 느리면 4초까지만 기다린다. 못 읽었으면 이번엔 빼고 다음 턴에 다시 읽는다.
      const read = await Promise.race([loadMemory().then(memoryContext), new Promise<null>((r) => setTimeout(() => r(null), 4000))]).catch(() => null)
      memoryText = read ?? ''
      if (read !== null) memorySnapRef.current.set(run.chatId, read)
    }
    if (isFg(run)) {
      setMessages(run.messages)
      setIsLoading(true)
      unsavedRef.current = true
    }
    // 중지하면 스트리밍 중 반영된 일부 파일 대신 이 상태로 되돌린다.
    const prevFiles = base.files
    const prevType = base.type
    // 받은 부분을 몇 초마다 백업한다. 복구되면 '끊긴 답변'(다시 시도 버튼)으로 보이고, 코드는 요청 전 상태로 둔다.
    let lastBackupAt = Date.now()
    const backupPartial = () => {
      const { explanation } = parseVibe(run.buffer)
      const partial = explanation || (run.buffer.includes('<VIBE_') ? '' : run.buffer.trim())
      backupChat({
        id: run.chatId, title: chatTitle(history), createdAt: run.createdAt, updatedAt: Date.now(),
        messages: [...history, USE_GENERATION_SERVER
          // 서버가 계속 받고 있으므로 끊긴 답변이 아니라 '생성 중'으로 남긴다(다시 열면 이어받기).
          ? { role: 'assistant', content: partial, files: {}, generationId }
          : { role: 'assistant', content: `${partial ? `${partial}\n\n` : ''}(응답 도중 브라우저가 닫혀 여기까지 저장됐습니다. 다시 시도를 눌러 주세요)`, files: {}, failed: true }],
        projectFiles: prevFiles, projectType: prevType, githubRepo: run.githubRepo, projectId: run.projectId,
      })
    }
    // 응답이 끝난 이유(onUsage 로 마지막에 한 번 온다). 잘린 응답이면 형식 보정 대신 '이어서 생성'을 안내한다.
    let stopReason: string | undefined
    const onUsage = (usage: TokenUsage) => { stopReason = usage.stopReason; recordUsage(run, usage) }
    let panelFocused = false
    // 생성 중 화면이 저절로 꺼져 연결이 끊기지 않게 한다. 미지원 브라우저·거부 시에는 없이 진행한다.
    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null)
    try {
      const chunks = resume
        ? resumeCode(activeApiKey, generationId, onUsage, controller.signal)
        : streamCode(activeApiKey, activeModel, history, Object.keys(prevFiles).length ? prevFiles : undefined, onUsage, controller.signal, generationId, modelOptions, (t) => handleThinking(run, t), {
            onActivity: (line) => handleActivity(run, line),
            onSource: (src) => handleSource(run, src),
            onFile: (id) => { if (!run.outputFiles.includes(id)) run.outputFiles.push(id) },
            onClientTool: (name, input) => runClientTool(run, name, input),
            appTools: useBrowser ? [...APP_TOOLS, MEMORY_TOOL, BROWSER_TOOL] : [...APP_TOOLS, MEMORY_TOOL],
            // 프로젝트 지침 + 기억(대화마다 처음 읽은 것을 고정해 캐시가 깨지지 않게 한다)
            projectContext: [projectContext(projects.find((p) => p.id === run.projectId)), memoryText].filter(Boolean).join('\n\n') || undefined,
            codeMode,
            // 코드를 만들거나 고치라는 메시지일 때만 파일 전체를 보내고, 일반 대화에는 목록만 보낸다.
            filesMode: isBuildRequest(history[history.length - 1]?.content ?? '') ? 'full' : 'list',
            notify: notifyHeader(run.chatId, chatTitle(history)),
          })
      for await (const chunk of chunks) {
        run.buffer += chunk
        // 응답이 시작되면 진행 중인 답변을 현재 답변으로 표시한다. 본문은 대화에 바로 나온다.
        if (!panelFocused && run.buffer.trim() && isFg(run)) {
          panelFocused = true
          setAnswerIndex(history.length)
        }
        const parsedChunk = parseVibe(run.buffer)
        const { explanation } = parsedChunk

        // Real-time patch: update code preview while streaming
        if (Object.keys(parsedChunk.files).length > 0) {
          const nextFingerprint = fingerprintFiles(parsedChunk.files)
          if (nextFingerprint !== run.lastPatch) {
            const elapsed = Date.now() - run.lastPatchAt
            if (elapsed >= REALTIME_PATCH_THROTTLE_MS) {
              applyRealtimePatch(run, parsedChunk.files, parsedChunk.projectType, nextFingerprint)
            } else {
              run.pendingPatch = {
                files: parsedChunk.files,
                projectType: parsedChunk.projectType,
                fingerprint: nextFingerprint,
              }
              if (!run.patchTimer) {
                const wait = Math.max(0, REALTIME_PATCH_THROTTLE_MS - elapsed)
                run.patchTimer = setTimeout(() => {
                  run.patchTimer = null
                  flushPendingRealtimePatch(run)
                }, wait)
              }
            }
          }
        }

        runSetMessages(run, (prev) => {
          const updated = [...prev]
          // VIBE 태그가 없으면 일반 대화 답변이므로 받은 텍스트를 그대로 보여준다.
          updated[updated.length - 1] = {
            role: 'assistant',
            content: explanation || (hideConfirmTag(run.buffer).includes('<VIBE_') ? '생성 중...' : hideConfirmTag(run.buffer)),
            files: {},
            ...(run.thinking ? { thinking: run.thinking } : {}),
            ...genMark,
          }
          return updated
        })
        if (Date.now() - lastBackupAt >= PARTIAL_BACKUP_MS) { lastBackupAt = Date.now(); backupPartial() }
      }

      flushPendingRealtimePatch(run)

      let parsed = parseVibe(run.buffer)
      // max_tokens: 출력 한도에 걸려 잘림 → 이어서 생성 가능. model_context_window_exceeded: 컨텍스트가 가득 참 → 이어서 생성 불가.
      const truncated: Message['truncated'] = stopReason === 'max_tokens' ? 'output'
        : stopReason === 'model_context_window_exceeded' ? 'context' : undefined

        // Auto-repair response format if model didn't generate valid code structure
      // 코드를 만들려다(<VIBE_FILE> 존재) 구조가 깨진 경우에만 보정한다. 태그가 없으면 일반 대화 답변이다.
      // 잘린 응답은 보정해도 같은 한도에 또 걸리므로 보정하지 않는다(원문 전체를 다시 보내 비용만 두 배가 된다).
      if (!truncated && run.buffer.includes('<VIBE_FILE') && !isValidGeneratedProject(mergeFiles(run.base, parsed.files, parsed.projectType), parsed.projectType)) {
        const repairPrompt = [
          '아래 원문 응답은 형식이 깨졌거나 코드가 부족합니다.',
          '반드시 <VIBE_FILE>, <VIBE_TYPE>, <VIBE_EXPLANATION> 형식으로만 다시 출력하세요.',
          '실제 실행 가능한 완성 코드(디자인+기능 포함)로 생성하고 설명문만 보내지 마세요.',
          '',
          '[원문 응답 시작]',
          run.buffer,
          '[원문 응답 끝]',
        ].join('\n')

        runSetMessages(run, (prev) => {
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
        run.generationId = repairId
        let repairedRaw = ''
        for await (const chunk of streamCode(
          activeApiKey,
          activeModel,
          [{ role: 'user', content: repairPrompt }],
          Object.keys(prevFiles).length ? prevFiles : undefined,
          (usage) => recordUsage(run, usage),
          controller.signal,
          repairId,
          modelOptions,
        )) {
          repairedRaw += chunk
        }

        const repaired = parseVibe(repairedRaw)
        if (isValidGeneratedProject(mergeFiles(run.base, repaired.files, repaired.projectType), repaired.projectType)) {
          parsed = repaired
          run.buffer = repairedRaw
        }
      }

      const { explanation } = parsed
      // 텍스트 에디터로 고친 파일도 이번 답변의 결과물로 친다(되돌리기 지점·'파일 N개' 표시).
      const files = { ...Object.fromEntries([...run.edited].map((n) => [n, run.base.files[n] ?? ''])), ...parsed.files }
      // 끝까지 받은(닫는 태그가 있는) 파일만 parseVibe 가 돌려주므로 잘린 응답이어도 완성된 파일은 반영한다.
      const pType = mergedType(run.base, files, parsed.projectType)
      if (Object.keys(files).length > 0) {
        runSetFiles(run, mergeFiles(run.base, files, parsed.projectType), pType)
      }
      const doneNames = Object.keys(files)
      const truncatedNote = truncated === 'output'
        ? `⚠️ 출력 한도(${Math.round(modelOptions.maxTokens / 1000)}K 토큰)에 도달해 응답이 잘렸습니다.` +
          (doneNames.length ? `  \n완성된 파일: ${doneNames.join(', ')}` : '') +
          `  \n'이어서 생성'을 누르거나, 모델 옵션에서 최대 출력을 늘려 다시 시도하세요.`
        : truncated === 'context'
          ? '⚠️ 대화가 모델의 컨텍스트 한도를 가득 채워 응답이 잘렸습니다. 새 대화에서 이어 가세요.'
          : ''
      // 수동 모드에서 모델이 '코딩 진행' 확인을 요청했는지(파일을 만들지 않은 답변에서만)
      const askConfirm = run.buffer.includes('<VIBE_CONFIRM') && !run.buffer.includes('<VIBE_FILE')
      const plain = hideConfirmTag(run.buffer)
      // 파일이 실제로 바뀐 경우에만 '완성' 이라고 한다.
      const changedAny = Object.keys(files).length > 0 || run.structuralChange
      const noChangeNote = !changedAny && !truncated && run.buffer.includes('<VIBE_') && !askConfirm
        ? '⚠️ 이번 답변에서 바뀐 파일이 없어요.' : ''
      const body = [explanation || (plain.includes('<VIBE_')
        ? (truncated || !changedAny ? '' : '완성됐습니다! 코드 탭에서 소스를 확인할 수 있어요.')
        : plain.trim()), noChangeNote].filter(Boolean).join('\n\n')
      runSetMessages(run, (prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: [body, truncatedNote].filter(Boolean).join('\n\n'),
          ...(truncated ? { truncated } : {}),
          ...(askConfirm && !truncated ? { confirm: true as const } : {}),
          // 인용된 출처를 앞에, 최대 10개
          ...(run.sources.size ? { sources: [...run.sources.values()].sort((a, b) => Number(b.cited) - Number(a.cited)).slice(0, 10) } : {}),
          ...(run.outputFiles.length ? { outputs: [...run.outputFiles] } : {}),
          ...(run.contextTokens ? { ctx: run.contextTokens } : {}),
          files,
          // 파일을 만든 답변만 되돌리기 지점이 된다.
          ...(changedAny ? { snapshot: run.files, projectType: pType } : {}),
        }
        return updated
      })
      // 프로젝트 파일 자동 저장(내 드라이브). 응답을 막지 않도록 뒤에서 처리한다.
      bindChatProject(run.chatId, projects.find((p) => p.id === run.projectId))
      if (USE_DRIVE && driveAutoSave && changedAny && isDriveConnected()) {
        if (hasFileScope()) {
          exportProject(run.chatId, chatTitle(history), run.files)
            .then((r) => { if (isFg(run)) setDriveFolderUrl(r.url) })
            .catch((e) => setStorageError(e instanceof FileScopeError ? e.message : '드라이브 폴더에 프로젝트 파일을 저장하지 못했습니다'))
        } else if (!scopeAskedRef.current) {
          scopeAskedRef.current = true
          setDriveModal('scope')
        }
      }
    } catch (err: unknown) {
      clearPatchTimer(run)
      if (controller.signal.aborted) {
        runSetFiles(run, prevFiles, prevType)
        const { explanation } = parseVibe(run.buffer)
        const partial = explanation || (run.buffer.includes('<VIBE_') ? '' : run.buffer.trim())
        runSetMessages(run, (prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: `${partial ? `${partial}\n\n` : ''}(생성을 중지했습니다)`, files: {} }
          return updated
        })
        return
      }
      // 스트리밍 중 반쯤 반영된 코드는 깨져 있으므로 요청 전으로 되돌리고, 받은 본문만 남긴다.
      runSetFiles(run, prevFiles, prevType)
      const { explanation } = parseVibe(run.buffer)
      const partial = explanation || (run.buffer.includes('<VIBE_') ? '' : run.buffer.trim())
      const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다'
      runSetMessages(run, (prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'assistant', content: `${partial ? `${partial}\n\n` : ''}오류: ${message}`, files: {}, failed: true }
        return updated
      })
    } finally {
      wakeLock?.release().catch(() => {})
      clearPatchTimer(run)
      runsRef.current.delete(run.chatId)
      syncRunning()
      // 직접 멈췄거나 지운 대화가 아니면 끝났음을 알린다.
      if (!controller.signal.aborted && !run.discarded) announceDone(run)
      if (isFg(run)) {
        // 화면의 대화: 완료·오류·중지 모두 이 응답을 답변 탭에 열고, 저장은 저장 effect 가 한다.
        setAnswerIndex(history.length)
        setVersionIndex(null)
        unsavedRef.current = !run.discarded
        setIsLoading(false)
      } else if (!run.discarded) {
        // 뒤에서 끝난 대화: 여기서 바로 저장하고 사이드바에 '새 답변' 표시를 남긴다.
        setUnreadIds((prev) => (prev.includes(run.chatId) ? prev : [...prev, run.chatId]))
        saveRun(run).catch(storageFailMessage('대화를 저장하지 못했습니다 (저장소에 연결할 수 없음)'))
      }
    }
  }

  // 생성을 멈춘다(브라우저 쪽 수신 + 서버 쪽 생성).
  const stopRun = (run: Run) => {
    run.controller.abort()
    cancelGeneration(activeApiKey, run.generationId).catch(() => setStorageError('서버에서 진행 중인 생성을 멈추지 못했습니다'))
  }
  const handleStop = () => {
    const run = fgChatIdRef.current ? runsRef.current.get(fgChatIdRef.current) : undefined
    if (run) stopRun(run)
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
  // 화면의 대화가 생성 중이면 그 Run. 직접 고친 내용(파일·저장소 연결)을 Run 에도 반영해 대화를 바꿔도 남게 한다.
  const fgRun = () => (fgChatIdRef.current ? runsRef.current.get(fgChatIdRef.current) : undefined)
  const handleImportProject = (importedFiles: Record<string, string>, importedType: 'html' | 'react' | 'vue') => {
    const run = fgRun()
    if (run) { run.files = importedFiles; run.type = importedType }
    projectFilesRef.current = importedFiles
    setProjectFiles(importedFiles)
    setProjectType(importedType)
    unsavedRef.current = true
  }

  const handleGithubRepoChange = (repo: GithubRepo) => {
    const run = fgRun()
    if (run) run.githubRepo = repo
    setGithubRepo(repo)
    unsavedRef.current = true
  }

  // 화면을 빈 대화 상태로 되돌린다. 저장소는 건드리지 않는다.
  const resetConversation = () => {
    setFilesOnlyOpen(false)
    setMessages([])
    projectFilesRef.current = {}
    setProjectFiles({})
    setProjectType('html')
    setGithubRepo(null)
    setAnswerIndex(null)
    setVersionIndex(null)
    setTokenUsage(null)
    contextTokensRef.current = 0
    setContextTokens(0)
    setLastCost(0)
    setSessionKey((k) => k + 1)
    setCanvasClosed(false)
    unsavedRef.current = false
    setIsLoading(false)
  }

  // 생성 중에도 새 대화·대화 전환을 할 수 있다. 떠난 대화의 생성은 뒤에서 계속되고(runsRef), 끝나면 스스로 저장한다.
  const handleNewChat = () => {
    leaveForeground()
    resetConversation()
    setChatId(null)
    setChatProjectId(null)
    setMobileTab('chat')
    if (isMobile) setSidebarOpen(false)
  }

  // 생성 중인 대화로 돌아왔을 때: 저장본이 아니라 Run 이 가진 지금 상태를 화면에 붙인다.
  const attachRun = (run: Run) => {
    resetConversation()
    setDriveFolderUrl(null)
    setChatId(run.chatId)
    setChatProjectId(run.projectId)
    bindChatProject(run.chatId, projects.find((p) => p.id === run.projectId))
    chatCreatedAtRef.current = run.createdAt
    setMessages(run.messages)
    const ctx = run.contextTokens || ([...run.messages].reverse().find((m) => m.role === 'assistant' && m.ctx)?.ctx ?? 0)
    contextTokensRef.current = ctx
    setContextTokens(ctx)
    setTokenUsage(run.turnUsage?.usage ?? null)
    setLastCost(run.turnUsage?.cost ?? 0)
    projectFilesRef.current = run.files
    setProjectFiles(run.files)
    setProjectType(run.type)
    setGithubRepo(run.githubRepo)
    setAnswerIndex(run.messages.length - 1)
    setVersionIndex(null)
    setIsLoading(true)
    focusPanel('preview')
    setMobileTab('chat')
    if (isMobile) setSidebarOpen(false)
  }

  const handleSelectChat = async (id: string) => {
    if (id === chatId || loadingChatId) return
    setUnreadIds((prev) => prev.filter((x) => x !== id))
    setToasts((prev) => prev.filter((t) => t.chatId !== id))
    const running = runsRef.current.get(id)
    if (running) {
      leaveForeground()
      attachRun(running)
      return
    }
    setLoadingChatId(id)
    try {
      const chat = chatCacheRef.current.get(id) ?? await loadChat(activeApiKey, id)
      if (!chat) {
        setChats((prev) => prev.filter((c) => c.id !== id))
        setStorageError('대화를 찾을 수 없습니다')
        return
      }
      // 불러오는 사이에 이 대화의 생성이 시작됐으면(드문 경우) 그쪽 상태를 쓴다.
      const started = runsRef.current.get(id)
      leaveForeground()
      if (started) { attachRun(started); return }
      resetConversation()
      setDriveFolderUrl(null)
      setChatId(chat.id)
      setChatProjectId(chat.projectId ?? null)
      bindChatProject(chat.id, projects.find((p) => p.id === chat.projectId))
      chatCreatedAtRef.current = chat.createdAt
      setMessages(chat.messages)
      {
        const lastCtx = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.ctx)?.ctx ?? 0
        contextTokensRef.current = lastCtx
        setContextTokens(lastCtx)
      }
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
        runGeneration({
          chatId: chat.id, history: chat.messages.slice(0, -1), generationId: last.generationId, resume: true,
          base: { files: chat.projectFiles, type: chat.projectType },
          githubRepo: chat.githubRepo ?? null, projectId: chat.projectId ?? null, createdAt: chat.createdAt,
        })
      }
    } catch (e) {
      storageFailMessage('대화를 불러오지 못했습니다')(e)
    } finally {
      setLoadingChatId(null)
    }
  }

  selectChatRef.current = handleSelectChat

  const handleDeleteChat = async (id: string) => {
    const title = chats.find((c) => c.id === id)?.title ?? '이 대화'
    const running = runsRef.current.get(id)
    if (!window.confirm(`'${title}' 대화를 삭제할까요? 되돌릴 수 없습니다.${running ? '\n(생성 중인 답변도 멈춥니다)' : ''}`)) return
    try {
      // 생성 중이면 멈추고, 끝나면서 다시 저장되지 않게 표시한다. 진행 중인 저장이 있으면 끝난 뒤에 지운다.
      if (running) { running.discarded = true; stopRun(running) }
      // 지우는 대화가 화면에 떠 있으면 대기 중인 자동 저장이 지운 대화를 되살리지 않게 한다.
      if (id === fgChatIdRef.current) unsavedRef.current = false
      await saveQueueRef.current.get(id)?.catch(() => {})
      await deleteChat(activeApiKey, id)
      setUnreadIds((prev) => prev.filter((x) => x !== id))
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

  // 상단 '미리보기' 버튼: 파일을 만든 가장 최근 답변으로 미리보기를 연다.
  const handleOpenPreview = () => {
    const last = messages.map((m) => Object.keys(m.files ?? {}).length > 0).lastIndexOf(true)
    if (last >= 0) return handleOpenAnswer(last)
    if (!Object.keys(projectFiles).length) {
      // 결과물 없이 첨부·실행 파일만 있으면 '파일' 탭으로 연다
      setFilesOnlyOpen(true)
      setCanvasClosed(false)
      focusPanel('files')
      setMobileTab('preview')
      return
    }
    setCanvasClosed(false)
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
    const run = fgRun()
    if (run) run.files = nextFiles
    projectFilesRef.current = nextFiles
    setProjectFiles(nextFiles)
    unsavedRef.current = true
  }

  // 결과물(파일)이 생기기 전이나 ✕ 로 닫았을 때는 오른쪽 패널을 숨기고 대화를 화면 가운데에 둔다.
  // 코드 실행 결과 파일을 드라이브 대화 폴더(outputs/)에 저장
  const saveOutputToDrive = USE_DRIVE && isDriveConfigured() ? async (fid: string) => {
              if (!isDriveConnected()) { setDriveModal('request'); throw new Error('드라이브 연결이 필요해요') }
              if (!hasFileScope()) { setDriveModal('scope'); throw new Error('권한 추가가 필요해요') }
              const id = fgChatIdRef.current
              if (!id) throw new Error('대화가 없습니다')
              const { name: fname, blob } = await downloadOutputFile(fid)
              const url = await saveToProject(id, chatTitle(messages), `outputs/${fname}`, blob)
              setDriveFolderUrl(url)
              return url
            } : undefined

  // 결과물이 없어도 첨부·실행 파일을 보려고 '파일' 탭으로 연 경우
  const [filesOnlyOpen, setFilesOnlyOpen] = useState(false)
  const canvasOpen = (Object.keys(projectFiles).length > 0 || filesOnlyOpen) && !canvasClosed
  const filesCount = chatFileCount(messages)

  const sidebar = (
    <Sidebar
      chats={chats}
      activeId={chatId}
      loadingId={loadingChatId}
      runningIds={runningIds}
      unreadIds={unreadIds}
      version={__APP_VERSION__}
      note={RELEASE_NOTE}
      notify={notifySupported() ? { on: notifyOn, push: pushOn, onToggle: toggleNotify } : undefined}
      onOpenMemoryGuide={() => setMemoryGuide(true)}
      browserExt={isMobileDevice() ? undefined : { version: extVersion, onOpen: () => setExtModal(true) }}
      error={storageError}
      onSelect={handleSelectChat}
      onNew={handleNewChat}
      projects={projects}
      activeProjectId={chatProjectId}
      onNewProject={() => setProjectModal('new')}
      onEditProject={(p) => setProjectModal(p)}
      onNewChatInProject={handleNewChatInProject}
      onMoveChat={handleMoveChat}
      onDelete={handleDeleteChat}
      onClose={toggleSidebar}
      drive={USE_DRIVE ? { autoSave: driveAutoSave, onAutoSave: toggleDriveAutoSave, folderUrl: driveFolderUrl, configured: isDriveConfigured(), connected: driveConnected, expired: !driveConnected && isDriveExpired(), account: driveAccount()?.email, busy: driveBusy, onConnect: handleConnectDrive, onDisconnect: handleDisconnectDrive, canStaySignedIn: canDriveStaySignedIn(), staySignedIn: driveStaysSignedIn(), onStaySignedIn: handleConnectDrive } : undefined}
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
            onOpenPreview={(Object.keys(projectFiles).length > 0 || filesCount > 0) && (!canvasOpen || (isMobile && mobileTab === 'chat')) ? handleOpenPreview : undefined}
            previewLabel={Object.keys(projectFiles).length > 0 ? '미리보기' : `파일 ${filesCount}`}
          />
          {/* ChatPanel 은 가로 줄 안에서 너비를 잡도록 짜여 있어 남은 높이를 채우는 가로 줄로 감싼다. */}
          <div className="flex flex-1 min-h-0">
          <ChatPanel
            chatKey={chatId ?? 'new'}
            messages={messages}
            onSend={(p, imgs, files, docs) => handleSend(p, imgs, messages, files, docs)}
            attachError={attachError}
            codeMode={codeMode}
            onCodeModeChange={setCodeMode}
            notice={confirms.length > 0 && (() => {
              // 브라우저 작업 확인: 입력창 바로 위 가로 바. 여러 건이면 하나씩.
              const c = confirms[0]
              return (
                <div key={c.id} className="confirm-bar" role="alertdialog" aria-live="assertive" aria-label="브라우저 작업 확인">
                  <div className="confirm-text">
                    <div className="confirm-title">{c.req.title}{confirms.length > 1 && <span className="confirm-more"> · 대기 {confirms.length - 1}건</span>}</div>
                    {c.chatId !== chatId && <div className="confirm-chat">'{c.chatTitle}' 대화</div>}
                    <div className="confirm-detail">{c.req.detail}</div>
                  </div>
                  <div className="confirm-actions">
                    <button className="confirm-allow" onClick={() => answerConfirm(c.id, true)}>{c.req.allowLabel ?? '허용'}</button>
                    <button className="confirm-deny" onClick={() => answerConfirm(c.id, false)}>취소</button>
                  </div>
                </div>
              )
            })()}
            browser={extVersion && !isMobileDevice() ? { on: browserOn, onToggle: toggleBrowser, outdated: versionLess(extVersion, MIN_EXTENSION_VERSION) } : undefined}
            projectName={currentProject?.name}
            onOpenProject={() => currentProject && setProjectModal(currentProject)}
            onStop={handleStop}
            onRetry={handleRetry}
            onContinue={handleContinue}
            onPickDriveFile={USE_DRIVE && isDriveConfigured() && isPickerConfigured() ? pickForAttachment : undefined}
            onSaveOutputToDrive={saveOutputToDrive}
            isLoading={isLoading}
            hasApiKey={!!activeApiKey}
            width={isMobile || !canvasOpen ? undefined : chatWidth}
            tokenUsage={tokenUsage}
            contextTokens={contextTokens}
            contextBudget={contextBudget(activeModel)}
            priceJumpAt={longPromptThreshold(activeModel)}
            onNewChat={() => (chatProjectIdRef.current ? handleNewChatInProject(chatProjectIdRef.current) : handleNewChat())}
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
            filesCount={filesCount}
            filesTab={<ChatFiles messages={messages} onOpenAnswer={handleOpenAnswer} onSaveOutputToDrive={saveOutputToDrive} />}
          />
        </div>
      </div>
      {memoryGuide && <MemoryGuideModal onClose={() => setMemoryGuide(false)} />}
      {extModal && <BrowserExtModal version={extVersion} minVersion={MIN_EXTENSION_VERSION} onClose={() => setExtModal(false)} />}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <button className="toast-open" onClick={() => { dismissToast(t.id); handleSelectChat(t.chatId) }}>
                <span>{t.failed ? '답변 생성 중 오류가 났어요' : '답변이 완료됐어요'}</span>
                <span>{t.title}</span>
              </button>
              <button className="icon-btn" aria-label="알림 닫기" onClick={() => dismissToast(t.id)}><X style={{ width: 14, height: 14 }} /></button>
            </div>
          ))}
        </div>
      )}
      {projectModal && (
        <ProjectModal
          project={projectModal === 'new' ? newProject('') : projectModal}
          isNew={projectModal === 'new'}
          chatCount={projectModal === 'new' ? 0 : chats.filter((c) => c.projectId === projectModal.id).length}
          onPickKnowledge={USE_DRIVE && isDriveConfigured() && isPickerConfigured() ? pickForAttachment : undefined}
          onSave={handleSaveProject}
          onDelete={handleDeleteProject}
          onClose={() => setProjectModal(null)}
        />
      )}
      {driveModal && (driveModal === 'scope' ? !hasFileScope() : !driveConnected) && (
        <DriveConnectModal mode={driveModal} busy={driveBusy} error={driveModalError} onConnect={connectFromModal} onClose={closeDriveModal} />
      )}
    </div>
  )
}
