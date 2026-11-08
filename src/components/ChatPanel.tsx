import { useState, useRef, useEffect } from 'react'
import { ArrowUp, AlertCircle, FileText, ImagePlus, X, Square, History } from '../icons'
import AnswerView from './AnswerView'
import type { Message, MessageImage, TokenUsage } from '../services/ai'
import type { PickerDoc } from '../services/driveExport'
import { imageSrc, MAX_IMAGES_PER_MESSAGE, readImage } from '../services/image'
import { formatUsd, remainingBalance } from '../services/usage'
import { GoogleDrive } from '../icons'
import { downloadOutputFile } from '../services/ai'
import type { Balance } from '../services/usage'
import type { UsageTotals } from '../services/usage'

// 실제 잔액·청구액은 일반 API 키로 조회할 수 없어 Console 대시보드로 안내한다.
const BILLING_URL = 'https://platform.claude.com/dashboard'

/**
 * ChatPanel 컴포넌트: 좌측 채팅 패널
 * 
 * 주요 기능:
 * - AI에 프롬프트 전송 (Shift+Enter로 개행)
 * - 채팅 메시지 히스토리 표시 (사용자/AI)
 * - 토큰 사용량 실시간 추적
 * - 빠른 시작 제안 버튼 (empty state)
 * - 새 세션 시작 버튼 (refresh)
 */
interface Props {
  messages: Message[]
  onSend: (prompt: string, images: MessageImage[], driveFiles?: PickerDoc[]) => void
  // 생성 중에 전송 버튼 자리의 중지 버튼이 부른다.
  onStop: () => void
  // 오류로 끊긴 마지막 답변의 질문을 다시 보낸다.
  onRetry: () => void
  // 출력 한도에서 잘린 마지막 답변을 이어서 생성한다.
  onContinue: () => void
  // 코드 실행 결과 파일을 내 드라이브 프로젝트 폴더에 저장(드라이브 방식일 때만). 폴더 주소를 돌려준다.
  onSaveOutputToDrive?: (fileId: string) => Promise<string>
  // 드라이브 파일 첨부(선택창). 고른 파일 정보만 돌려주고, 내용은 보낼 때 받는다. 설정이 없으면 버튼을 숨긴다.
  onPickDriveFile?: () => Promise<PickerDoc | null>
  // 보낼 때 첨부 파일을 받지 못한 경우 등
  attachError?: string
  // 지금 대화가 속한 프로젝트 이름(없으면 일반 대화). 누르면 프로젝트 설정을 연다.
  projectName?: string
  onOpenProject?: () => void
  isLoading: boolean
  hasApiKey: boolean
  width?: number
  tokenUsage?: TokenUsage | null
  // 마지막 요청의 예상 비용(USD)과 이 브라우저의 오늘·누적 합계
  lastCost: number
  usageTotals: UsageTotals
  onResetUsage: () => void
  // 추정 잔액(사용자가 입력한 잔액 − 이후 예상 비용). null 이면 미설정.
  balance: Balance | null
  onBalanceChange: (amount: number | null) => void
  // 결과물 카드 중 지금 캔버스에 연 답변. 그 카드를 강조한다.
  activeAnswerIndex: number | null
  onOpenAnswer: (index: number) => void
  // 파일 사본(snapshot)이 있는 답변을 그 시점 버전으로 되돌린다.
  onRestore: (index: number) => void
}

const SUGGESTIONS = [
  { label: 'any', desc: '아무거나 질문과 개발하실 내용을 적어주세요' },
]

/**
 * 로딩 상태를 나타내는 애니메이션 점 표시
 * 스트리밍 중 AI가 응답을 생성 중임을 시각적으로 표현
 */
