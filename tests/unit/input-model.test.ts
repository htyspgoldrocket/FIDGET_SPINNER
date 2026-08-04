// L1 — 포인터 샘플 → 각속도 변환.
//
// 핵심 불변식: 반경 방향으로 아무리 빠르게 움직여도 스피너는 돌지 않는다.
// (접선 성분만 뽑는다는 말을 "근사적으로"가 아니라 "정확히 0"으로 검증한다.)

import { describe, expect, it } from 'vitest';
import {
  clampFlickSensitivity,
  flickAngularVelocity,
  flickToOmegaDelta,
  selectFlickSamples,
  type PointerSample,
} from '../../src/core/input-model';
import {
  FLICK_MAX_SAMPLES,
  FLICK_MIN_LEVER_ARM_FRAC,
  FLICK_SAMPLE_WINDOW_MS,
  FLICK_SENSITIVITY_DEFAULT,
  FLICK_SENSITIVITY_MAX,
  FLICK_SENSITIVITY_MIN,
  K_FLICK,
  OMEGA_MAX,
} from '../../src/core/constants';

const CENTER = { x: 0, y: 0 } as const;
const RADIUS = 120;

const sample = (x: number, y: number, t: number): PointerSample => ({ x, y, t });

describe('selectFlickSamples', () => {
  it('샘플이 없으면 빈 배열이다', () => {
    expect(selectFlickSamples([])).toEqual([]);
  });

  it('마지막 샘플 기준 윈도 밖의 샘플을 버린다', () => {
    const samples = [
      sample(0, 0, 0), // 500ms 전 — 버림
      sample(1, 1, 400), // 100ms 전 — 경계, 포함
      sample(2, 2, 480),
      sample(3, 3, 500),
    ];
    const picked = selectFlickSamples(samples);
    expect(picked.map((s) => s.t)).toEqual([400, 480, 500]);
    expect(FLICK_SAMPLE_WINDOW_MS).toBe(100); // 윈도 크기가 바뀌면 이 기대값도 다시 봐야 한다
  });

  it('윈도 안이어도 최근 FLICK_MAX_SAMPLES 개까지만 쓴다', () => {
    const samples = Array.from({ length: 12 }, (_, i) => sample(i, i, 900 + i * 5));
    const picked = selectFlickSamples(samples);
    expect(picked.length).toBe(FLICK_MAX_SAMPLES);
    expect(picked[picked.length - 1]!.t).toBe(955);
  });

  it('샘플이 하나면 그 하나를 돌려준다', () => {
    expect(selectFlickSamples([sample(1, 2, 3)]).length).toBe(1);
  });
});

describe('접선 성분만 각속도에 기여한다', () => {
  // 중심 (0,0), 중점이 (100, 0) 이 되도록 구성한다 → r = 100 이 정확히 떨어진다.
  const tangentialOnly = [sample(100, -5, 0), sample(100, 5, 20)];

  it('순수 반경 방향 이동은 정확히 0 을 만든다', () => {
    const outward = [sample(50, 0, 0), sample(150, 0, 20)]; // 중심에서 바깥으로
    const inward = [sample(150, 0, 0), sample(50, 0, 20)]; // 안쪽으로
    expect(flickAngularVelocity(outward, CENTER, RADIUS)).toBe(0);
    expect(flickAngularVelocity(inward, CENTER, RADIUS)).toBe(0);
    expect(flickToOmegaDelta(outward, CENTER, RADIUS)).toBe(0);
  });

  it('접선 이동에 반경 성분을 얹어도 결과가 바뀌지 않는다', () => {
    // 같은 중점·같은 접선 속도. x 방향(= 반경 방향) 이동만 추가로 얹었다.
    const withRadial = [sample(90, -5, 0), sample(110, 5, 20)];
    expect(flickAngularVelocity(withRadial, CENTER, RADIUS)).toBe(
      flickAngularVelocity(tangentialOnly, CENTER, RADIUS),
    );
  });

  it('접선 속도 / 반경 이 각속도가 된다', () => {
    // v_tangential = 10px / 0.02s = 500 px/s, r = 100px → ω = 5 rad/s
    expect(flickAngularVelocity(tangentialOnly, CENTER, RADIUS)).toBeCloseTo(5, 9);
    expect(flickToOmegaDelta(tangentialOnly, CENTER, RADIUS)).toBeCloseTo(5 * K_FLICK, 9);
  });

  it('같은 접선 속도라도 중심에서 멀수록 각속도는 작다 (1/r)', () => {
    const near = [sample(50, -5, 0), sample(50, 5, 20)];
    const far = [sample(200, -5, 0), sample(200, 5, 20)];
    const wNear = flickAngularVelocity(near, CENTER, RADIUS);
    const wFar = flickAngularVelocity(far, CENTER, RADIUS);
    expect(wNear).toBeGreaterThan(wFar);
    expect(wNear / wFar).toBeCloseTo(4, 6); // r 이 4배면 ω 는 1/4
  });
});

