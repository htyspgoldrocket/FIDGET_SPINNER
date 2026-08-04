// Pointer Events → 플릭 / 브레이크 / 더블탭 제스처.
//
// 브라우저 경계 레이어다. 이벤트를 받아 좌표·시각을 뽑는 일만 하고, 각속도 계산 자체는
// core/input-model 에 맡긴다 (의존 방향: platform → core).
//
// 시각은 전부 `event.timeStamp` 를 쓴다. rAF 콜백이 받는 타임스탬프와 같은 시계이므로
// 게임 루프의 `isBraking(now)` 판정과 이벤트 시각을 그대로 비교할 수 있다.
// Date.now / performance.now 를 섞어 쓰지 않는다 (시간 소스 단일화).

import { flickToOmegaDelta, type Point2, type PointerSample } from '../core/input-model';

// ── 제스처 판정 임계값 ─────────────────────────────────────────
// 물리 상수가 아니라 이 파일 안에서만 의미를 갖는 입력 휴리스틱이므로 여기에 둔다
// (core/constants.ts 는 물리·햅틱 상수의 단일 출처다 — CLAUDE.md 규칙 5).

/** 이 거리[css px] 를 넘게 움직이면 "가만히 누르고 있는" 것이 아니다 → 브레이크 대상에서 제외. */
const BRAKE_MOVE_TOLERANCE_PX = 12;

/** 스피너 위에서 거의 움직이지 않고 이만큼[ms] 유지되면 브레이크로 판정한다.
 *  한 번 브레이크가 걸리면 포인터를 뗄 때까지 유지된다(래치) — 눌러둔 손가락은 계속 브레이크다. */
const BRAKE_HOLD_MS = 140;

/** 탭으로 인정하는 최대 누름 시간[ms]. */
const TAP_MAX_MS = 220;

/** 탭으로 인정하는 최대 이동 거리[css px]. */
const TAP_MOVE_TOLERANCE_PX = 12;

/** 두 탭 사이의 최대 간격[ms]. 이 안에 두 번째 탭이 끝나야 더블탭이다. */
const DOUBLE_TAP_WINDOW_MS = 300;

/** 두 탭 사이의 최대 거리[css px]. 화면 반대편을 두 번 친 것은 더블탭이 아니다. */
const DOUBLE_TAP_MAX_DIST_PX = 40;

/** 보관할 포인터 샘플 수 상한. core 의 플릭 윈도(100ms / 5샘플)보다 넉넉하게 잡는다. */
const MAX_SAMPLES = 24;

/** 스피너의 화면상 배치. 렌더러가 제공하는 값과 구조가 같다(레이어 간 import 를 만들지 않는다). */
export interface SpinnerGeometry {
  readonly center: Point2;
  readonly radius: number;
}

export interface PointerInputHandlers {
  /** 플릭으로 얻은 각속도 증가분 [rad/s]. 부호 = 회전 방향. */
  onFlick(deltaOmega: number): void;
  /** 더블탭 — 즉시 정지. */
  onDoubleTap(): void;
  /** 최초 사용자 인터랙션 1회. Wake Lock 획득처럼 사용자 제스처가 필요한 작업의 트리거. */
  onFirstInteraction?(): void;
}

export interface PointerInput {
  /**
   * 지금 브레이크가 걸린 상태인가. 게임 루프가 매 프레임 묻는다.
   *
   * 가만히 누르고 있으면 pointermove 가 오지 않으므로 "홀드 시간"은 이벤트로 알 수 없다.
   * 그래서 판정을 이벤트가 아니라 이 폴링 시점에서 한다.
   *
   * @param nowMs rAF 타임스탬프 [ms] — event.timeStamp 와 같은 시계여야 한다.
   */
  isBraking(nowMs: number): boolean;
  /** 진행 중인 제스처를 취소하고 상태를 비운다 (탭 전환 등). 콜백은 발생하지 않는다. */
  reset(): void;
  dispose(): void;
}