function Dots() {
  return (
    <span className="inline-flex gap-1.5 items-center py-1">
      {Array.from({ length: 3 }).map((_, i) => (
        <span
          key={i}
          className="pixel-loader-cell"
          style={{ width: 6, height: 6, animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  )
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
function fileIcon(name: string, mime?: string) {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return '📕'
  if (mime?.includes('spreadsheet') || /\.(csv|xlsx?)$/i.test(name)) return '📗'
  if (mime?.includes('presentation')) return '📙'
  if (mime?.startsWith('image/')) return '🖼'
  if (mime?.includes('document')) return '📘'
  return '📄'
}

/** 도구 진행 줄(🔎🌐⚙️🧠💾✏️ 로 시작) 중 마지막 것 */
const ACTIVITY = /^(🔎|🌐|⚙️|🧠|💾|✏️)/u
function lastActivity(thinking?: string) {
  return thinking?.trim().split('\n').filter((l) => ACTIVITY.test(l)).pop()
}

/** 코드 실행이 만든 파일 목록. 누르면 Files API 로 받아 저장한다(키는 이 브라우저에서만 쓴다). */
function OutputFiles({ ids, onSaveToDrive }: { ids: string[]; onSaveToDrive?: (id: string) => Promise<string> }) {
  const [state, setState] = useState<Record<string, string>>({})
  const [driveState, setDriveState] = useState<Record<string, string>>({})
  const toDrive = async (id: string) => {
    if (!onSaveToDrive) return
    setDriveState((s) => ({ ...s, [id]: '저장 중…' }))
    try {
      const url = await onSaveToDrive(id)
      setDriveState((s) => ({ ...s, [id]: url }))
    } catch (e) {
      setDriveState((s) => ({ ...s, [id]: e instanceof Error ? `!${e.message}` : '!저장하지 못했습니다' }))
    }
  }
  const save = async (id: string) => {
    setState((s) => ({ ...s, [id]: '받는 중…' }))
    try {
      const { name, blob } = await downloadOutputFile(id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setState((s) => ({ ...s, [id]: name }))
    } catch (e) {
      setState((s) => ({ ...s, [id]: e instanceof Error ? e.message : '받지 못했습니다' }))
    }
  }
  return (
    <div className="sources">
      <div style={{ fontWeight: 500 }}>코드 실행으로 만든 파일 {ids.length}개</div>
      <ol>
        {ids.map((id, n) => (
          <li key={id}>
            <button onClick={() => save(id)} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
              {state[id] && !state[id].endsWith('…') && !state[id].startsWith('Error') ? `${state[id]} 다시 받기` : `파일 ${n + 1} 받기`}
            </button>
            {state[id]?.endsWith('…') && <span className="sources-host">{state[id]}</span>}
            {onSaveToDrive && (
              driveState[id]?.startsWith('https://')
                ? <a className="sources-host" href={driveState[id]} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>드라이브에 저장됨 · 폴더 열기</a>
                : <button className="sources-host" onClick={() => toDrive(id)} disabled={driveState[id] === '저장 중…'} style={{ textDecoration: 'underline' }}>
                    {driveState[id] === '저장 중…' ? '저장 중…' : '드라이브에 저장'}
                  </button>
            )}
            {driveState[id]?.startsWith('!') && <span className="sources-host" style={{ color: 'var(--err)' }}>{driveState[id].slice(1)}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function ChatPanel({ projectName, onOpenProject, messages, onSend, onStop, onRetry, onContinue, onSaveOutputToDrive, onPickDriveFile, attachError, isLoading, hasApiKey, width, tokenUsage, lastCost, usageTotals, onResetUsage, balance, onBalanceChange, activeAnswerIndex, onOpenAnswer, onRestore }: Props) {
  // 마지막 답변은 현재 버전이라 되돌리기 버튼을 두지 않는다.
  const lastAnswerIndex = messages.map((m) => m.role).lastIndexOf('assistant')
  const [input, setInput] = useState('')
  // 잔액 입력 칸. null 이면 닫힘.
  const [balanceDraft, setBalanceDraft] = useState<string | null>(null)
  const remaining = remainingBalance(balance)
  const saveBalance = () => {
    const v = Number((balanceDraft ?? '').replace(/[$,\s]/g, ''))
    if (balanceDraft?.trim() === '') onBalanceChange(null)
    else if (Number.isFinite(v) && v >= 0) onBalanceChange(v)
    setBalanceDraft(null)
  }
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 보내기 전 이미지(🖼 버튼·붙여넣기·끌어다 놓기로 추가)
  const [images, setImages] = useState<MessageImage[]>([])
  // 드라이브에서 고른 첨부(정보만). 보낼 때 App 이 내용을 받아 메시지에 싣는다.
  const [driveFiles, setDriveFiles] = useState<PickerDoc[]>([])
  const pickDrive = async () => {
    if (!onPickDriveFile) return
    setImageError('')
    try {
      const f = await onPickDriveFile()
      if (f && !driveFiles.some((d) => d.id === f.id)) setDriveFiles((prev) => [...prev, f].slice(0, 5))
    } catch (e) {
      setImageError(e instanceof Error ? e.message : '드라이브 파일을 고르지 못했어요')
    }
  }
  const [imageError, setImageError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 결과물 창이 열리거나 닫혀 폭이 바뀌면 글이 다시 줄바꿈되므로 그때도 맨 아래로 내린다. 드래그로 폭을 조절할 때는 내리지 않는다.
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, width === undefined])

  // 남은 칸만큼만 받고, 형식이 맞지 않거나 읽기에 실패한 파일은 메시지로 알린다.
  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return
    setImageError('')
    const room = MAX_IMAGES_PER_MESSAGE - images.length
    if (files.length > room) setImageError(`이미지는 메시지당 최대 ${MAX_IMAGES_PER_MESSAGE}장까지 넣을 수 있어요`)
    const added: MessageImage[] = []
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        added.push(await readImage(file))
      } catch (err) {
        setImageError(err instanceof Error ? err.message : '이미지를 읽지 못했어요')
      }
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_MESSAGE))
  }

  // 클립보드에 이미지가 있을 때만 가로채고, 글자 붙여넣기는 그대로 둔다.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    void addImageFiles(Array.from(e.dataTransfer.files))
  }

  const submit = () => {
    const t = input.trim()
    // 생성 중에 보내면 '끼어들어 말하기': 지금 답변을 멈추고 이 메시지를 이어서 보낸다(App 이 처리).
    if ((!t && images.length === 0 && driveFiles.length === 0) || !hasApiKey) return
    onSend(t, images, driveFiles); setInput(''); setImages([]); setDriveFiles([]); setImageError('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
  }

  const hasDraft = !!input.trim() || images.length > 0 || driveFiles.length > 0
  const canSend = hasDraft && hasApiKey
  // 생성 중 + 입력 없음 → 정지 버튼, 생성 중 + 입력 있음 → 끼어들어 보내기
  const interrupting = isLoading && hasDraft

  // 입력창 묶음. 대화가 비어 있으면 화면 가운데에, 있으면 아래에 둔다.
  const composer = (
      <div className="flex-shrink-0 px-3 pb-3 pt-2 w-full max-w-[760px] mx-auto">
        {!hasApiKey && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2"
            style={{ background: 'var(--err-bg)', border: '1px solid var(--err-bd)', borderRadius: 'var(--radius-md)', color: 'var(--err)', fontSize: 'var(--fs-sm)' }}>
            <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
            API 키가 없습니다. 상단의 API 키 버튼에서 입력해 주세요.
          </div>
        )}
        {(imageError || attachError) && (
          <p role="alert" style={{ color: 'var(--err)', fontSize: 'var(--fs-xs)', margin: '0 4px 6px' }}>{imageError || attachError}</p>
        )}

        {/* 화면에는 보이지 않고, 생성 시작·끝을 스크린리더에 알린다. */}
        <span className="sr-only" aria-live="polite">
          {isLoading ? '응답을 생성하고 있습니다' : messages.length > 0 ? '응답이 끝났습니다' : ''}
        </span>
        <div className="chat-input-box transition-all"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          style={{
            background: 'var(--bg-panel)',
            border: `1px solid ${input || images.length > 0 ? 'var(--accent-bd)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 1px 3px rgba(20,20,19,0.06)',
          }}>
          {driveFiles.length > 0 && (
            <div className="flex flex-wrap gap-2" style={{ padding: '10px 12px 0' }}>
              {driveFiles.map((f) => (
                <span key={f.id} className="file-chip" title={f.name}>
                  <span aria-hidden="true">{fileIcon(f.name, f.mimeType)}</span>
                  <span className="truncate">{f.name}</span>
                  {f.sizeBytes ? <span className="file-chip-size">{fmtSize(f.sizeBytes)}</span> : null}
                  <button onClick={() => setDriveFiles((prev) => prev.filter((d) => d.id !== f.id))} aria-label={`${f.name} 첨부 빼기`} className="file-chip-x">
                    <X style={{ width: 12, height: 12 }} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2" style={{ padding: '10px 12px 0' }}>
              {images.map((img, k) => (
                <div key={k} className="relative">
                  <img src={imageSrc(img)} alt={`보낼 이미지 ${k + 1}`} className="chat-image-draft" />
                  <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== k))}
                    aria-label={`이미지 ${k + 1} 빼기`} className="chat-image-remove tip tip-up">
                    <X style={{ width: 12, height: 12 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea ref={taRef} value={input}
            onChange={onInput} onKeyDown={onKey} onPaste={onPaste}
            aria-label="메시지 입력"
            placeholder={!hasApiKey ? 'API 키를 먼저 설정해 주세요' : isLoading ? '생성 중에도 입력할 수 있어요. 보내면 지금 답변을 멈추고 이어서 말합니다' : '만들고 싶은 것을 설명해 주세요'}
            disabled={!hasApiKey} rows={2}
            className="w-full bg-transparent resize-none disabled:opacity-40"
            style={{
              display: 'block',
              padding: '12px 14px 4px',
              color: 'var(--txt)',
              fontSize: 'var(--fs-md)',
              lineHeight: 1.6,
              minHeight: 52,
              maxHeight: 180,
              border: 'none',
              outline: 'none',
              caretColor: 'var(--accent)',
            }}
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <span className="flex items-center gap-2">
              {onPickDriveFile && (
                <button onClick={pickDrive} disabled={!hasApiKey || driveFiles.length >= 5} aria-label="드라이브 파일 첨부" className="icon-btn tip-up">
                  <GoogleDrive style={{ width: 16, height: 16 }} />
                </button>
              )}
              <button onClick={() => fileInputRef.current?.click()}
                disabled={!hasApiKey || images.length >= MAX_IMAGES_PER_MESSAGE}
                aria-label="이미지 추가 (붙여넣기·끌어다 놓기도 됩니다)"
                className="icon-btn tip-up">
                <ImagePlus style={{ width: 16, height: 16 }} />
              </button>
              <input ref={fileInputRef} type="file" hidden multiple
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => { void addImageFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
              <span className="hidden md:inline" style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-xs)' }}>
                Shift+Enter 줄바꿈
              </span>
            </span>
            <button onClick={isLoading && !interrupting ? onStop : submit} disabled={!isLoading && !canSend}
              aria-label={interrupting ? '지금 답변을 멈추고 보내기' : isLoading ? '생성 중지' : '전송'}
              className="tip tip-up flex items-center justify-center transition-colors"
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: canSend || isLoading ? 'var(--accent)' : 'var(--bg-hover)',
                color: canSend || isLoading ? 'var(--on-accent)' : 'var(--txt-3)',
                border: 'none',
                cursor: canSend || isLoading ? 'pointer' : 'default',
              }}
              onMouseEnter={e => { if (canSend || isLoading) e.currentTarget.style.background = 'var(--accent-h)' }}
              onMouseLeave={e => { if (canSend || isLoading) e.currentTarget.style.background = 'var(--accent)' }}>
              {isLoading && !interrupting
                ? <Square style={{ width: 12, height: 12 }} fill="currentColor" />
                : <ArrowUp style={{ width: 16, height: 16 }} />}
            </button>
          </div>
        </div>
      </div>
  )

  return (
    <div className="flex flex-col flex-shrink-0"
      style={{
        width: width ?? '100%',
        minWidth: width ? 220 : undefined,
        maxWidth: width ? '60vw' : undefined,
        background: 'var(--bg-panel)',
        flex: width ? undefined : '1',
      }}>

      {projectName && (
        <div className="project-bar">
          <button onClick={onOpenProject} className="project-badge" title="프로젝트 설정">📁 {projectName}</button>
          <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>이 대화는 프로젝트 지침·공유 자료를 함께 받아요</span>
        </div>
      )}
      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col h-full items-center justify-center gap-4 px-3 pb-16">
            {/* 빈 화면: 제목 → 입력창 → 추천 순서로 가운데에 둔다. */}
            <div className="text-center px-3">
              <p style={{ color: 'var(--txt)', fontFamily: 'var(--display-font)', fontSize: 28, fontWeight: 500, marginBottom: 6 }}>
                무엇을 만들어 볼까요?
              </p>
              <p style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-sm)' }}>
                아이디어를 설명하면 Claude가 디자인 방향을 먼저 제안하고 코드로 만들어 드려요
              </p>
            </div>
            {composer}

            {/* Suggestions */}
            <div className="px-4 flex flex-wrap justify-center gap-2 w-full max-w-[760px]">
              {SUGGESTIONS.map(s => (
                <button key={s.label}
                  onClick={() => { setInput(s.desc); taRef.current?.focus() }}
                  className="transition-colors"
                  style={{
                    padding: '6px 12px',
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--txt-2)',
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-bd)'; e.currentTarget.style.color = 'var(--txt)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--txt-2)' }}>
                  {s.desc}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col px-4 py-4 gap-4 w-full max-w-[760px] mx-auto">
            {messages.map((msg, i) => (
              msg.role === 'user' ? (
                /* 사용자 메시지: 오른쪽 말풍선 */
                <div key={i} className="flex flex-col items-end gap-1.5">
                  {msg.docs && msg.docs.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5" style={{ maxWidth: '85%' }}>
                      {msg.docs.map((d, k) => (
                        <span key={k} className="file-chip" title={d.kind === 'ref' ? `${d.name} — 커서 필요할 때 읽어요` : d.name}>
                          <span aria-hidden="true">{fileIcon(d.name, d.mimeType)}</span>
                          <span className="truncate">{d.name}</span>
                          <span className="file-chip-size">{d.kind === 'ref' ? '필요할 때 읽음' : fmtSize(d.size)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5" style={{ maxWidth: '85%' }}>
                      {msg.images.map((img, k) => (
                        <img key={k} src={imageSrc(img)} alt={`첨부 이미지 ${k + 1}`} className="chat-image" />
                      ))}
                    </div>
                  )}
                  <p style={{
                    maxWidth: '85%',
                    padding: '8px 14px',
                    background: 'var(--bg-card)',
                    borderRadius: 'var(--radius-lg)',
                    color: 'var(--txt)',
                    fontSize: 'var(--fs-md)',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {msg.content}
                  </p>
                </div>
              ) : (
                /* Claude 메시지: 본문은 대화에 바로 보여 주고, 파일을 만든 답변에는 결과물 카드를 붙인다. 오류는 본문 대신 오류 문구만 보여준다. */
                <div key={i} className="flex flex-col gap-2.5 min-w-0">
                  {!msg.content
                    ? (msg.thinking
                        ? <div className="flex flex-col gap-1.5"><Dots /><div className="thinking-peek" aria-live="polite"><span>{msg.thinking}</span></div></div>
                        : <Dots />)
                    : msg.content.startsWith('오류:')
                      ? <p role="alert" style={{ color: 'var(--err)', fontSize: 'var(--fs-md)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingTop: 8 }}>{msg.content}</p>
                      : (<>
                        {/* 파일 코드는 캔버스에서 보므로 대화에는 본문만 렌더링한다. */}
                        <div className="chat-answer"><AnswerView message={{ ...msg, files: undefined }} /></div>
                        {msg.files && Object.keys(msg.files).length > 0 && (
                        <div className="flex gap-2.5 min-w-0">
                        <button onClick={() => onOpenAnswer(i)}
                          className="flex items-center gap-3 text-left min-w-0 flex-1 transition-colors"
                          aria-pressed={activeAnswerIndex === i}
                          style={{
                            padding: '10px 12px',
                            background: activeAnswerIndex === i ? 'var(--bg-card)' : 'var(--bg-panel)',
                            border: `1px solid ${activeAnswerIndex === i ? 'var(--accent-bd)' : 'var(--border)'}`,
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                          }}>
                          <FileText style={{ width: 18, height: 18, color: 'var(--txt-2)', flexShrink: 0 }} />
                          <span className="flex flex-col min-w-0">
                            <span className="truncate" style={{ color: 'var(--txt)', fontSize: 'var(--fs-md)', fontWeight: 500 }}>
                              결과물
                            </span>
                            <span style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-xs)' }}>
                              {`파일 ${Object.keys(msg.files).length}개 · 눌러서 보기`}
                            </span>
                          </span>
                        </button>
                        {msg.snapshot && i !== lastAnswerIndex && !isLoading && (
                          <button onClick={() => onRestore(i)}
                            className="icon-btn tip-up self-center flex-shrink-0"
                            aria-label="이 답변 시점의 버전으로 되돌리기"
                            style={{ border: '1px solid var(--border)' }}>
                            <History style={{ width: 16, height: 16 }} />
                          </button>
                        )}
                        </div>
                        )}
                      </>)}
                  {/* 본문이 이미 나오는 중에 검색을 시작하면 마지막 검색어를 작게 보여준다 */}
                  {isLoading && i === messages.length - 1 && msg.content && lastActivity(msg.thinking) && (
                    <p role="status" style={{ fontSize: 'var(--fs-xs)', color: 'var(--txt-3)', margin: 0 }}>
                      {lastActivity(msg.thinking)}
                    </p>
                  )}
                  {msg.outputs && msg.outputs.length > 0 && <OutputFiles ids={msg.outputs} onSaveToDrive={onSaveOutputToDrive} />}
                  {msg.sources && msg.sources.length > 0 && (
                    <details className="sources" open={msg.sources.some((s) => s.cited)}>
                      <summary>출처 {msg.sources.filter((s) => s.cited).length || msg.sources.length}개{msg.sources.some((s) => s.cited) ? '' : ' (검색한 페이지)'}</summary>
                      <ol>
                        {(msg.sources.some((s) => s.cited) ? msg.sources.filter((s) => s.cited) : msg.sources).map((src) => (
                          <li key={src.url}>
                            <a href={src.url} target="_blank" rel="noopener noreferrer" title={src.url}>{src.title}</a>
                            <span className="sources-host">{(() => { try { return new URL(src.url).hostname.replace(/^www\./, '') } catch { return '' } })()}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {msg.truncated === 'output' && i === messages.length - 1 && !isLoading && (
                    <button onClick={onContinue} className="self-start"
                      style={{ height: 32, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 999, background: 'var(--bg-panel)', color: 'var(--txt)', fontSize: 'var(--fs-md)', cursor: 'pointer' }}>
                      이어서 생성
                    </button>
                  )}
                  {msg.failed && i === messages.length - 1 && !isLoading && (
                    <button onClick={onRetry} className="self-start"
                      style={{ height: 32, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 999, background: 'var(--bg-panel)', color: 'var(--txt)', fontSize: 'var(--fs-md)', cursor: 'pointer' }}>
                      다시 시도
                    </button>
                  )}
                </div>
              )
            ))}
            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex gap-2.5">
                <Dots />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {messages.length > 0 && composer}

      {/* 사용량: 이번 요청 + 이 브라우저의 오늘·누적 예상 비용. 비용은 단가로 계산한 근사값이다. */}
      {(tokenUsage || usageTotals.totalTokens > 0 || balance) && (
        <div className="flex-shrink-0 px-4 pb-3 flex flex-col gap-0.5 w-full max-w-[760px] mx-auto"
          style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums' }}>
          {tokenUsage && (
            <span>
              이번 in {tokenUsage.promptTokens.toLocaleString()} · out {tokenUsage.completionTokens.toLocaleString()} · 약 {formatUsd(lastCost)}
            </span>
          )}
          <span className="flex items-center gap-2 flex-wrap">
            <span title="이 브라우저에서 보낸 요청만 합산한 예상 비용입니다">
              오늘 약 {formatUsd(usageTotals.todayCost)} · 누적 약 {formatUsd(usageTotals.totalCost)}
            </span>
            <button onClick={onResetUsage}
              style={{ color: 'var(--txt-2)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>
              초기화
            </button>
            <a href={BILLING_URL} target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
              실제 잔액 보기
            </a>
          </span>
          {balanceDraft !== null ? (
            <form className="flex items-center gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); saveBalance() }}>
              <label htmlFor="balance-input">Console 잔액 $</label>
              <input id="balance-input" autoFocus inputMode="decimal" value={balanceDraft} onChange={(e) => setBalanceDraft(e.target.value)}
                placeholder="예: 20" style={{ width: 80, height: 24, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-panel)', color: 'var(--txt)' }} />
              <button type="submit" style={{ color: 'var(--txt)', textDecoration: 'underline' }}>저장</button>
              <button type="button" onClick={() => setBalanceDraft(null)} style={{ color: 'var(--txt-2)', textDecoration: 'underline' }}>취소</button>
              <span>비워 두고 저장하면 표시를 끕니다</span>
            </form>
          ) : (
            <span className="flex items-center gap-2 flex-wrap">
              {remaining !== null ? (
                <span title="입력한 Console 잔액에서 이후 예상 비용을 뺀 값입니다. 실제 청구액과 조금 다를 수 있습니다."
                  style={{ color: remaining < 0.5 ? 'var(--err)' : remaining < 2 ? 'var(--warn)' : 'var(--txt-2)', fontWeight: 500 }}>
                  남은 금액 약 {remaining < 0 ? `-${formatUsd(-remaining)}` : formatUsd(remaining)}
                  {remaining < 2 && ' · 충전이 필요할 수 있어요'}
                </span>
              ) : (
                <span>남은 금액을 보려면 Console 잔액을 입력하세요</span>
              )}
              <button onClick={() => setBalanceDraft(balance ? String(Math.max(0, +(remaining ?? 0).toFixed(2))) : '')}
                style={{ color: 'var(--txt-2)', textDecoration: 'underline' }}>
                {balance ? '잔액 맞추기' : '잔액 입력'}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}