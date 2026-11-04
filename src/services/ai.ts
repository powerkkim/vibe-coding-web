import { SERVER_URL } from './chatStore'

// 사용자가 메시지에 넣은 이미지. data 는 data URL 접두어를 뺀 base64 본문이다.
export interface MessageImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data: string
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  files?: Record<string, string>
  projectType?: 'html' | 'react' | 'vue'
  images?: MessageImage[]
  // 이 답변이 끝난 시점의 전체 프로젝트 파일. 버전 되돌리기에만 쓰고 API 로는 보내지 않는다.
  snapshot?: Record<string, string>
  // 응답 도중 오류로 끊긴 답변. 채팅에서 다시 시도 버튼을 띄운다.
  failed?: true
  // 서버에서 생성 중인 답변의 생성 id. 응답을 다 받으면 빠진다. 남아 있는 채로 대화를 열면 이어 받는다.
  generationId?: string
}

export interface TokenUsage {
  // 캐시 쓰기·읽기 토큰을 포함한 전체 입력 토큰
  promptTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  completionTokens: number
  totalTokens: number
  limitPerMin: number
  remainingPerMin: number
  resetInSeconds: number
}

export interface AIModel {
  id: string
  label: string
  // 서버 측 refusal fallback 지원 여부. Haiku 는 지원하지 않는다.
  fallback: boolean
  // 100만 토큰당 USD 단가. 예상 비용 표시에만 쓴다.
  inputPerMTok: number
  outputPerMTok: number
  // 캐시 읽기 단가. 모델마다 입력 단가 대비 비율이 달라 따로 둔다. 캐시 쓰기는 모든 모델이 입력 단가의 1.25배(5분 TTL)다.
  cacheReadPerMTok: number
  // 프롬프트가 overTokens 를 넘으면 입·출력 단가에 multiplier 를 곱한다.
  longPrompt?: { overTokens: number; multiplier: number }
}

// 첫 항목이 기본 모델이다.
// 단가 출처: Anthropic 공식 가격표(2026-10 기준). 가격이 바뀌면 여기만 고친다.
export const MODELS: AIModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', fallback: true, inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', fallback: true, inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  // Haiku 5.5 는 프롬프트(캐시 토큰 포함) 10만 토큰 초과 시 캐시 단가까지 모든 단가가 5배
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', fallback: false, inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, longPrompt: { overTokens: 100_000, multiplier: 5 } },
]

