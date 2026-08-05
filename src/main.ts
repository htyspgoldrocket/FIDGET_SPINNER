// 조립 + 게임 루프. core/platform/render/ui 를 여기서만 엮는다.
//
// 시간 소스는 rAF 타임스탬프 하나뿐이다. 포인터 입력이 쓰는 event.timeStamp 와 같은 시계라
// 브레이크 홀드 판정이 프레임 시각과 그대로 비교된다. Date.now 는 쓰지 않는다.

import { createHapticState, scheduleHaptics, type HapticState } from './core/haptic-scheduler';
import { clampFlickSensitivity, flickOmegaCap } from './core/input-model';
import { advance, applyImpulse, createSpinState, halt, type SpinState } from './core/physics';
import {
  createStatsState,
  EMPTY_SPIN_AGGREGATE,
  mergeSpin,
  trackSpin,
  type CompletedSpin,
  type SpinAggregate,
  type StatsState,
} from './core/stats';
import { detectCapability, mountUnsupportedNotice } from './platform/capability';
import { attachPointerInput } from './platform/pointer-input';
import { attachScreenHistory } from './platform/screen-history';
import { DEFAULT_SETTINGS, newSpinRecord, type Settings } from './platform/storage/adapter';
import { aggregateStats, createStorage } from './platform/storage/indexeddb';
import { createHapticDriver } from './platform/vibration-driver';
import { createWakeLock } from './platform/wake-lock';
import { createCanvasRenderer } from './render/canvas-renderer';
import { createDebugOverlay, isDebugEnabled, type DebugOverlay } from './render/debug-overlay';
import { mountPanel } from './ui';

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
let stats: StatsState = createStatsState();

// ── 기록 ───────────────────────────────────────────────────────
// 저장은 전부 fire-and-forget 이다. IndexedDB 가 느리든 막혀 있든 게임 루프는 기다리지 않고,
// 실패해도 삼킨다 — 기록을 못 남기는 것이 회전이 끊기는 것보다 낫다.
// 화면에 보이는 숫자는 로컬에서 즉시 갱신한다. 저장소도 같은 mergeSpin 으로 집계하므로
// 두 값이 벌어지지 않는다 (indexeddb.ts 의 putRecord 참조).

const storage = createStorage();
let aggregate: SpinAggregate = EMPTY_SPIN_AGGREGATE;

// ── 사용자 설정 ────────────────────────────────────────────────
// 슬라이더·설명서는 이 객체 하나만 바꾼다. 입력 레이어는 플릭이 끝나는 순간 게터로 읽어가므로
// 새로 붙일 것도, 다시 조립할 것도 없다 — 다음 플릭부터 바로 새 값이다.
//
// 저장만 미룬다. 슬라이더를 한 번 끌면 눈금 수만큼 input 이 오는데, 그때마다 쓰면
// 저장 트랜잭션이 줄줄이 밀려 마지막 값이 언제 확정되는지 알 수 없게 된다.

const SETTINGS_SAVE_DEBOUNCE_MS = 300;

const settings: Settings = { ...DEFAULT_SETTINGS };
/** 저장소에서 읽어오기 전에 사용자가 먼저 슬라이더를 움직였는가. 그랬다면 읽어온 값으로 덮지 않는다. */
let sensitivityTouched = false;
let settingsSaveTimer = 0;

function writeSettings(): void {
  // 실패는 삼킨다. 적용은 이미 끝났고, 못 남긴 것은 다음 조작 때 다시 시도된다.
  void storage.putSettings({ ...settings }).catch(() => undefined);
}

function saveSettingsSoon(): void {
  if (settingsSaveTimer !== 0) window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = 0;
    writeSettings();
  }, SETTINGS_SAVE_DEBOUNCE_MS);
}

/** 미뤄둔 저장이 있으면 지금 쓴다. 탭이 숨겨질 때 부른다 — 안드로이드는 예고 없이 페이지를 버린다. */
function flushSettings(): void {
  if (settingsSaveTimer === 0) return;
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = 0;
  writeSettings();
}

