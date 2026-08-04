// L2 — 햅틱 스케줄러. 순수 함수이므로 목킹 없이 시각을 주입해 프레임 루프를 재현한다.
//
// 여기서 검증하는 것은 "언제 몇 ms 짜리 펄스가 나가는가"의 시퀀스다. 실제 진동 호출은
// vibration-driver.test.ts 가 가짜 host 로, 브라우저에서의 실제 호출 간격은 e2e 가 검증한다.
//
// 펄스 시각은 그것이 발사되는 프레임의 시각이다. 따라서 간격은 프레임 주기 단위로 양자화된다
// (60fps 면 16.7ms 격자). 아래 테스트들은 그 양자화를 인정한 위에서 성질을 검증한다.

import { describe, expect, it } from 'vitest';

import {
  BRAKE_PULSE_SCALE,
  DETENT_ANGLE,
  DETENT_COUNT,
  FINAL_PULSE_MS,
  FIXED_DT,
  MIN_PULSE_GAP_MS,
  OMEGA_MAX,
  PULSE_MS_FAST,
  PULSE_MS_SLOW,
} from '../../src/core/constants';
import {
  createHapticState,
  pulseDurationMs,
  scheduleHaptics,
  type HapticPulse,
  type HapticState,
} from '../../src/core/haptic-scheduler';
import { advance, createSpinState, type SpinState } from '../../src/core/physics';

/** 프레임당 고정 스텝 수. 60fps(16.7ms)는 240Hz 기준 4스텝에 해당한다. */
const STEPS_PER_FRAME_60 = 4;
const FRAME_MS_60 = STEPS_PER_FRAME_60 * FIXED_DT * 1000;

interface Run {
  readonly pulses: readonly HapticPulse[];
  readonly state: HapticState;
  /** 마지막 누적 회전각 [rad]. 실제로 넘은 경계 수를 세는 데 쓴다. */
  readonly theta: number;
}

/**
 * ω 를 고정한 이상적인 회전을 프레임 단위로 돌린다 (물리 감속 없음).
 * `stepsPerFrame` 으로 프레임 주기를 바꿀 수 있다 (4 = 60fps, 1 = 240fps).
 */
function runConstantOmega(
  omega: number,
  frames: number,
  options: { isBraking?: boolean; stepsPerFrame?: number } = {},
): Run {
  const isBraking = options.isBraking ?? false;
  const steps = options.stepsPerFrame ?? STEPS_PER_FRAME_60;
  const frameMs = steps * FIXED_DT * 1000;

  let state = createHapticState();
  const pulses: HapticPulse[] = [];
  let theta = 0;
  let nowMs = 0;

  for (let i = 0; i < frames; i += 1) {
    const prevTheta = theta;
    theta += omega * (steps * FIXED_DT);
    nowMs += frameMs;

    const result = scheduleHaptics(state, {
      prevTheta,
      theta,
      omega,
      isBraking,
      nowMs,
    });
    state = result.state;
    pulses.push(...result.pulses);
  }

  return { pulses, state, theta };
}

/** 실제 물리로 감속시키며 정지까지 돌린다. 프레임은 60fps 고정. */
function runSpinDown(initialOmega: number, maxFrames = 20_000, isBraking = false): Run {
  let spin: SpinState = createSpinState(initialOmega);
  let haptic = createHapticState();
  const pulses: HapticPulse[] = [];
  let nowMs = 0;

  for (let i = 0; i < maxFrames; i += 1) {
    nowMs += FRAME_MS_60;
    const prevTheta = spin.theta;
    const stepped = advance(spin, FRAME_MS_60 / 1000, isBraking);
    spin = stepped.state;

    const result = scheduleHaptics(haptic, {
      prevTheta,
      theta: spin.theta,
      omega: spin.omega,
      isBraking,
      nowMs,
    });
    haptic = result.state;
    pulses.push(...result.pulses);

    // 정지하고 마무리 펄스까지 나간 뒤 여유 프레임을 더 돌아 "그 뒤로 없음"을 확인한다.
    if (spin.omega === 0 && !haptic.finalPending && i > 2) {
      for (let extra = 0; extra < 120; extra += 1) {
        nowMs += FRAME_MS_60;
        const tail = scheduleHaptics(haptic, {
          prevTheta: spin.theta,
          theta: spin.theta,
          omega: spin.omega,
          isBraking,
          nowMs,
        });
        haptic = tail.state;
        pulses.push(...tail.pulses);
      }
      break;
    }
  }

  return { pulses, state: haptic, theta: spin.theta };
}

