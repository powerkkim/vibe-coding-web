import hljs from 'highlight.js/lib/core'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import markdown from 'highlight.js/lib/languages/markdown'

/**
 * 코드 문법 강조. 결과는 HTML 문자열이며 원문의 <, >, & 는 모두 이스케이프된다(dangerouslySetInnerHTML 에 넣어도 태그가 실행되지 않는다).
 * 언어는 파일명 확장자나 ```lang 이름으로 고른다. 등록되지 않은 언어는 색 없이 이스케이프만 한다.
 * 생성 결과에 자주 나오는 언어만 등록해 번들을 줄인다. Vue SFC 는 xml 로 강조한다.
 */
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('markdown', markdown)

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function highlightCode(code: string, nameOrLang: string): string {
  const ext = nameOrLang.split('.').pop()!.toLowerCase()
  const lang = ext === 'vue' ? 'xml' : ext
  if (!hljs.getLanguage(lang)) return escapeHtml(code)
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
}
