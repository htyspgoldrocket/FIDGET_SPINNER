# CLAUDE.md — FIDGET SPINNER

> 이 문서는 **프로젝트 헌법**이다. 모든 세션의 시작점이며, 여기 적힌 규칙은 임의로 어기지 않는다.
> 규칙을 바꿔야 한다고 판단되면 코드를 먼저 고치지 말고 `DECISIONS.md`에 ADR을 추가한 뒤 사용자 승인을 받는다.

---

## 0. 세션 프로토콜 (매번 반드시 수행)

### 세션 시작
1. `PROGRESS.md`를 읽는다. → 마지막 상태, 진행 중 태스크, 막힌 지점 파악
2. `git status && git log --oneline -10` 실행 → 커밋되지 않은 변경이 있으면 먼저 정리
3. `npm run verify` 실행 → 현재 코드가 green 상태인지 확인. red면 **새 기능 추가 전에 복구**
4. 이번 세션에서 할 태스크를 사용자에게 1줄로 선언하고 시작

### 세션 종료 (또는 태스크 완료 시마다)
1. `npm run verify` 통과 확인
2. `PROGRESS.md` 갱신 (완료 / 진행중 / 다음 / 막힌 지점)
3. Conventional Commit으로 커밋
4. **즉시 `git push`** — 로컬에만 두지 않는다

> 중단되어도 `PROGRESS.md` + 원격 저장소만 있으면 100% 복구 가능해야 한다. 이것이 최우선 원칙이다.

---

## 1. 프로젝트 개요

손가락으로 화면을 튕겨 피젯 스피너를 돌리고, 회전에 맞춰 **실제 진동이 손으로 전달되는** 스트레스 해소용 웹 미니게임.

| 항목 | 확정값 |
|---|---|
| 앱 표시명 | `FIDGET SPINNER` |
| 패키지명 (영구 고정) | `kr.goldrocket.fidgetspinner` |
| 타겟 플랫폼 | **Android Chrome / Samsung Internet 전용** |
| 배포 형태 | 웹 PWA (1차) → Play Store TWA (2차, 옵션) |
| 게임 성격 | 기록형 (최고 RPM, 총 회전수, 최장 회전 시간, 누적 통계) |
| 저장 | 로컬(IndexedDB) 전용 + **서버 확장 가능하도록 추상화** |
| 조작 | 플릭 / 브레이크 / 더블탭 정지 |
| 하네스 | 풀 세팅 (L0~L4 + GitHub Actions CI) |

### 명시적 비목표 (Non-goals)
- ❌ **iOS 지원 안 함.** iOS Safari는 Vibration API를 구현한 적이 없고, `<input type="checkbox" switch>` 우회 기법도 iOS 26.5에서 차단됐다. iOS 접속 시 "Android에서 진동을 지원합니다" 안내 배너만 띄우고 시각/오디오로만 동작시킨다.
- ❌ **Firefox 지원 안 함.** 129부터 Vibration API 지원이 제거됐다.
- ❌ 온라인 리더보드, 계정, 결제, 광고 — 1차 범위 밖
- ❌ 기기 기울임(자이로) 조작 — 결정론적 테스트 불가 + 기록 조작 가능성

---

## 2. 절대 규칙 (Invariants) — 위반 시 CI 실패

1. **`src/core/**` 는 순수하다.** `window`, `document`, `navigator`, `localStorage`, `Date.now`, `Math.random` 참조 금지. 시간과 난수는 인자로 주입받는다. → ESLint `no-restricted-globals`로 강제.
2. **`navigator.vibrate` 직접 호출은 `src/platform/vibration-driver.ts` 단 한 곳에서만** 한다. 다른 파일에서 호출하면 CI 실패.
3. **`requestAnimationFrame` 콜백 안에서 진동을 직접 호출하지 않는다.** 반드시 `HapticScheduler`를 경유한다. (매 프레임 호출 시 이전 패턴을 덮어써서 진동이 뭉개짐)
4. **`localStorage` / `sessionStorage` 사용 금지.** 저장은 `StorageAdapter` 인터페이스를 통한 IndexedDB만 사용한다.
5. **물리 상수는 `src/core/constants.ts` 한 곳에만 존재한다.** 매직 넘버를 코드에 흩뿌리지 않는다.
6. **런타임 외부 의존성 추가 금지.** 번들 예산을 지키기 위해 프로덕션 dependencies는 0개를 유지한다. (devDependencies는 자유)
7. **테스트 없는 물리/햅틱 로직 커밋 금지.** `src/core/**` 변경 시 대응 테스트가 같은 커밋에 포함되어야 한다.
8. **골든 스냅샷을 "테스트가 실패하니까" 갱신하지 않는다.** 물리 튜닝으로 의도적으로 바꾼 경우에만 갱신하고, 이유를 커밋 메시지에 적는다.

