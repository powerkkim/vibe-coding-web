/**
 * 답변 완료 알림(시스템 알림).
 * 앱 안 알림(토스트)과 탭 제목 표시는 App 이 직접 하고, 여기서는 다른 탭·다른 프로그램을 보고 있을 때 띄우는 OS 알림만 다룬다.
 * 사용자가 사이드바에서 켠 경우에만 보낸다. 앱이 열려 있는 동안만 동작한다(앱을 완전히 닫으면 오지 않는다).
 */
const KEY = 'vibe_notify'

export const notifySupported = () => typeof Notification !== 'undefined'
export function notifyEnabled(): boolean {
  try { return notifySupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted' } catch { return false }
}
/** 켜기: 브라우저 알림 권한을 요청한다. 거부되면 false. */
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  try {
    if (!on) { localStorage.removeItem(KEY); return false }
    if (!notifySupported()) return false
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') return false
    localStorage.setItem(KEY, '1')
    return true
  } catch { return false }
}

/** 화면을 보고 있지 않을 때만 OS 알림을 띄운다. 누르면 onOpen(chatId) 로 그 대화를 연다. */
export async function showSystemNotification(chatId: string, title: string, body: string, onOpen: (chatId: string) => void) {
  if (!notifyEnabled() || (document.visibilityState === 'visible' && document.hasFocus())) return
  const options = { body, tag: `vibe-${chatId}`, icon: `${import.meta.env.BASE_URL}icons/icon-192.png`, data: { chatId } }
  try {
    // 설치된 앱(PWA)·모바일은 서비스워커로만 알림을 띄울 수 있다. 누르면 서비스워커가 앱을 앞으로 가져오고 OPEN_CHAT 을 보낸다.
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg?.active) { await reg.showNotification(title, options); return }
    const n = new Notification(title, options)
    n.onclick = () => { window.focus(); onOpen(chatId); n.close() }
  } catch { /* 알림을 못 띄워도 앱 동작에는 영향 없음 */ }
}

/** 서비스워커가 알림 클릭을 알려 오면 그 대화를 연다. 해제 함수를 돌려준다. */
export function onNotificationOpen(handler: (chatId: string) => void): () => void {
  const listener = (e: MessageEvent) => {
    if (e.data?.type === 'OPEN_CHAT' && typeof e.data.chatId === 'string') handler(e.data.chatId)
  }
  navigator.serviceWorker?.addEventListener('message', listener)
  return () => navigator.serviceWorker?.removeEventListener('message', listener)
}
