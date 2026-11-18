# CLAUDE.md — vibe-coding-web 작업 안내

Claude(또는 사람)가 이 레포에서 작업할 때 따르는 규칙과 구조. 최종 수정 2026-11-18 (앱 v0.7.0 기준).

## 프로젝트

- 각자 자기 Anthropic API 키로 쓰는 코딩 챗봇 웹앱(PWA). 원본 guraking/vibe-coding-web 에서 옮겨 옴.
- 배포 주소: https://powerkkim.github.io/vibe-coding-web/
- 대화는 한국어로, 장황하지 않게.

## 작업 규칙 (꼭 지킬 것)

1. **브랜치**: 작업은 `dev` 에서 한다. `dev` 에는 바로 push 해도 된다.
2. **main**: `dev` 를 병합해서만 올린다. **main push 전에는 반드시 사용자 확인을 받는다** (main push 마다 GitHub Actions 배포가 돈다).
3. **논의 먼저**: 사용자가 "수정해/진행해"라고 하기 전에는 코드를 고치지 않는다. 원인을 물으면 고치기 전에 원인부터 보고한다.
4. **버전**: 앱 코드를 고칠 때마다 `package.json` 의 `version` 을 올린다.
   - 버그·작은 변경: `0.x.+1` / 기능 추가: `0.+1.0`
   - 버전은 창 제목에 자동 표시된다(`vite.config.ts`). 커밋 메시지와 보고에 버전을 적는다.
   - 문서만 바꾼 경우(README·CLAUDE.md·CHANGELOG.md)는 버전을 올리지 않는다.
   - 버전을 올리면 `CHANGELOG.md` 맨 위에 항목을 추가하고, 사이드바 공지 한 줄(`src/releaseNote.ts`)을 이번 변경에 맞게 고친다.
5. **드라이브 데이터 보존**: 구글 드라이브에 저장된 기존 대화·프로젝트·파일이 절대 날아가지 않게 한다. 저장 형식·위치를 바꿀 때는 먼저 상의한다.
6. **검증**: 배포 전 Playwright 모의 테스트 + 기존 회귀 테스트를 돌리고 결과를 보고한다. 실제 기기·실계정에서 확인하지 못한 것은 "미확인"이라고 적는다.
7. **비밀값**: API 키·토큰·클라이언트 비밀값을 코드·커밋·`VITE_*` 변수에 넣지 않는다. `VITE_*` 는 빌드 결과물에 그대로 들어간다.

8. **미리보기 격리**: 미리보기 iframe 의 `sandbox` 를 없애거나 `allow-same-origin` 을 넣지 않는다(`src/services/previewSandbox.ts`). 넣으면 만든 코드가 앱의 키·토큰을 읽을 수 있다. 만든 코드를 앱 주소(같은 출처)에서 직접 실행하는 경로도 만들지 않는다.

## 구조

```
src/
  App.tsx                 앱 상태·도구 실행(project_files, github, drive_files, app_status …)
  components/             화면(ChatPanel, PreviewPanel, Sidebar, Header, 각종 Modal)
  services/
    ai.ts                 Anthropic 호출(직접 또는 Worker 중계), 시스템 프롬프트, 도구 정의
    drive.ts              구글 로그인·드라이브 API (appDataFolder / drive.file)
    chatStore.ts          대화 저장(드라이브 + IndexedDB 백업)
    projectStore.ts       프로젝트(지침·공유 자료) — projects.json
    driveExport.ts        결과물 파일을 내 드라이브 "Vibe Coding/<프로젝트>/<대화>/"에 저장
    github.ts             GitHub 가져오기·커밋·푸시·Pages 배포
    previewSandbox.ts     미리보기 격리(sandbox 설정, 저장소 대체 코드, 격리된 새 탭)
    notify.ts             답변 완료 시스템 알림(켜기·끄기, 서비스워커 알림)
    push.ts               웹 푸시(앱을 닫아도 오는 알림): 구독 등록·해제, 생성 요청의 X-Vibe-Notify 헤더
    fileExtract.ts        첨부 파일 → 문서(MessageDoc): PDF, docx·xlsx·pptx·hwpx 글 추출, 텍스트(UTF-8/EUC-KR), 바이너리 거절
    browserExt.ts         크롬 확장과 통신, browser 도구 정의·실행(사이트 허용·위험 동작 확인)
    memoryStore.ts, usage.ts, localStore.ts …
  releaseNote.ts          사이드바 아래 한 줄 공지
public/sw.js              서비스워커: PWA 앱 화면 캐시, 알림 클릭 처리, 푸시 받기
worker/src/index.js       Cloudflare Worker: 응답 생성 중계(Durable Object) + 구글 로그인 유지 + 푸시 구독(PushRegistry)
worker/src/webpush.js     웹 푸시 암호화(RFC 8291)·VAPID 서명. 키 만들기: node worker/scripts/vapid.mjs
extension/                크롬 확장 "Vibe Coding 브라우저 도우미"(MV3, CDP). 배포 때 zip 으로 Pages 에 함께 올라간다
.github/workflows/        deploy.yml(Pages), worker.yml(Worker)
```

