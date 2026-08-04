# PROGRESS.md — FIDGET SPINNER

> **작성 규칙**: 매 세션 종료 시(또는 태스크 완료 시마다) 갱신하고 즉시 push 한다.
> 이 파일 + 원격 저장소만 있으면 어떤 시점에서 중단되어도 완전히 복구 가능해야 한다.
> 최신 세션을 맨 위에 추가한다.

---

## 현재 상태 요약

| 항목 | 값 |
|---|---|
| 마지막 갱신 | 2026-08-04 |
| 현재 단계 | **Phase 0 — 기획 확정 완료, 리포지토리 미생성** |
| 마지막 커밋 | (없음) |
| CI 상태 | (없음) |
| 배포 URL | (없음) |
| 블로커 | 없음 |

---

## 로드맵 체크리스트

### Phase 0 — 기반 구축
- [x] 요구사항 협의 및 스펙 확정
- [x] `CLAUDE.md` 작성
- [x] `PROGRESS.md` 작성
- [x] `DECISIONS.md` 작성
- [ ] GitHub 리포지토리 생성 + 초기 push
- [ ] Vite + TypeScript(strict) 프로젝트 골격
- [ ] `.claude/agents/` 서브에이전트 5종 정의
- [ ] L0 하네스: ESLint(순수성 규칙 포함) + Prettier + tsc
- [ ] GitHub Actions CI 워크플로
- [ ] 브랜치 보호 규칙 (CI 실패 시 main 머지 차단)

### Phase 1 — 물리 코어
- [ ] `core/constants.ts` 물리 상수 정의
- [ ] `core/physics.ts` 고정 타임스텝 시뮬레이션
- [ ] 단위 테스트: 감속 곡선, 정지 스냅, 클램프, death spiral 방지
- [ ] 골든 스냅샷 기준값 생성
- [ ] `core/input-model.ts` 포인터 샘플 → 각속도 변환 + 테스트

### Phase 2 — 렌더링 & 입력
- [ ] `render/canvas-renderer.ts` (DPR 대응, 3날개 스피너)
- [ ] Pointer Events 플릭 제스처
- [ ] 브레이크 (포인터 다운 유지)
- [ ] 더블탭 즉시 정지
- [ ] 세로 고정 / 오버스크롤·줌 차단 / Wake Lock

### Phase 3 — 햅틱 (핵심)
- [ ] `core/haptic-scheduler.ts` 디텐트 펄스 시점 계산
- [ ] `MIN_PULSE_GAP_MS` 가드 + 드랍 카운터
- [ ] `platform/vibration-driver.ts` (유일 호출 지점)
- [ ] 웜업 펄스 / visibility 변경 시 즉시 정지
- [ ] `platform/capability.ts` iOS·Firefox 감지 + 폴백 안내 배너
- [ ] `render/debug-overlay.ts` (`?debug=1`)
- [ ] 목킹 기반 타임스탬프 시퀀스 테스트

### Phase 4 — 기록 시스템
- [ ] `platform/storage/adapter.ts` 인터페이스
- [ ] `platform/storage/indexeddb.ts` 구현
- [ ] `core/stats.ts` 집계 로직 + 테스트
- [ ] 통계 UI (최고 RPM / 총 회전수 / 최장 시간 / 세션 수)
- [ ] 백업 코드 내보내기·불러오기

### Phase 5 — PWA & 배포
- [ ] `manifest.webmanifest` 완비 (maskable 아이콘 포함)
- [ ] Service Worker (오프라인 100%)
- [ ] History API 기반 화면 전환 (TWA 백버튼 대비)
- [ ] Playwright E2E + 시각 회귀
- [ ] 성능 예산 게이트 (번들 60KB / Lighthouse)
- [ ] Vercel 배포 + 자동 배포 연결

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
