// navigator.vibrate 를 호출하는 유일한 파일 (CLAUDE.md 규칙 2). 미지원 시 NoopDriver 폴백.
//
// **진동 지원 여부의 판정도 여기서 한다.** capability.ts 가 `navigator.vibrate` 를 들여다보면
// 규칙 2 의 셀렉터를 우회하는 셈이 되므로, 그쪽에는 이 파일이 내보내는 불리언만 넘긴다.
// 규칙을 예외로 풀지 않고 구조로 지킨다.
//
// 브라우저 전역은 `VibrationHost` 하나로 감싼다. 드라이버 본체는 이 인터페이스만 보고 동작하므로
// DOM 없는 node 환경(vitest)에서도 가짜 host 로 호출 시퀀스를 그대로 검증할 수 있다.

import { PULSE_MS_FAST } from '../core/constants';

/** 드라이버가 실제로 필요로 하는 브라우저 기능의 최소 집합. */
export interface VibrationHost {
  /** 진동 실행. 0 이면 즉시 중단. */
  vibrate(durationMs: number): boolean;
  /** 지금 탭이 보이는 상태인가. */
  isVisible(): boolean;
  /** visibility 변경 구독. 해제 함수를 돌려준다. */
  onVisibilityChange(listener: () => void): () => void;
}

/** 진동 스케줄러의 출력을 받아 실제로 발사하는 쪽. */
export interface HapticDriver {
  /** 이 드라이버가 실제로 진동을 낼 수 있는가. NoopDriver 는 false. */
  readonly supported: boolean;
  /** 펄스 1회. 스케줄러가 "발사하라"고 준 것만 넘긴다 (rAF 콜백에서 직접 부르지 않는다). */
  pulse(durationMs: number): void;
  /** 최초 사용자 제스처에서 1회. 브라우저의 진동 권한을 깨우는 웜업 펄스다. */
  warmUp(): void;
  /** 진행 중인 진동을 즉시 중단한다. */
  stop(): void;
  /** 구독 해제 + 정지. */
  dispose(): void;
}

/** navigator 중 이 파일이 쓰는 부분만. 테스트가 가짜 객체를 넘길 수 있게 구조적으로 좁힌다. */
interface VibrationNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
}

/** document 중 이 파일이 쓰는 부분만. */
interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * 진동 API 존재 여부. **호출하지 않고 존재만 본다.**
 * capability.ts 는 이 함수의 결과만 쓰고 navigator 를 직접 만지지 않는다.
 */
export function isVibrationSupported(nav: VibrationNavigator = navigator): boolean {
  return typeof nav.vibrate === 'function';
}

/**
 * 실제 브라우저 전역에 연결된 host. 진동을 지원하지 않으면 null 을 돌려준다.
 * 기본 인자로 전역을 받으므로 테스트에서는 가짜 navigator / document 를 넘기면 된다.
 */
export function createBrowserVibrationHost(
  nav: VibrationNavigator = navigator,
  doc: VisibilityDocument = document,
): VibrationHost | null {
  const vibrateFn = nav.vibrate;
  if (typeof vibrateFn !== 'function') return null;

  return {
    vibrate(durationMs: number): boolean {
      // navigator 에 바인딩해서 부른다 (떼어내서 호출하면 일부 브라우저가 예외를 던진다).
      return vibrateFn.call(nav, durationMs);
    },
    isVisible(): boolean {
      return doc.visibilityState === 'visible';
    },
    onVisibilityChange(listener: () => void): () => void {
      doc.addEventListener('visibilitychange', listener);
      return () => doc.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * 진동을 내지 않는 드라이버. 미지원 플랫폼(iOS / Firefox)에서 쓰인다.
 * 호출부가 분기 없이 그대로 쓸 수 있도록 인터페이스는 동일하게 유지한다 — 전부 조용한 no-op 이다.
 */
export function createNoopDriver(): HapticDriver {
  return {
    supported: false,
    pulse(): void {},
    warmUp(): void {},
    stop(): void {},
    dispose(): void {},
  };
}

/**
 * host 를 통해 실제로 진동을 내는 드라이버.
 *
 * - 탭이 보이지 않으면 발사하지 않는다. visibility 가 깨지는 순간 즉시 vibrate(0) 로 끊는다
 *   (CLAUDE.md 5장). 게임 루프가 멈추는 것과 별개로 드라이버 스스로 보장한다.
 * - host 가 던지는 예외는 전부 삼킨다. 진동은 실패해도 앱이 죽으면 안 되는 부가 기능이다.
 */
export function createVibrationDriver(host: VibrationHost): HapticDriver {
  let disposed = false;
  let warmedUp = false;

  function safeVibrate(durationMs: number): void {
    try {
      host.vibrate(durationMs);
    } catch {
      // 무시한다. 진동 실패로 프레임 루프를 끊지 않는다.
    }
  }

  function visible(): boolean {
    try {
      return host.isVisible();
    } catch {
      return false;
    }
  }

  const unsubscribe = host.onVisibilityChange(() => {
    if (!visible()) safeVibrate(0);
  });

  function pulse(durationMs: number): void {
    if (disposed) return;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    if (!visible()) return;
    safeVibrate(Math.round(durationMs));
  }

  return {
    supported: true,
    pulse,

    warmUp(): void {
      if (warmedUp || disposed) return;
      warmedUp = true;
      // 가장 짧은 펄스로 깨운다. 첫 탭에서 사용자가 의아해하지 않을 만큼 짧아야 한다.
      pulse(PULSE_MS_FAST);
    },

    stop(): void {
      if (disposed) return;
      safeVibrate(0);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      safeVibrate(0);
    },
  };
}

/**
 * 앱이 쓰는 팩토리. 진동을 지원하면 실제 드라이버를, 아니면 NoopDriver 를 돌려준다.
 * `enabled=false` 로 강제로 끌 수도 있다 (capability 판정이 iOS/Firefox 를 걸러낸 경우).
 */
export function createHapticDriver(enabled = true): HapticDriver {
  if (!enabled) return createNoopDriver();
  const host = createBrowserVibrationHost();
  return host === null ? createNoopDriver() : createVibrationDriver(host);
}
