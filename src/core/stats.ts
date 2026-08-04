// 회전 세션 추적 + 기록 집계. RPM / 회전수 / 지속 시간.
//
// 순수 모듈이다 — 시간은 프레임 인자로 주입받고 브라우저 API 를 전혀 참조하지 않는다
// (CLAUDE.md 규칙 1). UUID 생성과 epoch 시각은 여기서 하지 않는다: 저장 레이어(platform)의
// 일이다. 이 파일이 만드는 것은 "방금 끝난 회전 한 번"의 순수한 측정값뿐이다.
//
// 세션 판정은 haptic-scheduler 의 정지 판정과 **같은 문턱(OMEGA_STOP)** 을 쓴다.
// 그래야 기록의 끝과 마무리 펄스가 같은 프레임에서 일어난다 — "딱" 소리와 기록이 어긋나지 않는다.

import {
  MIN_RECORDED_DURATION_MS,
  OMEGA_STOP,
  RAD_PER_REVOLUTION,
  RPM_PER_RAD_PER_SEC,
  SESSION_GAP_MS,
} from './constants';

/** 끝난 회전 한 번의 측정값. 저장 레이어가 여기에 id/ts 를 붙여 SpinRecord 로 만든다. */
export interface CompletedSpin {
  /** 세션 중 관측한 최고 RPM. */
  readonly maxRpm: number;
  /** 회전이 지속된 시간 [ms]. */
  readonly durationMs: number;
  /** 회전수 (|Δθ| 누적 / 2π). 방향은 무시한다 — 반대로 돌아도 돈 것이다. */
  readonly revolutions: number;
  /** 세션 중 한 번이라도 브레이크가 걸렸는가. */
  readonly braked: boolean;
}

/**
 * 누적 통계. CLAUDE.md 6장 `Aggregate` 에서 `schemaVersion` 을 뺀 모양이다.
 *
 * 스키마 버전은 **저장 형식**의 속성이지 집계 로직의 속성이 아니고, core 는 저장 레이어를
 * import 할 수 없다 (단방향 의존). 그래서 순수한 수치부만 여기서 다루고,
 * `platform/storage/adapter.ts` 가 여기에 schemaVersion 을 붙인 타입을 정의한다.
 */
export interface SpinAggregate {
  readonly totalRevolutions: number;
  readonly totalTimeMs: number;
  readonly bestRpm: number;
  readonly bestDurationMs: number;
  readonly sessionCount: number;
}

/** 기록이 하나도 없는 상태. 동결해두고 공유한다 (누구도 변형할 수 없다). */
export const EMPTY_SPIN_AGGREGATE: SpinAggregate = Object.freeze({
  totalRevolutions: 0,
  totalTimeMs: 0,
  bestRpm: 0,
  bestDurationMs: 0,
  sessionCount: 0,
});

/** 진행 중인 회전 세션. 외부에서 직접 만들지 않는다 — `trackSpin` 이 관리한다. */
interface ActiveSession {
  /** 회전이 시작된 프레임의 시각 [ms]. */
  readonly startedAtMs: number;
  /** 마지막으로 관측한 프레임의 시각 [ms]. 프레임 공백 판정에 쓴다. */
  readonly lastAtMs: number;
  /** 지금까지 관측한 최대 |ω| [rad/s]. RPM 환산은 세션이 끝날 때 한 번만 한다. */
  readonly maxOmega: number;
  /** 지금까지 누적된 회전수. */
  readonly revolutions: number;
  readonly braked: boolean;
}

/** 프레임 사이에 들고 가는 상태. 불변 객체다. */
export interface StatsState {
  readonly session: ActiveSession | null;
}

/** 한 프레임의 입력. main 의 게임 루프가 advance() 결과에서 그대로 채운다. */
export interface StatsFrame {
  /** advance() 이전의 누적 회전각 [rad]. */
  readonly prevTheta: number;
  /** advance() 이후의 누적 회전각 [rad]. */
  readonly theta: number;
  /** advance() 이후의 각속도 [rad/s]. */
  readonly omega: number;
  /** 이 프레임에 브레이크가 걸려 있었는가. */
  readonly isBraking: boolean;
  /** 현재 시각 [ms]. rAF 타임스탬프. */
  readonly nowMs: number;
}

export interface StatsFrameResult {
  readonly state: StatsState;
  /** 이 프레임에 종료된 세션. 없으면 null — 대부분의 프레임은 null 이다. */
  readonly completed: CompletedSpin | null;
}

export function createStatsState(): StatsState {
  return { session: null };
}

/** 세션 중인가. 정지 판정은 haptic-scheduler 와 같은 문턱을 쓴다. */
export function isSpinning(omega: number): boolean {
  return Math.abs(omega) >= OMEGA_STOP;
}

const CLEARED: StatsState = Object.freeze({ session: null });