---

## 3. 아키텍처

```
src/
├── core/                    # 순수 로직. 브라우저 API 의존 0. 100% 단위 테스트 대상
│   ├── constants.ts         # 모든 물리/햅틱 상수
│   ├── physics.ts           # 각운동 시뮬레이션 (결정론적)
│   ├── haptic-scheduler.ts  # 진동 "시점"만 계산. 실제 호출 안 함
│   ├── input-model.ts       # 포인터 샘플 → 각속도 변환
│   └── stats.ts             # RPM/회전수/기록 집계
├── platform/                # 브라우저 경계. 여기서만 부작용 발생
│   ├── vibration-driver.ts  # navigator.vibrate 유일 호출 지점
│   ├── storage/
│   │   ├── adapter.ts       # StorageAdapter 인터페이스
│   │   └── indexeddb.ts     # 구현체 (추후 remote.ts 추가 가능)
│   ├── wake-lock.ts
│   └── capability.ts        # 진동 지원 여부 감지, iOS/Firefox 판별
├── render/
│   ├── canvas-renderer.ts   # Canvas 2D, DPR 대응
│   └── debug-overlay.ts     # ω, 펄스 타임라인, 드랍 카운터 실시간 표시
├── ui/                      # 통계 화면, 설정, 히스토리 관리
└── main.ts                  # 조립 + 게임 루프

tests/
├── unit/        # Vitest — core 전체
├── golden/      # 감속 곡선/펄스 시퀀스 스냅샷
└── e2e/         # Playwright 모바일 에뮬레이션
```

**의존 방향은 단방향이다:** `main → ui/render/platform → core`. `core`는 아무것도 import 하지 않는다.

---

## 4. 물리 모델 명세

상태: `theta`(rad, 누적), `omega`(rad/s, 부호 = 회전 방향)

```
dω/dt = -sign(ω)·τ_coulomb - b_viscous·ω - c_drag·ω·|ω| - τ_brake·sign(ω)·isBraking
θ += ω·dt
```

| 상수 | 초기값 | 의미 |
|---|---|---|
| `TAU_COULOMB` | 0.35 rad/s² | 베어링 정지 마찰 (일정 감속) |
| `B_VISCOUS` | 0.08 /s | 점성 마찰 (속도 비례) |
| `C_DRAG` | 0.004 /rad | 공기 저항 (속도 제곱 비례) |
| `TAU_BRAKE` | 4.0 rad/s² | 손가락 브레이크 추가 감속 |
| `OMEGA_MAX` | 210 rad/s | 상한 클램프 (≈2000 RPM) |
| `OMEGA_STOP` | 0.15 rad/s | 이 이하로 떨어지면 0으로 스냅 |
| `FIXED_DT` | 1/240 s | 고정 타임스텝 |
| `MAX_SUBSTEPS` | 5 | 프레임당 최대 서브스텝 (death spiral 방지) |

**결정론 요구사항:** 동일한 입력 시퀀스 → 동일한 `ω(t)` 곡선이 비트 단위로 재현되어야 한다. `requestAnimationFrame` 타이밍 변동은 accumulator로 흡수한다.

**RPM 변환:** `RPM = ω × 60 / (2π)` = `ω × 9.5493`

**입력 → 각속도:** 최근 100ms 이내 포인터 샘플 최대 5개 사용. 스피너 중심 기준 접선 속도 성분만 추출 → `Δω = K_FLICK × v_tangential / r`. 결과는 `OMEGA_MAX`로 클램프.

