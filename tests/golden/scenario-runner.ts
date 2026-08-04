// 골든 시나리오 정의 + 실행기. 테스트와 기준값 생성이 **같은 코드**를 쓰도록 여기 모아둔다.
// (생성 경로와 검증 경로가 갈라지면 스냅샷은 아무것도 지키지 못한다.)

import * as C from '../../src/core/constants';
import { advance, createSpinState } from '../../src/core/physics';

/** 한 시나리오를 어떻게 돌릴지에 대한 완전한 서술. 여기 있는 값만으로 재현이 끝나야 한다. */
export interface GoldenScenario {
  /** 파일명 겸 테스트 이름. */
  readonly name: string;
  readonly description: string;
  /** 초기 각속도 [rad/s]. */
  readonly omega0: number;
  /** 초기 누적각 [rad]. */
  readonly theta0: number;
  /** 브레이크를 계속 잡고 있는가. */
  readonly braking: boolean;
  /** 프레임 dt [s] 패턴. 프레임마다 순환해서 쓴다 — 길이 1이면 균일 프레임. */
  readonly frameDtPattern: readonly number[];
  /** 총 프레임 수. */
  readonly frames: number;
  /** 몇 프레임마다 한 번 기록할지. */
  readonly sampleEvery: number;
}

/** [t, omega, theta] — 부동소수 원값 그대로 저장한다. */
export type GoldenSample = readonly [number, number, number];

export interface GoldenFile {
  readonly name: string;
  readonly description: string;
  /** 기준값을 만든 시점의 물리 상수. 상수가 바뀌면 곡선이 왜 움직였는지 diff 에 드러난다. */
  readonly constants: Readonly<Record<string, number>>;
  readonly scenario: Omit<GoldenScenario, 'name' | 'description'>;
  /** 누적 서브스텝 수와 death spiral 가드가 폐기한 총 시간 [s]. */
  readonly totals: { readonly substeps: number; readonly droppedSec: number };
  readonly samples: readonly GoldenSample[];
}

/** 골든에 박아두는 물리 상수 목록. constants.ts 의 물리 파트와 1:1 이다. */
export const PHYSICS_CONSTANTS: Readonly<Record<string, number>> = {
  TAU_COULOMB: C.TAU_COULOMB,
  B_VISCOUS: C.B_VISCOUS,
  C_DRAG: C.C_DRAG,
  TAU_BRAKE: C.TAU_BRAKE,
  OMEGA_MAX: C.OMEGA_MAX,
  OMEGA_STOP: C.OMEGA_STOP,
  FIXED_DT: C.FIXED_DT,
  MAX_SUBSTEPS: C.MAX_SUBSTEPS,
};

/** 시나리오를 실행해 골든 파일 내용을 만든다. 순수 함수 — 파일 I/O 는 하지 않는다. */
export function buildGoldenFile(scenario: GoldenScenario): GoldenFile {
  const { name, description, omega0, theta0, braking, frameDtPattern, frames, sampleEvery } =
    scenario;

  let state = createSpinState(omega0, theta0);
  let elapsed = 0;
  let substeps = 0;
  let droppedSec = 0;

  const samples: GoldenSample[] = [[0, state.omega, state.theta]];

  for (let frame = 0; frame < frames; frame += 1) {
    const dt = frameDtPattern[frame % frameDtPattern.length] ?? 0;
    const result = advance(state, dt, braking);
    state = result.state;
    substeps += result.substeps;
    droppedSec += result.droppedSec;
    elapsed += dt;

    if ((frame + 1) % sampleEvery === 0) {
      samples.push([elapsed, state.omega, state.theta]);
    }
  }

  return {
    name,
    description,
    constants: PHYSICS_CONSTANTS,
    scenario: { omega0, theta0, braking, frameDtPattern, frames, sampleEvery },
    totals: { substeps, droppedSec },
    samples,
  };
}

const FRAME_60 = 1 / 60;

