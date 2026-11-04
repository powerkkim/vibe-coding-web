import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from '../icons'
import ClaudeMascot from './ClaudeMascot'
import type { Message } from '../services/ai'
import { highlightCode } from '../services/highlight'

/**
 * AnswerView: 오른쪽 패널의 '답변' 탭
 *
 * Claude 답변(message.content)을 마크다운으로 렌더링하고, 생성된 파일이 있으면 그 아래에 코드 블록으로 함께 보여준다.
 * react-markdown 은 원문 HTML 을 렌더링하지 않으므로 모델 출력에 섞인 태그·스크립트는 텍스트로만 표시된다.
 */

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] }

function nodeText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(nodeText).join('')
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 클립보드 권한이 없으면(비보안 컨텍스트 등) 복사하지 않고 버튼 상태도 바꾸지 않는다.
    }
  }
  return (
    <div className="answer-code">
      <div className="answer-code-head">
        <span>{label}</span>
        <button onClick={copy} aria-label={`${label} 복사`}>
          {copied ? <Check style={{ width: 13, height: 13 }} /> : <Copy style={{ width: 13, height: 13 }} />}
          <span>{copied ? '복사됨' : '복사'}</span>
        </button>
      </div>
      <pre><code dangerouslySetInnerHTML={{ __html: highlightCode(code, label) }} /></pre>
    </div>
  )
}

// 펜스 코드 블록(```lang)만 CodeBlock 으로 바꾼다. 인라인 `code` 는 기본 렌더링 + CSS 를 쓴다.
const markdownComponents: Components = {
  pre: ({ node }) => {
    const codeNode = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code')
    const className = codeNode?.properties?.className
    const lang = Array.isArray(className) ? String(className[0] ?? '').replace('language-', '') : ''
    return <CodeBlock code={codeNode ? nodeText(codeNode).replace(/\n$/, '') : ''} label={lang || 'code'} />
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

export default function AnswerView({ message }: { message: Message | null }) {
  if (!message) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: 'var(--txt-3)' }}>
        <ClaudeMascot width={48} />
        <p style={{ fontSize: 'var(--fs-md)' }}>Claude의 답변이 여기에 표시됩니다</p>
        <ul className="answer-tips">
          <li>새 프로젝트는 디자인 방향 2~3안을 먼저 받고, 번호로 골라 시작합니다</li>
          <li>"바로 만들어"라고 하면 제안 없이 곧장 코드를 만듭니다</li>
          <li>화면 캡처를 붙여 넣으면 그 화면을 참고해서 만듭니다</li>
          <li>만든 뒤에는 "버튼 색 바꿔줘"처럼 고칠 부분만 말하면 됩니다</li>
        </ul>
      </div>
    )
  }

  const files = Object.entries(message.files ?? {})
  return (
    <article className="answer-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message.content}
      </ReactMarkdown>
      {files.length > 0 && (
        <>
          <h3>생성된 파일 {files.length}개</h3>
          {files.map(([name, content]) => (
            <CodeBlock key={name} code={content} label={name} />
          ))}
        </>
      )}
    </article>
  )
}