function gaps(pulses: readonly HapticPulse[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pulses.length; i += 1) {
    out.push((pulses[i]?.atMs ?? 0) - (pulses[i - 1]?.atMs ?? 0));
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe('펄스 길이', () => {
  it('고속일수록 짧고 저속일수록 길다 (양 끝은 상수로 클램프된다)', () => {
    expect(pulseDurationMs(OMEGA_MAX, false)).toBe(PULSE_MS_FAST);
    expect(pulseDurationMs(1, false)).toBe(PULSE_MS_SLOW);
    expect(pulseDurationMs(0, false)).toBe(PULSE_MS_SLOW);

    // 듀티 보간 구간에서는 ω 가 커질수록 단조 감소한다.
    let previous = Number.POSITIVE_INFINITY;
    for (let omega = 30; omega <= 100; omega += 5) {
      const ms = pulseDurationMs(omega, false);
      expect(ms).toBeLessThanOrEqual(previous);
      expect(ms).toBeGreaterThanOrEqual(PULSE_MS_FAST);
      expect(ms).toBeLessThanOrEqual(PULSE_MS_SLOW);
      previous = ms;
    }
  });

  it('부호(회전 방향)는 길이에 영향을 주지 않는다', () => {
    expect(pulseDurationMs(-50, false)).toBe(pulseDurationMs(50, false));
  });

  it('브레이크 중에는 BRAKE_PULSE_SCALE 만큼 길어진다', () => {
    expect(pulseDurationMs(OMEGA_MAX, true)).toBe(Math.round(PULSE_MS_FAST * BRAKE_PULSE_SCALE));
    expect(pulseDurationMs(1, true)).toBe(Math.round(PULSE_MS_SLOW * BRAKE_PULSE_SCALE));
  });
});

describe('디텐트 간격', () => {
  /** 이상적인 펄스 간격 [ms] = 2π / (DETENT_COUNT · ω). */
  function idealGapMs(omega: number): number {
    return ((Math.PI * 2) / (DETENT_COUNT * Math.abs(omega))) * 1000;
  }

  it('① 일정한 ω 에서 펄스 간격이 2π/(DETENT_COUNT·ω) 에 수렴한다', () => {
    // 가드에 걸리지 않는 속도(간격 105ms)를 쓴다. 가드가 개입하면 간격은 당연히 달라진다.
    const omega = 20;
    const expected = idealGapMs(omega);
    expect(expected).toBeGreaterThan(MIN_PULSE_GAP_MS);

    const { pulses, state } = runConstantOmega(omega, 600);
    expect(pulses.length).toBeGreaterThan(50);
    expect(state.droppedPulses).toBe(0);

    const sequence = gaps(pulses);
    // 평균은 이상적인 간격에 수렴한다 (양자화 오차는 누적되지 않고 상쇄된다).
    expect(mean(sequence)).toBeCloseTo(expected, 0);
    // 개별 간격도 프레임 주기 격자 위에서 이상값을 벗어나지 않는다.
    for (const gap of sequence) {
      expect(Math.abs(gap - expected)).toBeLessThan(FRAME_MS_60);
    }
  });

  it('프레임이 촘촘할수록 개별 간격이 이상값에 더 가까워진다 (양자화가 유일한 오차원)', () => {
    const omega = 20;
    const expected = idealGapMs(omega);
    const fineFrameMs = FIXED_DT * 1000; // 240fps
    const { pulses } = runConstantOmega(omega, 2400, { stepsPerFrame: 1 });

    for (const gap of gaps(pulses)) {
      expect(Math.abs(gap - expected)).toBeLessThan(fineFrameMs);
    }
  });

  it('역회전에서도 같은 간격으로 펄스가 나온다', () => {
    const omega = -20;
    const expected = idealGapMs(omega);
    const { pulses, state } = runConstantOmega(omega, 300);

    expect(pulses.length).toBeGreaterThan(20);
    expect(state.droppedPulses).toBe(0);
    expect(mean(gaps(pulses))).toBeCloseTo(expected, 0);
  });

  it('θ 가 움직이지 않으면 펄스가 없다', () => {
    expect(runConstantOmega(0, 100).pulses).toHaveLength(0);
  });
});

describe('MIN_PULSE_GAP_MS 가드', () => {
  it('② 고속 회전에서 25ms 보다 촘촘한 간격이 단 하나도 없다', () => {
    for (const omega of [OMEGA_MAX, 150, 120, 90, 84, 60, 30]) {
      for (const stepsPerFrame of [1, 4, 5]) {
        const { pulses } = runConstantOmega(omega, 400, { stepsPerFrame });
        expect(pulses.length).toBeGreaterThan(5);
        for (const gap of gaps(pulses)) {
          expect(gap).toBeGreaterThanOrEqual(MIN_PULSE_GAP_MS);
        }
      }
    }
  });

  it('감속 곡선 전체(OMEGA_MAX → 정지)에서도 25ms 미만 간격이 없다', () => {
    const { pulses } = runSpinDown(OMEGA_MAX);
    expect(pulses.length).toBeGreaterThan(100);
    for (const gap of gaps(pulses)) expect(gap).toBeGreaterThanOrEqual(MIN_PULSE_GAP_MS);
  });

  it('한 프레임에 발사되는 펄스는 최대 1개다 (같은 시각의 두 번째 통과는 반드시 걸린다)', () => {
    let state = createHapticState();
    let theta = 0;
    let nowMs = 0;

    // 5스텝(20.83ms, MAX_SUBSTEPS 상한)에 OMEGA_MAX 로 도는 최악의 프레임 — 경계를 여러 번 넘는다.
    for (let i = 0; i < 300; i += 1) {
      const prevTheta = theta;
      theta += OMEGA_MAX * (5 * FIXED_DT);
      nowMs += 5 * FIXED_DT * 1000;
      const result = scheduleHaptics(state, {
        prevTheta,
        theta,
        omega: OMEGA_MAX,
        isBraking: false,
        nowMs,
      });
      state = result.state;
      expect(result.pulses.length).toBeLessThanOrEqual(1);
    }
    expect(state.droppedPulses).toBeGreaterThan(0);
  });

  it('③ 드랍 카운터가 실제로 버려진 수와 일치한다', () => {
    const { pulses, state, theta } = runConstantOmega(OMEGA_MAX, 400);

    // 이 구간에서 실제로 넘은 경계 수 = θ_final / DETENT_ANGLE (θ 는 0 에서 시작한다).
    const crossings = Math.floor(theta / DETENT_ANGLE);

    expect(state.totalPulses).toBe(pulses.length);
    expect(state.totalPulses + state.droppedPulses).toBe(crossings);
    expect(state.droppedPulses).toBeGreaterThan(0);
  });

  it('가드에 걸린 프레임은 상태를 오염시키지 않는다 (마지막 발사 시각이 밀리지 않음)', () => {
    const first = scheduleHaptics(createHapticState(), {
      prevTheta: 0,
      theta: DETENT_ANGLE * 1.01,
      omega: 50,
      isBraking: false,
      nowMs: 1000,
    });
    expect(first.pulses).toHaveLength(1);
    expect(first.state.lastPulseAtMs).toBe(1000);

    // 5ms 뒤에 또 경계를 넘는다 → 버려진다.
    const second = scheduleHaptics(first.state, {
      prevTheta: DETENT_ANGLE * 1.01,
      theta: DETENT_ANGLE * 2.01,
      omega: 50,
      isBraking: false,
      nowMs: 1005,
    });
    expect(second.pulses).toHaveLength(0);
    expect(second.state.droppedPulses).toBe(1);
    expect(second.state.lastPulseAtMs).toBe(1000);

    // 가드가 풀리는 시점에는 정상적으로 나간다.
    const third = scheduleHaptics(second.state, {
      prevTheta: DETENT_ANGLE * 2.01,
      theta: DETENT_ANGLE * 3.01,
      omega: 50,
      isBraking: false,
      nowMs: 1000 + MIN_PULSE_GAP_MS,
    });
    expect(third.pulses).toHaveLength(1);
  });
});

describe('감속', () => {
  it('④ 감속 구간에서 펄스 간격이 단조 증가한다 (프레임 양자화 오차 범위 안에서)', () => {
    // 가드가 개입하지 않는 속도에서 시작한다 (ω < 84 rad/s 면 간격이 25ms 를 넘는다).
    const { pulses, state } = runSpinDown(60);
    expect(state.droppedPulses).toBe(0);

    // 마지막 펄스는 마무리 펄스이므로 간격 비교에서 제외한다.
    const sequence = gaps(pulses.slice(0, -1));
    expect(sequence.length).toBeGreaterThan(20);

    // 프레임 격자에 스냅되면서 인접 간격이 한 번씩 되돌아갈 수 있다. 그 되돌아감의 크기는
    // 프레임 주기의 2배를 넘을 수 없다 — 그 이상은 감속이 아니라 버그다.
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i] ?? 0).toBeGreaterThan((sequence[i - 1] ?? 0) - 2 * FRAME_MS_60);
    }

    // 추세는 예외 없이 증가한다: 연속한 8개 구간의 평균이 계속 커진다.
    const windowSize = 8;
    let previous = 0;
    for (let start = 0; start + windowSize <= sequence.length; start += windowSize) {
      const current = mean(sequence.slice(start, start + windowSize));
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }

    // 감속 구간의 시작과 끝은 확연히 다르다.
    expect(sequence[sequence.length - 1] ?? 0).toBeGreaterThan((sequence[0] ?? 0) * 5);
  });

  it('브레이크 중 펄스는 같은 ω 의 일반 펄스보다 길다', () => {
    const braked = runConstantOmega(40, 60, { isBraking: true }).pulses;
    const plain = runConstantOmega(40, 60).pulses;

    expect(braked.length).toBeGreaterThan(0);
    expect(braked).toHaveLength(plain.length); // 길이만 달라지고 시점은 같다
    expect(braked[0]?.atMs).toBe(plain[0]?.atMs);
    expect(braked[0]?.durationMs).toBe(pulseDurationMs(40, true));
    expect(braked[0]?.durationMs).toBeGreaterThan(plain[0]?.durationMs ?? 0);
  });
});

