# Vibe Coding Web

> v4 · 2026-11-05 · powerkkim 구성 (원본: guraking/vibe-coding-web)
> 배포 주소: https://powerkkim.github.io/vibe-coding-web/

AI 기반 프론트엔드 코드 생성 웹 애플리케이션입니다. 자연어로 설명하면 HTML / React / Vue 프로젝트를 즉시 생성하고 실시간으로 미리볼 수 있습니다.

## 주요 기능

- **자연어 → 코드 생성** — Claude API를 이용해 멀티 파일 웹 프로젝트를 자동 생성
- **실시간 미리보기** — 생성된 HTML / React / Vue 앱을 iframe에서 즉시 확인
- **3가지 프로젝트 타입** — HTML+CSS+JS, React(Vite), Vue 3(Vite) 지원
- **대화형 수정** — 채팅 이력을 유지하면서 프로젝트를 반복적으로 개선
- **내보내기 / 가져오기** — 생성된 파일을 ZIP으로 다운로드하거나 ZIP을 불러와 수정
- **모바일 지원** — 반응형 레이아웃으로 모바일에서도 사용 가능
- **PWA 지원** — 폰·PC에 앱으로 설치(크롬 메뉴 → 앱 설치 / iOS 공유 → 홈 화면에 추가), 앱 화면 캐시로 빠른 실행·오프라인 열기

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | React 18 + TypeScript |
| 빌드 도구 | Vite 6 |
| 스타일링 | Tailwind CSS |
| AI API | [Claude API](https://platform.claude.com/docs) (`@anthropic-ai/sdk`) |
| 아이콘 | lucide-react |

## 시작하기

### 1. 저장소 클론

```bash
git clone https://github.com/powerkkim/vibe-coding-web.git
cd vibe-coding-web
```

### 2. 의존성 설치

```bash
npm install
```

### 3. API 키 설정

[Claude Console](https://platform.claude.com)에서 API 키를 발급받은 후 `.env.local` 파일을 생성합니다.

```env
VITE_ANTHROPIC_API_KEY=sk-ant-your_key_here
```

> `.env.local`이 없으면 앱 실행 후 설정 버튼에서 키를 직접 입력할 수 있습니다.
> `VITE_` 변수는 빌드 결과물에 그대로 포함됩니다. 공개 배포(GitHub Pages) 빌드에는 키를 넣지 말고 설정 모달에서 입력하세요.

### 4. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173`을 열면 됩니다.

### 5. 프로덕션 빌드

```bash
npm run build
```

## Cloudflare 없이 쓰기 (Google 드라이브 저장) — powerkkim 구성

`VITE_CHAT_SERVER_URL` 을 비워 두면 Cloudflare Worker 없이 동작합니다.

| 기능 | Worker 방식(원본) | 이 구성 |
|------|------|------|
| 코드 생성 | Worker → Anthropic | 브라우저 → Anthropic 직접 호출 (`anthropic-dangerous-direct-browser-access`) |
| 대화 저장 | R2 (API 키별) | 드라이브 연결 전: 이 브라우저(IndexedDB) / 연결 후: Google 드라이브 appDataFolder |
| 브라우저 닫힌 뒤 이어 받기 | 지원 | 미지원 (다시 시도 버튼) |

API 키는 설정 모달에 입력하면 **내 브라우저 localStorage 에만** 저장됩니다. 빌드 결과물·저장소에는 들어가지 않습니다.

### Google OAuth 클라이언트 ID 만들기 (1회)

1. [Google Cloud 콘솔](https://console.cloud.google.com/) → 프로젝트 생성
2. `API 및 서비스 > 라이브러리` → **Google Drive API** 사용 설정
3. `OAuth 동의 화면` → 외부(External), 앱 이름 입력, 범위에 `.../auth/drive.appdata` 추가, **테스트 사용자에 내 Gmail 추가**
4. `사용자 인증 정보 > OAuth 클라이언트 ID 만들기` → 웹 애플리케이션
   - 승인된 자바스크립트 원본: `https://powerkkim.github.io`, `http://localhost:5173`
5. 발급된 클라이언트 ID(`xxxx.apps.googleusercontent.com`)를
   - GitHub 저장소 `Settings > Secrets and variables > Actions > Variables` 에 `GOOGLE_CLIENT_ID` 로 등록
   - 로컬은 `.env.local` 에 `VITE_GOOGLE_CLIENT_ID=...`

앱 왼쪽 대화 목록 아래 **Google 드라이브 연결** 버튼을 누르면 저장이 켜집니다. 토큰은 1시간마다 만료되어 다시 연결 버튼을 눌러야 할 수 있습니다.

## 배포 (GitHub Push 자동 배포)

이 프로젝트는 `main` 브랜치에 `push`하면 GitHub Actions로 자동 배포되도록 설정되어 있습니다.

### 1. 원격 저장소 연결

```bash
git remote add origin https://github.com/<your-id>/<your-repo>.git
```

### 2. GitHub Pages 설정

GitHub 저장소 설정에서 아래를 확인하세요.

- `Settings > Pages > Build and deployment > Source`: `GitHub Actions`

### 3. 푸시 배포

```bash
git add .
git commit -m "chore: deploy setup"
git push origin main
```

배포는 `Actions` 탭에서 진행 상황을 볼 수 있고, 완료되면 `Settings > Pages`에서 배포 URL을 확인할 수 있습니다.

## 사용 방법

1. 상단에서 Claude 모델(Opus 5.5 / Sonnet 5.5 / Haiku 5.5)을 선택합니다.
2. 설정 모달에서 Anthropic API 키를 저장합니다.
3. 채팅 입력창에 만들고 싶은 앱을 한국어 또는 영어로 설명합니다.
4. 우측 미리보기 패널에서 결과를 확인하고, 추가 수정 요청을 입력합니다.
5. 완성된 프로젝트는 내보내기(Export) 버튼으로 ZIP 파일로 다운로드할 수 있습니다.

## 라이선스

MIT
