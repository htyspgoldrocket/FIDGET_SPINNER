// 디텐트 경계 통과 시점만 계산한다. 실제 진동 호출은 하지 않는다.
//
// 순수 모듈이다 — 시간은 인자로 주입받고 브라우저 API 를 전혀 참조하지 않는다 (CLAUDE.md 규칙 1).
// 여기서 나온 펄스 목록을 platform/vibration-driver 가 받아서 실제로 발사한다.
//
// 설계: 연속 진동이 아니라 회전 디텐트 클릭이다.
//   θ 가 DETENT_ANGLE 배수를 넘을 때마다 펄스 1회
//   → ω 가 크면 촘촘하게(다다다다닥), 감속하면 벌어지게(딱... 딱... 딱)
//   → ω 가 OMEGA_STOP 밑으로 내려가면 마무리 펄스 1회로 닫는다

import {
  BRAKE_PULSE_SCALE,
  DETENT_ANGLE,
  FINAL_PULSE_MS,
  MIN_PULSE_GAP_MS,
  OMEGA_STOP,
  PULSE_DETENT_DUTY,
  PULSE_MS_FAST,
  PULSE_MS_SLOW,
} from './constants';

/** 발사할 펄스 하나. */
export interface HapticPulse {
  /** 발사 시각 [ms] = 이 펄스를 넘겨받은 프레임의 시각. 실제 vibrate 호출이 일어나는 시점이다. */
  readonly atMs: number;
  /** 진동 지속 시간 [ms]. 정수. */
  readonly durationMs: number;
}

/** 스케줄러가 프레임 사이에 들고 가는 상태. 불변 객체로 주고받는다. */
export interface HapticState {
  /** 마지막으로 **발사한** 펄스의 시각 [ms]. 아직 없으면 -Infinity. */
  readonly lastPulseAtMs: number;
  /** 지금까지 발사한 펄스 수 (마무리 펄스 포함). */
  readonly totalPulses: number;
  /** MIN_PULSE_GAP_MS 가드에 걸려 버린 펄스 수. */
  readonly droppedPulses: number;
  /** 직전 프레임에서 회전 중이었는가 (|ω| ≥ OMEGA_STOP). 정지 전이 감지에 쓴다. */
  readonly spinning: boolean;
  /** 마무리 펄스를 발사해야 하는데 아직 가드 때문에 못 쏜 상태인가. */
  readonly finalPending: boolean;
}

/** 한 프레임의 입력. main 의 게임 루프가 advance() 결과에서 그대로 채워준다. */
export interface HapticFrame {
  /** advance() 이전의 누적 회전각 [rad]. */
  readonly prevTheta: number;
  /** advance() 이후의 누적 회전각 [rad]. */
  readonly theta: number;
  /** advance() 이후의 각속도 [rad/s]. 펄스 길이와 정지 판정에 쓴다. */
  readonly omega: number;
  /** 이 프레임에 브레이크가 걸려 있었는가. */
  readonly isBraking: boolean;
  /** 현재 시각 [ms]. rAF 타임스탬프 — 이 프레임의 펄스가 실제로 발사되는 시점이다. */
  readonly nowMs: number;
}

export interface HapticFrameResult {
  readonly state: HapticState;
  /** 이번 프레임에 발사할 펄스. 시각 오름차순. 비어 있는 경우가 대부분이다. */
  readonly pulses: readonly HapticPulse[];
}

/** 펄스가 없는 프레임의 반환값. 매 프레임 빈 배열을 새로 만들지 않는다 (GC 압력). */
const NO_PULSES: readonly HapticPulse[] = Object.freeze([]);

/**
 * 한 프레임에서 처리할 경계 통과 수의 상한 (방어용).
 *
 * 정상 경로에서는 절대 걸리지 않는다: 한 프레임의 시뮬레이션 시간은 MAX_SUBSTEPS 때문에
 * 20.83ms 이내이고, ω 는 OMEGA_MAX(210) 이하이므로 통과 수는 최대 3 이다.
 * θ 가 비정상적으로 점프해도 루프가 폭주하지 않게 막아둔다.
 */
const MAX_CROSSINGS_PER_FRAME = 64;

export function createHapticState(): HapticState {
  return {
    lastPulseAtMs: Number.NEGATIVE_INFINITY,
    totalPulses: 0,
    droppedPulses: 0,
    spinning: false,
    finalPending: false,
  };
}

/**
 * ω 에 맞는 펄스 길이 [ms]. **보간은 "디텐트 간격의 듀티"로 한다.**
 *
 *   간격 t = DETENT_ANGLE / |ω|  →  길이 = t × PULSE_DETENT_DUTY, [FAST, SLOW] 로 클램프
 *
 * 즉 ω 에 대해 선형이 아니라 **1/ω 에 선형**이다. 사람이 느끼는 것은 ω 자체가 아니라
 * 펄스 사이의 시간 간격이고, 펄스가 그 간격의 일정 비율을 넘으면 클릭이 아니라
 * 지속 진동으로 뭉개지기 때문이다. 상수 하나(듀티)로 두 끝점이 자연스럽게 결정된다.
 *
 * 브레이크 중에는 클램프 뒤에 BRAKE_PULSE_SCALE 을 곱한다. 클램프 범위를 일부러 벗어나게 해서
 * (12~27ms) 평소와 다른 "긁히는" 감각을 만든다.
 */
