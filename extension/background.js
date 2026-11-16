/**
 * Vibe Coding 브라우저 도우미 (크롬 확장, MV3)
 *
 * 앱(powerkkim.github.io/vibe-coding-web)이 chrome.runtime.sendMessage(확장 ID, 메시지)로 부른다.
 *   { type: 'ping' }                          → { ok, version }
 *   { type: 'call', action, args }            → { ok, result } | { ok: false, error }
 * 조작은 이 확장이 만든 "Vibe" 탭 그룹 안의 탭에서만 한다(사용자가 쓰던 탭은 건드리지 않는다).
 * 클릭·입력·스크린샷은 chrome.debugger(CDP)로 한다. 조작 중에는 크롬이 '디버깅 중' 띠를 띄우고, 띠의 '취소'를 누르면 멈춘다.
 * 위험한 동작(저장·삭제·전송 등)의 확인은 앱이 받는다. 이 확장은 앱이 보낸 명령만 실행한다.
 */

const VERSION = chrome.runtime.getManifest().version
const ALLOWED_ORIGINS = ['https://powerkkim.github.io', 'http://localhost:5173', 'http://localhost:4186']
const GROUP_TITLE = 'Vibe'
const LOAD_TIMEOUT_MS = 15_000
const MAX_SHOT_WIDTH = 1280
// 사용자가 디버깅 띠에서 '취소'를 누르면 이 시간 동안 조작을 거부한다(모델이 곧바로 다시 붙지 않게).
const USER_STOP_MS = 60_000

const attached = new Set()
let userStoppedAt = 0

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) attached.delete(source.tabId)
  if (reason === 'canceled_by_user') userStoppedAt = Date.now()
})
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId))

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '')
  if (!ALLOWED_ORIGINS.includes(origin)) { sendResponse({ ok: false, error: 'origin not allowed' }); return false }
  if (msg?.type === 'ping') { sendResponse({ ok: true, version: VERSION }); return false }
  if (msg?.type !== 'call') { sendResponse({ ok: false, error: 'unknown message' }); return false }
  run(String(msg.action), msg.args || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})

// ── 탭 그룹 ─────────────────────────────────────────────

async function groupId() {
  const { vibeGroupId } = await chrome.storage.session.get('vibeGroupId')
  if (vibeGroupId === undefined) return undefined
  try { await chrome.tabGroups.get(vibeGroupId); return vibeGroupId } catch { return undefined }
}

async function groupTabs() {
  const gid = await groupId()
  return gid === undefined ? [] : chrome.tabs.query({ groupId: gid })
}

/** Vibe 그룹 안의 탭만 돌려준다. 아니면 오류. */
async function vibeTab(tabId) {
  const gid = await groupId()
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw new Error('tab_id is required (use the id from open or tabs)')
  const tab = await chrome.tabs.get(id).catch(() => null)
  if (!tab) throw new Error(`Tab ${id} no longer exists`)
  if (gid === undefined || tab.groupId !== gid) throw new Error(`Tab ${id} is not in the Vibe tab group; only tabs opened with "open" can be controlled`)
  return tab
}