## 여러 대화 동시 생성 (v0.4.0)

- 생성 1건은 `App.tsx` 의 `Run` 객체 하나다(`runsRef`: 대화 id → Run). 생성 중인 대화의 메시지·파일은 화면(React 상태)이 아니라 Run 이 원본이다.
- 생성 코드에서는 `setMessages`·`setProjectFiles` 를 직접 부르지 않고 `runSetMessages(run, …)`·`runSetFiles(run, …)` 를 쓴다. 화면에 떠 있는 대화(`isFg(run)`)일 때만 화면에 반영된다. 도구도 `run` 을 받아 그 대화의 파일에 적용한다.
- 화면의 대화에서 끝나면 저장 effect 가 저장하고, 뒤에서 끝나면 `saveRun` 이 저장한다. 저장은 모두 `persistChat`(대화별 순서 보장)을 거친다.
- 새 화면 상태를 추가할 때: 생성 중 바뀌는 값이면 Run 에 두고 `attachRun`(생성 중인 대화로 돌아올 때)에서 화면에 붙인다.

## 웹 푸시 (v0.6.0)

- 생성 요청마다 `X-Vibe-Notify`(대화 id·제목)를 보낸다. 앱은 결과를 끝까지 받으면 `PATCH /api/generations/:id`(ack)를 보낸다.
- 생성이 끝나고 8초 안에 ack 가 없으면(앱이 꺼짐·멈춤) Worker 가 그 API 키로 등록된 모든 기기에 푸시한다. 사용자가 중지한 생성은 보내지 않는다.
- 필요: 레포 Secret `VAPID_JWK`. 없으면 푸시만 꺼지고 앱 안 알림은 그대로. 키를 바꾸면 각 기기에서 알림을 다시 켜야 한다.

## 브라우저 조작 (v0.6.0)

- 확장 ID 는 `extension/manifest.json` 의 `key` 로 고정(`abmofglkkjkkeghdpgipiakpkcahcbhb`). key 를 바꾸면 앱의 `EXTENSION_ID` 도 바꿔야 한다.
- 확장은 자기가 만든 "Vibe" 탭 그룹 안의 탭만 조작한다. 앱 주소(`externally_connectable`)에서 온 메시지만 받는다.
- 처음 여는 사이트·위험해 보이는 동작의 확인은 앱이 받는다(`browserExt.ts` 의 `DANGER_RE`, 모델의 `needs_confirm`).
- 확장을 고치면 `extension/manifest.json` 의 `version` 을 올리고, 앱이 새 기능을 필요로 하면 `MIN_EXTENSION_VERSION` 도 올린다.
- 대화별 켜짐(`vibe_browser_chats`)·허용 사이트(`vibe_browser_sites`)는 localStorage 에만 둔다(드라이브 저장 형식 변경 없음).

## 저장 위치

| 데이터 | 위치 |
|---|---|
| 대화·projects.json | 구글 드라이브 숨김 앱 폴더(appDataFolder) |
| 결과물 파일 | 내 드라이브 `Vibe Coding/<프로젝트>/<대화>/` (drive.file) |
| 최근 대화 10개·미업로드 대화 | IndexedDB |
| API 키, GitHub 토큰(`vibe_gh_token`), 드라이브 토큰·암호화된 갱신 토큰 | localStorage |

Worker 는 대화를 저장하지 않는다. 생성 원문만 24시간 보관 후 삭제. 허용한 앱 주소(`worker/wrangler.toml` 의 `ALLOWED_ORIGINS`)에서 온 요청만 받는다.

## 배포

- `main` push → `deploy.yml` 이 GitHub Pages 배포(항상).
- `worker/**` 또는 `worker.yml` 이 바뀌면 `worker.yml` 이 Cloudflare Worker 배포(수동 실행도 가능).
- Secrets: `CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_SECRET`
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID`, `GENERATION_SERVER_URL`(`off` 면 브라우저 직접 호출)

## 로컬 실행·테스트

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # tsc + vite build
cd worker && npx wrangler dev   # Worker 로컬 실행
```

Playwright 모의 테스트는 가짜 Anthropic·드라이브·GIS·GitHub 로 돌리고, Worker 는 `wrangler dev` 로 띄워 검증한다.
