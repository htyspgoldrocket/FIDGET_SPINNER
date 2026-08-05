// L1 — 각운동 시뮬레이션. physics-engineer.md 의 필수 테스트 7종 + 경계 케이스.
//
// 이 테스트들이 지키는 것: 감속만 한다 / 정지하면 정지해 있는다 / 상한을 넘지 않는다 /
// 프레임이 얼마나 튀든 폭주하지 않는다 / 같은 입력은 같은 결과다.

import { describe, expect, it } from 'vitest';
import {
  advance,
  angularAcceleration,
  applyImpulse,
  clampOmega,
  createSpinState,
  halt,
  isStopped,
  type SpinState,
} from '../../src/core/physics';
import {
  B_VISCOUS,
  C_DRAG,
  FIXED_DT,
  MAX_SUBSTEPS,
  OMEGA_MAX,
  OMEGA_STOP,
  TAU_BRAKE,
  TAU_COULOMB,
} from '../../src/core/constants';

const FRAME_60 = 1 / 60;

/** 프레임을 n번 돌리며 매 프레임 상태를 남긴다. */
function run(omega0: number, frames: number, { dt = FRAME_60, braking = false } = {}): SpinState[] {
  let state = createSpinState(omega0);
  const history: SpinState[] = [state];
  for (let i = 0; i < frames; i += 1) {
    state = advance(state, dt, braking).state;
    history.push(state);
  }
  return history;
}