describe('회전 방향(부호)', () => {
  it('캔버스 좌표계에서 시계 방향이 양수다', () => {
    // 오른쪽(x>0)에서 아래(y+)로 쓸면 화면상 시계 방향
    const clockwise = [sample(100, -5, 0), sample(100, 5, 20)];
    expect(flickToOmegaDelta(clockwise, CENTER, RADIUS)).toBeGreaterThan(0);
  });

  it('반대로 쓸면 정확히 부호만 뒤집힌다', () => {
    const cw = [sample(100, -5, 0), sample(100, 5, 20)];
    const ccw = [sample(100, 5, 0), sample(100, -5, 20)];
    expect(flickAngularVelocity(ccw, CENTER, RADIUS)).toBe(
      -flickAngularVelocity(cw, CENTER, RADIUS),
    );
  });

  it('중심이 원점이 아니어도 같은 결과가 나온다 (평행이동 불변)', () => {
    const shifted = { x: 640, y: 360 } as const;
    const local = [sample(100, -5, 0), sample(100, 5, 20)];
    const world = local.map((s) => sample(s.x + shifted.x, s.y + shifted.y, s.t));
    expect(flickAngularVelocity(world, shifted, RADIUS)).toBe(
      flickAngularVelocity(local, CENTER, RADIUS),
    );
  });
});

