// ?debug=1 오버레이 — ω/RPM, 펄스 타임라인, 드랍 카운터, 프레임 히스토그램 (L5 대체 장치).
//
// 촉감은 자동 테스트가 불가능하다. "느낌이 이상하다"를 숫자로 잡기 위한 도구이므로
// 항목을 줄이거나 삭제하지 않는다 (CLAUDE.md 7장).
//
// canvas-renderer 는 건드리지 않는다. 오버레이는 캔버스 위에 얹는 독립 DOM 이고,
// ?debug=1 이 없으면 이 모듈의 코드는 아예 실행되지 않는다 (main 에서 import 는 하지만
// createDebugOverlay 를 부르지 않으므로 프레임당 비용은 0 이다).

import { RPM_PER_RAD_PER_SEC } from '../core/constants';
import type { HapticPulse } from '../core/haptic-scheduler';

/** 매 프레임 오버레이에 넘기는 값. main 의 루프가 그대로 채운다. */
export interface DebugSample {
  /** rAF 타임스탬프 [ms]. */
  readonly nowMs: number;
  /** 현재 각속도 [rad/s]. */
  readonly omega: number;
  /** 직전 프레임과의 간격 [ms]. */
  readonly frameDtMs: number;
  /** advance() 가 실행한 고정 스텝 수. */
  readonly substeps: number;
  /** advance() 가 폐기한 시뮬레이션 시간 [s]. 0 이 아니면 프레임이 밀린 것이다. */
  readonly droppedSec: number;
  /** 이번 프레임에 발사된 펄스. */
  readonly pulses: readonly HapticPulse[];
  /** 누적 발사 수. */
  readonly totalPulses: number;
  /** 누적 드랍 수 (MIN_PULSE_GAP_MS 가드에 걸린 수). */
  readonly droppedPulses: number;
}

export interface DebugOverlay {
  record(sample: DebugSample): void;
  dispose(): void;
}

/** 타임라인에 보여줄 구간 [ms]. */
const TIMELINE_MS = 3000;

/** 화면 갱신 주기 [ms]. 매 프레임 DOM 을 건드리면 측정 대상인 프레임 시간 자체가 왜곡된다. */
const REPAINT_INTERVAL_MS = 100;

const TIMELINE_WIDTH = 300;
const TIMELINE_HEIGHT = 30;

/** 타임라인 막대 높이를 정규화할 최대 펄스 길이 [ms] (BRAKE 최대치 27ms + 마무리 30ms 를 덮는다). */
const MAX_PULSE_MS_FOR_SCALE = 30;

/** 프레임 시간 히스토그램의 구간 상한 [ms]. 마지막 칸은 이 상한을 넘는 프레임이다. */
const FRAME_BUCKETS_MS = [8, 12, 17, 20, 33];

/** 롱프레임 기준 [ms]. CLAUDE.md 성능 예산(>20ms 비율 ≤ 1%)과 같은 값이다. */
const LONG_FRAME_MS = 20;

/** `?debug=1` 인가. */
export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * 오버레이를 만들어 host 에 붙인다. `?debug=1` 일 때만 호출된다.
 *
 * record() 는 매 프레임 불리지만 실제 DOM 갱신은 REPAINT_INTERVAL_MS 마다 한 번만 한다.
 * 펄스 링버퍼만 프레임마다 채운다 (타임라인이 펄스를 빠뜨리면 안 되므로).
 */
