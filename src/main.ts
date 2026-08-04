// 조립 + 게임 루프. core/platform/render/ui 를 여기서만 엮는다.
//
// 시간 소스는 rAF 타임스탬프 하나뿐이다. 포인터 입력이 쓰는 event.timeStamp 와 같은 시계라
// 브레이크 홀드 판정이 프레임 시각과 그대로 비교된다. Date.now 는 쓰지 않는다.

import { advance, applyImpulse, createSpinState, halt, type SpinState } from './core/physics';
import { attachPointerInput } from './platform/pointer-input';
import { createWakeLock } from './platform/wake-lock';
import { createCanvasRenderer } from './render/canvas-renderer';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('#stage 캔버스를 찾지 못했다.');

const renderer = createCanvasRenderer(canvas);
const wakeLock = createWakeLock();

let state: SpinState = createSpinState();

const input = attachPointerInput(canvas, () => renderer.layout(), {
  onFlick(deltaOmega: number): void {
    state = applyImpulse(state, deltaOmega);
  },
  onDoubleTap(): void {
    state = halt(state);
  },
  onFirstInteraction(): void {
    // Wake Lock 요청은 사용자 제스처 이후에만 허용된다.
    wakeLock.enable();
  },
});

// ── 크기 / DPR 동기화 ──────────────────────────────────────────
// 매 프레임 레이아웃을 읽지 않는다. 크기는 ResizeObserver 로, DPR 변경은 media query 로 받는다.

let cssWidth = 0;
let cssHeight = 0;

function applySize(): void {
  renderer.resize(cssWidth, cssHeight, window.devicePixelRatio);
}

const initialRect = canvas.getBoundingClientRect();
cssWidth = initialRect.width;
cssHeight = initialRect.height;
applySize();

const resizeObserver = new ResizeObserver((entries) => {
  const rect = entries[0]?.contentRect;
  if (rect === undefined) return;
  cssWidth = rect.width;
  cssHeight = rect.height;
  applySize();
});
resizeObserver.observe(canvas);

/**
 * devicePixelRatio 변화를 구독한다. DPR 은 이벤트가 없어서, 현재 값에 정확히 걸리는
 * resolution 미디어 쿼리를 걸어두고 그 쿼리가 깨지는 순간을 변경으로 읽는다.
 * 값이 바뀌면 새 값으로 쿼리를 다시 건다 (일회성 트리거의 연쇄).
 */
function watchDevicePixelRatio(onChange: () => void): void {
  let media: MediaQueryList | null = null;

  function handleChange(): void {
    subscribe();
    onChange();
  }

  function subscribe(): void {
    media?.removeEventListener('change', handleChange);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener('change', handleChange);
  }

  subscribe();
}

watchDevicePixelRatio(applySize);

// ── 게임 루프 ──────────────────────────────────────────────────

let rafId = 0;
let lastFrameMs: number | null = null;

function frame(nowMs: number): void {
  rafId = requestAnimationFrame(frame);

  // 첫 프레임(복귀 직후 포함)은 dt = 0. 물리를 전진시키지 않고 시각 기준만 잡는다.
  const frameDt = lastFrameMs === null ? 0 : (nowMs - lastFrameMs) / 1000;
  lastFrameMs = nowMs;

  state = advance(state, frameDt, input.isBraking(nowMs)).state;
  renderer.render(state.theta);
}

function startLoop(): void {
  if (rafId !== 0) return;
  lastFrameMs = null;
  rafId = requestAnimationFrame(frame);
}

function stopLoop(): void {
  if (rafId === 0) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

// 탭이 숨겨지면 루프를 세운다. 브라우저가 rAF 를 멈추기도 하지만 명시적으로 끊어두면
// 복귀 시점의 상태가 분명해진다 — 진행 중이던 제스처도 함께 버린다(뗌 이벤트가 오지 않는다).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startLoop();
  } else {
    stopLoop();
    input.reset();
  }
});

startLoop();