describe('경계 케이스', () => {
  it('샘플 0개 / 1개면 0 이다', () => {
    expect(flickToOmegaDelta([], CENTER, RADIUS)).toBe(0);
    expect(flickToOmegaDelta([sample(100, 0, 0)], CENTER, RADIUS)).toBe(0);
  });

  it('타임스탬프가 같은 샘플만 있으면 0 이다 (0 으로 나누지 않는다)', () => {
    const same = [sample(100, -5, 50), sample(100, 5, 50), sample(100, 15, 50)];
    const result = flickToOmegaDelta(same, CENTER, RADIUS);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('시간이 역행하는 쌍은 버린다', () => {
    const reversed = [sample(100, 5, 20), sample(100, -5, 0)];
    expect(flickToOmegaDelta(reversed, CENTER, RADIUS)).toBe(0);
  });

  it('정확히 회전 중심 위의 입력은 기여하지 않는다 (NaN 없음)', () => {
    const atCenter = [sample(0, 0, 0), sample(0, 0, 20)];
    const result = flickToOmegaDelta(atCenter, CENTER, RADIUS);
    expect(result).toBe(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('중심 아주 가까이에서의 플릭도 발산하지 않는다 (지렛대 하한)', () => {
    const minArm = RADIUS * FLICK_MIN_LEVER_ARM_FRAC;
    const nearCenter = [sample(0.001, -5, 0), sample(0.001, 5, 20)];
    const result = flickAngularVelocity(nearCenter, CENTER, RADIUS);
    expect(Number.isFinite(result)).toBe(true);
    // 지렛대를 minArm 으로 취급했으므로 |ω| ≈ v_t / minArm 을 넘지 않는다
    expect(Math.abs(result)).toBeLessThanOrEqual(500 / minArm + 1e-6);
  });

  it('반경이 0·음수·NaN 이면 0 을 돌려준다', () => {
    const samples = [sample(100, -5, 0), sample(100, 5, 20)];
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(flickToOmegaDelta(samples, CENTER, bad)).toBe(0);
    }
  });

  it('윈도 밖의 격렬한 움직임은 결과에 영향을 주지 않는다', () => {
    const recent = [sample(100, -5, 1000), sample(100, 5, 1020)];
    const withOldNoise = [sample(-800, 900, 100), sample(900, -800, 150), ...recent];
    expect(flickAngularVelocity(withOldNoise, CENTER, RADIUS)).toBe(
      flickAngularVelocity(recent, CENTER, RADIUS),
    );
  });
});

describe('플릭 민감도 (사용자 설정 배율)', () => {
  // 100px 지점에서 접선으로 500 px/s → 손가락 각속도 5 rad/s.
  const flick = [sample(100, -5, 0), sample(100, 5, 20)];

  it('상수의 범위가 뒤집혀 있지 않다', () => {
    expect(FLICK_SENSITIVITY_MIN).toBeGreaterThan(0);
    expect(FLICK_SENSITIVITY_MIN).toBeLessThan(FLICK_SENSITIVITY_DEFAULT);
    expect(FLICK_SENSITIVITY_DEFAULT).toBeLessThan(FLICK_SENSITIVITY_MAX);
  });

  it('인자를 생략하면 기본 배율이다 (기존 호출부는 값이 변하지 않는다)', () => {
    expect(flickToOmegaDelta(flick, CENTER, RADIUS)).toBe(
      flickToOmegaDelta(flick, CENTER, RADIUS, FLICK_SENSITIVITY_DEFAULT),
    );
    expect(FLICK_SENSITIVITY_DEFAULT).toBe(1);
  });

  it('배율 0.5 면 Δω 가 정확히 절반이다', () => {
    const full = flickToOmegaDelta(flick, CENTER, RADIUS, 1);
    const half = flickToOmegaDelta(flick, CENTER, RADIUS, 0.5);
    expect(half).toBeCloseTo(full / 2, 12);
    expect(half).toBeCloseTo(5 * K_FLICK * 0.5, 9);
  });

  it('배율은 Δω 에 선형으로 곱해진다 (부호도 함께 따라간다)', () => {
    const base = flickToOmegaDelta(flick, CENTER, RADIUS, 1);
    for (const s of [0.25, 0.4, 0.75, 1.25, 1.5]) {
      expect(flickToOmegaDelta(flick, CENTER, RADIUS, s)).toBeCloseTo(base * s, 9);
    }

    const reversed = [sample(100, 5, 0), sample(100, -5, 20)];
    expect(flickToOmegaDelta(reversed, CENTER, RADIUS, 0.5)).toBeCloseTo(
      -flickToOmegaDelta(flick, CENTER, RADIUS, 0.5),
      12,
    );
  });

  it('민감도를 낮춰도 회전 자체가 사라지지는 않는다', () => {
    const lowest = flickToOmegaDelta(flick, CENTER, RADIUS, FLICK_SENSITIVITY_MIN);
    expect(lowest).toBeGreaterThan(0);
    expect(lowest).toBeLessThan(flickToOmegaDelta(flick, CENTER, RADIUS));
  });

  it('민감도를 올려도 OMEGA_MAX 클램프는 그대로 작동한다', () => {
    const insane = [sample(100, -5000, 0), sample(100, 5000, 4)];
    expect(flickToOmegaDelta(insane, CENTER, RADIUS, FLICK_SENSITIVITY_MAX)).toBe(OMEGA_MAX);
    expect(flickToOmegaDelta(insane, CENTER, RADIUS, FLICK_SENSITIVITY_MIN)).toBe(OMEGA_MAX);
  });

  it('접선 성분이 0 이면 배율이 얼마든 0 이다', () => {
    const radial = [sample(50, 0, 0), sample(150, 0, 20)];
    expect(flickToOmegaDelta(radial, CENTER, RADIUS, FLICK_SENSITIVITY_MAX)).toBe(0);
  });
});

describe('민감도 클램프 (저장소에서 돌아온 값 방어)', () => {
  const flick = [sample(100, -5, 0), sample(100, 5, 20)];

  it('범위 안의 값은 그대로 통과한다', () => {
    for (const s of [FLICK_SENSITIVITY_MIN, 0.5, 1, 1.25, FLICK_SENSITIVITY_MAX]) {
      expect(clampFlickSensitivity(s)).toBe(s);
    }
  });

  it('범위를 벗어난 값은 가장 가까운 경계로 잘린다', () => {
    expect(clampFlickSensitivity(0.001)).toBe(FLICK_SENSITIVITY_MIN);
    expect(clampFlickSensitivity(9999)).toBe(FLICK_SENSITIVITY_MAX);
  });

  it('0 과 음수는 하한으로 잘린다 (설정이 회전 방향을 뒤집지 않는다)', () => {
    expect(clampFlickSensitivity(0)).toBe(FLICK_SENSITIVITY_MIN);
    expect(clampFlickSensitivity(-1)).toBe(FLICK_SENSITIVITY_MIN);
    // 음수 배율이 새어나가면 오른쪽으로 튕겼는데 왼쪽으로 도는 일이 생긴다.
    expect(flickToOmegaDelta(flick, CENTER, RADIUS, -1)).toBeGreaterThan(0);
  });

  it('NaN / Infinity 는 기본값으로 되돌린다', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampFlickSensitivity(bad)).toBe(FLICK_SENSITIVITY_DEFAULT);
    }
  });

  it('잘못된 값이 들어와도 Δω 는 항상 유한하다', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0, 1e308]) {
      const delta = flickToOmegaDelta(flick, CENTER, RADIUS, bad);
      expect(Number.isFinite(delta)).toBe(true);
      expect(Math.abs(delta)).toBeLessThanOrEqual(OMEGA_MAX);
    }
  });

  it('클램프된 값과 클램프 전 값이 같은 Δω 를 만든다 (경로 무관)', () => {
    expect(flickToOmegaDelta(flick, CENTER, RADIUS, 5)).toBe(
      flickToOmegaDelta(flick, CENTER, RADIUS, FLICK_SENSITIVITY_MAX),
    );
  });
});

