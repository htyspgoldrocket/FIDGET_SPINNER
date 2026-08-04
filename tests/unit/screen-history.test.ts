// L0 — 화면 ↔ 히스토리 대응 (CLAUDE.md 8장 3번).
//
// e2e 는 "실제 백버튼으로 패널이 닫힌다"를 확인한다. 여기서는 실브라우저에서 만들어내기
// 번거로운 경계 — 어긋난 상태에서의 닫기 요청, 새로고침 복원, 남의 히스토리 상태 — 를 본다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachScreenHistory,
  type HistoryHost,
  type HistoryScreen,
} from '../../src/platform/screen-history';

/**
 * 브라우저 히스토리의 최소 모형. 엔트리 배열 + 현재 위치이고, back() 은 위치만 옮긴 뒤
 * popstate 를 동기로 쏜다 (실제 브라우저는 비동기지만 순서는 같다).
 */
function createFakeHost(initialState: unknown = null): HistoryHost & {
  entries: unknown[];
  index: number;
  forward(): void;
} {
  const listeners = new Set<() => void>();
  const host = {
    entries: [initialState] as unknown[],
    index: 0,

    history: {
      get state(): unknown {
        return host.entries[host.index];
      },
      pushState(data: unknown): void {
        // 앞쪽 엔트리는 버려진다 — 실제 히스토리와 같다.
        host.entries = [...host.entries.slice(0, host.index + 1), data];
        host.index += 1;
      },
      back(): void {
        if (host.index === 0) throw new Error('앱 밖으로 나갔다 (TWA 라면 종료)');
        host.index -= 1;
        for (const listener of listeners) listener();
      },
    },

    forward(): void {
      host.index += 1;
      for (const listener of listeners) listener();
    },

    addEventListener(_type: 'popstate', listener: () => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: 'popstate', listener: () => void): void {
      listeners.delete(listener);
    },
  };
  return host;
}

/** open/close 호출을 기록하는 화면. 실제 StatsPanel 과 같은 모양이다. */
function createFakeScreen(): HistoryScreen & { openCalls: number; closeCalls: number } {
  let opened = false;
  return {
    openCalls: 0,
    closeCalls: 0,
    isOpen(): boolean {
      return opened;
    },
    open(): void {
      if (opened) return;
      opened = true;
      this.openCalls += 1;
    },
    close(): void {
      if (!opened) return;
      opened = false;
      this.closeCalls += 1;
    },
  };
}

describe('attachScreenHistory', () => {
  let host: ReturnType<typeof createFakeHost>;
  let screen: ReturnType<typeof createFakeScreen>;

  beforeEach(() => {
    host = createFakeHost();
    screen = createFakeScreen();
  });

  it('붙이는 것만으로는 히스토리를 건드리지 않는다 (백버튼 = 앱 종료 유지)', () => {
    attachScreenHistory('stats', screen, host);

    expect(host.entries).toHaveLength(1);
    expect(host.index).toBe(0);
    expect(screen.isOpen()).toBe(false);
    // 이 상태의 back 은 앱 밖으로 나가는 것이 정상이다.
    expect(() => host.history.back()).toThrow('앱 밖으로 나갔다');
  });

  it('열면 엔트리가 하나 생기고, 뒤로가기가 닫는다', () => {
    const nav = attachScreenHistory('stats', screen, host);

    nav.requestOpen();
    expect(screen.isOpen()).toBe(true);
    expect(host.entries).toHaveLength(2);
    expect(host.history.state).toEqual({ screen: 'stats' });

    host.history.back(); // 안드로이드 백버튼
    expect(screen.isOpen()).toBe(false);
    expect(host.index).toBe(0);
  });

  it('닫기 요청은 뒤로가기로 처리해 엔트리를 남기지 않는다', () => {
    const nav = attachScreenHistory('stats', screen, host);

    for (let i = 0; i < 3; i += 1) {
      nav.requestOpen();
      nav.requestClose();
    }

    expect(screen.isOpen()).toBe(false);
    expect(host.index).toBe(0);
    expect(host.history.state).toBeNull();
  });

  it('이미 열려 있으면 다시 push 하지 않는다', () => {
    const nav = attachScreenHistory('stats', screen, host);

    nav.requestOpen();
    nav.requestOpen();
    nav.requestOpen();

    expect(host.entries).toHaveLength(2);
    expect(screen.openCalls).toBe(1);
  });

  it('닫혀 있을 때의 닫기 요청은 아무것도 하지 않는다', () => {
    const nav = attachScreenHistory('stats', screen, host);
    const back = vi.spyOn(host.history, 'back');

    nav.requestClose();

    expect(back).not.toHaveBeenCalled();
    expect(host.index).toBe(0);
  });

  it('우리 엔트리 위가 아닌데 화면이 열려 있으면 back 대신 그냥 닫는다', () => {
    // 히스토리를 거치지 않고 코드가 직접 open() 한 상태. 여기서 back 을 부르면 앱이 꺼진다.
    const nav = attachScreenHistory('stats', screen, host);
    screen.open();
    const back = vi.spyOn(host.history, 'back');

    nav.requestClose();

    expect(back).not.toHaveBeenCalled();
    expect(screen.isOpen()).toBe(false);
  });

  it('새로고침처럼 화면 엔트리에서 시작하면 화면을 열어 히스토리와 맞춘다', () => {
    const restored = createFakeHost({ screen: 'stats' });
    attachScreenHistory('stats', screen, restored);

    expect(screen.isOpen()).toBe(true);
    expect(restored.entries).toHaveLength(1); // 복원하면서 엔트리를 더 만들지 않는다
  });

  it('다른 화면 이름의 엔트리에는 반응하지 않는다', () => {
    const other = createFakeHost({ screen: 'settings' });
    attachScreenHistory('stats', screen, other);

    expect(screen.isOpen()).toBe(false);
  });

  it('앞으로 가기로 돌아오면 화면이 다시 열린다', () => {
    const nav = attachScreenHistory('stats', screen, host);

    nav.requestOpen();
    host.history.back();
    expect(screen.isOpen()).toBe(false);

    host.forward();
    expect(screen.isOpen()).toBe(true);
  });

  it('dispose 후에는 popstate 를 따르지 않는다', () => {
    const nav = attachScreenHistory('stats', screen, host);

    nav.requestOpen();
    nav.dispose();
    host.history.back();

    expect(screen.isOpen()).toBe(true); // 구독을 끊었으므로 화면은 그대로다
  });
});