---

## 5. 햅틱 명세 (이 프로젝트의 핵심)

**설계 원칙: 연속 진동이 아니라 "회전 디텐트 클릭"이다.**
계속 부르르 떨면 실제 스피너 느낌이 안 나고, 배터리·발열·모터 수명에도 나쁘다.

```
회전각이 (2π / DETENT_COUNT) 경계를 넘을 때마다 펄스 1회 발사
→ ω 높으면 펄스 간격 짧음 = 다다다다닥
→ 감속하면 간격 벌어짐 = 딱... 딱... 딱
→ ω < OMEGA_STOP 이면 마무리 펄스 1회 후 종료
```

| 상수 | 초기값 | 비고 |
|---|---|---|
| `DETENT_COUNT` | 3 | 3날개 스피너 → 회전당 3회 |
| `PULSE_MS_FAST` | 8 | 고속 회전 시 (짧고 날카롭게) |
| `PULSE_MS_SLOW` | 18 | 저속 회전 시 |
| `MIN_PULSE_GAP_MS` | 25 | **필수 가드.** 이보다 촘촘하면 드랍 |
| `BRAKE_PULSE_SCALE` | 1.5 | 브레이크 중 펄스 길이 배율 (거친 감각) |
| `FINAL_PULSE_MS` | 30 | 정지 시 마무리 |

### 필수 준수 사항
- `MIN_PULSE_GAP_MS` 가드 없이 고속 회전하면 진동 큐가 밀려서 그냥 "웅—" 하는 연속 진동으로 뭉개진다. **가드는 협상 대상이 아니다.**
- 드랍된 펄스는 카운트해서 디버그 오버레이에 표시한다.
- `document.visibilityState !== 'visible'` 이 되면 즉시 `navigator.vibrate(0)`.
- 첫 사용자 탭 이전에는 진동이 차단된다(브라우저 정책). 첫 탭에서 "웜업 펄스" 1회로 권한을 활성화한다.
- 진동 미지원 환경에서는 `NoopDriver` + 오디오 클릭 + 화면 셰이크로 대체한다.

---

## 6. 기록 / 저장 명세

`StorageAdapter` 인터페이스를 통해서만 접근한다. 나중에 원격 백엔드를 붙일 때 구현체만 추가하면 되도록 한다.

```ts
interface StorageAdapter {
  getAggregate(): Promise<Aggregate>;
  putRecord(r: SpinRecord): Promise<void>;
  listRecords(limit: number, cursor?: string): Promise<SpinRecord[]>;
  export(): Promise<string>;   // 백업 코드 (Base64 JSON)
  import(code: string): Promise<void>;
  clear(): Promise<void>;
}
```

```ts
// schemaVersion은 모든 레코드에 필수. 나중에 서버 마이그레이션의 근거가 된다.
type SpinRecord = {
  id: string;            // UUID v4
  ts: number;            // epoch ms
  maxRpm: number;
  durationMs: number;
  revolutions: number;
  braked: boolean;
  schemaVersion: 1;
};

type Aggregate = {
  totalRevolutions: number;
  totalTimeMs: number;
  bestRpm: number;
  bestDurationMs: number;
  sessionCount: number;
  schemaVersion: 1;
};
```

**중요:** 브라우저 저장소는 사용자가 캐시를 지우면 통째로 날아간다. 기록형 게임에서 이는 치명적이므로 **백업 코드 내보내기/불러오기 기능은 MVP 필수 항목이다.**

---

## 7. 하네스 (품질 게이트)

| 레이어 | 내용 | 명령어 |
|---|---|---|
| L0 | TypeScript strict + ESLint + Prettier | `npm run lint` `npm run typecheck` |
| L1 | 물리 엔진 단위 테스트 + 골든 스냅샷 | `npm run test:unit` |
| L2 | 햅틱 스케줄러 테스트 (vibrate 목킹, 타임스탬프 시퀀스 검증) | `npm run test:unit` |
| L3 | Playwright 모바일 E2E + 시각 회귀 | `npm run test:e2e` |
| L4 | 성능 예산 게이트 (번들 사이즈, Lighthouse CI) | `npm run test:perf` |
| L5 | **실기기 수동 체크리스트** (촉감은 자동 검증 불가) | `docs/DEVICE_CHECKLIST.md` |