/** 결정론적 의사난수 (Math.random 은 테스트에서도 쓰지 않는다 — 재현 불가능한 실패를 만든다). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('angularAcceleration', () => {
  it('멈춰 있으면 가속도가 0 이다 (브레이크를 잡고 있어도 저절로 움직이지 않는다)', () => {
    expect(angularAcceleration(0, false)).toBe(0);
    expect(angularAcceleration(0, true)).toBe(0);
  });

  it('항상 회전 반대 방향으로 작용한다', () => {
    for (const w of [0.2, 1, 50, OMEGA_MAX]) {
      expect(angularAcceleration(w, false)).toBeLessThan(0);
      expect(angularAcceleration(-w, false)).toBeGreaterThan(0);
    }
  });

  it('부호에 대해 완전히 대칭이다: a(-ω) === -a(ω)', () => {
    for (const w of [0.5, 3, 77.25, OMEGA_MAX]) {
      expect(angularAcceleration(-w, false)).toBe(-angularAcceleration(w, false));
      expect(angularAcceleration(-w, true)).toBe(-angularAcceleration(w, true));
    }
  });

  it('CLAUDE.md 4장의 식과 수치가 일치한다', () => {
    const w = 42;
    const expected = -TAU_COULOMB - B_VISCOUS * w - C_DRAG * w * w;
    expect(angularAcceleration(w, false)).toBeCloseTo(expected, 12);
    expect(angularAcceleration(w, true)).toBeCloseTo(expected - TAU_BRAKE, 12);
  });
});

describe('감속 곡선', () => {
  it('상한 속도에서 정지까지 |ω| 가 단조 감소한다', () => {
    const history = run(OMEGA_MAX, 1600);
    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1]!;
      const cur = history[i]!;
      expect(Math.abs(cur.omega)).toBeLessThanOrEqual(Math.abs(prev.omega));
    }
    expect(history[history.length - 1]!.omega).toBe(0);
  });

  it('정지 전까지는 매 프레임 실제로 줄어든다 (평평한 구간이 없다)', () => {
    const history = run(50, 1300);
    let stoppedAt = history.length;
    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1]!;
      const cur = history[i]!;
      if (cur.omega === 0) {
        stoppedAt = i;
        break;
      }
      expect(Math.abs(cur.omega)).toBeLessThan(Math.abs(prev.omega));
    }
    expect(stoppedAt).toBeLessThan(history.length); // 실제로 멈추긴 했는가
  });

  it('θ 는 회전 방향으로 단조 증가/감소한다', () => {
    const forward = run(120, 600);
    for (let i = 1; i < forward.length; i += 1) {
      expect(forward[i]!.theta).toBeGreaterThanOrEqual(forward[i - 1]!.theta);
    }
    const backward = run(-120, 600);
    for (let i = 1; i < backward.length; i += 1) {
      expect(backward[i]!.theta).toBeLessThanOrEqual(backward[i - 1]!.theta);
    }
  });

  it('θ 는 2π 로 wrap 되지 않고 누적된다 (회전수 집계의 근거)', () => {
    const history = run(OMEGA_MAX, 600);
    expect(history[history.length - 1]!.theta).toBeGreaterThan(2 * Math.PI * 50);
  });

  it('음의 회전은 양의 회전의 정확한 거울상이다', () => {
    const plus = run(90, 400);
    const minus = run(-90, 400);
    for (let i = 0; i < plus.length; i += 1) {
      // 합이 정확히 0 인지로 본다 (-0 과 0 을 구분하지 않으면서도 오차는 허용하지 않는다)
      expect(plus[i]!.omega + minus[i]!.omega, `frame ${i} omega`).toBe(0);
      expect(plus[i]!.theta + minus[i]!.theta, `frame ${i} theta`).toBe(0);
    }
  });
});

describe('정지 스냅', () => {
  it('정지 후에는 ω 가 정확히 0 이고 부호가 튀지 않는다', () => {
    const history = run(30, 1400);
    const stopIndex = history.findIndex((s) => s.omega === 0);
    expect(stopIndex).toBeGreaterThan(0);

    const thetaAtStop = history[stopIndex]!.theta;
    for (let i = stopIndex; i < history.length; i += 1) {
      expect(history[i]!.omega).toBe(0);
      expect(Object.is(history[i]!.omega, -0)).toBe(false); // -0 도 새어나가면 안 된다
      expect(history[i]!.theta).toBe(thetaAtStop); // 멈춘 뒤 θ 는 더 움직이지 않는다
    }
  });

  it('감속 도중 한 번도 반대 부호로 넘어가지 않는다 (진동 없음)', () => {
    for (const w0 of [0.2, 1, 7.5, 210]) {
      for (const braking of [false, true]) {
        const history = run(w0, 1500, { braking });
        for (const s of history) {
          expect(s.omega).toBeGreaterThanOrEqual(0);
        }
        const mirrored = run(-w0, 1500, { braking });
        for (const s of mirrored) {
          expect(s.omega).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it('OMEGA_STOP 바로 위에서 시작해도 한 스텝 만에 0 으로 떨어진다', () => {
    const justAbove = OMEGA_STOP + 0.001;
    const after = advance(createSpinState(justAbove), FIXED_DT, false).state;
    expect(after.omega).toBe(0);
  });

  it('멈춘 상태를 계속 스텝해도 0 을 유지한다 (음수로 새지 않는다)', () => {
    let state = createSpinState(0);
    for (let i = 0; i < 500; i += 1) {
      state = advance(state, FRAME_60, i % 2 === 0).state;
      expect(state.omega).toBe(0);
      expect(state.theta).toBe(0);
    }
    expect(isStopped(state)).toBe(true);
  });

  it('브레이크로 멈춘 뒤 역회전하지 않는다', () => {
    const history = run(0.4, 200, { braking: true });
    for (const s of history) expect(s.omega).toBeGreaterThanOrEqual(0);
    expect(history[history.length - 1]!.omega).toBe(0);
  });
});

describe('OMEGA_MAX 클램프', () => {
  it('양·음 양쪽에서 상한을 넘지 않는다', () => {
    expect(clampOmega(1e6)).toBe(OMEGA_MAX);
    expect(clampOmega(-1e6)).toBe(-OMEGA_MAX);
    expect(clampOmega(OMEGA_MAX)).toBe(OMEGA_MAX);
    expect(clampOmega(-OMEGA_MAX)).toBe(-OMEGA_MAX);
    expect(clampOmega(12.5)).toBe(12.5);
  });

  it('초기 상태 생성에서 클램프된다', () => {
    expect(createSpinState(999).omega).toBe(OMEGA_MAX);
    expect(createSpinState(-999).omega).toBe(-OMEGA_MAX);
  });

  it('플릭 임펄스를 아무리 넣어도 상한을 넘지 못한다', () => {
    let state = createSpinState(0);
    for (let i = 0; i < 20; i += 1) state = applyImpulse(state, 100);
    expect(state.omega).toBe(OMEGA_MAX);

    for (let i = 0; i < 40; i += 1) state = applyImpulse(state, -100);
    expect(state.omega).toBe(-OMEGA_MAX);
  });

  it('시뮬레이션 도중에도 |ω| 가 상한을 넘는 프레임이 없다', () => {
    for (const s of run(OMEGA_MAX, 300)) {
      expect(Math.abs(s.omega)).toBeLessThanOrEqual(OMEGA_MAX);
    }
    for (const s of run(-OMEGA_MAX, 300)) {
      expect(Math.abs(s.omega)).toBeLessThanOrEqual(OMEGA_MAX);
    }
  });
});

describe('고정 타임스텝 / death spiral 방지', () => {
  it('정상 프레임(60fps)은 4서브스텝을 돌고 아무것도 폐기하지 않는다', () => {
    let state = createSpinState(100);
    for (let i = 0; i < 100; i += 1) {
      const r = advance(state, FRAME_60, false);
      expect(r.substeps).toBeLessThanOrEqual(MAX_SUBSTEPS);
      expect(r.droppedSec).toBe(0);
      state = r.state;
    }
  });

  it('dt 가 1초로 튀어도 서브스텝이 MAX_SUBSTEPS 로 제한되고 남은 시간은 폐기된다', () => {
    const start = createSpinState(100);
    const r = advance(start, 1.0, false);

    expect(r.substeps).toBe(MAX_SUBSTEPS);
    // 밀린 시간을 다음 프레임으로 넘기지 않는다 — 넘기면 계속 상한에 걸려 따라잡지 못한다
    expect(r.state.accumulator).toBeLessThan(FIXED_DT);
    // 시간은 사라지지 않고 (소화 + 폐기 + 이월) 로 나뉜다
    expect(MAX_SUBSTEPS * FIXED_DT + r.droppedSec + r.state.accumulator).toBeCloseTo(1.0, 12);

    // 결과는 "FIXED_DT 를 5번 돌린 것"과 정확히 같아야 한다.
    let stepped = start;
    for (let i = 0; i < MAX_SUBSTEPS; i += 1) stepped = advance(stepped, FIXED_DT, false).state;
    expect(r.state.omega).toBe(stepped.omega);
    expect(r.state.theta).toBe(stepped.theta);
  });

  it('상한에 걸려도 FIXED_DT 미만의 잔여는 버리지 않고 이월한다', () => {
    const start = createSpinState(100);

    // 5.5스텝짜리 프레임: 5스텝을 돌고 남는 0.5스텝은 아직 버릴 시간이 아니다
    const partial = advance(start, 5.5 * FIXED_DT, false);
    expect(partial.substeps).toBe(MAX_SUBSTEPS);
    expect(partial.droppedSec).toBe(0);
    expect(partial.state.accumulator).toBeCloseTo(0.5 * FIXED_DT, 15);

    // 6.5스텝짜리 프레임: 온전한 1스텝만 버리고 0.5스텝은 이월한다
    const over = advance(start, 6.5 * FIXED_DT, false);
    expect(over.substeps).toBe(MAX_SUBSTEPS);
    expect(over.droppedSec).toBeCloseTo(FIXED_DT, 15);
    expect(over.state.accumulator).toBeCloseTo(0.5 * FIXED_DT, 15);
  });

  it('지속 45fps(상한을 계속 넘는 프레임)에서도 손실이 이론 최소치에 머문다', () => {
    const frames = 600;
    const frameDt = 1 / 45; // 5.33 서브스텝 필요 — 매번 상한에 걸린다
    let state = createSpinState(OMEGA_MAX);
    let simulated = 0;
    for (let i = 0; i < frames; i += 1) {
      const r = advance(state, frameDt, false);
      state = r.state;
      simulated += r.substeps * FIXED_DT;
    }
    // 소화 가능한 최대치는 프레임당 MAX_SUBSTEPS × FIXED_DT — 그 93% 이상을 실제로 쓴다
    const wallClock = frames * frameDt;
    expect(simulated / wallClock).toBeGreaterThan(0.93);
  });

  it('1초짜리 폭증이 반복돼도 폭주하지 않고 계속 감속한다', () => {
    // 한 프레임이 소화하는 시뮬레이션 시간은 MAX_SUBSTEPS × FIXED_DT ≈ 20.8ms 뿐이므로
    // 상한 속도에서 멈추기까지 (24.6s / 20.8ms) ≈ 1180 프레임이 필요하다.
    let state = createSpinState(OMEGA_MAX);
    let prev = Math.abs(state.omega);
    for (let i = 0; i < 1400; i += 1) {
      state = advance(state, 1.0, false).state;
      expect(Number.isFinite(state.omega)).toBe(true);
      expect(Number.isFinite(state.theta)).toBe(true);
      expect(Math.abs(state.omega)).toBeLessThanOrEqual(prev);
      expect(state.omega).toBeGreaterThanOrEqual(0);
      prev = Math.abs(state.omega);
    }
    expect(state.omega).toBe(0); // 멈추긴 한다 — 시뮬레이션이 정지하지 않았다는 뜻
  });

  it('accumulator 는 항상 [0, FIXED_DT) 안에 있다', () => {
    const rand = lcg(20260804);
    let state = createSpinState(80);
    for (let i = 0; i < 2000; i += 1) {
      state = advance(state, rand() * 0.05, false).state;
      expect(state.accumulator).toBeGreaterThanOrEqual(0);
      expect(state.accumulator).toBeLessThan(FIXED_DT);
    }
  });

  it('반 스텝짜리 프레임 두 번은 한 스텝짜리 프레임 한 번과 같다 (accumulator 이월)', () => {
    const start = createSpinState(70);
    const half = advance(advance(start, FIXED_DT / 2, false).state, FIXED_DT / 2, false).state;
    const whole = advance(start, FIXED_DT, false).state;
    expect(half.omega).toBe(whole.omega);
    expect(half.theta).toBe(whole.theta);
  });

  it('dt = 0 이면 상태가 그대로다', () => {
    const start = createSpinState(70);
    const r = advance(start, 0, false);
    expect(r.substeps).toBe(0);
    expect(r.droppedSec).toBe(0);
    expect(r.state).toEqual(start);
  });

  it('음수·NaN·Infinity 인 dt 는 무시한다', () => {
    const start = createSpinState(70);
    for (const bad of [-1, -0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = advance(start, bad, false);
      expect(r.substeps).toBe(0);
      expect(r.state).toEqual(start);
    }
  });

  it('FIXED_DT 미만의 프레임이 이어져도 시간이 쌓여 결국 스텝이 돈다', () => {
    let state = createSpinState(70);
    let total = 0;
    for (let i = 0; i < 4; i += 1) {
      const r = advance(state, FIXED_DT / 3, false);
      state = r.state;
      total += r.substeps;
    }
    expect(total).toBe(1); // 4 × (1/3) 스텝 → 1스텝 소화, 나머지는 이월
  });
});

describe('브레이크', () => {
  it('회전 방향과 무관하게 항상 감속시킨다', () => {
    for (const w0 of [50, -50, 5, -5, OMEGA_MAX, -OMEGA_MAX]) {
      const free = run(w0, 120)[120]!;
      const braked = run(w0, 120, { braking: true })[120]!;
      expect(Math.abs(braked.omega)).toBeLessThan(Math.abs(free.omega));
      // 부호는 유지된다 — 브레이크가 방향을 뒤집지 않는다
      expect(Math.sign(braked.omega) === Math.sign(w0) || braked.omega === 0).toBe(true);
    }
  });

  it('브레이크 감속량이 양·음 방향에서 대칭이다', () => {
    const plus = run(60, 200, { braking: true })[200]!;
    const minus = run(-60, 200, { braking: true })[200]!;
    expect(plus.omega + minus.omega).toBe(0);
    expect(plus.theta + minus.theta).toBe(0);
  });

  it('브레이크를 잡으면 훨씬 빨리 멈춘다', () => {
    const framesToStop = (braking: boolean): number => {
      let state = createSpinState(50);
      for (let i = 1; i <= 3000; i += 1) {
        state = advance(state, FRAME_60, braking).state;
        if (state.omega === 0) return i;
      }
      return Number.POSITIVE_INFINITY;
    };
    expect(framesToStop(true)).toBeLessThan(framesToStop(false) / 2);
  });
});

describe('결정론', () => {
  it('같은 dt 시퀀스를 두 번 돌리면 모든 프레임이 비트 단위로 일치한다', () => {
    const makeRun = (): SpinState[] => {
      const rand = lcg(1234567);
      let state = createSpinState(OMEGA_MAX);
      const out: SpinState[] = [];
      for (let i = 0; i < 1500; i += 1) {
        // 프레임 지터 + 가끔 탭 전환급 멈춤 + 브레이크 on/off 를 섞는다
        const jitter = rand() * 0.03;
        const dt = i % 137 === 0 ? 1.0 : jitter;
        state = advance(state, dt, i % 91 < 20).state;
        out.push(state);
      }
      return out;
    };

    const a = makeRun();
    const b = makeRun();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(Object.is(a[i]!.omega, b[i]!.omega), `frame ${i} omega`).toBe(true);
      expect(Object.is(a[i]!.theta, b[i]!.theta), `frame ${i} theta`).toBe(true);
      expect(Object.is(a[i]!.accumulator, b[i]!.accumulator), `frame ${i} accumulator`).toBe(true);
    }
  });

  it('advance 는 입력 상태를 변형하지 않는다 (순수 함수)', () => {
    const start = createSpinState(100);
    const before = { ...start };
    advance(start, FRAME_60, true);
    expect(start).toEqual(before);
  });
});

describe('상태 조작 헬퍼', () => {
  it('applyImpulse 는 각속도만 바꾸고 θ·accumulator 는 건드리지 않는다', () => {
    const state: SpinState = { theta: 12.5, omega: 10, accumulator: 0.001 };
    const next = applyImpulse(state, 5);
    expect(next.omega).toBe(15);
    expect(next.theta).toBe(12.5);
    expect(next.accumulator).toBe(0.001);
  });

  it('applyImpulse 는 유효하지 않은 값을 무시한다', () => {
    const state = createSpinState(10);
    expect(applyImpulse(state, Number.NaN).omega).toBe(10);
    expect(applyImpulse(state, Number.POSITIVE_INFINITY).omega).toBe(10);
  });

  it('applyImpulse 의 상한 인자를 생략하면 예전 동작과 완전히 같다 (회귀)', () => {
    // 3번째 인자가 생기기 전의 결과는 "clampOmega(ω + Δ)" 였다. 그대로여야 한다.
    for (const omega of [0, 3.5, -3.5, 120, -120, OMEGA_MAX, -OMEGA_MAX]) {
      for (const delta of [0, 7, -7, 500, -500]) {
        const state = createSpinState(omega);
        expect(Object.is(applyImpulse(state, delta).omega, clampOmega(omega + delta))).toBe(true);
        expect(applyImpulse(state, delta).omega).toBe(applyImpulse(state, delta, OMEGA_MAX).omega);
      }
    }
  });

  it('상한 인자가 도달 가능한 최고 속도를 정한다 (양·음 대칭)', () => {
    const cap = OMEGA_MAX * 0.25; // 52.5
    expect(applyImpulse(createSpinState(0), 100, cap).omega).toBe(cap);
    expect(applyImpulse(createSpinState(0), -100, cap).omega).toBe(-cap);
  });

  it('상한에 닿은 뒤 같은 방향으로 더 튕겨도 빨라지지 않는다 (연속 플릭 포화)', () => {
    const cap = OMEGA_MAX * 0.25;
    let state = createSpinState(0);
    for (let i = 0; i < 10; i += 1) state = applyImpulse(state, 40, cap);
    expect(state.omega).toBe(cap);

    for (let i = 0; i < 20; i += 1) state = applyImpulse(state, -40, cap);
    expect(state.omega).toBe(-cap);
  });

  it('상한보다 이미 빠르면 플릭이 스피너를 느리게 만들지 않는다', () => {
    // 회전 중에 민감도를 낮춘 상황. 미는 동작이 브레이크가 되면 안 된다.
    const cap = OMEGA_MAX * 0.25;
    const fast = createSpinState(100);
    expect(applyImpulse(fast, 50, cap).omega).toBe(100);
    expect(applyImpulse(fast, 0, cap).omega).toBe(100);
    expect(applyImpulse(createSpinState(-100), -50, cap).omega).toBe(-100);

    // 반대 방향 입력으로 줄이는 것은 여전히 가능하다.
    expect(applyImpulse(fast, -60, cap).omega).toBe(40);
  });

  it('오염된 상한 값은 OMEGA_MAX 로 되돌아간다', () => {
    const state = createSpinState(0);
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(applyImpulse(state, 1e6, bad).omega).toBe(OMEGA_MAX);
      expect(applyImpulse(state, -1e6, bad).omega).toBe(-OMEGA_MAX);
    }
    // OMEGA_MAX 를 넘는 상한도 물리 상한 위로는 못 올라간다.
    expect(applyImpulse(state, 1e6, OMEGA_MAX * 10).omega).toBe(OMEGA_MAX);
  });

  it('상한 집행이 -0 을 흘리지 않는다', () => {
    const cap = OMEGA_MAX * 0.25;
    expect(Object.is(applyImpulse(createSpinState(-5), 5, cap).omega, -0)).toBe(false);
    expect(Object.is(applyImpulse(createSpinState(0), -0, cap).omega, -0)).toBe(false);
    expect(Object.is(applyImpulse(createSpinState(0), -0).omega, -0)).toBe(false);
  });

  it('halt 는 즉시 멈추되 누적 θ 는 보존한다 (기록이 사라지면 안 된다)', () => {
    const state: SpinState = { theta: 987.65, omega: -180, accumulator: 0.002 };
    const stopped = halt(state);
    expect(stopped.omega).toBe(0);
    expect(stopped.theta).toBe(987.65);
    expect(isStopped(stopped)).toBe(true);
  });
});