export function createDebugOverlay(host: HTMLElement): DebugOverlay {
  const root = document.createElement('div');
  root.id = 'debug-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: 'calc(6px + env(safe-area-inset-top, 0px))',
    left: '6px',
    padding: '6px 8px',
    borderRadius: '8px',
    background: 'rgba(4, 8, 12, 0.72)',
    color: '#9ef01a',
    font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre',
    pointerEvents: 'none',
    zIndex: '30',
  });

  const readout = document.createElement('div');
  const canvas = document.createElement('canvas');
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  canvas.width = Math.round(TIMELINE_WIDTH * dpr);
  canvas.height = Math.round(TIMELINE_HEIGHT * dpr);
  Object.assign(canvas.style, {
    display: 'block',
    width: `${TIMELINE_WIDTH}px`,
    height: `${TIMELINE_HEIGHT}px`,
    marginTop: '4px',
    borderRadius: '4px',
    background: 'rgba(57, 213, 255, 0.08)',
  });

  root.append(readout, canvas);
  host.append(root);

  const ctx = canvas.getContext('2d');
  ctx?.scale(dpr, dpr);

  const recent: HapticPulse[] = [];
  const buckets = new Array<number>(FRAME_BUCKETS_MS.length + 1).fill(0);
  let frames = 0;
  let longFrames = 0;
  let lastPaintMs = Number.NEGATIVE_INFINITY;
  let lastPulseAtMs: number | null = null;
  let lastGapMs: number | null = null;

  function bucketOf(frameDtMs: number): number {
    for (let i = 0; i < FRAME_BUCKETS_MS.length; i += 1) {
      const edge = FRAME_BUCKETS_MS[i];
      if (edge !== undefined && frameDtMs < edge) return i;
    }
    return FRAME_BUCKETS_MS.length;
  }

  function paintTimeline(nowMs: number): void {
    if (ctx === null) return;
    ctx.clearRect(0, 0, TIMELINE_WIDTH, TIMELINE_HEIGHT);

    // 1초 격자 — 간격이 벌어지는 것을 눈으로 읽기 위한 기준선.
    ctx.fillStyle = 'rgba(207, 233, 245, 0.18)';
    for (let t = 1000; t <= TIMELINE_MS; t += 1000) {
      const x = TIMELINE_WIDTH * (1 - t / TIMELINE_MS);
      ctx.fillRect(x, 0, 1, TIMELINE_HEIGHT);
    }

    ctx.fillStyle = '#39d5ff';
    for (const pulse of recent) {
      const age = nowMs - pulse.atMs;
      if (age < 0 || age > TIMELINE_MS) continue;
      const x = TIMELINE_WIDTH * (1 - age / TIMELINE_MS);
      const scale = Math.min(pulse.durationMs / MAX_PULSE_MS_FOR_SCALE, 1);
      const height = 4 + (TIMELINE_HEIGHT - 6) * scale;
      ctx.fillRect(x - 1, TIMELINE_HEIGHT - height, 2, height);
    }
  }

  function paintReadout(sample: DebugSample): void {
    const rpm = sample.omega * RPM_PER_RAD_PER_SEC;
    const attempted = sample.totalPulses + sample.droppedPulses;
    const dropPct = attempted > 0 ? (sample.droppedPulses / attempted) * 100 : 0;
    const longPct = frames > 0 ? (longFrames / frames) * 100 : 0;
    const lastEdge = FRAME_BUCKETS_MS[FRAME_BUCKETS_MS.length - 1] ?? LONG_FRAME_MS;
    const histogram = buckets
      .map((count, i) => {
        const edge = FRAME_BUCKETS_MS[i];
        const label = edge === undefined ? `${lastEdge}+` : `<${edge}`;
        return `${label}:${count}`;
      })
      .join(' ');

    readout.textContent = [
      `ω     ${fixed(sample.omega, 2).padStart(8)} rad/s   ${fixed(rpm, 0).padStart(5)} RPM`,
      `pulse fired ${sample.totalPulses}  dropped ${sample.droppedPulses} (${fixed(dropPct, 1)}%)`,
      `gap   ${lastGapMs === null ? '—' : `${fixed(lastGapMs, 1)}ms`}   최근 3초 ${recent.length}발`,
      `frame ${fixed(sample.frameDtMs, 1)}ms  sub ${sample.substeps}  drop ${fixed(sample.droppedSec * 1000, 1)}ms`,
      `hist  ${histogram}  long ${fixed(longPct, 2)}%`,
    ].join('\n');
  }

  return {
    record(sample: DebugSample): void {
      const { nowMs } = sample;

      if (Number.isFinite(sample.frameDtMs) && sample.frameDtMs > 0) {
        frames += 1;
        const index = bucketOf(sample.frameDtMs);
        buckets[index] = (buckets[index] ?? 0) + 1;
        if (sample.frameDtMs > LONG_FRAME_MS) longFrames += 1;
      }

      for (const pulse of sample.pulses) {
        recent.push(pulse);
        if (lastPulseAtMs !== null) lastGapMs = pulse.atMs - lastPulseAtMs;
        lastPulseAtMs = pulse.atMs;
      }
      // 3초를 벗어난 것은 앞에서부터 버린다 (시각 오름차순으로만 들어온다).
      while (recent.length > 0 && nowMs - (recent[0]?.atMs ?? nowMs) > TIMELINE_MS) {
        recent.shift();
      }

      if (nowMs - lastPaintMs < REPAINT_INTERVAL_MS) return;
      lastPaintMs = nowMs;
      paintReadout(sample);
      paintTimeline(nowMs);
    },

    dispose(): void {
      root.remove();
    },
  };
}
