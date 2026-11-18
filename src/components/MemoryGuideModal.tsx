import { useState } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { MemoryManager } from './ModelOptionsMenu'

/**
 * 사이드바 아래 '메모리 활용 팁' 안내. 기억은 항상 켜져 있고(대화 시작 때 앱이 넣어 준다),
 * "기억해 줘"라고 하면 Claude 가 저장한다. 여기서 기억 보기·편집 창도 연다.
 */
const EXAMPLES = [
  ['저장하기', '"기억해: 나는 Vue 3 + Spring Boot 로 개발해"', '"기억해: 커밋 메시지는 한국어로, 짧게"', '"기억해: 답변은 표로 정리해 줘"'],
  ['확인하기', '"내가 기억시킨 것 보여 줘"'],
  ['고치기·지우기', '"스택 기억을 Vue 3 + NestJS 로 바꿔 줘"', '"답변 형식 기억은 지워 줘"'],
]

export default function MemoryGuideModal({ onClose }: { onClose: () => void }) {
  const [manager, setManager] = useState(false)
  useEscapeKey(onClose, !manager)
  if (manager) return <MemoryManager onClose={() => setManager(false)} />
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="memory-guide-title" className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)', padding: 16 }} onClick={onClose}>
      <div className="mopt" style={{ position: 'static', width: 'min(480px, 100%)', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div className="mopt-head"><span id="memory-guide-title">메모리 활용 팁</span></div>
        <p className="mopt-desc" style={{ margin: 0 }}>
          한 번 알려 준 취향·규칙을 기억해서 <b>다음 대화에도 자동으로 반영</b>해요. 따로 켤 필요 없어요.
        </p>
        {EXAMPLES.map(([title, ...lines]) => (
          <div key={title}>
            <span className="mopt-label" style={{ fontWeight: 600 }}>{title}</span>
            {lines.map((l) => <span key={l} className="mopt-desc" style={{ display: 'block' }}>{l}</span>)}
          </div>
        ))}
        <div>
          <span className="mopt-label" style={{ fontWeight: 600 }}>알아 두기</span>
          <ul className="mopt-desc" style={{ margin: '2px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            <li>잘 맞는 것: 쓰는 기술 스택, 코드 규칙, 디자인 취향, 답변 방식</li>
            <li>넣지 말 것: 비밀번호·API 키·개인정보</li>
            <li>새로 기억한 내용은 <b>다음 대화부터</b> 반영돼요</li>
            <li>기억은 내 구글 드라이브(연결 시)에 저장되고, 지인과 공유되지 않아요</li>
            <li>기억이 짧을수록 매 대화에 드는 토큰이 적어요. 안 쓰는 건 지워 주세요</li>
          </ul>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="sidebar-new" onClick={() => setManager(true)}>기억 보기·편집</button>
          <button className="mopt-reset" onClick={onClose} autoFocus>닫기</button>
        </div>
      </div>
    </div>
  )
}
