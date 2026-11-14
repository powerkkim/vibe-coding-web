/**
 * 미리보기 격리(sandbox).
 *
 * 미리보기는 Claude 가 방금 만든, 아직 확인하지 않은 코드를 실행한다. 앱과 같은 출처로 실행하면 그 코드가
 * 앱의 localStorage(Anthropic 키, GitHub 토큰, 드라이브 토큰)와 화면을 그대로 읽고 바꿀 수 있다.
 * 그래서 iframe 에 sandbox 를 걸고 allow-same-origin 을 주지 않는다 → 브라우저가 '출처 없는 남'으로 취급한다.
 * allow-same-origin 을 추가하면 격리가 사라지므로 절대 넣지 않는다.
 */
export const PREVIEW_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock'

/**
 * 격리된 미리보기에서는 localStorage·sessionStorage·document.cookie 접근이 예외를 던져 앱이 멈춘다.
 * 그 경우에만 메모리 기반 대체품으로 바꿔 끼운다(새로고침하면 비워진다). 격리되지 않은 곳에서는 아무것도 하지 않는다.
 */
const STORAGE_SHIM = `<script>(function(){
  function make(){
    var d=Object.create(null)
    var api={
      getItem:function(k){k=String(k);return k in d?d[k]:null},
      setItem:function(k,v){d[String(k)]=String(v)},
      removeItem:function(k){delete d[String(k)]},
      clear:function(){d=Object.create(null)},
      key:function(i){var ks=Object.keys(d);return i<ks.length?ks[i]:null}
    }
    return new Proxy(api,{
      get:function(t,p){if(p==='length')return Object.keys(d).length;if(p in t)return t[p];return typeof p==='string'&&p in d?d[p]:undefined},
      set:function(t,p,v){d[String(p)]=String(v);return true},
      has:function(t,p){return p in t||p in d},
      deleteProperty:function(t,p){delete d[p];return true},
      ownKeys:function(){return Object.keys(d)},
      getOwnPropertyDescriptor:function(t,p){return p in d?{value:d[p],writable:true,enumerable:true,configurable:true}:undefined}
    })
  }
  ['localStorage','sessionStorage'].forEach(function(n){
    try{window[n].getItem('')}catch(e){
      try{Object.defineProperty(window,n,{value:make(),configurable:true})}catch(e2){}
    }
  })
  try{document.cookie}catch(e){
    try{Object.defineProperty(document,'cookie',{get:function(){return ''},set:function(){},configurable:true})}catch(e2){}
  }
})()</script>`

/** 미리보기 HTML 맨 앞(다른 스크립트보다 먼저)에 저장소 대체 코드를 넣는다. */
export function withStorageShim(html: string): string {
  const head = html.match(/<head[^>]*>/i)
  if (head) return html.replace(head[0], `${head[0]}\n${STORAGE_SHIM}`)
  const root = html.match(/<html[^>]*>/i)
  if (root) return html.replace(root[0], `${root[0]}\n${STORAGE_SHIM}`)
  return `${STORAGE_SHIM}\n${html}`
}

/**
 * 미리보기를 새 탭에서 연다. 새 탭에 그대로 열면 sandbox 가 없어 앱과 같은 출처로 실행되므로,
 * 빈 탭에 격리된 iframe 하나만 두고 그 안에서 실행한다.
 */
export function openSandboxedTab(source: { html: string } | { url: string }, title = '미리보기'): void {
  const win = window.open('', '_blank')
  if (!win) return
  const doc = win.document
  doc.title = title
  doc.documentElement.style.height = '100%'
  doc.body.style.cssText = 'margin:0;height:100%;background:#fff'
  const frame = doc.createElement('iframe')
  frame.setAttribute('sandbox', PREVIEW_SANDBOX)
  frame.setAttribute('allow', 'fullscreen')
  frame.title = title
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
  if ('html' in source) frame.srcdoc = source.html
  else frame.src = source.url
  doc.body.appendChild(frame)
}
