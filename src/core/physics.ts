// 각운동 시뮬레이션. 고정 타임스텝 + 결정론적 — 시간은 인자로 주입받는다.
//
// 이 파일의 모든 함수는 순수 함수다. 상태는 읽기 전용 데이터로 주고받고, 부작용은 없다.
// 사용하는 수치 연산은 +, -, *, / 와 Math.abs / Math.sign / Math.min / Math.max 뿐이다.
// 전부 IEEE-754 로 정확히 규정된 연산이므로 플랫폼이 달라도 비트 단위로 같은 결과가 나온다.
// (초월함수를 쓰면 이 보장이 깨진다 — 골든 스냅샷이 CI에서 흔들리게 된다.)

import {
  B_VISCOUS,
  C_DRAG,
  FIXED_DT,
  MAX_SUBSTEPS,
  OMEGA_MAX,
  OMEGA_STOP,
  TAU_BRAKE,
  TAU_COULOMB,
} from './constants';

/**
 * 스피너의 전체 시뮬레이션 상태.
 *
 * `theta` 는 **누적값**이다. 2π 로 wrap 하지 않는다 — 총 회전수 집계(Phase 4)와
 * 디텐트 경계 통과 판정(Phase 3)이 모두 누적각을 근거로 삼기 때문이다.
 * 화면에 그릴 때만 렌더러가 wrap 한다.
 */
export interface SpinState {
  /** 누적 회전각 [rad]. 부호는 회전 방향을 따른다. */
  readonly theta: number;
  /** 각속도 [rad/s]. 부호 = 회전 방향. */
  readonly omega: number;
  /** 아직 고정 스텝으로 소화되지 않은 잔여 프레임 시간 [s]. 항상 0 ≤ acc < FIXED_DT. */
  readonly accumulator: number;
}

/** `advance` 한 번의 결과. 여분 정보는 디버그 오버레이(CLAUDE.md 7장)가 쓴다. */
export interface AdvanceResult {
  readonly state: SpinState;
  /** 이번 호출에서 실제로 실행된 고정 스텝 수. 0 ≤ n ≤ MAX_SUBSTEPS. */
  readonly substeps: number;
  /** MAX_SUBSTEPS 제한 때문에 폐기한 시뮬레이션 시간 [s]. 0 이면 정상 프레임. */
  readonly droppedSec: number;
}

/** |ω| 를 OMEGA_MAX 로 자른다. 양·음 대칭. */
export function clampOmega(omega: number): number {
  if (omega > OMEGA_MAX) return OMEGA_MAX;
  if (omega < -OMEGA_MAX) return -OMEGA_MAX;
  return omega;
}

/**
 * 초기 상태를 만든다. omega 는 OMEGA_MAX 로 클램프된다.
 * 정지 스냅(OMEGA_STOP)은 여기서 걸지 않는다 — 첫 스텝이 처리한다.
 */
export function createSpinState(omega = 0, theta = 0): SpinState {
  return { theta, omega: clampOmega(omega), accumulator: 0 };
}

/**
 * 각가속도 [rad/s²]. CLAUDE.md 4장의 식 그대로.
 *
 * 모든 항이 `sign(ω)` 또는 ω 에 비례하므로, ω = 0 이면 가속도도 0 이다.
 * 즉 멈춘 스피너는 브레이크를 잡고 있어도 저절로 움직이지 않는다.
 */
export function angularAcceleration(omega: number, isBraking: boolean): number {
  // 명시적으로 리터럴 0 을 돌려준다. 식을 그대로 태우면 -0 이 나오는데,
  // 산술 결과는 같아도 로그·스냅샷·Object.is 비교에서 계속 걸리적거린다.
  if (omega === 0) return 0;

  const s = Math.sign(omega);
  const brake = isBraking ? TAU_BRAKE : 0;
  return -s * TAU_COULOMB - B_VISCOUS * omega - C_DRAG * omega * Math.abs(omega) - brake * s;
}

