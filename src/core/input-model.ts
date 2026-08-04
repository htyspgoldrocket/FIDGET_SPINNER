// 포인터 샘플 시퀀스 → 접선 속도 → 각속도 변화량 변환.
//
// 순수 함수만 있다. 시간은 샘플에 실려 들어온다 — 여기서 시계를 읽지 않는다.
// "지금"의 기준도 마지막 샘플의 타임스탬프다 (주입된 값). 그래야 같은 입력이 항상 같은 Δω 가 된다.

import {
  FLICK_MAX_SAMPLES,
  FLICK_MIN_LEVER_ARM_FRAC,
  FLICK_SAMPLE_WINDOW_MS,
  FLICK_SENSITIVITY_DEFAULT,
  FLICK_SENSITIVITY_MAX,
  FLICK_SENSITIVITY_MIN,
  K_FLICK,
  OMEGA_MAX,
} from './constants';

/** 포인터 이동 샘플. 좌표계는 캔버스 픽셀, `t` 는 밀리초(주입값). */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  /** 타임스탬프 [ms]. 호출자가 주입한다 (Date.now 를 여기서 읽지 않는다). */
  readonly t: number;
}

/** 스피너 회전 중심 [px]. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** 지렛대 길이가 사실상 0 인 샘플(중심 정확히 위)은 접선 방향이 정의되지 않으므로 버린다. */
const LEVER_ARM_EPSILON = 1e-9;

/**
 * 마지막 샘플 기준 FLICK_SAMPLE_WINDOW_MS 이내의 샘플을 최대 FLICK_MAX_SAMPLES 개 고른다.
 * 시간순 정렬(오름차순)을 가정한다 — 포인터 이벤트는 그렇게 들어온다.
 */
export function selectFlickSamples(samples: readonly PointerSample[]): readonly PointerSample[] {
  const last = samples[samples.length - 1];
  if (last === undefined) return [];

  const cutoff = last.t - FLICK_SAMPLE_WINDOW_MS;
  let start = samples.length - 1;
  while (start > 0) {
    const prev = samples[start - 1];
    if (prev === undefined || prev.t < cutoff) break;
    start -= 1;
  }

  // 윈도 안이라도 최근 FLICK_MAX_SAMPLES 개까지만 쓴다.
  const maxStart = samples.length - FLICK_MAX_SAMPLES;
  return samples.slice(start > maxStart ? start : maxStart);
}

/**
 * 손가락이 회전 중심에 대해 그린 **각속도** [rad/s] 를 추정한다. 게인은 곱하지 않는다.
 *
 * 인접 샘플 쌍마다 중점의 위치벡터 r 과 속도벡터 v 를 만들고, 외적의 z 성분으로
 * 접선 성분만 뽑는다: `v_tangential = (rx·vy - ry·vx) / |r|`.
 * 반경 방향 성분은 r 과 평행해 외적이 정확히 0 이므로 **기여가 0 이다** (근사가 아니라 항등).
 * 그 뒤 `ω = v_tangential / r` 로 각속도가 된다.
 *
 * 여러 쌍은 시간 가중 평균으로 합친다 — 샘플 간격이 불균일해도 "휩쓴 각도 / 걸린 시간"과
 * 같은 뜻이 되고, 마지막 한 쌍의 노이즈에 결과가 통째로 끌려가지 않는다.
 *
 * 부호는 캔버스 좌표계(y 아래 방향) 기준이다. 양수 = θ 가 커지는 방향 = 화면상 시계 방향.
 *
 * @param center 스피너 회전 중심 [px]
 * @param spinnerRadius 스피너 반경 [px]. 중심 근처 데드존의 기준 길이로 쓴다.
 */
