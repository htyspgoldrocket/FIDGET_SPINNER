// core/stats 세션 추적 + 집계. 순수 로직이므로 시간과 물리값을 전부 손으로 넣는다.
import { describe, expect, it } from 'vitest';

import {
  MIN_RECORDED_DURATION_MS,
  OMEGA_STOP,
  RAD_PER_REVOLUTION,
  RPM_PER_RAD_PER_SEC,
  SESSION_GAP_MS,
} from '../../src/core/constants';
import {
  aggregateOf,
  createStatsState,
  EMPTY_SPIN_AGGREGATE,
  endSession,
  isSpinning,
  mergeSpin,
  trackSpin,
  type CompletedSpin,
  type StatsFrame,
  type StatsFrameResult,
  type StatsState,
} from '../../src/core/stats';

/** 한 프레임의 입력. theta 는 직전 프레임의 theta 로부터 이어지도록 호출부가 관리한다. */
interface Step {
  readonly omega: number;
  readonly dtMs: number;
  readonly isBraking?: boolean;
  /** 이 프레임에 실제로 돈 각도 [rad]. 생략하면 omega × dt 로 채운다. */
  readonly dTheta?: number;
}

/** 프레임 열을 순서대로 흘려보내고 종료된 세션을 모은다. */
function run(
  steps: readonly Step[],
  options: { readonly startMs?: number; readonly state?: StatsState } = {},
): { state: StatsState; completed: CompletedSpin[]; theta: number; nowMs: number } {
  let state = options.state ?? createStatsState();
  let theta = 0;
  let nowMs = options.startMs ?? 1000;
  const completed: CompletedSpin[] = [];

  for (const step of steps) {
    nowMs += step.dtMs;
    const prevTheta = theta;
    theta += step.dTheta ?? (step.omega * step.dtMs) / 1000;
    const result: StatsFrameResult = trackSpin(state, {
      prevTheta,
      theta,
      omega: step.omega,
      isBraking: step.isBraking ?? false,
      nowMs,
    } satisfies StatsFrame);
    state = result.state;
    if (result.completed !== null) completed.push(result.completed);
  }

  return { state, completed, theta, nowMs };
}

/** ω 를 dtMs 간격으로 count 프레임 유지하는 열. */
function hold(omega: number, count: number, dtMs = 16, isBraking = false): Step[] {
  return Array.from({ length: count }, () => ({ omega, dtMs, isBraking }));
}

describe('isSpinning', () => {
  it('OMEGA_STOP 이 회전/정지의 경계다 (haptic-scheduler 와 같은 문턱)', () => {
    expect(isSpinning(0)).toBe(false);
    expect(isSpinning(OMEGA_STOP - 1e-9)).toBe(false);
    expect(isSpinning(OMEGA_STOP)).toBe(true);
    expect(isSpinning(-OMEGA_STOP)).toBe(true); // 역회전도 회전이다
  });
});

describe('세션 시작 / 종료 판정', () => {
  it('멈춰 있는 프레임만 흘리면 세션이 생기지 않는다', () => {
    const { state, completed } = run(hold(0, 30));
    expect(state.session).toBeNull();
    expect(completed).toEqual([]);
  });

  it('ω 가 문턱을 넘으면 세션이 열리고 0 이 되는 프레임에 닫힌다', () => {
    const { state, completed } = run([...hold(20, 40), { omega: 0, dtMs: 16 }]);
    expect(state.session).toBeNull();
    expect(completed).toHaveLength(1);
  });

  it('회전이 끝나기 전에는 아무것도 보고하지 않는다', () => {
    const { state, completed } = run(hold(20, 100));
    expect(completed).toEqual([]);
    expect(state.session).not.toBeNull(); // 아직 진행 중이다
  });

  it('멈췄다 다시 돌면 별개의 세션 두 개다', () => {
    const { completed } = run([
      ...hold(20, 40),
      { omega: 0, dtMs: 16 },
      ...hold(20, 40),
      { omega: 0, dtMs: 16 },
    ]);
    expect(completed).toHaveLength(2);
  });

  it('역회전도 세션으로 잡히고 회전수는 양수다', () => {
    const { completed } = run([...hold(-20, 40), { omega: 0, dtMs: 16 }]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.revolutions).toBeGreaterThan(0);
    expect(completed[0]?.maxRpm).toBeCloseTo(20 * RPM_PER_RAD_PER_SEC, 6);
  });
});