/**
 * 고정 타임스텝 1회. semi-implicit Euler — ω 를 먼저 갱신하고 그 ω 로 θ 를 전진시킨다.
 * (explicit Euler 보다 감쇠계에서 안정적이고, 0 으로 스냅된 스텝에서 θ 가 더 밀리지 않는다.)
 *
 * 마찰은 "감속만" 시킬 수 있다. 그래서 두 겹의 가드를 둔다.
 *  1) 부호 역전 금지: 한 스텝의 감속량이 ω 보다 크면 0 에서 멈춘다. 마찰이 스피너를
 *     반대로 돌리는 일은 물리적으로 없다. (dt 가 커져도 진동하지 않는 근거)
 *  2) 정지 스냅: |ω| < OMEGA_STOP 이면 정확히 0. 부호 있는 0(-0)이 새어나가지 않도록
 *     리터럴 0 을 대입한다.
 */
function integrateOnce(theta: number, omega: number, isBraking: boolean): [number, number] {
  let next = omega + angularAcceleration(omega, isBraking) * FIXED_DT;

  if (next * omega < 0) next = 0; // (1) 마찰에 의한 부호 역전 차단
  if (Math.abs(next) < OMEGA_STOP) next = 0; // (2) 정지 스냅
  next = clampOmega(next);

  return [theta + next * FIXED_DT, next];
}

/**
 * 프레임 시간 `frameDt` [s] 를 받아 고정 스텝으로 소화한다 (accumulator 패턴).
 *
 * **death spiral 방지**: 한 프레임에 최대 MAX_SUBSTEPS 만 돈다. 탭 전환 후 복귀처럼
 * frameDt 가 1초로 튀면 5스텝(≈20.8ms)만 시뮬레이션하고 **소화하지 못한 나머지 시간은
 * 폐기한다**. 남겨두면 다음 프레임에도 밀린 시간이 그대로 넘어가 계속 상한에 걸리고,
 * 프레임 비용이 회복되지 않아 영영 따라잡지 못한다 — 이것이 death spiral 이다.
 * 폐기의 대가는 "긴 멈춤 뒤에는 스피너가 그만큼 덜 감속해 있다"는 것이고, 이는 감속이
 * 폭주하거나 시뮬레이션이 멈추는 것보다 낫다. 폐기량은 `droppedSec` 로 보고한다.
 *
 * 폐기할 때 **온전한 스텝 단위로만 버리고 FIXED_DT 미만의 잔여는 그대로 이월한다.**
 * 잔여는 아직 할 일이 아니라 위상(phase)일 뿐이라 버려도 부하가 줄지 않는다.
 * 통째로 0 으로 만들면 상한에 걸리는 프레임마다 최대 FIXED_DT 씩 시간을 더 잃는데,
 * 45fps 처럼 상한에 계속 걸리는 기기에서는 이 손실이 누적돼 감속이 실제보다 느려지고
 * 기록이 부풀려진다. 이월해도 accumulator 는 항상 FIXED_DT 미만이라 폭주하지 않는다.
 *
 * frameDt 가 음수·NaN·Infinity 면 0 으로 취급한다 (타이머 이상값 방어).
 */
export function advance(state: SpinState, frameDt: number, isBraking: boolean): AdvanceResult {
  const dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;

  let theta = state.theta;
  let omega = state.omega;
  let accumulator = state.accumulator + dt;
  let substeps = 0;

  while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
    [theta, omega] = integrateOnce(theta, omega, isBraking);
    accumulator -= FIXED_DT;
    substeps += 1;
  }

  let droppedSec = 0;
  if (accumulator >= FIXED_DT) {
    // fmod 는 IEEE-754 에서 정확히 규정된 연산이다 — 결정론이 깨지지 않는다.
    const carry = accumulator % FIXED_DT;
    droppedSec = accumulator - carry;
    accumulator = carry;
  }

  return { state: { theta, omega, accumulator }, substeps, droppedSec };
}

/**
 * 플릭 등으로 각속도를 더한다. 결과는 OMEGA_MAX 로 클램프된다.
 * accumulator 는 건드리지 않는다 — 입력은 시간 진행과 무관하다.
 */
export function applyImpulse(state: SpinState, deltaOmega: number): SpinState {
  const delta = Number.isFinite(deltaOmega) ? deltaOmega : 0;
  return { ...state, omega: clampOmega(state.omega + delta) };
}

/** 더블탭 즉시 정지. θ 는 유지한다 (누적 회전수는 기록으로 남아야 한다). */
export function halt(state: SpinState): SpinState {
  return { ...state, omega: 0 };
}

/** 스피너가 멈춰 있는가. 정지 스냅 뒤에는 ω 가 정확히 0 이므로 비교로 충분하다. */
export function isStopped(state: SpinState): boolean {
  return state.omega === 0;
}
