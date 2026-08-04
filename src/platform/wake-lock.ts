// Screen Wake Lock — 회전 중 화면 꺼짐 방지. 미지원 환경에서는 무시한다.
//
// 스피너는 몇 분씩 손을 대지 않고 바라보는 화면이라, 잠금이 없으면 감속 도중에 화면이 꺼진다.
// 잠금 요청은 사용자 제스처 이후에만 허용되므로 최초 인터랙션에서 `enable()` 을 부른다.
// 그 뒤로는 계속 유지한다 — 회전 여부에 따라 잡았다 놨다 하지 않는다(요청 실패 위험만 늘고,
// 브라우저가 탭이 숨겨질 때 알아서 해제한다).

export interface WakeLockController {
  /** 잠금을 켠다. 사용자 제스처 핸들러 안에서 처음 불러야 한다. 이미 켜져 있으면 무시된다. */
  enable(): void;
  /** 잠금을 끄고 보유 중인 센티널을 해제한다. */
  disable(): void;
  dispose(): void;
}

/**
 * Wake Lock 컨트롤러를 만든다.
 *
 * 실패는 전부 삼킨다. 미지원 브라우저, 배터리 절약 모드, 권한 정책 등 거절 사유가 여럿인데
 * 어느 쪽이든 앱이 못 돌 이유는 아니다 — 화면이 좀 일찍 꺼질 뿐이다.
 *
 * 탭이 숨겨지면 브라우저가 잠금을 자동 해제하므로, 돌아올 때 다시 잡는다.
 */
export function createWakeLock(): WakeLockController {
  let enabled = false;
  let sentinel: WakeLockSentinel | null = null;
  let pending = false;

  function onSentinelRelease(): void {
    sentinel = null;
  }

  function acquire(): void {
    if (!enabled || pending || sentinel !== null) return;
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return; // 숨겨진 상태의 요청은 반드시 거절된다

    pending = true;
    navigator.wakeLock
      .request('screen')
      .then((next) => {
        pending = false;
        if (!enabled) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
        next.addEventListener('release', onSentinelRelease);
      })
      .catch(() => {
        pending = false;
      });
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') acquire();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  function release(): void {
    const held = sentinel;
    sentinel = null;
    if (held === null) return;
    held.removeEventListener('release', onSentinelRelease);
    void held.release().catch(() => {});
  }

  return {
    enable(): void {
      if (enabled) return;
      enabled = true;
      acquire();
    },

    disable(): void {
      enabled = false;
      release();
    },

    dispose(): void {
      enabled = false;
      release();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