export function flickAngularVelocity(
  samples: readonly PointerSample[],
  center: Point2,
  spinnerRadius: number,
): number {
  if (!(spinnerRadius > 0) || !Number.isFinite(spinnerRadius)) return 0;

  const recent = selectFlickSamples(samples);
  if (recent.length < 2) return 0; // 샘플이 0개거나 1개면 속도를 만들 수 없다

  // 1/r 발산 방지: 중심에 너무 가까운 입력은 이 거리에서 일어난 것으로 취급한다.
  const minLeverArm = spinnerRadius * FLICK_MIN_LEVER_ARM_FRAC;

  let weighted = 0; // Σ ω_i · dt_i
  let totalDt = 0; // Σ dt_i

  for (let i = 1; i < recent.length; i += 1) {
    const a = recent[i - 1];
    const b = recent[i];
    if (a === undefined || b === undefined) continue;

    const dt = (b.t - a.t) / 1000; // ms → s
    if (!(dt > 0) || !Number.isFinite(dt)) continue; // 같은 타임스탬프/역행 샘플은 버린다

    const vx = (b.x - a.x) / dt;
    const vy = (b.y - a.y) / dt;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;

    // 구간 중점을 지렛대 위치로 쓴다 (한쪽 끝을 쓰면 이동량만큼 편향된다).
    const rx = (a.x + b.x) / 2 - center.x;
    const ry = (a.y + b.y) / 2 - center.y;
    const r = Math.sqrt(rx * rx + ry * ry); // Math.hypot 은 정확도 규정이 없어 결정론이 깨진다
    if (!(r > LEVER_ARM_EPSILON)) continue; // 정확히 중심 위 — 접선 방향이 없다

    const vTangential = (rx * vy - ry * vx) / r;
    const leverArm = r > minLeverArm ? r : minLeverArm;

    weighted += (vTangential / leverArm) * dt;
    totalDt += dt;
  }

  if (totalDt <= 0) return 0;
  return weighted / totalDt;
}

/**
 * 사용자 설정 민감도를 사용 가능한 배율로 좁힌다.
 *
 * **클램프가 여기 있는 이유**: 이 값은 저장소를 거쳐 돌아온다. 스키마가 바뀌었거나, 백업을
 * 손으로 고쳤거나, 예전 버전이 다른 단위로 저장했으면 범위 밖 값·NaN 이 들어올 수 있다.
 * 그런 값이 K_FLICK 에 그대로 곱해지면 한 번 튕겼을 때 무슨 일이 벌어질지 저장소가 정하게 된다.
 * 읽는 쪽이 아니라 **쓰는 쪽 바로 앞**에서 막아야 어떤 경로로 들어와도 새지 않는다.
 *
 * 음수는 뒤집힌 회전 방향이 아니라 잘못된 값으로 본다 — 방향은 손가락이 정하는 것이지
 * 설정이 정하는 것이 아니다. 따라서 하한으로 잘린다.
 */
export function clampFlickSensitivity(sensitivity: number): number {
  if (!Number.isFinite(sensitivity)) return FLICK_SENSITIVITY_DEFAULT;
  if (sensitivity < FLICK_SENSITIVITY_MIN) return FLICK_SENSITIVITY_MIN;
  if (sensitivity > FLICK_SENSITIVITY_MAX) return FLICK_SENSITIVITY_MAX;
  return sensitivity;
}

/**
 * 플릭 입력을 각속도 증가분 Δω [rad/s] 로 바꾼다.
 *
 *   Δω = K_FLICK × sensitivity × v_tangential / r
 *
 * 결과는 OMEGA_MAX 로 클램프한다 (양·음 대칭). 부호 = 회전 방향.
 *
 * @param sensitivity 사용자 설정 민감도 배율. 생략하면 기본값(1.0) — 설정을 모르는 호출부는
 *   이전과 정확히 같은 값을 받는다. 범위 밖 값은 clampFlickSensitivity 가 잘라낸다.
 */
export function flickToOmegaDelta(
  samples: readonly PointerSample[],
  center: Point2,
  spinnerRadius: number,
  sensitivity: number = FLICK_SENSITIVITY_DEFAULT,
): number {
  const gain = K_FLICK * clampFlickSensitivity(sensitivity);
  const delta = gain * flickAngularVelocity(samples, center, spinnerRadius);
  if (!Number.isFinite(delta)) return 0;
  if (delta > OMEGA_MAX) return OMEGA_MAX;
  if (delta < -OMEGA_MAX) return -OMEGA_MAX;
  return delta;
}
