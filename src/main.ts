// 조립 + 게임 루프. core/platform/render/ui 를 여기서만 엮는다.
//
// 시간 소스는 rAF 타임스탬프 하나뿐이다. 포인터 입력이 쓰는 event.timeStamp 와 같은 시계라
// 브레이크 홀드 판정이 프레임 시각과 그대로 비교된다. Date.now 는 쓰지 않는다.

import { createHapticState, scheduleHaptics, type HapticState } from './core/haptic-scheduler';
import { advance, applyImpulse, createSpinState, halt, type SpinState } from './core/physics';
import { detectCapability, mountUnsupportedNotice } from './platform/capability';
import { attachPointerInput } from './platform/pointer-input';
import { createHapticDriver } from './platform/vibration-driver';
import { createWakeLock } from './platform/wake-lock';
import { createCanvasRenderer } from './render/canvas-renderer';
import { createDebugOverlay, isDebugEnabled, type DebugOverlay } from './render/debug-overlay';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('#stage 캔버스를 찾지 못했다.');

const renderer = createCanvasRenderer(canvas);
const wakeLock = createWakeLock();

// 진동: 지원 여부를 먼저 판정하고, 안 되는 플랫폼이면 NoopDriver + 안내 배너로 떨어진다.
// 드라이버는 visibility 변경을 스스로 구독해 즉시 vibrate(0) 한다 (CLAUDE.md 5장).
const capability = detectCapability();
const driver = createHapticDriver(capability.vibration);
mountUnsupportedNotice(capability, document.body);

// ?debug=1 이 없으면 오버레이는 만들지 않는다 — 프레임 루프의 비용은 null 검사 하나뿐이다.
const overlay: DebugOverlay | null = isDebugEnabled(window.location.search)
  ? createDebugOverlay(document.body)
  : null;

let state: SpinState = createSpinState();
let haptics: HapticState = createHapticState();

const input = attachPointerInput(canvas, () => renderer.layout(), {
  onFlick(deltaOmega: number): void {
    state = applyImpulse(state, deltaOmega);
  },
  onDoubleTap(): void {
    state = halt(state);
  },
  onFirstInteraction(): void {
    // Wake Lock 요청과 진동은 사용자 제스처 이후에만 허용된다.
    // 웜업 펄스로 진동 권한을 깨워두지 않으면 첫 디텐트 펄스가 조용히 무시된다.
    wakeLock.enable();
    driver.warmUp();
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

  const isBraking = input.isBraking(nowMs);
  const prevTheta = state.theta;
  const stepped = advance(state, frameDt, isBraking);
  state = stepped.state;

  // 진동은 여기서 직접 부르지 않는다. 스케줄러가 "발사하라"고 준 것만 드라이버로 넘긴다
  // (CLAUDE.md 규칙 3). 한 프레임에 넘어오는 펄스는 최대 1개임이 스케줄러에서 보장된다.
  const scheduled = scheduleHaptics(haptics, {
    prevTheta,
    theta: state.theta,
    omega: state.omega,
    isBraking,
    nowMs,
  });
  haptics = scheduled.state;
  for (const pulse of scheduled.pulses) driver.pulse(pulse.durationMs);

  renderer.render(state.theta);

  overlay?.record({
    nowMs,
    omega: state.omega,
    frameDtMs: frameDt * 1000,
    substeps: stepped.substeps,
    droppedSec: stepped.droppedSec,
    pulses: scheduled.pulses,
    totalPulses: haptics.totalPulses,
    droppedPulses: haptics.droppedPulses,
  });
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
// 진동 중단은 드라이버가 같은 이벤트를 스스로 구독해 처리한다 (여기서 중복으로 부르지 않는다).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startLoop();
  } else {
    stopLoop();
    input.reset();
  }
});

startLoop();