const SYSTEM_PROMPT = `You are Vibe Coding AI — an expert frontend developer and product designer who builds multi-file web projects from natural language.

If the user is chatting or asking a question rather than requesting something to build or change, reply in plain Korean text with no VIBE tags.

## File downloads
When the user asks for a file or document (Excel, CSV, PDF, Word, PowerPoint, image, JSON, text, ZIP),
build the page that shows the content AND a visible download button that saves a real file.
Load libraries by <script> in index.html with these exact URLs:
- Excel (.xlsx): https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js  (XLSX.writeFile)
- PDF: https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js
  (render an HTML element; never jsPDF text APIs — their built-in fonts cannot draw Korean)
- Word (.docx): https://unpkg.com/docx@8.5.0/build/index.umd.js  (docx.Packer.toBlob)
- PowerPoint (.pptx): https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js  (pptx.writeFile)
- ZIP: https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
- CSV / JSON / TXT / SVG: no library — new Blob + <a download>. Prefix CSV with "\\uFEFF" so Excel reads Korean.
- PNG image: canvas.toBlob, or html2canvas for an HTML area.
Use Korean file names that describe the content (e.g. "매출표.xlsx").

## Animation (only when the design calls for motion)
Use motion with restraint: purposeful transitions, scroll reveals, micro-interactions. No constant floating/pulsing/parallax decoration.
Load by <script> with these exact URLs (React/Vue may import the same packages instead):
- GSAP: https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js
  + ScrollTrigger: https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/ScrollTrigger.min.js  (call gsap.registerPlugin(ScrollTrigger))
- anime.js v4: https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.umd.min.js
  (global \`anime\`; v4 API: anime.animate(targets, { ... }), anime.createTimeline() — never the v3 anime({ targets }) call)
Respect prefers-reduced-motion: skip or shorten animations when it is set.

## Styling
Write plain CSS (style.css / src/index.css / component styles) with CSS variables for colors and spacing.
Do not add Tailwind or other CSS frameworks unless the user asks for one.

## Mode 1: HTML Project (default)
For simple web pages, landing pages, widgets, games, calculators, dashboards, etc.:

<VIBE_FILE name="index.html">
<!DOCTYPE html>...
</VIBE_FILE>
<VIBE_FILE name="style.css">
/* CSS here */
</VIBE_FILE>
<VIBE_FILE name="app.js">
// JS here
</VIBE_FILE>
<VIBE_TYPE>html</VIBE_TYPE>
<VIBE_EXPLANATION>[Korean description]</VIBE_EXPLANATION>

HTML mode rules:
- ALWAYS split into index.html + style.css + app.js
- index.html links style.css and app.js as relative paths
- Add CDN libraries only when needed (e.g. Chart.js for charts, Three.js for 3D)
- NEVER inline CSS in style tags or JS in script tags
- Fully interactive JavaScript, responsive layout

## Mode 2: React Project
ONLY when user explicitly asks for React, or needs component lifecycle, hooks, state management, routing:

<VIBE_FILE name="package.json">
{
  "name": "vibe-app",
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.0", "vite": "^6.0.0" }
}
</VIBE_FILE>
<VIBE_FILE name="vite.config.js">
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })
</VIBE_FILE>
<VIBE_FILE name="index.html">
<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vibe App</title>
</head><body><div id="root"></div><script type="module" src="./src/main.jsx"></script></body></html>
</VIBE_FILE>
<VIBE_FILE name="src/main.jsx">
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
</VIBE_FILE>
<VIBE_FILE name="src/index.css">
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
</VIBE_FILE>
<VIBE_FILE name="src/App.jsx">
// Main App component
</VIBE_FILE>
<!-- Additional component files as needed: src/components/Foo.jsx -->
<VIBE_TYPE>react</VIBE_TYPE>
<VIBE_EXPLANATION>[Korean description]</VIBE_EXPLANATION>

React mode rules:
- MUST include package.json, vite.config.js, index.html, src/main.jsx, src/index.css, src/App.jsx
- In index.html, entry script path MUST be relative ('./src/main.jsx'), never absolute ('/src/main.jsx')
- Split into meaningful components in src/components/
- Fully interactive with React hooks (useState, useEffect, etc.)

## Mode 3: Vue Project
ONLY when user explicitly asks for Vue:

<VIBE_FILE name="package.json">
{
  "name": "vibe-app",
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "vue": "^3.5.0" },
  "devDependencies": { "@vitejs/plugin-vue": "^5.2.0", "vite": "^6.0.0" }
}
</VIBE_FILE>
<VIBE_FILE name="vite.config.js">
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ plugins: [vue()] })
</VIBE_FILE>
<VIBE_FILE name="index.html">
<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vibe App</title>
</head><body><div id="app"></div><script type="module" src="./src/main.js"></script></body></html>
</VIBE_FILE>
<VIBE_FILE name="src/main.js">
import { createApp } from 'vue'
import './index.css'
import App from './App.vue'
createApp(App).mount('#app')
</VIBE_FILE>
<VIBE_FILE name="src/index.css">
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
</VIBE_FILE>
<VIBE_FILE name="src/App.vue">
<template>
  <!-- root template -->
</template>
<script setup>
// composition API here
</script>
<style scoped>
/* scoped styles */
</style>
</VIBE_FILE>
<!-- Additional components: src/components/Foo.vue -->
<VIBE_TYPE>vue</VIBE_TYPE>
<VIBE_EXPLANATION>[Korean description]</VIBE_EXPLANATION>

Vue mode rules:
- MUST include package.json, vite.config.js, index.html, src/main.js, src/index.css, src/App.vue
- In index.html, entry script path MUST be relative ('./src/main.js'), never absolute ('/src/main.js')
- Use Vue 3 Composition API with <script setup>
- Split into .vue SFC components in src/components/
- Use ref(), reactive(), computed(), onMounted() as needed

## Refining (all modes)
- Keep the existing design language consistent and change only what was asked

## Design direction first (new projects only)
When there is NO "Current files" section below and the user has not specified a visual style:
- Do NOT generate code yet. Reply in plain Korean text only (no <VIBE_*> tags).
- Propose 2–3 distinct design directions. For each: a short name, mood, color palette (hex), fonts, layout idea, and one reference feel (e.g. "노션 같은 문서형").
- Avoid generic AI-looking choices (purple/cyan gradients, glow blobs, emoji decoration, dark-by-default).
- End by asking which one to use or what to change.
Generate code only after the user picks or adjusts a direction.
If the user says to build immediately (e.g. "바로 만들어", "알아서"), skip this step.
Refinements of an existing project never go through this step.`

