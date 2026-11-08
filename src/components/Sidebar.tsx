import { Plus, Trash2, MessageSquare, PanelLeft, Loader2, GoogleDrive } from '../icons'
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
  // 대화를 Google 드라이브에 저장할 때만 넘긴다.
  drive?: { configured: boolean; connected: boolean; expired: boolean; account?: string; busy: boolean; onConnect: () => void; onDisconnect: () => void
    // 프로젝트 파일 자동 저장(내 드라이브 Vibe Coding 폴더)과 지금 대화의 폴더 주소
    autoSave: boolean; onAutoSave: (on: boolean) => void; folderUrl: string | null }
}

const DAY_MS = 24 * 60 * 60 * 1000

function groupLabel(updatedAt: number, todayStart: number): string {
  if (updatedAt >= todayStart) return '오늘'
  if (updatedAt >= todayStart - DAY_MS) return '어제'
  if (updatedAt >= todayStart - 7 * DAY_MS) return '지난 7일'
  return '이전'
}

export default function Sidebar({ chats, activeId, loadingId, busy, error, onSelect, onNew, onDelete, onClose, drive }: Props) {
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const groups: { label: string; items: ChatSummary[] }[] = []
  for (const chat of chats) {
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
        <button onClick={onClose} className="icon-btn" aria-label="대화 목록 접기" aria-expanded>
          <PanelLeft style={{ width: 18, height: 18 }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {chats.length === 0 && (
          <p style={{ color: 'var(--txt-3)', fontSize: 'var(--fs-sm)', padding: '8px 10px' }}>
            저장된 대화가 없습니다
          </p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="mb-3">
            <h2 className="sidebar-group">{group.label}</h2>
            <ul>
              {group.items.map((chat) => (
                <li key={chat.id} className="sidebar-item" data-active={chat.id === (loadingId ?? activeId)} aria-busy={chat.id === loadingId}>
                  <button onClick={() => onSelect(chat.id)} disabled={busy} className="sidebar-item-open" title={chat.title}>
                    {chat.id === loadingId
                      ? <Loader2 aria-label="불러오는 중" className="motion-safe:animate-spin" style={{ width: 14, height: 14, flexShrink: 0 }} />
                      : <MessageSquare aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />}
                    <span className="truncate" style={chat.driveOnly ? { opacity: 0.55 } : undefined}>{chat.title}</span>
                    {chat.pending && drive?.connected === false && drive.expired && (
                      <span title="드라이브를 다시 연결하면 자동으로 올라갑니다" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: 'var(--warn)' }}>대기</span>
                    )}
                  </button>
                  <button onClick={() => onDelete(chat.id)} disabled={busy} className="sidebar-item-delete tip" aria-label={`${chat.title} 삭제`}>
                    <Trash2 style={{ width: 14, height: 14 }} />
                  </button>
                </li>
              ))}
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