describe('측정값 정확성', () => {
  it('durationMs 는 첫 회전 프레임부터 정지 프레임까지다', () => {
    // 16ms 프레임 40개 회전 + 정지 프레임 1개.
    // 첫 회전 프레임 시각이 시작점이므로 (40 - 1 + 1) × 16 = 640ms.
    const { completed } = run([...hold(20, 40), { omega: 0, dtMs: 16 }]);
    expect(completed[0]?.durationMs).toBeCloseTo(640, 6);
  });

  it('revolutions 는 |Δθ| 누적 / 2π 이고 정지 프레임의 잔여 회전까지 센다', () => {
    const { completed } = run([
      ...hold(1, 30, 100, false), // 100ms × 30 = 3s, ω=1 → 3 rad
      { omega: 0, dtMs: 100, dTheta: RAD_PER_REVOLUTION }, // 마지막 한 바퀴는 정지 프레임에서
    ]);
    expect(completed[0]?.revolutions).toBeCloseTo(3 / RAD_PER_REVOLUTION + 1, 9);
  });

  it('maxRpm 은 세션 중 최댓값이다 (끝값이 아니라)', () => {
    const { completed } = run([
      ...hold(5, 10, 50),
      ...hold(120, 4, 50), // 최고점은 중간에 있다
      ...hold(3, 10, 50),
      { omega: 0, dtMs: 50 },
    ]);
    expect(completed[0]?.maxRpm).toBeCloseTo(120 * RPM_PER_RAD_PER_SEC, 6);
  });
});

describe('braked 플래그', () => {
  it('브레이크가 한 번도 없으면 false', () => {
    const { completed } = run([...hold(20, 40), { omega: 0, dtMs: 16 }]);
    expect(completed[0]?.braked).toBe(false);
  });

  it('한 프레임이라도 브레이크가 걸렸으면 true 로 남는다', () => {
    const { completed } = run([
      ...hold(20, 20),
      { omega: 20, dtMs: 16, isBraking: true },
      ...hold(20, 20),
      { omega: 0, dtMs: 16 },
    ]);
    expect(completed[0]?.braked).toBe(true);
  });

  it('세션이 끝나면 플래그도 초기화된다 (다음 세션으로 새지 않는다)', () => {
    const { completed } = run([
      ...hold(20, 20, 16, true),
      { omega: 0, dtMs: 16 },
      ...hold(20, 20),
      { omega: 0, dtMs: 16 },
    ]);
    expect(completed.map((s) => s.braked)).toEqual([true, false]);
  });
});

