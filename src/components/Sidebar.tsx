import { useEffect, useState } from 'react'
import { Plus, Trash2, MessageSquare, PanelLeft, Loader2, GoogleDrive, FolderGit2, ChevronDown, ChevronRight, Ellipsis, SlidersHorizontal } from '../icons'
import type { Project } from '../services/projectStore'
import type { ChatListItem as ChatSummary } from '../services/chatStore'

/**
 * Sidebar: 저장된 대화 목록
 *
 * 최근 수정 순으로 오늘 / 어제 / 지난 7일 / 이전 묶음으로 보여준다.
 * 응답 생성 중(busy)에는 대화 전환·새 대화·삭제를 막는다. 진행 중인 스트림이 다른 대화에 섞이지 않게 하기 위함이다.
 */
interface Props {
  chats: ChatSummary[]
  activeId: string | null
  // 불러오는 중인 대화. 응답 전에도 이 항목을 선택된 것으로 표시한다.
  loadingId: string | null
  busy: boolean
  error: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
  // 프로젝트: 목록·지금 대화의 프로젝트·만들기·설정·프로젝트 안 새 대화·대화 옮기기
  projects: Project[]
  activeProjectId: string | null
  onNewProject: () => void
  onEditProject: (p: Project) => void
  onNewChatInProject: (projectId: string) => void
  onMoveChat: (chatId: string, projectId: string | null) => void
  // 대화를 Google 드라이브에 저장할 때만 넘긴다.
  drive?: { configured: boolean; connected: boolean; expired: boolean; account?: string; busy: boolean; onConnect: () => void; onDisconnect: () => void
    // 프로젝트 파일 자동 저장(내 드라이브 Vibe Coding 폴더)과 지금 대화의 폴더 주소
    autoSave: boolean; onAutoSave: (on: boolean) => void; folderUrl: string | null
    // 로그인 유지(1시간마다 다시 로그인 안 함). canStaySignedIn: 서버가 있어 켤 수 있음, staySignedIn: 켜져 있음
    canStaySignedIn?: boolean; staySignedIn?: boolean; onStaySignedIn?: () => void }
}

const DAY_MS = 24 * 60 * 60 * 1000

function groupLabel(updatedAt: number, todayStart: number): string {
  if (updatedAt >= todayStart) return '오늘'
  if (updatedAt >= todayStart - DAY_MS) return '어제'
  if (updatedAt >= todayStart - 7 * DAY_MS) return '지난 7일'
  return '이전'
}

