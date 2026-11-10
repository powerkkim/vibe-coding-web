/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANTHROPIC_API_KEY: string
  readonly VITE_CHAT_SERVER_URL: string
  // 응답 생성 중계 서버(worker/) 주소. 있으면 백그라운드·브라우저 종료 중에도 서버가 끝까지 받는다.
  readonly VITE_GENERATION_SERVER_URL?: string
  readonly VITE_GOOGLE_CLIENT_ID: string
  readonly VITE_GOOGLE_API_KEY: string
  readonly VITE_GOOGLE_APP_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// package.json 의 version (vite.config.ts define)
declare const __APP_VERSION__: string