export function pulseDurationMs(omega: number, isBraking: boolean): number {
  const speed = Math.abs(omega);
  // ω = 0 이면 간격이 무한대 → 가장 느린 쪽으로 떨어진다.
  const detentMs = speed > 0 ? (DETENT_ANGLE / speed) * 1000 : Number.POSITIVE_INFINITY;

  let ms = detentMs * PULSE_DETENT_DUTY;
  if (ms < PULSE_MS_FAST) ms = PULSE_MS_FAST;
  if (ms > PULSE_MS_SLOW) ms = PULSE_MS_SLOW;
  if (isBraking) ms *= BRAKE_PULSE_SCALE;

  return Math.round(ms);
}

/**
 * 한 프레임의 펄스를 계산한다.
 *
 * **가드는 "실제 호출 시각" 위에서 건다.** 경계를 넘은 정확한 시각을 프레임 안에서 보간할 수도
 * 있지만, 그렇게 하면 이상적인 타임라인에서만 25ms 가 지켜지고 **실제 vibrate 호출**은 프레임
 * 경계로 몰려 16.7ms 간격으로 나갈 수 있다. 진동 큐가 밀리는 것은 이상적 시각이 아니라 실제
 * 호출이므로, 펄스의 시각은 그것이 발사되는 프레임의 시각(`nowMs`)으로 잡는다.
 * 그 대가로 펄스 간격이 프레임 주기 단위로 양자화되지만(60fps 면 16.7ms 격자), 이는 rAF 로
 * 진동을 내는 이상 피할 수 없는 실제 동작이고 평균은 이상적인 간격에 수렴한다.
 *
 * **MIN_PULSE_GAP_MS 가드**: 직전에 발사한 펄스로부터 이 간격이 확보되지 않은 펄스는
 * 발사하지 않고 버린다 (`droppedPulses` 증가). 한 프레임에 경계를 여러 번 넘어도
 * 각각에 대해 개별로 판정한다 — 프레임 단위가 아니라 펄스 단위의 가드다.
 * 같은 프레임의 통과들은 시각이 같으므로 첫 하나만 발사되고 나머지는 버려진다. 따라서
 * 드라이버가 한 프레임에 vibrate 를 두 번 불러 앞 펄스를 덮어쓰는 일이 구조적으로 없다.
 *
 * **정지**: |ω| 가 OMEGA_STOP 밑으로 떨어진 프레임에 FINAL_PULSE_MS 펄스 1회.
 * 이 마무리 펄스도 가드를 지키되, **버리지 않고 미룬다** — 가드가 풀리는 다음 프레임에 쏜다.
 * 회전이 다시 시작되기 전까지는 그 뒤로 아무것도 발사하지 않는다.
 */
export function scheduleHaptics(state: HapticState, frame: HapticFrame): HapticFrameResult {
  const { prevTheta, theta, omega, isBraking, nowMs } = frame;

  // 타이머·물리 이상값 방어. 판단할 수 없는 프레임은 아무 일도 하지 않고 넘긴다.
  if (
    !Number.isFinite(prevTheta) ||
    !Number.isFinite(theta) ||
    !Number.isFinite(omega) ||
    !Number.isFinite(nowMs)
  ) {
    return { state, pulses: NO_PULSES };
  }

  let lastPulseAtMs = state.lastPulseAtMs;
  let totalPulses = state.totalPulses;
  let droppedPulses = state.droppedPulses;
  let spinning = state.spinning;
  let finalPending = state.finalPending;

  let pulses: HapticPulse[] | null = null;

  function fire(atMs: number, durationMs: number): void {
    (pulses ??= []).push({ atMs, durationMs });
    lastPulseAtMs = atMs;
    totalPulses += 1;
  }

  // ── 1. 디텐트 경계 통과 ────────────────────────────────────────
  const delta = theta - prevTheta;
  if (delta !== 0) {
    const prevIndex = Math.floor(prevTheta / DETENT_ANGLE);
    const nextIndex = Math.floor(theta / DETENT_ANGLE);
    const crossings = Math.abs(nextIndex - prevIndex);

    // 정상 경로에서 상한을 넘을 일은 없다. 넘은 만큼은 계산하지 않고 버린 것으로만 센다.
    const excess = crossings > MAX_CROSSINGS_PER_FRAME ? crossings - MAX_CROSSINGS_PER_FRAME : 0;
    droppedPulses += excess;

    for (let i = excess; i < crossings; i += 1) {
      if (nowMs - lastPulseAtMs >= MIN_PULSE_GAP_MS) {
        fire(nowMs, pulseDurationMs(omega, isBraking));
      } else {
        droppedPulses += 1;
      }
    }
  }

  // ── 2. 정지 전이 감지 ──────────────────────────────────────────
  // physics 가 |ω| < OMEGA_STOP 을 정확히 0 으로 스냅하므로 보통 omega === 0 이지만,
  // 스냅 전 값이 들어와도 같은 판정이 되도록 문턱으로 비교한다.
  if (Math.abs(omega) >= OMEGA_STOP) {
    spinning = true;
  } else if (spinning) {
    spinning = false;
    finalPending = true;
  }

  // ── 3. 마무리 펄스 ────────────────────────────────────────────
  if (finalPending && nowMs - lastPulseAtMs >= MIN_PULSE_GAP_MS) {
    finalPending = false;
    fire(nowMs, FINAL_PULSE_MS);
  }

  return {
    state: { lastPulseAtMs, totalPulses, droppedPulses, spinning, finalPending },
    pulses: pulses ?? NO_PULSES,
  };
}
