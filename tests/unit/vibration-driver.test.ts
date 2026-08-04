// L2 — 진동 드라이버. navigator.vibrate 를 목킹하고 **호출 시퀀스**를 그대로 검증한다.
//
// 드라이버 본체는 VibrationHost 인터페이스만 보므로 DOM 없이도 돌지만, 실제 브라우저 배선
// (navigator.vibrate 바인딩 / visibilitychange 구독)까지 확인하기 위해 가짜 navigator·document 를
// createBrowserVibrationHost 에 주입하는 테스트를 따로 둔다.

import { describe, expect, it, vi } from 'vitest';

import { PULSE_MS_FAST } from '../../src/core/constants';
import {
  createBrowserVibrationHost,
  createHapticDriver,
  createNoopDriver,
  createVibrationDriver,
  isVibrationSupported,
  type VibrationHost,
} from '../../src/platform/vibration-driver';

interface FakeHost extends VibrationHost {
  /** vibrate 로 넘어온 값의 순서. */
  readonly calls: number[];
  /** visibilitychange 를 흉내 낸다. */
  setVisible(visible: boolean): void;
  readonly listenerCount: () => number;
}

function createFakeHost(options: { throws?: boolean } = {}): FakeHost {
  const calls: number[] = [];
  const listeners = new Set<() => void>();
  let visible = true;

  return {
    calls,
    vibrate(durationMs: number): boolean {
      if (options.throws === true) throw new Error('vibrate 실패');
      calls.push(durationMs);
      return true;
    },
    isVisible: () => visible,
    onVisibilityChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible(next: boolean): void {
      visible = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('지원 감지', () => {
  it('vibrate 가 함수일 때만 지원으로 본다', () => {
    expect(isVibrationSupported({ vibrate: () => true })).toBe(true);
    expect(isVibrationSupported({})).toBe(false);
    expect(isVibrationSupported({ vibrate: undefined } as never)).toBe(false);
  });

  it('미지원 navigator 면 브라우저 host 를 만들지 않는다', () => {
    const doc = {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(createBrowserVibrationHost({}, doc)).toBeNull();
  });
});

describe('펄스 발사', () => {
  it('스케줄러가 준 길이 그대로 순서대로 나간다', () => {
    const host = createFakeHost();
    const driver = createVibrationDriver(host);

    driver.pulse(8);
    driver.pulse(18);
    driver.pulse(30);

    expect(host.calls).toEqual([8, 18, 30]);
    expect(driver.supported).toBe(true);
  });

  it('길이는 정수로 반올림해서 넘긴다', () => {
    const host = createFakeHost();
    createVibrationDriver(host).pulse(17.45);
    expect(host.calls).toEqual([17]);
  });

  it('0 이하 / 비유한 길이는 아예 부르지 않는다', () => {
    const host = createFakeHost();
    const driver = createVibrationDriver(host);

    driver.pulse(0);
    driver.pulse(-5);
    driver.pulse(Number.NaN);
    driver.pulse(Number.POSITIVE_INFINITY);

    expect(host.calls).toEqual([]);
  });

  it('stop() 은 vibrate(0) 이다', () => {
    const host = createFakeHost();
    createVibrationDriver(host).stop();
    expect(host.calls).toEqual([0]);
  });
});

describe('웜업 펄스', () => {
  it('첫 호출에서 한 번만 나간다', () => {
    const host = createFakeHost();
    const driver = createVibrationDriver(host);

    driver.warmUp();
    driver.warmUp();
    driver.warmUp();

    expect(host.calls).toEqual([PULSE_MS_FAST]);
  });
});

describe('⑥ visibility', () => {
  it('보이지 않게 되는 순간 즉시 vibrate(0) 이 나간다', () => {
    const host = createFakeHost();
    createVibrationDriver(host);

    host.setVisible(false);

    expect(host.calls).toEqual([0]);
  });

  it('숨겨진 동안에는 펄스를 발사하지 않는다', () => {
    const host = createFakeHost();
    const driver = createVibrationDriver(host);

    host.setVisible(false);
    driver.pulse(18);
    driver.warmUp();

    expect(host.calls).toEqual([0]); // 중단 호출 하나뿐

    host.setVisible(true);
    driver.pulse(18);
    expect(host.calls).toEqual([0, 18]);
  });

  it('다시 보이게 될 때는 아무것도 부르지 않는다', () => {
    const host = createFakeHost();
    createVibrationDriver(host);
    host.setVisible(true);
    expect(host.calls).toEqual([]);
  });

  it('dispose() 는 구독을 풀고 진동을 끊는다', () => {
    const host = createFakeHost();
    const driver = createVibrationDriver(host);
    expect(host.listenerCount()).toBe(1);

    driver.dispose();
    expect(host.calls).toEqual([0]);
    expect(host.listenerCount()).toBe(0);

    driver.pulse(18);
    driver.stop();
    expect(host.calls).toEqual([0]); // dispose 뒤에는 아무것도 나가지 않는다
  });
});

describe('⑦ 미지원 / 실패 환경', () => {
  it('NoopDriver 는 어떤 호출에도 예외를 내지 않는다', () => {
    const driver = createNoopDriver();
    expect(driver.supported).toBe(false);
    expect(() => {
      driver.pulse(18);
      driver.warmUp();
      driver.stop();
      driver.dispose();
    }).not.toThrow();
  });

  it('enabled=false 면 NoopDriver 로 떨어진다', () => {
    expect(createHapticDriver(false).supported).toBe(false);
  });

  it('vibrate 가 예외를 던져도 삼킨다 (프레임 루프를 끊지 않는다)', () => {
    const host = createFakeHost({ throws: true });
    const driver = createVibrationDriver(host);
    expect(() => {
      driver.pulse(18);
      driver.warmUp();
      driver.stop();
      host.setVisible(false);
      driver.dispose();
    }).not.toThrow();
  });

  it('isVisible 이 예외를 던지면 숨김으로 간주한다', () => {
    const calls: number[] = [];
    const host: VibrationHost = {
      vibrate(durationMs: number): boolean {
        calls.push(durationMs);
        return true;
      },
      isVisible(): boolean {
        throw new Error('detached');
      },
      onVisibilityChange: () => () => {},
    };
    const driver = createVibrationDriver(host);
    expect(() => driver.pulse(18)).not.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('브라우저 배선 (가짜 navigator / document 주입)', () => {
  it('navigator.vibrate 로 그대로 전달되고 visibilitychange 를 구독한다', () => {
    const listeners = new Set<() => void>();
    // vibrate 안에서 호출 대상(this)을 기록한다. 여기서 expect 를 부르면 드라이버의
    // try/catch 가 실패를 삼켜버리므로, 기록만 하고 판정은 바깥에서 한다.
    const receivers: unknown[] = [];
    const nav = {
      marker: 'navigator',
      vibrate: vi.fn(function (this: unknown, durationMs: number): boolean {
        receivers.push(this);
        return durationMs >= 0;
      }),
    };
    const doc = {
      visibilityState: 'visible',
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_type: string, listener: () => void) => {
        listeners.delete(listener);
      }),
    };
    function fireVisibilityChange(): void {
      for (const listener of listeners) listener();
    }

    const host = createBrowserVibrationHost(nav as never, doc);
    if (host === null) throw new Error('host 가 만들어져야 한다.');

    const driver = createVibrationDriver(host);
    driver.pulse(18);
    expect(nav.vibrate).toHaveBeenCalledWith(18);
    expect(doc.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    // navigator 에 바인딩된 채로 불려야 한다 (떼어내 부르면 일부 브라우저가 예외를 던진다).
    expect(receivers).toEqual([nav]);

    doc.visibilityState = 'hidden';
    fireVisibilityChange();
    expect(nav.vibrate).toHaveBeenLastCalledWith(0);

    // 숨겨진 동안에는 더 이상 발사되지 않는다.
    driver.pulse(18);
    expect(nav.vibrate).toHaveBeenLastCalledWith(0);

    driver.dispose();
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(listeners.size).toBe(0);
  });
});