describe('정지', () => {
  it('⑤ 정지 시 마무리 펄스가 정확히 1회 나가고 그 뒤로는 없다', () => {
    const { pulses, state } = runSpinDown(60);

    const finals = pulses.filter((pulse) => pulse.durationMs === FINAL_PULSE_MS);
    expect(finals).toHaveLength(1);
    expect(pulses[pulses.length - 1]).toBe(finals[0]); // 마지막 펄스가 곧 마무리 펄스다
    expect(state.finalPending).toBe(false);
    expect(state.spinning).toBe(false);
  });

  it('마무리 펄스도 가드를 지킨다 — 버리지 않고 미뤘다가 쏜다', () => {
    // 직전에 펄스를 쏜 직후 곧바로 멈춘 상황.
    const first = scheduleHaptics(createHapticState(), {
      prevTheta: 0,
      theta: DETENT_ANGLE * 1.01,
      omega: 5,
      isBraking: false,
      nowMs: 1000,
    });
    expect(first.pulses).toHaveLength(1);

    const stopped = scheduleHaptics(first.state, {
      prevTheta: DETENT_ANGLE * 1.01,
      theta: DETENT_ANGLE * 1.01,
      omega: 0,
      isBraking: false,
      nowMs: 1005,
    });
    expect(stopped.pulses).toHaveLength(0);
    expect(stopped.state.finalPending).toBe(true);
    expect(stopped.state.droppedPulses).toBe(0); // 드랍이 아니라 보류다

    const later = scheduleHaptics(stopped.state, {
      prevTheta: DETENT_ANGLE * 1.01,
      theta: DETENT_ANGLE * 1.01,
      omega: 0,
      isBraking: false,
      nowMs: 1000 + MIN_PULSE_GAP_MS,
    });
    expect(later.pulses).toHaveLength(1);
    expect(later.pulses[0]?.durationMs).toBe(FINAL_PULSE_MS);
    expect(later.state.finalPending).toBe(false);
  });

  it('처음부터 멈춰 있으면 마무리 펄스가 나가지 않는다', () => {
    let state = createHapticState();
    for (let i = 0; i < 60; i += 1) {
      const result = scheduleHaptics(state, {
        prevTheta: 0,
        theta: 0,
        omega: 0,
        isBraking: false,
        nowMs: i * FRAME_MS_60,
      });
      state = result.state;
      expect(result.pulses).toHaveLength(0);
    }
    expect(state.totalPulses).toBe(0);
  });

  it('다시 회전하면 펄스가 재개되고, 다음 정지에서 마무리 펄스가 또 1회 나간다', () => {
    let spin = createSpinState(20);
    let haptic = createHapticState();
    let nowMs = 0;
    const collected: HapticPulse[] = [];

    function pump(frames: number): void {
      for (let i = 0; i < frames; i += 1) {
        nowMs += FRAME_MS_60;
        const prevTheta = spin.theta;
        const stepped = advance(spin, FRAME_MS_60 / 1000, false);
        spin = stepped.state;
        const result = scheduleHaptics(haptic, {
          prevTheta,
          theta: spin.theta,
          omega: spin.omega,
          isBraking: false,
          nowMs,
        });
        haptic = result.state;
        collected.push(...result.pulses);
      }
    }

    pump(4000);
    expect(spin.omega).toBe(0);
    expect(collected.filter((pulse) => pulse.durationMs === FINAL_PULSE_MS)).toHaveLength(1);
    const afterFirstStop = collected.length;

    // 다시 튕긴다.
    spin = { ...spin, omega: 20 };
    pump(4000);
    expect(spin.omega).toBe(0);
    expect(collected.length).toBeGreaterThan(afterFirstStop + 10);
    expect(collected.filter((pulse) => pulse.durationMs === FINAL_PULSE_MS)).toHaveLength(2);
  });

  it('더블탭(즉시 정지)에서도 마무리 펄스가 나간다', () => {
    const spinning = scheduleHaptics(createHapticState(), {
      prevTheta: 0,
      theta: 0.1,
      omega: 50,
      isBraking: false,
      nowMs: 0,
    });
    const halted = scheduleHaptics(spinning.state, {
      prevTheta: 0.1,
      theta: 0.1,
      omega: 0, // halt()
      isBraking: false,
      nowMs: 100,
    });
    expect(halted.pulses).toHaveLength(1);
    expect(halted.pulses[0]?.durationMs).toBe(FINAL_PULSE_MS);
  });
});

describe('이상값 방어', () => {
  it('NaN / Infinity 입력은 상태를 바꾸지 않고 그대로 흘린다', () => {
    const base = createHapticState();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        scheduleHaptics(base, {
          prevTheta: bad,
          theta: 1,
          omega: 10,
          isBraking: false,
          nowMs: 0,
        }).pulses,
      ).toHaveLength(0);

      expect(
        scheduleHaptics(base, {
          prevTheta: 0,
          theta: 1,
          omega: 10,
          isBraking: false,
          nowMs: bad,
        }).state,
      ).toBe(base);
    }
  });

  it('θ 가 비정상적으로 점프해도 루프가 폭주하지 않고 전부 집계된다', () => {
    const result = scheduleHaptics(createHapticState(), {
      prevTheta: 0,
      theta: DETENT_ANGLE * 10_000,
      omega: 50,
      isBraking: false,
      nowMs: 0,
    });
    expect(result.pulses).toHaveLength(1);
    expect(result.state.totalPulses + result.state.droppedPulses).toBe(10_000);
  });
});
