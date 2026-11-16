import { Globe } from '../icons'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { versionLess } from '../services/browserExt'

/**
 * 크롬 확장 "Vibe Coding 브라우저 도우미" 설치·업데이트 안내.
 * 확장은 웹스토어가 아니라 개발자 모드로 설치한다(zip 은 Pages 배포에 함께 올라간다: vibe-browser-extension.zip).
 */
interface Props { version: string | null; minVersion: string; onClose: () => void }

const ZIP_URL = `${import.meta.env.BASE_URL}vibe-browser-extension.zip`

export default function BrowserExtModal({ version, minVersion, onClose }: Props) {
  useEscapeKey(onClose, true)
  const outdated = !!version && versionLess(version, minVersion)
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ext-modal-title" className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)', padding: 16 }} onClick={onClose}>
      <div className="mopt" style={{ position: 'static', width: 'min(460px, 100%)', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Globe aria-hidden="true" style={{ width: 22, height: 22, flexShrink: 0 }} />
          <h2 id="ext-modal-title" style={{ margin: 0, fontSize: 'var(--fs-lg, 17px)', fontWeight: 600 }}>
            {version ? (outdated ? '브라우저 확장을 업데이트해 주세요' : `브라우저 확장 v${version} 연결됨`) : '브라우저 확장 설치'}
          </h2>
        </div>
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--txt-2)', lineHeight: 1.6 }}>
          확장을 설치하면 챗봇이 이 크롬의 "Vibe" 탭 그룹 안에서 사이트를 열고, 읽고, 클릭·입력할 수 있어요. 대화마다 입력창의 <b>브라우저</b> 버튼으로 켜요(기본 꺼짐).
          데스크톱 크롬·엣지 전용이에요.
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--fs-sm)', color: 'var(--txt-2)', lineHeight: 1.7 }}>
          <li><a href={ZIP_URL} download style={{ color: 'var(--accent)' }}>vibe-browser-extension.zip</a> 을 받아 압축을 풀어요(폴더는 지우지 말고 둬요)</li>
          <li>주소창에 <code>chrome://extensions</code> 를 열고 오른쪽 위 <b>개발자 모드</b>를 켜요</li>
          <li><b>압축해제된 확장 프로그램 로드</b> → 푼 폴더를 선택해요{outdated ? ' (업데이트는 새 파일로 폴더를 바꾼 뒤 확장 카드의 새로고침 ↻)' : ''}</li>
          <li>이 앱을 새로고침하면 "브라우저 확장 연결됨"으로 바뀌어요</li>
        </ol>
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--txt-3)', lineHeight: 1.5 }}>
          조작하는 동안 크롬 위에 "디버깅 중" 띠가 떠요. 띠의 취소를 누르면 바로 멈춰요. 처음 여는 사이트, 저장·삭제·전송처럼 되돌리기 어려운 동작은 누르기 전에 이 앱에서 확인을 받아요.
          챗봇과 확장은 같은 크롬 프로필에서 열어야 연결돼요.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="mopt-reset" onClick={onClose} autoFocus>닫기</button>
        </div>
      </div>
    </div>
  )
}