/**
 * Claude 스트리밍 코드 생성
 *
 * 텍스트 델타만 순서대로 yield 하고, 응답이 끝나면 토큰 사용량을 onUsage 로 한 번 넘긴다.
 * currentFiles 가 있으면 리파인 요청으로 보고 현재 파일 전체를 system 에 붙인다.
 * stop_reason 이 refusal 이면(fallback 모델까지 거절한 경우) Error 를 던진다.
 * 요청은 대화 저장 서버(worker/)의 생성 API 로 보낸다. 서버가 Anthropic 응답을 끝까지 받아 두므로,
 * 화면이 꺼져 연결이 끊기면 다시 보일 때 받은 위치부터 이어 받는다. 브라우저를 닫았다면 resumeCode 로 이어 받는다.
 *
 * @param apiKey - Anthropic API 키. 서버는 이 키로 Anthropic 을 호출하고 저장하지 않는다.
 * @param model - MODELS 의 모델 ID
 * @param generationId - 이 요청의 생성 id(ID 형식: 영문·숫자·_·-, 64자 이하). 이어 받기와 중지에 쓴다.
 */
export async function* streamCode(
  apiKey: string,
  model: string,
  messages: Message[],
  currentFiles: Record<string, string> | undefined,
  onUsage: ((usage: TokenUsage) => void) | undefined,
  // abort() 하면 스트림이 끊기고 반복이 예외를 던진다. 서버 쪽 생성은 cancelGeneration 으로 따로 멈춘다.
  signal: AbortSignal | undefined,
  generationId: string,
): AsyncGenerator<string, void, unknown> {
  const currentContext = currentFiles && Object.keys(currentFiles).length > 0
    ? `\n\nThe user is refining their existing project. Current files:\n` +
      Object.entries(currentFiles)
        .map(([name, content]) => `--- ${name} ---\n${content}`)
        .join('\n\n')
    : ''

  const useFallback = MODELS.find((m) => m.id === model)?.fallback ?? false
  const body = JSON.stringify({
    model,
    stream: true,
    // 멀티 파일 프로젝트 전체를 한 응답에 담으므로 넉넉히 잡는다. 스트리밍이라 HTTP 타임아웃 대상이 아니다.
    max_tokens: 64000,
    // 고정 프롬프트만 캐시한다. 파일 내용은 요청마다 바뀌어 캐시해도 적중하지 않는다.
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ...(currentContext ? [{ type: 'text' as const, text: currentContext }] : []),
    ],
    // 이미지가 있는 메시지는 이미지 블록들 뒤에 텍스트를 둔다(이미지를 먼저 두는 것이 권장 순서).
    // 이전 턴의 이미지도 매번 다시 보내야 Claude 가 그 이미지를 참조할 수 있다.
    messages: messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            ...m.images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
            })),
            { type: 'text' as const, text: m.content },
          ]
        : m.content,
    })),
    ...(useFallback ? { fallbacks: 'default' } : {}),
  })
  const headers: Record<string, string> = {
    ...(SERVER_URL ? authHeader(apiKey) : directHeaders(apiKey)),
    'Content-Type': 'application/json',
    ...(useFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
  }

  // 서버가 없으면 브라우저에서 Anthropic 으로 바로 보낸다. 끊기면 이어 받을 곳이 없으므로 오류로 끝난다(다시 시도 버튼).
  if (!SERVER_URL) {
    let direct: Response | null = null
    for (let attempt = 0; ; attempt++) {
      direct = await fetch(DIRECT_URL, { method: 'POST', headers, body, signal })
      if ((direct.status !== 429 && direct.status < 500) || attempt >= START_RETRY_DELAYS_MS.length) break
      await sleep(START_RETRY_DELAYS_MS[attempt], signal)
    }
    yield* readGeneration(apiKey, generationId, direct, onUsage, signal, false)
    return
  }

  let res: Response | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(generationUrl(generationId), { method: 'POST', headers, body, signal })
    } catch (e) {
      // 응답 헤더 전에 끊겼다. 서버가 이미 시작했을 수 있으므로 이어 받기로 넘긴다(시작 전이면 404 오류로 끝난다).
      if (signal?.aborted) throw e
      break
    }
    if ((res.status !== 429 && res.status < 500) || attempt >= START_RETRY_DELAYS_MS.length) break
    await sleep(START_RETRY_DELAYS_MS[attempt], signal)
  }
  yield* readGeneration(apiKey, generationId, res, onUsage, signal)
}

/** 브라우저를 닫는 등으로 놓친 생성을 처음부터 다시 받는다. 생성이 이미 끝났으면 저장된 결과를 한 번에 받는다. */
export function resumeCode(apiKey: string, generationId: string, onUsage?: (usage: TokenUsage) => void, signal?: AbortSignal) {
  if (!SERVER_URL) return failed(new GenerationError('브라우저가 닫혀 생성이 끊겼습니다. 다시 시도해 주세요'))
  return readGeneration(apiKey, generationId, null, onUsage, signal)
}