describe('짧은 튕김', () => {
  it('한 프레임 만에 멈춘 회전은 기록하지 않는다', () => {
    const { state, completed } = run([
      { omega: 0.2, dtMs: 16 },
      { omega: 0, dtMs: 16 },
    ]);
    expect(completed).toEqual([]);
    expect(state.session).toBeNull(); // 상태는 확실히 비워진다
  });

  it('문턱 바로 아래 길이의 세션은 버리고, 문턱을 넘으면 기록한다', () => {
    const shortMs = MIN_RECORDED_DURATION_MS - 10;
    const longMs = MIN_RECORDED_DURATION_MS + 10;

    const dropped = run([
      { omega: 5, dtMs: 16 },
      { omega: 5, dtMs: shortMs },
      { omega: 0, dtMs: 0 },
    ]);
    expect(dropped.completed).toEqual([]);

    const kept = run([
      { omega: 5, dtMs: 16 },
      { omega: 5, dtMs: longMs },
      { omega: 0, dtMs: 0 },
    ]);
    expect(kept.completed).toHaveLength(1);
    expect(kept.completed[0]?.durationMs).toBeCloseTo(longMs, 6);
  });

  it('버려진 튕김 뒤에도 다음 진짜 회전은 정상 기록된다', () => {
    const { completed } = run([
      { omega: 0.2, dtMs: 16 },
      { omega: 0, dtMs: 16 },
      ...hold(30, 40),
      { omega: 0, dtMs: 16 },
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.maxRpm).toBeCloseTo(30 * RPM_PER_RAD_PER_SEC, 6);
  });
});

describe('프레임 공백 (탭 전환)', () => {
  it('공백이 SESSION_GAP_MS 를 넘으면 마지막 관측 시각에서 세션을 끊는다', () => {
    const { completed } = run([
      ...hold(20, 40), // 640ms 짜리 세션
      { omega: 20, dtMs: SESSION_GAP_MS + 500, dTheta: 0 }, // 복귀 프레임 (물리는 전진하지 않았다)
      ...hold(20, 40),
      { omega: 0, dtMs: 16 },
    ]);

    expect(completed).toHaveLength(2);
    // 첫 세션의 길이에 공백이 얹히지 않았다.
    expect(completed[0]?.durationMs).toBeCloseTo(624, 6);
    expect(completed[1]?.durationMs).toBeLessThan(SESSION_GAP_MS);
  });

  it('공백 프레임에서 한 프레임에 두 세션이 닫히지 않는다', () => {
    // 공백 뒤 곧바로 정지한 프레임 — 끊긴 세션 하나만 나와야 한다.
    let count = 0;
    const state = run(hold(20, 40)).state;
    const after = trackSpin(state, {
      prevTheta: 100,
      theta: 100,
      omega: 0,
      isBraking: false,
      nowMs: 1_000_000,
    });
    if (after.completed !== null) count += 1;
    expect(count).toBe(1);
    expect(after.state.session).toBeNull();
  });
});

describe('이상값 방어', () => {
  it.each([
    ['nowMs', { prevTheta: 0, theta: 1, omega: 10, isBraking: false, nowMs: Number.NaN }],
    ['omega', { prevTheta: 0, theta: 1, omega: Number.NaN, isBraking: false, nowMs: 10 }],
    [
      'theta',
      { prevTheta: 0, theta: Number.POSITIVE_INFINITY, omega: 10, isBraking: false, nowMs: 10 },
    ],
    ['prevTheta', { prevTheta: Number.NaN, theta: 1, omega: 10, isBraking: false, nowMs: 10 }],
  ])('%s 가 유한하지 않은 프레임은 상태를 바꾸지 않는다', (_label, frame) => {
    const before = createStatsState();
    const result = trackSpin(before, frame as StatsFrame);
    expect(result.state).toBe(before);
    expect(result.completed).toBeNull();
  });
});

describe('endSession', () => {
  it('진행 중인 세션을 즉시 닫는다', () => {
    const { state, nowMs } = run(hold(20, 40));
    const result = endSession(state, nowMs + 16);
    expect(result.completed?.maxRpm).toBeCloseTo(20 * RPM_PER_RAD_PER_SEC, 6);
    expect(result.state.session).toBeNull();
  });

  it('세션이 없으면 아무것도 돌려주지 않는다', () => {
    expect(endSession(createStatsState(), 100).completed).toBeNull();
  });
});

describe('Aggregate 병합', () => {
  const spin = (over: Partial<CompletedSpin> = {}): CompletedSpin => ({
    maxRpm: 100,
    durationMs: 1000,
    revolutions: 10,
    braked: false,
    ...over,
  });

  it('빈 집계값에서 시작해 합계가 더해지고 최고값이 갱신된다', () => {
    const after = mergeSpin(EMPTY_SPIN_AGGREGATE, spin());
    expect(after).toEqual({
      totalRevolutions: 10,
      totalTimeMs: 1000,
      bestRpm: 100,
      bestDurationMs: 1000,
      sessionCount: 1,
    });
  });

  it('최고 기록은 더 큰 값이 들어올 때만 바뀐다', () => {
    const first = mergeSpin(EMPTY_SPIN_AGGREGATE, spin({ maxRpm: 500, durationMs: 9000 }));
    const second = mergeSpin(first, spin({ maxRpm: 120, durationMs: 300, revolutions: 2 }));

    expect(second.bestRpm).toBe(500);
    expect(second.bestDurationMs).toBe(9000);
    expect(second.totalRevolutions).toBe(12);
    expect(second.totalTimeMs).toBe(9300);
    expect(second.sessionCount).toBe(2);
  });

  it('인자를 변형하지 않는다', () => {
    const before = mergeSpin(EMPTY_SPIN_AGGREGATE, spin());
    const snapshot = { ...before };
    mergeSpin(before, spin({ maxRpm: 999 }));
    expect(before).toEqual(snapshot);
  });

  it('aggregateOf 는 순서에 무관하게 같은 결과를 낸다', () => {
    const spins = [
      spin({ maxRpm: 10, durationMs: 400, revolutions: 1 }),
      spin({ maxRpm: 900, durationMs: 50, revolutions: 3 }),
      spin({ maxRpm: 300, durationMs: 7000, revolutions: 40 }),
    ];
    expect(aggregateOf(spins)).toEqual(aggregateOf([...spins].reverse()));
    expect(aggregateOf(spins).sessionCount).toBe(3);
    expect(aggregateOf([])).toEqual(EMPTY_SPIN_AGGREGATE);
  });

  it('루프에서 나온 세션들이 그대로 집계로 접힌다', () => {
    const { completed } = run([
      ...hold(50, 30),
      { omega: 0, dtMs: 16 },
      ...hold(10, 60),
      { omega: 0, dtMs: 16 },
    ]);
    const aggregate = aggregateOf(completed);

    expect(aggregate.sessionCount).toBe(2);
    expect(aggregate.bestRpm).toBeCloseTo(50 * RPM_PER_RAD_PER_SEC, 6);
    expect(aggregate.bestDurationMs).toBeCloseTo(
      Math.max(...completed.map((s) => s.durationMs)),
      6,
    );
    expect(aggregate.totalTimeMs).toBeCloseTo(
      completed.reduce((sum, s) => sum + s.durationMs, 0),
      6,
    );
  });
});