const panel = mountPanel(document.body, {
  onExport: () => storage.export(),
  async onImport(code: string): Promise<void> {
    await storage.import(code);
    aggregate = aggregateStats(await storage.getAggregate());
    panel.setAggregate(aggregate);
  },
  onSensitivityChange(sensitivity: number): void {
    settings.flickSensitivity = clampFlickSensitivity(sensitivity);
    sensitivityTouched = true;
    saveSettingsSoon();
  },
  onManualViewed(): void {
    // 설명서를 한 번이라도 보면 다음 실행부터 자동으로 띄우지 않는다. 디바운스를 거치지 않고
    // 즉시 쓴다 — 이 표시가 저장되지 못하면 사용자는 실행할 때마다 설명서를 다시 만난다.
    if (settings.manualSeen) return;
    settings.manualSeen = true;
    writeSettings();
  },
  // 패널 열고 닫기는 히스토리를 거친다 — 안드로이드 백버튼으로 닫히게 하기 위해서다.
  // 훅은 mount 시점이 아니라 클릭 시점에 불리므로 아래에서 채워도 늦지 않는다.
  onOpenRequest: () => panelHistory.requestOpen(),
  onCloseRequest: () => panelHistory.requestClose(),
});

const panelHistory = attachScreenHistory('stats', panel);

// 어느 경로로 저장되고 있는지 DOM 에 남긴다. 실기기에서 "기록이 안 남는다"를 진단할 때,
// 폴백으로 떨어졌는지(저장소 차단) 저장 자체가 실패했는지를 가르는 유일한 단서다.
void storage.usingFallback.then((fallback) => {
  document.documentElement.dataset['storage'] = fallback ? 'memory' : 'indexeddb';
});

void storage
  .getAggregate()
  .then((stored) => {
    aggregate = aggregateStats(stored);
    panel.setAggregate(aggregate);
  })
  .catch(() => {
    // 읽지 못하면 0 에서 시작한다. 이번 세션의 기록은 계속 쌓이고 저장도 계속 시도한다.
  });

void storage
  .getSettings()
  .then((stored) => {
    if (!sensitivityTouched) {
      // 읽어오는 사이에 사용자가 이미 슬라이더를 움직였다면 그쪽이 최신이다.
      settings.flickSensitivity = clampFlickSensitivity(stored.flickSensitivity);
      panel.setSensitivity(settings.flickSensitivity);
    }
    // 최초 실행이면 설명서부터 보여준다 (히스토리를 거치므로 백버튼 = 설명서 닫기).
    // 이 실행 중에 이미 봤다면(저장이 읽히기 전에 사용자가 열어봤다면) 다시 띄우지 않는다.
    if (!stored.manualSeen && !settings.manualSeen) {
      panel.setTab('manual');
      panelHistory.requestOpen();
    } else {
      settings.manualSeen = true;
    }
  })
  .catch(() => {
    // 못 읽으면 기본 배율로 간다. 슬라이더는 이미 기본값에 맞춰져 있다.
    // 설명서 자동 표시는 저장이 안 되는 환경이라 매번 뜨게 된다 — 띄우지 않는 쪽을 고른다.
  });

function recordSpin(spin: CompletedSpin): void {
  aggregate = mergeSpin(aggregate, spin);
  panel.setAggregate(aggregate);
  void storage.putRecord(newSpinRecord(spin)).catch(() => {});
}

const input = attachPointerInput(
  canvas,
  () => renderer.layout(),
  {
    onFlick(deltaOmega: number): void {
      // 민감도는 플릭의 세기(게터로 이미 반영)뿐 아니라 도달 가능한 최고 속도도 정한다.
      // 상한을 함께 낮추지 않으면 연속 플릭이 항상 OMEGA_MAX 에 붙어 설정 차이가 사라진다.
      state = applyImpulse(state, deltaOmega, flickOmegaCap(settings.flickSensitivity));
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
  },
  () => settings.flickSensitivity,
);

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

  // 회전 세션 추적. 세션이 끝난 프레임에만 completed 가 나온다 (프레임당 최대 하나).
  const tracked = trackSpin(stats, {
    prevTheta,
    theta: state.theta,
    omega: state.omega,
    isBraking,
    nowMs,
  });
  stats = tracked.state;
  if (tracked.completed !== null) recordSpin(tracked.completed);

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
    flushSettings();
  }
});

// ── 배포 갱신 ──────────────────────────────────────────────────
// 서비스 워커는 프리캐시한 셸을 먼저 내주므로, 배포 뒤 첫 방문은 옛 화면이고 새 워커는
// 백그라운드에서 skipWaiting + claim 으로 페이지를 넘겨받는다. 그 넘겨받는 순간
// (controllerchange) 한 번만 새로고침해 두 번째 방문을 기다리지 않고 새 셸을 보여준다.
// hadController 가드: 최초 설치의 claim 은 이전 컨트롤러가 없다 — 첫 화면을 리로드로
// 날리지 않는다. reloaded 가드: 리로드는 어떤 경우에도 1회.
if ('serviceWorker' in navigator) {
  const hadController = navigator.serviceWorker.controller !== null;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

startLoop();
