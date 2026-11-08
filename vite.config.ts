import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.GITHUB_ACTIONS === 'true' && repoName ? `/${repoName}/` : '/'

export default defineConfig({
  plugins: [
    react(),
    // 창 제목에 버전을 붙인다(배포된 버전을 바로 확인할 수 있게)
    { name: 'app-version-title', transformIndexHtml: (html) => html.replace('<title>Vibe Coding</title>', `<title>Vibe Coding v${pkg.version}</title>`) },
  ],
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
})
