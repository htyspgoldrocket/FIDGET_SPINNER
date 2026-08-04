# PROGRESS.md — FIDGET SPINNER

> **작성 규칙**: 매 세션 종료 시(또는 태스크 완료 시마다) 갱신하고 즉시 push 한다.
> 이 파일 + 원격 저장소만 있으면 어떤 시점에서 중단되어도 완전히 복구 가능해야 한다.
> 최신 세션을 맨 위에 추가한다.

---

## 현재 상태 요약

| 항목 | 값 |
|---|---|
| 마지막 갱신 | 2026-08-04 |
| 현재 단계 | **Phase 5 완료 — Phase 6(실기기 튜닝) 시작 대기** |
| 마지막 커밋 | `fix: remove comment keys from vercel.json and record deploy URL` (develop) |
| CI 상태 | develop green · main green (PR#1 머지, 945c947) |
| 배포 URL | **https://goldrocket.vercel.app** (Vercel 프로젝트 `goldrocket`, fidget_spinner 리포 연결) |
| 블로커 | 없음 |

---

## 로드맵 체크리스트

### Phase 0 — 기반 구축
- [x] 요구사항 협의 및 스펙 확정
- [x] `CLAUDE.md` 작성
- [x] `PROGRESS.md` 작성
- [x] `DECISIONS.md` 작성
- [x] GitHub 리포지토리 생성 + 초기 push
- [x] Vite + TypeScript(strict) 프로젝트 골격
- [x] `.claude/agents/` 서브에이전트 5종 정의
- [x] L0 하네스: ESLint(순수성 규칙 포함) + Prettier + tsc
- [x] GitHub Actions CI 워크플로 (파일 등록 완료 — 첫 실행 결과는 push 후 확인)
- [x] 브랜치 보호 규칙 (CI 실패 시 main 머지 차단) — PR 필수 + 필수 체크 4개 (L0-L2 / L3 / L4 / PROGRESS 가드)

### Phase 1 — 물리 코어
- [x] `core/constants.ts` 물리 상수 정의
- [x] `core/physics.ts` 고정 타임스텝 시뮬레이션
- [x] 단위 테스트: 감속 곡선, 정지 스냅, 클램프, death spiral 방지
- [x] 골든 스냅샷 기준값 생성 (시나리오 8종, CI에서 갱신 차단)
- [x] `core/input-model.ts` 포인터 샘플 → 각속도 변환 + 테스트

### Phase 2 — 렌더링 & 입력
- [x] `render/canvas-renderer.ts` (DPR 대응, 3날개 스피너) — 네온 아웃라인(B 시안), 오프스크린 캐시 + rotate/drawImage
- [x] Pointer Events 플릭 제스처 (`platform/pointer-input.ts`)
- [x] 브레이크 (포인터 다운 유지)
- [x] 더블탭 즉시 정지
- [x] 세로 고정 / 오버스크롤·줌 차단 / Wake Lock

### Phase 3 — 햅틱 (핵심)
- [x] `core/haptic-scheduler.ts` 디텐트 펄스 시점 계산 (펄스 길이 = 디텐트 간격 듀티 1/3, [8,18] 클램프)
- [x] `MIN_PULSE_GAP_MS` 가드 + 드랍 카운터 (가드는 실제 호출 시각 기준 — 프레임당 최대 1펄스 구조 보장)
- [x] `platform/vibration-driver.ts` (유일 호출 지점, VibrationHost 주입 구조)
- [x] 웜업 펄스 / visibility 변경 시 즉시 정지
- [x] `platform/capability.ts` iOS·Firefox 감지 + 폴백 안내 배너
- [x] `render/debug-overlay.ts` (`?debug=1`)
- [x] 목킹 기반 타임스탬프 시퀀스 테스트 (단위 44개 + e2e 5개, 실브라우저 vibrate 간격 검증 포함)

### Phase 4 — 기록 시스템
- [x] `platform/storage/adapter.ts` 인터페이스 (CLAUDE.md 6장 그대로, 백업 코드 인코딩/검증 단일화)
- [x] `platform/storage/indexeddb.ts` 구현 (records+aggregate 단일 트랜잭션, 실패 시 인메모리 폴백)
- [x] `core/stats.ts` 집계 로직 + 테스트 (OMEGA_STOP 문턱 공유, 250ms 미만 미기록, 1초 공백 세션 분리)
- [x] 통계 UI (최고 RPM / 총 회전수 / 최장 시간 / 세션 수)
- [x] 백업 코드 내보내기·불러오기 (import는 교체 방식 — 사유는 세션 #6 로그)

### Phase 5 — PWA & 배포
- [x] `manifest.webmanifest` 완비 (maskable 아이콘 포함, 아이콘은 scripts/generate-icons.mjs로 SVG에서 생성)
- [x] Service Worker (오프라인 100%, injectManifest + 자작 60줄, sw.js 0.9KB gzip)
- [x] History API 기반 화면 전환 (TWA 백버튼 대비, platform/screen-history.ts)
- [x] Playwright E2E + 시각 회귀 (win32 베이스라인 커밋, linux는 베이스라인 생기면 자동 활성)
- [x] 성능 예산 게이트 (번들 60KB + Lighthouse CI assert, Perf 100 실측)
- [x] Vercel 배포 + 자동 배포 연결 — https://goldrocket.vercel.app (프로덕션 배포·검증 완료, git 연결 수정으로 자동 배포 활성)

### Phase 6 — 실기기 튜닝
- [ ] `docs/DEVICE_CHECKLIST.md` 작성
- [ ] 실제 안드로이드 기기 촉감 검증
- [ ] 물리·햅틱 상수 튜닝 (변경 시 골든 스냅샷 갱신 + 사유 기록)

### Phase 7 — Play Store (옵션, 별도 판단)
- [ ] 도메인 확정 + `assetlinks.json`
- [ ] Bubblewrap AAB 빌드
- [ ] keystore 백업 절차 수립
- [ ] 개발자 계정 등록 / 비공개 테스트 12명 × 14일

---

## 세션 로그

### 2026-08-04 — 세션 #8 (배포)
**완료**
- ADR-007 승인·반영 (Lighthouse PWA 100 → e2e 검증 대체, CLAUDE.md 7장 수정)
- develop → main PR#1 머지 (필수 체크 4개 green, 945c947)
- 배포 트러블슈팅: ① 리포명 FIDGET_SPINNER → fidget_spinner 변경 감지, 원격 URL 갱신 ② Vercel 프로젝트(goldrocket)가 **다른 리포(htyspgoldrocket/goldrocket)에 연결돼 있어** push가 배포를 트리거하지 않던 문제 → `vercel git connect`로 fidget_spinner에 재연결 ③ vercel.json의 주석용 `"//"` 키를 Vercel 스키마가 거부 → 제거
- CLI로 프로덕션 배포 후 원격 검증: 앱 셸/manifest(application/manifest+json)/sw.js(no-cache)/아이콘 3종 전부 200
- **배포 URL: https://goldrocket.vercel.app** — 이후 main push마다 자동 배포

**다음 할 일**
- Phase 6: 실기기(Android Chrome) 촉감 검증 — docs/DEVICE_CHECKLIST.md 작성, 물리·햅틱 상수 튜닝

**막힌 지점 / 결정 대기**
- 없음

### 2026-08-04 — 세션 #7 (Phase 5 PWA & 배포 준비)
**완료**
- manifest.webmanifest 필수 필드 완비. 아이콘 192/512/maskable-512는 spinner-reference.svg에서 Playwright로 래스터화 (`npm run icons`), maskable은 안전영역 계산으로 별도 파일
- SW: vite-plugin-pwa injectManifest + 자작 프리캐시 온리 (60줄, 0.9KB gzip — generateSW의 워크박스 런타임 회피). 캐시명에 목록 지문, autoUpdate 실측 검증. includeManifestIcons 중복 → addAll 전체 실패 함정 회피
- History API: screen-history.ts — 열 때만 push, 루트에서 가짜 엔트리 없음(TWA 백버튼 = 종료 정상), 우리가 push한 엔트리일 때만 back() (아니면 close만 — 닫기 버튼이 앱을 끄는 사고 방지), 새로고침 시 패널 복원
- 시각 회귀: 베이스라인 없는 플랫폼은 skip (CI 안전) + 자기 기준 검사(정지 화면 2회 촬영 동일성)는 전 플랫폼 실행. 갱신은 FIDGET_UPDATE_VISUAL=1 필수, CI 금지
- Lighthouse CI를 test:perf에 통합, assert 실효성 역검증(강제 실패 확인). 실측: **Perf 100 / BP 100 / SEO 100 / A11y 91** (user-scalable=no — 게임 특성상 의도된 감점)
- vercel.json: sw.js no-cache(굳으면 옛 앱에 갇힘), 해시 에셋 immutable, manifest Content-Type 명시
- 단위 199(+10) / e2e 29(+13, dev·preview 이중 webServer) green. 번들 11.8KB gzip

**다음 할 일**
- Vercel 계정 연결 (사용자 인증 필요) → 배포 → 실기기 URL 전달
- ADR 후보: CLAUDE.md 7장 "Lighthouse PWA 100" — Lighthouse 12에서 PWA 카테고리 자체가 제거되어 측정 불가. e2e(tests/e2e/pwa/)가 매니페스트·오프라인을 더 강하게 검증 중. 문구 수정은 사용자 승인 대기

**막힌 지점 / 결정 대기**
- ~~Vercel 인증~~ → 사용자가 대시보드에서 리포 import 완료 (2026-08-04)
- ~~CLAUDE.md 7장 PWA 100 문구~~ → ADR-007 승인·반영 완료. 프로덕션 배포는 develop → main PR 머지로 트리거

### 2026-08-04 — 세션 #6 (Phase 4 기록 시스템)
**완료**
- `core/stats.ts`: trackSpin 순수 함수 — 세션 판정 문턱을 haptic-scheduler와 같은 OMEGA_STOP으로 공유 (마무리 펄스와 기록 종료가 같은 프레임). 250ms 미만 튕김 미기록, 1초 초과 프레임 공백 시 세션 분리(탭 전환이 duration을 부풀리지 않음)
- storage: DB v1 (records + aggregate), putRecord는 레코드+집계 단일 트랜잭션 (중간 크래시에도 불일치 없음). 열기 실패/차단/3초 무응답 → 인메모리 폴백, `data-storage` 속성으로 진단 가능
- import는 병합이 아닌 **교체**: 백업 코드가 레코드 500개 제한이라 병합 시 집계 복원 불가 + 같은 코드 재입력 시 이중 집계 문제. 교체는 대칭적이고 설명 가능
- IndexedDB 테스트는 fake 폴리필 대신 실브라우저 e2e (영속성·트랜잭션 커밋을 진짜로 검증). devDependency 추가 0
- 통계 패널 UI: 4개 지표 + 백업 내보내기/복사/불러오기. Phase 5 History API 연결용 open/close 훅 분리
- 단위 189개(+66) / e2e 14개(+6: 영속, 백업 라운드트립, 오류 코드 무손상, 폴백 등) green. 번들 11KB gzip
- playwright.config.ts 로컬 워커 50%→4 (CPU 포화 시 mouse.move 간격이 벌어져 기존 플릭 테스트가 플레이키해짐. CI는 workers:1이라 무관)

**다음 할 일**
- Phase 5: manifest/SW 오프라인/History API(통계 패널 백버튼)/시각 회귀/Lighthouse/Vercel 배포
- Vercel 연결은 사용자 인증 필요 시점에 요청 예정

**막힌 지점 / 결정 대기**
- 기록 초기화(clear) UI 버튼 미구현 — 파괴적 조작이라 사용자 결정 대기

### 2026-08-04 — 세션 #5 (Phase 3 햅틱, haptics-specialist 수행)
**완료**
- 햅틱 상수 6종(CLAUDE.md 5장 표) + 파생 상수(DETENT_ANGLE, PULSE_DETENT_DUTY, RPM_PER_RAD_PER_SEC) constants.ts에 추가. 물리 상수 미변경, 골든 9종 그대로 통과
- 스케줄러: 펄스 길이는 ω 선형이 아니라 "디텐트 간격의 1/3 듀티"를 [8,18]로 클램프 (간격 대비 펄스가 길면 클릭감이 뭉개짐). 가드는 이상적 통과 시각이 아니라 **실제 발사(프레임) 시각** 기준 — 실호출 간격 25ms 미만 0건이 진짜 보장되고, 프레임당 최대 1펄스가 구조적으로 성립
- 정지 마무리 펄스(30ms)는 가드에 걸리면 드랍이 아니라 다음 프레임으로 보류 (마무리 소실 방지)
- 드라이버: VibrationHost 인터페이스로 브라우저 전역 격리 (node 환경 시퀀스 테스트 가능). visibility 구독은 드라이버가 직접 — 루프 정지와 무관하게 vibrate(0) 보장
- capability: describePlatform 순수 함수, iOS/Firefox는 API 존재 주장과 무관하게 미지원 처리. 배너는 pointer-events:none 컨테이너로 플릭 방해 없음
- 디버그 오버레이(?debug=1): ω/RPM, fired/dropped, 펄스 타임라인(3초), frame dt/substeps/히스토그램/long%
- 테스트 123개(+44) green, e2e 8개(+5, 실브라우저 vibrate 타임스탬프 간격 검증 포함), 번들 5.79KB gzip

**다음 할 일**
- Phase 4: storage adapter/IndexedDB, core/stats.ts (RPM_PER_RAD_PER_SEC 재정의 금지), 통계 UI, 백업 코드
- Phase 5: PWA (manifest/SW/History API), 시각 회귀, Lighthouse, Vercel 배포

**막힌 지점 / 결정 대기 (Phase 6 실기기 관찰 항목)**
- 오디오 클릭·화면 셰이크 폴백 미구현 (배너+Noop까지만) — UX 결정 필요
- 펄스 간격의 프레임 양자화: 60fps 실질 최대 발사율 초당 30회 — "고속에서 성기다" 느껴지면 재검토
- BRAKE 저속 펄스 27ms > 가드 25ms — 이전 펄스 잘림 가능성 낮지만 관찰

### 2026-08-04 — 세션 #4 (Phase 2 렌더링 & 입력)
**완료**
- 스피너 디자인 확정: B안 네온 아웃라인 (파랑 #39d5ff 몸체 + 라임 #9ef01a 포인트, 다크 #0e1116 배경). 기준 시안 `docs/design/spinner-reference.svg`
- `render/canvas-renderer.ts`: DPR 대응, 글로우(shadowBlur)는 오프스크린 캔버스에 1회 렌더 후 매 프레임 rotate+drawImage만 수행 (리사이즈/DPR 변경 시 재생성)
- `platform/pointer-input.ts`: 플릭(샘플 수집 → core input-model로 Δω), 브레이크(홀드 판정), 더블탭 정지. 판정 임계값은 파일 내 명명 상수
- `main.ts`: rAF 게임 루프 + core advance() 연결, visibility hidden 시 루프 정지
- `platform/wake-lock.ts`: 화면 꺼짐 방지, visibility 복귀 시 재획득, 미지원 무시
- index.html/CSS: 전체화면 캔버스, touch-action/overscroll/줌 차단
- E2E 스모크 3종 (앱 셸 로드/정지 상태 렌더/플릭 회전 + 더블탭 정지) — 로컬 chromium 통과
- verify green (79 단위 테스트) + build 성공 (번들 3.26KB gzip / 예산 60KB)

**다음 할 일**
- Phase 3: 햅틱 — `core/haptic-scheduler.ts`, `platform/vibration-driver.ts`, 웜업 펄스, capability 감지, 디버그 오버레이

**막힌 지점 / 결정 대기**
- 없음

### 2026-08-04 — 세션 #3 (Phase 1 물리 코어, physics-engineer 수행)
**완료**
- `core/constants.ts`: CLAUDE.md 4장 물리 상수 8종 + 입력 모델 상수 (K_FLICK=18 무차원, 근거 주석 포함, Phase 6 실기기 튜닝 대상)
- `core/physics.ts`: semi-implicit Euler, 고정 타임스텝 + accumulator, MAX_SUBSTEPS 상한. 폐기는 온전한 스텝 단위로만 하고 FIXED_DT 미만 잔여는 이월 (fmod, 결정론 유지). 정지 스냅 2겹 (한 스텝 감속량 > ω → 0 정지로 부호 진동 원천 차단, |ω| < OMEGA_STOP 스냅, -0 방지)
- `core/input-model.ts`: 인접 샘플 쌍의 외적으로 접선 성분만 추출 (반경 성분 기여는 항등적으로 0), 시간 가중 평균, 100ms/5샘플 윈도. r는 손가락 지렛대 길이로 해석, `FLICK_MIN_LEVER_ARM_FRAC=0.15` 데드존으로 중심 근처 발산 차단
- 테스트 79개 green: physics 34 + input-model 23 + golden 9 + harness 10. 필수 7종 + 경계 케이스 (dt=0/음수/NaN/∞, 샘플 0·1개, 시간 역행 등)
- 골든 스냅샷 8종 (max/mid/braked/reverse/near-stop/jitter/stall-recovery/low-fps). JSON 기준값 + Object.is 비교, 갱신은 `FIDGET_UPDATE_GOLDEN=1` 필수, CI에서는 갱신 자체를 에러로 차단. 결정론 2회 실행 + 별도 프로세스 재생성 바이트 일치 확인

**다음 할 일**
- CI(ubuntu)에서 골든 스냅샷 첫 통과 확인 → 크로스 플랫폼 결정론 검증
- Phase 2: 캔버스 렌더러 + 플릭/브레이크/더블탭 입력 연결

**막힌 지점 / 결정 대기**
- MAX_SUBSTEPS=5는 48fps 미만 지속 시 시뮬레이션이 실시간보다 느려짐 (기록 부풀림 가능성) — Phase 6 실기기 튜닝에서 재검토
- 입력 모델의 r 해석(스피너 반경 아닌 지렛대 길이)은 물리적 타당성 기준의 판단 — 이견 시 ADR로 논의

### 2026-08-04 — 세션 #2 (리포 생성 + 골격 + L0 하네스)
**완료**
- GitHub 리포 연결, 파일 구조 정리(scripts/, .github/workflows/, .claude/agents/), 첫 커밋 + main/develop push
- Vite + TypeScript(strict, noUncheckedIndexedAccess) 골격 — CLAUDE.md 3장 구조 그대로 스텁만 생성, 로직 없음
- 명령어 계약 9개 등록: typecheck / lint / format:check / test:unit / test:e2e / test:perf / verify / verify:full / build
- 설정: tsconfig / vite.config / vitest.config / playwright.config(모바일 에뮬레이션) / .prettierrc / .prettierignore
- **eslint 실효성 검증 (test-harness-engineer 수행)**: core 프로브 파일로 15개 에러 검출 확인. 우회 경로 2건 발견·수정 — ① core 밖에서 `window.sessionStorage`·`globalThis.localStorage`가 통과하던 구멍을 객체 무관 MemberExpression 셀렉터로 봉쇄, ② vibration-driver.ts 예외가 규칙 전체를 끄던 것을 vibrate 셀렉터만 해제하도록 축소. globals 미선언으로 scripts/가 no-undef 나던 것도 수정. 프로브 파일은 삭제됨
- `npm run verify` green (typecheck + lint + 단위 테스트 10개), `npm run build` 성공 (번들 0.4KB gzip / 예산 60KB)
- harness.test.ts가 명령어 계약 존재와 프로덕션 dependencies 0개를 테스트로 강제

**다음 할 일**
- Phase 1: `core/constants.ts` 물리 상수 + `core/physics.ts` 고정 타임스텝 시뮬레이션

**세션 후반 완료 (같은 날)**
- CI 첫 실행 develop green 확인 (9c4b84c — verify / e2e / budget 전체 성공)
- main 브랜치 보호 규칙 설정 완료: PR 필수 + 필수 status check 4개 등록 → **Phase 0 전체 완료**

**막힌 지점 / 결정 대기**
- 문서(md) 파일은 `.prettierignore`에 넣어 format:check 대상에서 제외함 — 문서도 포맷 대상에 넣을지 결정 필요
- 배포 도메인 미정 (기존과 동일)

### 2026-08-04 — 세션 #1 (기획)
**완료**
- 요구사항 협의: iOS 웹 햅틱 불가 확인 → Android 전용으로 범위 확정
- 스코프 확정: 기록형 / 로컬 저장 + 확장 여지 / 플릭+브레이크+더블탭 / 풀 하네스
- 앱 이름 `FIDGET SPINNER`, 패키지명 `kr.goldrocket.fidgetspinner` 확정
- `CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md` 초안 작성

**다음 할 일**
- GitHub 리포지토리 생성 및 초기 push
- Vite + TS 골격 + L0 하네스

**막힌 지점 / 결정 대기**
- 배포 도메인 미정 (PWA 단계에서는 `*.vercel.app` 사용 예정, Play Store 진행 시 확정 필요)
