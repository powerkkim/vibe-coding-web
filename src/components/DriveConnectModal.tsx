import { useState } from 'react'
import { GoogleDrive } from '../icons'
import { useEscapeKey } from '../hooks/useEscapeKey'

/**
 * Google 드라이브 연결 안내 팝업.
 * - welcome: 앱을 열었는데 드라이브를 한 번도 연결하지 않은 경우
 * - request: 챗봇이 "드라이브에 저장/불러오기" 요청을 받았는데 연결이 안 된 경우(request_drive_connection 도구)
 * 연결 버튼은 사용자가 직접 눌러야 한다(로그인 팝업은 클릭 안에서만 열 수 있다).
 */
interface Props {
  mode: 'welcome' | 'request' | 'scope'
  busy: boolean
  error?: string
  onConnect: () => void
  onClose: (dontShowAgain: boolean) => void
}

export default function DriveConnectModal({ mode, busy, error, onConnect, onClose }: Props) {
  const [dontShow, setDontShow] = useState(false)
  useEscapeKey(() => onClose(dontShow), true)
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="drive-modal-title" className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)', padding: 16 }} onClick={() => onClose(dontShow)}>
      <div className="mopt" style={{ position: 'static', width: 'min(420px, 100%)', gap: 14 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <GoogleDrive aria-hidden="true" style={{ width: 22, height: 22, flexShrink: 0 }} />
          <h2 id="drive-modal-title" style={{ margin: 0, fontSize: 'var(--fs-lg, 17px)', fontWeight: 600 }}>
            {mode === 'welcome' ? '대화를 계속 보관하려면 드라이브를 연결하세요' : mode === 'scope' ? '드라이브에 파일로 저장하려면 권한을 추가해 주세요' : 'Google 드라이브 연결이 필요해요'}
          </h2>
        </div>
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--txt-2)', lineHeight: 1.6 }}>
          {mode === 'scope'
            ? '이제 프로젝트 파일과 저장하라고 한 파일을 내 드라이브의 "Vibe Coding" 폴더에 보이는 파일로 저장해요. 이를 위해 "이 앱이 만든 파일만 보고 관리" 권한을 한 번 더 허용해 주세요.'
            : mode === 'welcome'
            ? '연결하지 않으면 대화가 이 브라우저에만 저장되어, 브라우저 데이터를 지우거나 다른 기기에서는 볼 수 없어요. 연결하면 모든 대화가 내 Google 드라이브의 앱 전용 숨김 폴더에 자동 저장되고, 어느 기기에서든 이어서 쓸 수 있어요.'
            : '드라이브에 저장하거나 불러오려면 먼저 연결해야 해요. 연결하면 지금까지의 대화도 자동으로 드라이브에 올라가고, 저장된 대화는 왼쪽 목록에서 열 수 있어요.'}
        </p>
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--txt-3)', lineHeight: 1.5 }}>
          이 앱은 자기가 만든 파일·폴더(숨김 대화 폴더와 "Vibe Coding" 폴더)만 읽고 쓸 수 있어요. 드라이브의 다른 파일은 볼 수 없습니다.
        </p>
        {error && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="sidebar-new" onClick={onConnect} disabled={busy} autoFocus style={{ flex: '1 1 auto' }}>
            {busy ? '연결 중…' : mode === 'scope' ? '권한 추가' : 'Google 드라이브 연결'}
          </button>
          <button className="mopt-reset" onClick={() => onClose(dontShow)}>나중에</button>
        </div>
        {mode === 'welcome' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--txt-3)', cursor: 'pointer' }}>
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
            다시 보지 않기 (왼쪽 아래에서 언제든 연결할 수 있어요)
          </label>
        )}
      </div>
    </div>
  )
}