interface TapMark {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/**
 * 제스처 판정 규칙 (셋은 서로 배타적이다):
 *
 *  - **브레이크**: 스피너 반경 안에서 눌러 시작 + 이동 ≤ BRAKE_MOVE_TOLERANCE_PX 인 채로
 *    BRAKE_HOLD_MS 경과. 한 번 걸리면 뗄 때까지 유지된다.
 *  - **플릭**: 브레이크가 걸리지 않은 제스처의 뗌. 최근 샘플로 core 가 Δω 를 계산한다.
 *    (브레이크로 판정된 제스처는 플릭을 발생시키지 않는다 — 잡아 세운 뒤 튕겨나가면 어색하다.)
 *  - **더블탭**: TAP_MAX_MS 안에 TAP_MOVE_TOLERANCE_PX 이내로 끝난 "탭" 두 번이
 *    DOUBLE_TAP_WINDOW_MS / DOUBLE_TAP_MAX_DIST_PX 안에 연달아 일어난 경우.
 *    탭 판정은 브레이크 래치와 독립적이다 — BRAKE_HOLD_MS(140) 와 TAP_MAX_MS(220) 가 겹치는
 *    구간에서는 아주 짧게 브레이크가 걸렸다 풀리지만, 감속량이 0.3 rad/s 미만이라 체감되지 않는다.
 */
export function attachPointerInput(
  target: HTMLElement,
  getGeometry: () => SpinnerGeometry,
  handlers: PointerInputHandlers,
): PointerInput {
  let pointerId: number | null = null;
  let originX = 0; // 제스처 시작 시점의 target 좌상단 (뷰포트 기준). 매 move 마다 재측정하지 않는다.
  let originY = 0;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let maxMoveDist = 0;
  let braking = false;
  let brakeEligible = false;
  let samples: PointerSample[] = [];
  let lastTap: TapMark | null = null;
  let interacted = false;

  function clearGesture(): void {
    pointerId = null;
    braking = false;
    brakeEligible = false;
    maxMoveDist = 0;
    samples = [];
  }

  function pushSample(event: PointerEvent): void {
    const x = event.clientX - originX;
    const y = event.clientY - originY;
    samples.push({ x, y, t: event.timeStamp });
    if (samples.length > MAX_SAMPLES) samples.shift();

    const dx = x - downX;
    const dy = y - downY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxMoveDist) maxMoveDist = dist;
  }

  function onPointerDown(event: PointerEvent): void {
    if (pointerId !== null) return; // 멀티터치: 첫 포인터만 따른다
    event.preventDefault();

    pointerId = event.pointerId;
    const rect = target.getBoundingClientRect();
    originX = rect.left;
    originY = rect.top;
    downX = event.clientX - originX;
    downY = event.clientY - originY;
    downT = event.timeStamp;
    maxMoveDist = 0;
    braking = false;
    samples = [{ x: downX, y: downY, t: downT }];

    const { center, radius } = getGeometry();
    const dx = downX - center.x;
    const dy = downY - center.y;
    brakeEligible = radius > 0 && dx * dx + dy * dy <= radius * radius;

    target.setPointerCapture(event.pointerId);

    if (!interacted) {
      interacted = true;
      handlers.onFirstInteraction?.();
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();

    // 합쳐진 중간 이동까지 복원한다. 빠른 플릭에서 속도 추정의 정확도가 눈에 띄게 좋아진다.
    const coalesced =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    if (coalesced.length > 0) {
      for (const sub of coalesced) pushSample(sub);
    } else {
      pushSample(event);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    pushSample(event);

    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    const endT = event.timeStamp;
    const wasBraking = braking;
    const endX = event.clientX - originX;
    const endY = event.clientY - originY;
    const { center, radius } = getGeometry();
    const gestureSamples = samples;
    const moved = maxMoveDist;
    clearGesture();

    if (!wasBraking) {
      const delta = flickToOmegaDelta(gestureSamples, center, radius);
      if (delta !== 0) handlers.onFlick(delta);
    }

    const isTap = endT - downT <= TAP_MAX_MS && moved <= TAP_MOVE_TOLERANCE_PX;
    if (!isTap) {
      lastTap = null;
      return;
    }

    if (lastTap !== null && endT - lastTap.t <= DOUBLE_TAP_WINDOW_MS) {
      const dx = endX - lastTap.x;
      const dy = endY - lastTap.y;
      if (Math.sqrt(dx * dx + dy * dy) <= DOUBLE_TAP_MAX_DIST_PX) {
        lastTap = null; // 세 번째 탭이 곧바로 또 더블탭이 되지 않도록 소비한다
        handlers.onDoubleTap();
        return;
      }
    }
    lastTap = { x: endX, y: endY, t: endT };
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    clearGesture();
    lastTap = null;
  }

  function onContextMenu(event: Event): void {
    // 길게 누르기(= 브레이크)가 컨텍스트 메뉴로 가로채이지 않게 한다.
    event.preventDefault();
  }

  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onPointerCancel);
  target.addEventListener('contextmenu', onContextMenu);

  return {
    isBraking(nowMs: number): boolean {
      if (pointerId === null) return false;
      if (braking) return true;
      if (!brakeEligible) return false;
      if (maxMoveDist > BRAKE_MOVE_TOLERANCE_PX) return false; // 이미 휘두른 제스처 → 플릭이다
      if (!Number.isFinite(nowMs) || nowMs - downT < BRAKE_HOLD_MS) return false;
      braking = true;
      return true;
    },

    reset(): void {
      clearGesture();
      lastTap = null;
    },

    dispose(): void {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerCancel);
      target.removeEventListener('contextmenu', onContextMenu);
      clearGesture();
    },
  };
}