describe('클램프와 결정론', () => {
  it('말도 안 되게 빠른 플릭은 OMEGA_MAX 로 잘린다 (양·음)', () => {
    const insaneCw = [sample(100, -5000, 0), sample(100, 5000, 4)];
    const insaneCcw = [sample(100, 5000, 0), sample(100, -5000, 4)];
    expect(flickToOmegaDelta(insaneCw, CENTER, RADIUS)).toBe(OMEGA_MAX);
    expect(flickToOmegaDelta(insaneCcw, CENTER, RADIUS)).toBe(-OMEGA_MAX);
  });

  it('현실적인 강한 플릭은 상한에 닿지 않는다 (K_FLICK 감각 확인)', () => {
    // 130px 지점에서 접선으로 900 px/s
    const strong = [sample(130, -9, 0), sample(130, 9, 20)];
    const delta = flickToOmegaDelta(strong, CENTER, RADIUS);
    expect(delta).toBeGreaterThan(80); // 한 번에 확실히 돌아간다
    expect(delta).toBeLessThan(OMEGA_MAX); // 그래도 상한은 남겨둔다
  });

  it('같은 입력을 두 번 넣으면 완전히 같은 값이 나온다', () => {
    const samples = [
      sample(97, -22, 940),
      sample(101, -8, 953),
      sample(104, 6, 967),
      sample(103, 19, 980),
      sample(99, 31, 994),
    ];
    const a = flickToOmegaDelta(samples, CENTER, RADIUS);
    const b = flickToOmegaDelta(samples, CENTER, RADIUS);
    expect(Object.is(a, b)).toBe(true);
    expect(a).toBeGreaterThan(0);
  });

  it('입력 배열을 변형하지 않는다 (순수 함수)', () => {
    const samples = [sample(100, -5, 0), sample(100, 5, 20)];
    const snapshot = JSON.stringify(samples);
    flickToOmegaDelta(samples, CENTER, RADIUS);
    expect(JSON.stringify(samples)).toBe(snapshot);
  });

  it('불균일한 샘플 간격에서도 시간 가중 평균이 적용된다', () => {
    // 앞 구간은 길고 느리게, 뒤 구간은 짧고 빠르게 — 결과는 두 값 사이에 있어야 한다
    const mixed = [sample(100, -30, 0), sample(100, 0, 60), sample(100, 10, 70)];
    const slowOnly = flickAngularVelocity([mixed[0]!, mixed[1]!], CENTER, RADIUS);
    const fastOnly = flickAngularVelocity([mixed[1]!, mixed[2]!], CENTER, RADIUS);
    const combined = flickAngularVelocity(mixed, CENTER, RADIUS);
    expect(combined).toBeGreaterThan(slowOnly);
    expect(combined).toBeLessThan(fastOnly);
  });
});
