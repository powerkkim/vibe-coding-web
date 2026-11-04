import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * active 인 동안 ref 의 대화상자 안에 키보드 포커스를 가둔다.
 *
 * 열릴 때 첫 입력칸(없으면 첫 포커스 가능 요소)으로 포커스를 옮기고, Tab·Shift+Tab 은 안에서 순환한다.
 * 닫히면 열기 직전에 포커스가 있던 요소로 되돌린다. 그 요소를 기억해야 하므로 대화상자 안에 autoFocus 를 두지 않는다.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
      ?? dialog.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (items.length === 0) return
      const head = items[0]
      const tail = items[items.length - 1]
      const inside = dialog.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === head || !inside)) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && (document.activeElement === tail || !inside)) {
        e.preventDefault()
        head.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (opener?.isConnected) opener.focus()
    }
  }, [ref, active])
}
