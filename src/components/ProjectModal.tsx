import { useState } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { loadAttachment } from '../services/driveExport'
import type { PickerDoc } from '../services/driveExport'
import { KNOWLEDGE_FILE_LIMIT, KNOWLEDGE_TOTAL_LIMIT } from '../services/projectStore'
import type { KnowledgeFile, Project } from '../services/projectStore'

/**
 * 프로젝트 만들기·설정
 * - 이름, 지침(이 프로젝트의 모든 대화에 적용), 공유 자료(텍스트 파일 — 드라이브에서 고르거나 직접 붙여 넣기)
 * - 삭제해도 대화는 지우지 않고 프로젝트 밖으로 꺼낸다
 */
interface Props {
  project: Project
  isNew: boolean
  chatCount: number
  onPickKnowledge?: () => Promise<PickerDoc | null>
  onSave: (p: Project) => void
  onDelete: (p: Project) => void
  onClose: () => void
}

const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}천 자` : `${n}자`)

export default function ProjectModal({ project, isNew, chatCount, onPickKnowledge, onSave, onDelete, onClose }: Props) {
  const [name, setName] = useState(project.name === '새 프로젝트' && isNew ? '' : project.name)
  const [instructions, setInstructions] = useState(project.instructions)
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>(project.knowledge)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEscapeKey(onClose, true)

  const total = knowledge.reduce((n, k) => n + k.text.length, 0)
  const addFromDrive = async () => {
    if (!onPickKnowledge) return
    setError('')
    setBusy(true)
    try {
      const picked = await onPickKnowledge()
      if (!picked) return
      const { doc } = await loadAttachment(picked)
      if (!doc || doc.kind !== 'text' || doc.text === undefined) throw new Error('공유 자료는 텍스트·Google 문서·시트만 넣을 수 있어요(PDF·이미지는 대화에 첨부해 주세요)')
      if (doc.text.length > KNOWLEDGE_FILE_LIMIT) throw new Error(`파일이 너무 커요(${fmt(doc.text.length)}). ${fmt(KNOWLEDGE_FILE_LIMIT)} 이하만 넣을 수 있어요`)
      if (total + doc.text.length > KNOWLEDGE_TOTAL_LIMIT) throw new Error(`공유 자료 전체가 ${fmt(KNOWLEDGE_TOTAL_LIMIT)}를 넘어요. 다른 자료를 빼고 넣어 주세요`)
      setKnowledge((prev) => [...prev.filter((k) => k.id !== picked.id), { id: picked.id, name: doc.name, mimeType: doc.mimeType, size: doc.size, text: doc.text! }])
    } catch (e) {
      setError(e instanceof Error ? e.message : '자료를 넣지 못했어요')
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const n = name.trim()
    if (!n) { setError('프로젝트 이름을 입력해 주세요'); return }
    onSave({ ...project, name: n, instructions, knowledge, updatedAt: Date.now() })
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="project-modal-title" className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)', padding: 16 }} onClick={onClose}>
      <div className="mopt" style={{ position: 'static', width: 'min(560px, 100%)', maxHeight: 'min(88dvh, 760px)', gap: 14 }} onClick={(e) => e.stopPropagation()}>
        <div className="mopt-head">
          <span id="project-modal-title">{isNew ? '새 프로젝트' : '프로젝트 설정'}</span>
          <button className="mopt-reset" onClick={onClose}>닫기</button>
        </div>

        <label>
          <span className="mopt-label">이름</span>
          <input autoFocus={isNew} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 회사 홈페이지 리뉴얼" maxLength={60}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            style={{ width: '100%', height: 36, marginTop: 6, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-panel)', color: 'var(--txt)', fontSize: 'var(--fs-sm)' }} />
        </label>

        <label>
          <span className="mopt-label">지침</span>
          <span className="mopt-desc">이 프로젝트의 모든 대화에 적용돼요. 예: "Vue 3 + TypeScript, 다크모드 기본, 한국어 UI"</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Claude가 이 프로젝트에서 항상 따를 내용을 적어 주세요"
            style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-panel)', color: 'var(--txt)', fontSize: 'var(--fs-sm)', resize: 'vertical' }} />
        </label>

        <section>
          <span className="mopt-label">공유 자료</span>
          <span className="mopt-desc">이 프로젝트의 모든 대화가 참고하는 텍스트 자료예요(요구사항, 스타일 가이드, 데이터 등). 대화마다 캐시되어 비용이 작아요. {fmt(total)} / {fmt(KNOWLEDGE_TOTAL_LIMIT)}</span>
          {knowledge.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' }}>
              {knowledge.map((k) => (
                <span key={k.id} className="file-chip" title={k.name}>
                  <span aria-hidden="true">📄</span><span className="truncate">{k.name}</span>
                  <span className="file-chip-size">{fmt(k.text.length)}</span>
                  <button className="file-chip-x" aria-label={`${k.name} 빼기`} onClick={() => setKnowledge((prev) => prev.filter((x) => x.id !== k.id))}>✕</button>
                </span>
              ))}
            </div>
          )}
          {onPickKnowledge
            ? <button className="mopt-reset" onClick={addFromDrive} disabled={busy}>{busy ? '불러오는 중…' : '+ 드라이브에서 자료 추가'}</button>
            : <span className="mopt-desc">드라이브를 연결하고 선택창을 설정하면 드라이브 파일을 자료로 넣을 수 있어요.</span>}
        </section>

        {error && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--err)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="sidebar-new" onClick={save} style={{ flex: '1 1 auto' }}>{isNew ? '만들기' : '저장'}</button>
          {!isNew && (confirmDelete
            ? <><span className="mopt-desc" style={{ margin: 0 }}>대화 {chatCount}개는 지우지 않고 프로젝트 밖으로 옮겨요.</span>
                <button className="mopt-reset" style={{ color: 'var(--err)' }} onClick={() => onDelete(project)}>삭제 확인</button></>
            : <button className="mopt-reset" onClick={() => setConfirmDelete(true)}>프로젝트 삭제</button>)}
        </div>
      </div>
    </div>
  )
}