/**
 * 세션을 닫아 측정값으로 만든다. 기록 문턱에 못 미치면 null (기록하지 않는다).
 *
 * `extraRevolutions` 는 세션을 닫는 그 프레임에서 마저 돈 양이다. 정지 프레임에서도 θ 는
 * 조금 더 전진하므로(감속의 마지막 조각) 이것까지 세야 회전수가 맞는다.
 */
function finish(
  session: ActiveSession,
  endAtMs: number,
  extraRevolutions: number,
): CompletedSpin | null {
  const durationMs = endAtMs - session.startedAtMs;
  if (!(durationMs >= MIN_RECORDED_DURATION_MS)) return null;

  return {
    maxRpm: session.maxOmega * RPM_PER_RAD_PER_SEC,
    durationMs,
    revolutions: session.revolutions + extraRevolutions,
    braked: session.braked,
  };
}

/**
 * 한 프레임을 세션 추적에 반영한다.
 *
 * **시작**: 세션이 없는데 |ω| ≥ OMEGA_STOP 인 프레임.
 * **종료**: 세션이 있는데 |ω| 가 문턱 밑으로 떨어진 프레임 (physics 가 0 으로 스냅한 프레임).
 * 더블탭 정지도 ω 를 0 으로 만들므로 같은 경로로 닫힌다.
 *
 * **짧은 튕김**: 지속 시간이 MIN_RECORDED_DURATION_MS 에 못 미치는 세션은 상태만 비우고
 * 기록하지 않는다. 문턱 아래의 ω 는 physics 가 첫 스텝에서 0 으로 스냅해버리므로 애초에
 * 세션이 열리지도 않지만, 프레임 간격이 짧아 스냅이 다음 프레임으로 밀리는 경우가 남는다.
 *
 * **프레임 공백**: 탭 전환 등으로 SESSION_GAP_MS 를 넘는 공백이 생기면 세션을 마지막 관측
 * 시각에서 끊는다. 이 프레임의 회전은 새 세션으로 들어간다 — 따라서 한 프레임에서 종료되는
 * 세션은 언제나 최대 하나다.
 *
 * 유한하지 않은 값이 들어온 프레임은 아무 일도 하지 않고 넘긴다 (타이머·물리 이상값 방어).
 */
export function trackSpin(state: StatsState, frame: StatsFrame): StatsFrameResult {
  const { prevTheta, theta, omega, isBraking, nowMs } = frame;

  if (
    !Number.isFinite(prevTheta) ||
    !Number.isFinite(theta) ||
    !Number.isFinite(omega) ||
    !Number.isFinite(nowMs)
  ) {
    return { state, completed: null };
  }

  let session = state.session;
  let completed: CompletedSpin | null = null;

  // 공백 감지가 먼저다. 끊긴 세션의 시간에 공백을 얹지 않는다.
  if (session !== null && nowMs - session.lastAtMs > SESSION_GAP_MS) {
    completed = finish(session, session.lastAtMs, 0);
    session = null;
  }

  const turned = Math.abs(theta - prevTheta) / RAD_PER_REVOLUTION;

  if (isSpinning(omega)) {
    const speed = Math.abs(omega);
    const next: ActiveSession =
      session === null
        ? {
            startedAtMs: nowMs,
            lastAtMs: nowMs,
            maxOmega: speed,
            revolutions: turned,
            braked: isBraking,
          }
        : {
            startedAtMs: session.startedAtMs,
            lastAtMs: nowMs,
            maxOmega: Math.max(session.maxOmega, speed),
            revolutions: session.revolutions + turned,
            braked: session.braked || isBraking,
          };
    return { state: { session: next }, completed };
  }

  if (session === null) return { state: state.session === null ? state : CLEARED, completed };

  return { state: CLEARED, completed: finish(session, nowMs, turned) };
}

/** 진행 중인 세션을 즉시 닫는다 (앱 종료 등). 기록 문턱에 못 미치면 null. */
export function endSession(state: StatsState, nowMs: number): StatsFrameResult {
  if (state.session === null || !Number.isFinite(nowMs)) {
    return { state: CLEARED, completed: null };
  }
  return { state: CLEARED, completed: finish(state.session, nowMs, 0) };
}

/** 끝난 회전 하나를 누적 통계에 더한다. 순수 — 인자를 변형하지 않는다. */
export function mergeSpin(aggregate: SpinAggregate, spin: CompletedSpin): SpinAggregate {
  return {
    totalRevolutions: aggregate.totalRevolutions + spin.revolutions,
    totalTimeMs: aggregate.totalTimeMs + spin.durationMs,
    bestRpm: Math.max(aggregate.bestRpm, spin.maxRpm),
    bestDurationMs: Math.max(aggregate.bestDurationMs, spin.durationMs),
    sessionCount: aggregate.sessionCount + 1,
  };
}

/** 기록 목록으로부터 누적 통계를 접어 만든다. 백업 검증·인메모리 저장소가 쓴다. */
export function aggregateOf(spins: readonly CompletedSpin[]): SpinAggregate {
  let aggregate = EMPTY_SPIN_AGGREGATE;
  for (const spin of spins) aggregate = mergeSpin(aggregate, spin);
  return aggregate;
}