/**
 * 대표 시나리오들. 각각이 물리 모델의 서로 다른 구간을 고정한다.
 *
 * 프레임 dt 는 실제 rAF 처럼 흔들리는 경우까지 포함시킨다 — accumulator 가 프레임 지터를
 * 흡수하지 못하게 되면(= 결정론이 깨지면) 그 순간 곡선이 통째로 달라져 여기서 잡힌다.
 */
export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  {
    name: 'spindown-max',
    description:
      '상한 속도(210 rad/s ≈ 2005 RPM)에서 완전 정지까지. 공기저항 지배 구간을 고정한다.',
    omega0: C.OMEGA_MAX,
    theta0: 0,
    braking: false,
    frameDtPattern: [FRAME_60],
    frames: 1560, // 26s — 실제 정지는 24.57s
    sampleEvery: 30, // 0.5s 간격
  },
  {
    name: 'spindown-mid',
    description: '중속(50 rad/s)에서 완전 정지까지. 점성·쿨롱 마찰 지배 구간.',
    omega0: 50,
    theta0: 0,
    braking: false,
    frameDtPattern: [FRAME_60],
    frames: 1380, // 23s — 실제 정지는 21.53s
    sampleEvery: 30,
  },
  {
    name: 'spindown-mid-braked',
    description: '중속(50 rad/s)에서 브레이크를 계속 잡은 채 정지까지. TAU_BRAKE 기여를 고정한다.',
    omega0: 50,
    theta0: 0,
    braking: true,
    frameDtPattern: [FRAME_60],
    frames: 420, // 7s — 실제 정지는 6.18s
    sampleEvery: 10,
  },
  {
    name: 'spindown-reverse',
    description: '역방향(-120 rad/s) 감속. 부호 대칭성과 음의 θ 누적을 고정한다.',
    omega0: -120,
    theta0: 0,
    braking: false,
    frameDtPattern: [FRAME_60],
    frames: 1500, // 25s — 실제 정지는 23.78s
    sampleEvery: 30,
  },
  {
    name: 'near-stop',
    description:
      '정지 직전 저속 구간(0.6 rad/s)을 240Hz 로 촘촘히. OMEGA_STOP 스냅이 일어나는 정확한 스텝을 고정한다.',
    omega0: 0.6,
    theta0: 0,
    braking: false,
    frameDtPattern: [C.FIXED_DT],
    frames: 320, // 1.33s — 실제 스냅은 284프레임(1.183s)
    sampleEvery: 10,
  },
  {
    name: 'jitter-frames',
    description:
      '프레임 dt 가 흔들리는(45~120fps) 상황의 감속. accumulator 가 지터를 흡수하는지 고정한다.',
    omega0: 150,
    theta0: 0,
    braking: false,
    frameDtPattern: [1 / 60, 1 / 90, 1 / 45, 1 / 60, 1 / 120],
    frames: 1200,
    sampleEvery: 25,
  },
  {
    name: 'stall-recovery',
    description:
      '10프레임마다 1초짜리 멈춤(탭 전환 복귀)이 끼어드는 상황. MAX_SUBSTEPS 가드가 시간을 폐기하는 양까지 고정한다.',
    omega0: 100,
    theta0: 0,
    braking: false,
    frameDtPattern: [
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      FRAME_60,
      1.0,
    ],
    frames: 300,
    sampleEvery: 10,
  },
  {
    name: 'low-fps-sustained',
    description:
      '발열로 스로틀링된 기기의 지속 37fps. 매 프레임 MAX_SUBSTEPS 상한에 걸리면서 잔여가 스텝 경계에 딱 떨어지지 않는 조건이라, 폐기 정책(온전한 스텝만 버리고 잔여는 이월)이 여기서 고정된다.',
    omega0: 180,
    theta0: 0,
    braking: false,
    frameDtPattern: [1 / 37], // 6.49 서브스텝 필요 — 상한(5)을 늘 넘긴다
    frames: 600,
    sampleEvery: 20,
  },
];
