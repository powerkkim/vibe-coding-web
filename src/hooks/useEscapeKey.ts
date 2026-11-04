import { useEffect } from 'react'

/**
 * active 인 동안 Esc 키로 onClose 를 호출한다.
 * 모달처럼 열려 있을 때만 반응해야 하는 UI 에서 쓴다.
 */
export function useEscapeKey(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, active])
}