function checkUrl(url) {
  let u
  try { u = new URL(String(url)) } catch { throw new Error(`Invalid URL: ${url}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) pages can be opened')
  return u.href
}

async function openTab(url) {
  const href = checkUrl(url)
  const gid = await groupId()
  let windowId
  if (gid !== undefined) windowId = (await chrome.tabGroups.get(gid)).windowId
  else windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))?.id
  const tab = await chrome.tabs.create({ url: href, active: true, ...(windowId !== undefined ? { windowId } : {}) })
  if (gid !== undefined) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: gid })
  } else {
    const newGid = await chrome.tabs.group({ tabIds: [tab.id] })
    await chrome.tabGroups.update(newGid, { title: GROUP_TITLE, color: 'blue' })
    await chrome.storage.session.set({ vibeGroupId: newGid })
  }
  await waitLoad(tab.id)
  return tab.id
}

function waitLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); setTimeout(resolve, 400) }
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done() }
    const timer = setTimeout(done, LOAD_TIMEOUT_MS)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done() }).catch(done)
  })
}

// ── CDP ────────────────────────────────────────────────

async function cdp(tabId, method, params = {}) {
  if (Date.now() - userStoppedAt < USER_STOP_MS) throw new Error('The user cancelled browser control in Chrome. Stop using the browser tool and ask the user how to proceed.')
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (e) {
      // 다른 곳(이 확장의 이전 세션 등)에서 이미 붙어 있으면 그대로 쓴다.
      if (!String(e?.message).includes('already attached')) throw new Error(`Cannot control this page: ${e?.message ?? e}`)
    }
    attached.add(tabId)
  }
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

/** 페이지에서 식을 실행하고 값을 돌려준다(JSON 으로 주고받을 수 있는 값만). */
async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'script error')
  return r.result?.value
}

// 조작 중 표시(오른쪽 아래 작은 띠). 클릭을 가로채지 않는다.
const BADGE_JS = `(() => {
  if (document.getElementById('__vibe_badge')) return
  const b = document.createElement('div')
  b.id = '__vibe_badge'
  b.textContent = 'Vibe가 조작 중'
  b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;background:#185FA5;color:#fff;font:12px/1.4 sans-serif;padding:4px 10px;border-radius:999px;opacity:.9'
  document.documentElement.appendChild(b)
})()`

// 상호작용 요소에 번호(ref)를 붙이고 페이지를 글로 정리한다.
const READ_JS = (maxChars) => `(() => {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[contenteditable=""],[contenteditable=true]'
  document.querySelectorAll('[data-vibe-ref]').forEach((e) => e.removeAttribute('data-vibe-ref'))
  const vw = innerWidth, vh = innerHeight
  const lines = []
  let n = 0
  for (const el of document.querySelectorAll(SEL)) {
    if (n >= 300) break
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue
    if (el.type === 'hidden') continue
    el.setAttribute('data-vibe-ref', String(++n))
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role') || (tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag)
    const name = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
    const value = (tag === 'input' || tag === 'textarea' || tag === 'select') && el.type !== 'password' ? ' value="' + String(el.value).slice(0, 60) + '"' : (el.type === 'password' ? ' (password)' : '')
    const checked = el.checked ? ' checked' : ''
    const off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw ? ' (offscreen)' : ''
    const dis = el.disabled ? ' (disabled)' : ''
    lines.push('[' + n + '] ' + role + ' "' + name + '"' + value + checked + dis + off)
  }
  let text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim()
  const cut = text.length > ${maxChars}
  if (cut) text = text.slice(0, ${maxChars})
  return 'Title: ' + document.title + '\\nURL: ' + location.href + '\\nViewport: ' + vw + 'x' + vh + ', scrollY ' + Math.round(scrollY) + ' of ' + Math.round(document.documentElement.scrollHeight) +
    '\\n\\nInteractive elements (use ref with click/type):\\n' + (lines.join('\\n') || '(none)') +
    '\\n\\nPage text' + (cut ? ' (truncated)' : '') + ':\\n' + text
})()`

/** ref 요소를 화면 가운데로 스크롤하고 중심 좌표·설명을 돌려준다. */
const LOCATE_JS = (ref, highlight) => `(async () => {
  const el = document.querySelector('[data-vibe-ref="${ref}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  await new Promise((r) => setTimeout(r, 150))
  const r = el.getBoundingClientRect()
  ${highlight ? `const o = el.style.outline; el.style.outline = '3px dashed #EF9F27'; setTimeout(() => { el.style.outline = o }, 900)` : ''}
  const tag = el.tagName.toLowerCase()
  return {
    x: r.left + r.width / 2, y: r.top + r.height / 2,
    tag, type: el.type || '', role: el.getAttribute('role') || '',
    label: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    form: !!el.form, href: el.href || '',
  }
})()`

async function locate(tabId, ref, highlight = false) {
  const r = Number(ref)
  if (!Number.isInteger(r) || r < 1) throw new Error('ref must be a number from read_page')
  const info = await evaluate(tabId, LOCATE_JS(r, highlight))
  if (!info) throw new Error(`Element [${r}] not found. The page may have changed; call read_page again.`)
  return info
}

async function mouseClick(tabId, x, y) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
}

async function pressKey(tabId, name) {
  const k = KEYS[name]
  if (!k) throw new Error(`Unsupported key ${name}. Supported: ${Object.keys(KEYS).join(', ')}`)
  const base = { key: k.key ?? name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) })
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** JPEG 헤더에서 크기를 읽는다(좌표 변환용). */
function jpegSize(b64) {
  const bin = atob(b64.slice(0, 40000))
  for (let i = 2; i < bin.length - 9;) {
    if (bin.charCodeAt(i) !== 0xff) { i++; continue }
    const m = bin.charCodeAt(i + 1)
    const len = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3)
    if (m >= 0xc0 && m <= 0xc3) return { height: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6), width: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8) }
    i += 2 + len
  }
  return null
}

// 마지막 스크린샷의 이미지 크기 ↔ 화면(CSS) 크기. 좌표 클릭(x, y)을 화면 좌표로 바꾼다.
const shotScale = new Map()

async function screenshot(tabId) {
  const tab = await chrome.tabs.get(tabId)
  // 보이지 않는 탭은 그려지지 않을 수 있어 그 창에서 앞으로 가져온다.
  if (!tab.active) { await chrome.tabs.update(tabId, { active: true }); await new Promise((r) => setTimeout(r, 300)) }
  await evaluate(tabId, BADGE_JS).catch(() => {})
  const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics')
  const scale = Math.min(1, MAX_SHOT_WIDTH / vv.clientWidth)
  const { data } = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 60,
    clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale },
  })
  const size = jpegSize(data) ?? { width: Math.round(vv.clientWidth * scale), height: Math.round(vv.clientHeight * scale) }
  shotScale.set(tabId, { sx: vv.clientWidth / size.width, sy: vv.clientHeight / size.height })
  return { data, width: size.width, height: size.height }
}

// ── 명령 ───────────────────────────────────────────────

async function run(action, a) {
  switch (action) {
    case 'tabs': {
      const tabs = await groupTabs()
      return { tabs: tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active })) }
    }
    case 'open': {
      const id = await openTab(a.url)
      const t = await chrome.tabs.get(id)
      return { tab_id: id, title: t.title, url: t.url }
    }
    case 'navigate': {
      const tab = await vibeTab(a.tab_id)
      await chrome.tabs.update(tab.id, { url: checkUrl(a.url) })
      await waitLoad(tab.id)
      const t = await chrome.tabs.get(tab.id)
      return { tab_id: t.id, title: t.title, url: t.url }
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const tab = await vibeTab(a.tab_id)
      if (action === 'back') await chrome.tabs.goBack(tab.id)
      else if (action === 'forward') await chrome.tabs.goForward(tab.id)
      else await chrome.tabs.reload(tab.id)
      await waitLoad(tab.id)
      const t = await chrome.tabs.get(tab.id)
      return { tab_id: t.id, title: t.title, url: t.url }
    }
    case 'screenshot': {
      const tab = await vibeTab(a.tab_id)
      return screenshot(tab.id)
    }
    case 'read_page': {
      const tab = await vibeTab(a.tab_id)
      await evaluate(tab.id, BADGE_JS).catch(() => {})
      const max = Math.min(Math.max(Number(a.max_chars) || 8000, 1000), 30000)
      return { text: await evaluate(tab.id, READ_JS(max)) }
    }
    case 'inspect': {
      const tab = await vibeTab(a.tab_id)
      const t = await chrome.tabs.get(tab.id)
      if (a.ref === undefined) return { url: t.url, title: t.title }
      return { ...(await locate(tab.id, a.ref)), url: t.url }
    }
    case 'click': {
      const tab = await vibeTab(a.tab_id)
      let x, y, label = ''
      if (a.ref !== undefined) {
        const info = await locate(tab.id, a.ref, true)
        await new Promise((r) => setTimeout(r, 350))
        ;({ x, y, label } = info)
      } else if (Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))) {
        const s = shotScale.get(tab.id) ?? { sx: 1, sy: 1 }
        x = Number(a.x) * s.sx
        y = Number(a.y) * s.sy
      } else throw new Error('click needs ref (from read_page) or x, y (screenshot pixels)')
      const before = (await chrome.tabs.get(tab.id)).url
      await mouseClick(tab.id, x, y)
      await new Promise((r) => setTimeout(r, 700))
      const t = await chrome.tabs.get(tab.id)
      if (t.status === 'loading' || t.url !== before) await waitLoad(tab.id)
      const after = await chrome.tabs.get(tab.id)
      return { clicked: label || `(${Math.round(x)}, ${Math.round(y)})`, url: after.url, title: after.title }
    }
    case 'type': {
      const tab = await vibeTab(a.tab_id)
      if (a.ref !== undefined) {
        const info = await locate(tab.id, a.ref, true)
        await mouseClick(tab.id, info.x, info.y)
        if (a.clear) await evaluate(tab.id, `(() => { const el = document.querySelector('[data-vibe-ref="${Number(a.ref)}"]'); if (!el) return; if ('select' in el && typeof el.select === 'function') el.select(); else { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r) } })()`)
      }
      await cdp(tab.id, 'Input.insertText', { text: String(a.text ?? '') })
      if (a.submit) { await pressKey(tab.id, 'Enter'); await new Promise((r) => setTimeout(r, 700)); const t = await chrome.tabs.get(tab.id); if (t.status === 'loading') await waitLoad(tab.id) }
      return { typed: String(a.text ?? '').length }
    }
    case 'key': {
      const tab = await vibeTab(a.tab_id)
      await pressKey(tab.id, String(a.key))
      await new Promise((r) => setTimeout(r, 400))
      return { pressed: a.key }
    }
    case 'scroll': {
      const tab = await vibeTab(a.tab_id)
      const amount = Math.min(Math.max(Number(a.amount) || 600, 50), 5000)
      const { cssVisualViewport: vv } = await cdp(tab.id, 'Page.getLayoutMetrics')
      await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: vv.clientWidth / 2, y: vv.clientHeight / 2, deltaX: 0, deltaY: a.direction === 'up' ? -amount : amount })
      await new Promise((r) => setTimeout(r, 400))
      return { scrolled: a.direction === 'up' ? -amount : amount }
    }
    case 'wait': {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(a.ms) || 1000, 100), 10000)))
      return { waited: true }
    }
    case 'close': {
      const tab = await vibeTab(a.tab_id)
      if (attached.has(tab.id)) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {})
      await chrome.tabs.remove(tab.id)
      return { closed: tab.id }
    }
    case 'release': {
      // 작업이 끝나면 디버깅 연결을 풀어 '디버깅 중' 띠를 없앤다(탭은 남긴다).
      for (const tabId of [...attached]) {
        await evaluate(tabId, `document.getElementById('__vibe_badge')?.remove()`).catch(() => {})
        await chrome.debugger.detach({ tabId }).catch(() => {})
      }
      attached.clear()
      return { released: true }
    }
    default:
      throw new Error(`Unknown action ${action}`)
  }
}