export default function Sidebar({ chats, activeId, loadingId, busy, error, onSelect, onNew, onDelete, onClose, drive, projects, activeProjectId, onNewProject, onEditProject, onNewChatInProject, onMoveChat }: Props) {
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const projectIds = new Set(projects.map((p) => p.id))
  const inProject = (c: ChatSummary) => !!c.projectId && projectIds.has(c.projectId)
  // 펼친 프로젝트(지금 대화의 프로젝트는 항상 펼침)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (id: string) => open[id] ?? id === activeProjectId
  // '프로젝트로 옮기기' 메뉴가 열린 대화
  const [moveMenu, setMoveMenu] = useState<string | null>(null)
  useEffect(() => {
    if (!moveMenu) return
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.move-menu, [aria-expanded="true"]')) setMoveMenu(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moveMenu])

  const row = (chat: ChatSummary) => (
    <li key={chat.id} className="sidebar-item" data-active={chat.id === (loadingId ?? activeId)} aria-busy={chat.id === loadingId} style={{ position: 'relative' }}>
      <button onClick={() => onSelect(chat.id)} disabled={busy} className="sidebar-item-open" title={chat.title}>
        {chat.id === loadingId
          ? <Loader2 aria-label="불러오는 중" className="motion-safe:animate-spin" style={{ width: 14, height: 14, flexShrink: 0 }} />
          : <MessageSquare aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />}
        <span className="truncate" style={chat.driveOnly ? { opacity: 0.55 } : undefined}>{chat.title}</span>
        {chat.pending && drive?.connected === false && drive.expired && (
          <span title="드라이브를 다시 연결하면 자동으로 올라갑니다" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: 'var(--warn)' }}>대기</span>
        )}
      </button>
      {projects.length > 0 && (
        <button onClick={() => setMoveMenu(moveMenu === chat.id ? null : chat.id)} disabled={busy} className="sidebar-item-delete" title="프로젝트로 옮기기" aria-label={`${chat.title} 프로젝트로 옮기기`} aria-expanded={moveMenu === chat.id}>
          <Ellipsis style={{ width: 14, height: 14 }} />
        </button>
      )}
      <button onClick={() => onDelete(chat.id)} disabled={busy} className="sidebar-item-delete tip" aria-label={`${chat.title} 삭제`}>
        <Trash2 style={{ width: 14, height: 14 }} />
      </button>
      {moveMenu === chat.id && (
        <div role="menu" className="move-menu">
          <div className="move-menu-title">프로젝트로 옮기기</div>
          {projects.filter((p) => p.id !== chat.projectId).map((p) => (
            <button key={p.id} role="menuitem" onClick={() => { onMoveChat(chat.id, p.id); setMoveMenu(null) }}>📁 {p.name}</button>
          ))}
          {inProject(chat) && <button role="menuitem" onClick={() => { onMoveChat(chat.id, null); setMoveMenu(null) }}>프로젝트에서 빼기</button>}
          <button role="menuitem" onClick={() => setMoveMenu(null)} style={{ color: 'var(--txt-3)' }}>닫기</button>
        </div>
      )}
    </li>
  )

  const groups: { label: string; items: ChatSummary[] }[] = []
  for (const chat of chats.filter((c) => !inProject(c))) {
    const label = groupLabel(chat.updatedAt, todayStart)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.items.push(chat)
    else groups.push({ label, items: [chat] })
  }

  return (
    <nav aria-label="대화 목록" className="sidebar flex flex-col h-full">
      <div className="p-3 flex-shrink-0 flex items-center gap-2">
        <button onClick={onNew} disabled={busy} className="sidebar-new">
          <Plus style={{ width: 16, height: 16 }} />
          <span>새 대화</span>
        </button>
        <button onClick={onNewProject} disabled={busy} className="icon-btn tip" aria-label="새 프로젝트">
          <FolderGit2 style={{ width: 18, height: 18 }} />
        </button>
        <button onClick={onClose} className="icon-btn" aria-label="대화 목록 접기" aria-expanded>
          <PanelLeft style={{ width: 18, height: 18 }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {projects.length > 0 && (
          <section className="mb-3">
            <h2 className="sidebar-group">프로젝트</h2>
            <ul>
              {projects.map((p) => {
                const items = chats.filter((c) => c.projectId === p.id)
                return (
                  <li key={p.id}>
                    <div className="sidebar-item" data-active={p.id === activeProjectId && !activeId}>
                      <button className="sidebar-item-open" onClick={() => setOpen((o) => ({ ...o, [p.id]: !isOpen(p.id) }))} aria-expanded={isOpen(p.id)} title={p.name}>
                        {isOpen(p.id) ? <ChevronDown style={{ width: 14, height: 14, flexShrink: 0 }} /> : <ChevronRight style={{ width: 14, height: 14, flexShrink: 0 }} />}
                        <span className="truncate" style={{ fontWeight: 600 }}>📁 {p.name}</span>
                        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: 'var(--txt-3)' }}>{items.length}</span>
                      </button>
                      <button onClick={() => onNewChatInProject(p.id)} disabled={busy} className="sidebar-item-delete tip" aria-label={`${p.name}에서 새 대화`}>
                        <Plus style={{ width: 14, height: 14 }} />
                      </button>
                      <button onClick={() => onEditProject(p)} className="sidebar-item-delete tip" aria-label={`${p.name} 설정`}>
                        <SlidersHorizontal style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                    {isOpen(p.id) && (
                      <ul style={{ paddingLeft: 14 }}>
                        {items.length === 0
                          ? <li style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-xs)', padding: '4px 10px' }}>+ 를 눌러 이 프로젝트에서 새 대화를 시작하세요</li>
                          : items.map(row)}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {chats.length === 0 && (
          <p style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-sm)', padding: '8px 10px' }}>
            저장된 대화가 없습니다
          </p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="mb-3">
            <h2 className="sidebar-group">{projects.length ? `대화 · ${group.label}` : group.label}</h2>
            <ul>
              {group.items.map(row)}
            </ul>
          </section>
        ))}
      </div>

      {drive && (
        <div className="flex-shrink-0" style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)', color: 'var(--txt-2)' }}>
          <GoogleDrive aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }} />
          {!drive.configured ? (
            <span>이 브라우저에 저장 중 (드라이브 연결은 GOOGLE_CLIENT_ID 설정 후 가능)</span>
          ) : drive.connected ? (
            <>
              <span className="flex-1 min-w-0" style={{ display: 'flex', flexDirection: 'column' }}>
                <span>Google 드라이브에 저장 중</span>
                {drive.account && <span className="truncate" style={{ color: 'var(--txt-3)' }} title={drive.account}>{drive.account}</span>}
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, cursor: 'pointer' }} title='답변으로 파일이 바뀔 때마다 내 드라이브 "Vibe Coding/프로젝트" 폴더에 저장'>
                  <input type="checkbox" checked={drive.autoSave} onChange={(e) => drive.onAutoSave(e.target.checked)} />
                  프로젝트 파일 드라이브에 저장
                </label>
                {drive.folderUrl && <a href={drive.folderUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>이 프로젝트 폴더 열기</a>}
                {drive.canStaySignedIn && (drive.staySignedIn
                  ? <span style={{ color: 'var(--txt-3)', marginTop: 2 }}>로그인 유지 중</span>
                  : <button onClick={drive.onStaySignedIn} disabled={drive.busy} title="한 번만 동의하면 1시간마다 다시 로그인하지 않아요"
                      style={{ alignSelf: 'flex-start', color: 'var(--accent)', textDecoration: 'underline', marginTop: 2 }}>로그인 유지 켜기</button>)}
              </span>
              <button onClick={drive.onDisconnect} disabled={drive.busy} style={{ color: 'var(--txt-3)', textDecoration: 'underline', flexShrink: 0 }}>연결 해제</button>
            </>
          ) : drive.expired ? (
            <div className="flex-1 min-w-0" role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ color: 'var(--warn)' }}>드라이브 연결이 만료됐어요 (1시간마다 만료)</span>
              <span style={{ color: 'var(--txt-3)' }}>화면을 클릭하면 자동으로 다시 연결해요. 그동안 대화는 이 브라우저에 임시 저장했다가 연결되면 드라이브로 올립니다.</span>
              <button onClick={drive.onConnect} disabled={drive.busy} className="sidebar-new">
                {drive.busy ? '연결 중…' : `다시 연결${drive.account ? ` (${drive.account})` : ''}`}
              </button>
            </div>
          ) : (
            <div className="flex-1" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>이 브라우저에 저장 중</span>
              <button onClick={drive.onConnect} disabled={drive.busy} className="sidebar-new">
                {drive.busy ? '연결 중…' : 'Google 드라이브 연결'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="flex-shrink-0" style={{ color: 'var(--err)', fontSize: 'var(--fs-xs)', padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
          {error}
        </p>
      )}
    </nav>
  )
}