```bash
npm run verify   # L0 + L1 + L2 (빠른 게이트, 커밋 전 필수)
npm run verify:full  # 전체 L0~L4 (PR 전)
```

### 성능 예산 (초과 시 CI 실패)
- 프로덕션 JS 번들: **≤ 60KB gzip**
- 롱프레임(>20ms) 비율: **≤ 1%** (60초 회전 측정)
- Lighthouse Performance: **≥ 95점** (PWA 카테고리는 Lighthouse 12에서 제거됨 — 설치성·오프라인 검증은 `tests/e2e/pwa/`가 담당한다. ADR-007)

### L5를 메우는 장치: 디버그 오버레이
촉감은 자동 테스트가 불가능하다. 그래서 `?debug=1` 로 켜지는 오버레이에 다음을 실시간 표시한다:
- 현재 ω (rad/s) 및 RPM
- 펄스 타임라인 (최근 3초)
- 드랍된 펄스 수 / 총 펄스 수
- 프레임 시간 히스토그램

"느낌이 이상하다"를 숫자로 잡기 위한 필수 도구다. 삭제하지 않는다.

---

## 8. TWA 호환 제약 (Play Store 대비, 지금부터 지킨다)

1. `manifest.webmanifest` 필수 필드 완비: `name`, `short_name`, `start_url`, `scope`, `display: standalone`, `orientation: portrait`, `theme_color`, `background_color`, icons 192/512 + **maskable 512**
2. Service Worker로 **오프라인 100% 동작**. 네트워크 의존 0.
3. **안드로이드 뒤로가기 대응**: History API로 화면 전환을 관리한다. 히스토리가 비면 TWA에서 백버튼 누를 때 앱이 그대로 종료된다.
4. `/.well-known/assetlinks.json` 배치 자리를 미리 확보한다 (도메인 확정 시 채움)
5. 서명 키(keystore) 분실 = 영구 업데이트 불가. Play App Signing 등록 + 키 별도 백업을 릴리즈 절차에 못 박는다.

---

## 9. 작업 보존 규칙

- **브랜치**: `main`(배포) / `develop`(통합) / `feat|fix|chore/*`
- **커밋**: Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`)
- **태스크 1개 = 커밋 1개 + 즉시 push.** 커밋을 몰아서 하지 않는다.
- **CI 실패 시 `main` 머지 차단.** 깨진 상태가 저장되는 것을 원천 봉쇄한다.
- `.claude/` 디렉토리(에이전트 정의 포함)도 반드시 커밋한다.
- 문서 3종은 항상 최신 상태를 유지한다:
  - `CLAUDE.md` — 헌법 (이 문서)
  - `PROGRESS.md` — 세션 로그, 매 세션 갱신
  - `DECISIONS.md` — ADR, 설계 판단이 바뀔 때마다 추가

---

## 10. 서브에이전트 (`.claude/agents/`)

| 에이전트 | 담당 |
|---|---|
| `physics-engineer` | 각운동 모델, 결정론 유지, 골든 스냅샷 관리 |
| `haptics-specialist` | 펄스 스케줄링, 플랫폼 폴백, 촉감 튜닝 |
| `test-harness-engineer` | L0~L4 하네스 구축·유지, CI 파이프라인 |
| `mobile-perf-auditor` | FPS·번들·배터리 감사, 성능 예산 집행 |
| `release-manager` | 배포, 롤백, PROGRESS.md 갱신, 릴리즈 노트 |

에이전트는 이 5개로 제한한다. 늘리려면 ADR을 먼저 작성한다.

---

## 11. 용어 정의

- **디텐트(detent)**: 회전 중 진동 펄스를 발사하는 각도 경계
- **드랍(drop)**: `MIN_PULSE_GAP_MS` 가드에 걸려 발사되지 못한 펄스
- **웜업 펄스**: 브라우저 진동 권한 활성화용 최초 1회 진동
- **골든 스냅샷**: 결정론적 시뮬레이션 결과를 고정해둔 회귀 기준값