// eslint-disable-next-line require-yield
async function* failed(err: Error): AsyncGenerator<string, void, unknown> { throw err }

/** 서버에서 진행 중인 생성을 멈춘다. 이미 끝났으면 아무 일도 하지 않는다. */
export async function cancelGeneration(apiKey: string, generationId: string): Promise<void> {
  // 직접 호출 방식은 fetch 를 abort 하면 Anthropic 쪽 생성도 멈춘다.
  if (!SERVER_URL) return
  const res = await fetch(generationUrl(generationId), { method: 'DELETE', headers: authHeader(apiKey) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// 연결이 끊긴 뒤 연속으로 이어 받기를 시도하는 횟수와 간격. 화면이 꺼져 있는 동안은 시도하지 않고 다시 보일 때까지 기다린다.
const RESUME_ATTEMPTS = 5
const RESUME_DELAY_MS = 2000
// 429·5xx 로 시작이 거부됐을 때 다시 시작하기 전 대기 시간. 이전에 쓰던 SDK 의 기본 재시도(2회)와 횟수를 맞춘다.
const START_RETRY_DELAYS_MS = [1000, 3000]

/** 이어 받아도 소용없는 오류(키 거부, 거절, 서버가 기록한 생성 실패). */
class GenerationError extends Error {}

const DIRECT_URL = 'https://api.anthropic.com/v1/messages'

/** 브라우저에서 Anthropic API 를 직접 부를 때의 헤더. 키는 이 브라우저(localStorage)에만 있다. */
function directHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
}

function authHeader(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` }
}

function generationUrl(id: string, offset?: number) {
  if (!SERVER_URL) throw new GenerationError('VITE_CHAT_SERVER_URL 이 설정되지 않았습니다')
  return `${SERVER_URL}/api/generations/${encodeURIComponent(id)}${offset ? `?offset=${offset}` : ''}`
}

async function httpError(res: Response, fromServer = true): Promise<GenerationError> {
  if (res.status === 401) return new GenerationError('API 키가 거부됐습니다. 설정에서 키를 확인해 주세요')
  if (res.status === 404 && fromServer) return new GenerationError('서버에서 이 생성을 찾을 수 없습니다')
  const body = await res.json().catch(() => null)
  return new GenerationError(body?.error?.message ? `HTTP ${res.status}: ${body.error.message}` : `HTTP ${res.status}`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function waitVisible(signal?: AbortSignal): Promise<void> {
  if (document.visibilityState === 'visible') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', onChange)
      resolve()
    }
    document.addEventListener('visibilitychange', onChange)
    signal?.addEventListener('abort', () => { document.removeEventListener('visibilitychange', onChange); reject(signal.reason) }, { once: true })
  })
}

/**
 * 서버가 흘려주는 Anthropic SSE 를 읽어 텍스트 델타를 yield 한다. message_stop 을 받아야 정상 종료다.
 * 그 전에 연결이 끊기면 받은 바이트 수를 offset 으로 다시 요청한다. 디코더와 미완성 이벤트를 그대로 이어 쓰므로
 * 이벤트나 멀티바이트 문자가 끊긴 지점에서 나뉘어도 깨지지 않는다.
 */
async function* readGeneration(
  apiKey: string,
  id: string,
  first: Response | null,
  onUsage: ((usage: TokenUsage) => void) | undefined,
  signal: AbortSignal | undefined,
  // false 면 끊겨도 다시 요청하지 않는다(서버 없이 Anthropic 을 직접 부를 때).
  canResume = true,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder()
  let buffer = ''
  let received = 0
  let failures = 0
  let res = first
  const usage: Record<string, number> = {}
  let stopReason: string | undefined
  let stopExplanation: string | undefined

  for (;;) {
    let lost: unknown = new Error('서버와 연결이 끊겼습니다')
    try {
      if (!res) res = await fetch(generationUrl(id, received), { headers: authHeader(apiKey), signal })
      if (!res.ok || !res.body) throw await httpError(res, canResume)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        failures = 0
        buffer += decoder.decode(value, { stream: true })
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const data = buffer.slice(0, end).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
          buffer = buffer.slice(end + 2)
          if (!data) continue
          const event = JSON.parse(data)
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text
          else if (event.type === 'message_start') Object.assign(usage, definedNumbers(event.message.usage))
          else if (event.type === 'message_delta') {
            Object.assign(usage, definedNumbers(event.usage))
            stopReason = event.delta.stop_reason ?? stopReason
            stopExplanation = event.delta.stop_details?.explanation ?? stopExplanation
          } else if (event.type === 'error') throw new GenerationError(event.error?.message ?? '생성 중 오류가 발생했습니다')
          else if (event.type === 'message_stop') {
            reportUsage(usage, stopReason, stopExplanation, onUsage)
            return
          }
        }
      }
    } catch (e) {
      if (signal?.aborted || e instanceof GenerationError || !canResume) throw e
      lost = e
    }
    if (++failures > RESUME_ATTEMPTS) throw lost
    res = null
    await waitVisible(signal)
    await sleep(RESUME_DELAY_MS, signal)
  }
}

function definedNumbers(obj: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (typeof v === 'number') out[k] = v
  return out
}

function reportUsage(usage: Record<string, number>, stopReason: string | undefined, explanation: string | undefined, onUsage?: (usage: TokenUsage) => void) {
  if (stopReason === 'refusal') {
    throw new GenerationError(explanation ? `Claude가 요청을 거절했습니다: ${explanation}` : 'Claude가 요청을 거절했습니다')
  }
  // input_tokens 는 캐시 토큰을 뺀 값이라 캐시 쓰기·읽기를 더해야 전체 입력이 된다.
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const promptTokens = (usage.input_tokens ?? 0) + cacheWriteTokens + cacheReadTokens
  const completionTokens = usage.output_tokens ?? 0
  onUsage?.({
    promptTokens,
    cacheWriteTokens,
    cacheReadTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    // Anthropic rate limit 헤더는 서버가 전달하지 않으므로 -1(표시 안 함)로 둔다.
    limitPerMin: -1,
    remainingPerMin: -1,
    resetInSeconds: -1,
  })
}

/**
 * AI 응답을 파싱하여 파일과 프로젝트 타입 추출
 * <VIBE_FILE>, <VIBE_TYPE>, <VIBE_EXPLANATION> 형식 파싱
 * @param raw - 파싱할 원본 AI 응답
 * @returns 파일, 설명, 프로젝트 타입
 */
/**
 * AI 응답을 파싱하여 파일과 프로젝트 타입 추출
 * 
 * AI는 다음 형식으로 응답:
 * <VIBE_FILE name=\"파일명\">
 * 파일 내용
 * </VIBE_FILE>
 * <VIBE_TYPE>html|react|vue</VIBE_TYPE>
 * <VIBE_EXPLANATION>프로젝트 설명</VIBE_EXPLANATION>
 * 
 * 스트리밍 중 부분 파싱도 지원 (완성되지 않은 형식도 처리)
 * Vue (.vue), React (.jsx/.tsx) 파일 확장자로 프로젝트 타입 자동 감지
 * 
 * @param raw - 파싱할 원본 AI 응답 텍스트
 * @returns {{ files, explanation, projectType }} 파일 객체, 설명, 감지된 프로젝트 타입
 */
export function parseVibe(raw: string): { files: Record<string, string>; explanation: string; projectType: 'html' | 'react' | 'vue' } {
  const fileMatches = [...raw.matchAll(/<VIBE_FILE name="([^"]+)">([/\s\S]*?)<\/VIBE_FILE>/g)]
  const explMatch = raw.match(/<VIBE_EXPLANATION>([\s\S]*?)<\/VIBE_EXPLANATION>/)
  const typeMatch = raw.match(/<VIBE_TYPE>(html|react|vue)<\/VIBE_TYPE>/)
  const projectType: 'html' | 'react' | 'vue' = (typeMatch?.[1] as 'html' | 'react' | 'vue') ?? 'html'

  const files: Record<string, string> = {}
  for (const [, name, content] of fileMatches) {
    files[name.trim()] = content.trim()
  }

  // Fallback: legacy VIBE_HTML format
  if (Object.keys(files).length === 0) {
    const htmlMatch = raw.match(/<VIBE_HTML>([\s\S]*?)<\/VIBE_HTML>/)
    if (htmlMatch) files['index.html'] = htmlMatch[1].trim()
  }

  // Auto-detect by file extensions
  const fileNames = Object.keys(files)
  const isVue = projectType === 'vue' || fileNames.some(f => f.endsWith('.vue'))
  const isReact = !isVue && (projectType === 'react' || fileNames.some(f => f.endsWith('.jsx') || f.endsWith('.tsx')))

  return {
    files,
    explanation: explMatch?.[1]?.trim() ?? '',
    projectType: isVue ? 'vue' : isReact ? 'react' : 'html',
  }
}
