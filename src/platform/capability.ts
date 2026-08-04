// 진동 지원 여부 감지 및 iOS / Firefox 판별 (비지원 플랫폼 안내 배너용).
//
// 진동 API 자체는 여기서 만지지 않는다 — 존재 확인은 vibration-driver 의 isVibrationSupported()
// 를 통해서만 한다 (CLAUDE.md 규칙 2: navigator.vibrate 는 그 파일 밖으로 나가지 않는다).
//
// 안내 배너는 **세션 안에서만** 기억한다. localStorage 는 금지이고(규칙 4), 이 정도 안내를
// IndexedDB 에 적을 이유는 없다 — 닫으면 그 세션 동안만 다시 뜨지 않는다.

import { isVibrationSupported } from './vibration-driver';

export interface PlatformCapability {
  /** 진동을 쓸 수 있는가. 이 값이 false 면 NoopDriver 로 떨어진다. */
  readonly vibration: boolean;
  /** iOS (Safari 포함 전 브라우저). Vibration API 가 구현된 적이 없다. */
  readonly ios: boolean;
  /** Firefox. 129 부터 Vibration API 지원이 제거됐다. */
  readonly firefox: boolean;
}

/**
 * UA 문자열과 API 존재 여부로 플랫폼 능력을 판정한다. 순수 함수 — 테스트에서 UA 를 주입한다.
 *
 * UA 판별은 일부러 단순하게 둔다. 정확한 브라우저 식별이 목적이 아니라 "왜 진동이 안 되는지"
 * 안내 문구를 고르는 것이 목적이고, 판정이 틀려도 폴백 동작은 같기 때문이다.
 */
export function describePlatform(userAgent: string, vibrationApi: boolean): PlatformCapability {
  const ua = userAgent;
  const ios = /iPad|iPhone|iPod/i.test(ua);
  const firefox = /Firefox\/|FxiOS\//i.test(ua);
  // 알려진 미지원 플랫폼은 API 가 있다고 주장해도 믿지 않는다 (폴리필·래퍼가 끼어드는 경우).
  return { vibration: vibrationApi && !ios && !firefox, ios, firefox };
}

/** 실제 브라우저 환경의 능력 판정. */
export function detectCapability(): PlatformCapability {
  return describePlatform(navigator.userAgent, isVibrationSupported());
}

/** 안내 문구. 원인이 분명하면 그 원인을 말해준다. */
export function unsupportedMessage(capability: PlatformCapability): string {
  if (capability.ios) {
    return 'iOS 는 웹 진동을 지원하지 않습니다. Android Chrome 에서 진동을 지원합니다.';
  }
  if (capability.firefox) {
    return 'Firefox 는 129 버전부터 웹 진동을 지원하지 않습니다. Android Chrome 에서 진동을 지원합니다.';
  }
  return '이 브라우저는 웹 진동을 지원하지 않습니다. Android Chrome 에서 진동을 지원합니다.';
}

/**
 * 진동 미지원일 때 화면 하단에 안내 배너를 띄운다. 지원하면 아무것도 하지 않는다.
 *
 * 배너 자체는 포인터 이벤트를 받지 않는다 — 캔버스 위에 떠 있어도 플릭 제스처를 가로채지 않도록
 * 닫기 버튼만 클릭을 받는다. 반환값은 배너를 걷어내는 함수다.
 */
export function mountUnsupportedNotice(
  capability: PlatformCapability,
  host: HTMLElement,
): () => void {
  if (capability.vibration) return () => {};

  const banner = document.createElement('div');
  banner.id = 'haptic-notice';
  banner.setAttribute('role', 'status');
  Object.assign(banner.style, {
    position: 'fixed',
    left: '12px',
    right: '12px',
    bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: '10px',
    border: '1px solid rgba(57, 213, 255, 0.35)',
    background: 'rgba(14, 17, 22, 0.92)',
    color: '#cfe9f5',
    font: '13px/1.45 system-ui, sans-serif',
    zIndex: '20',
    pointerEvents: 'none',
  });

  const text = document.createElement('span');
  text.textContent = unsupportedMessage(capability);
  text.style.flex = '1';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.setAttribute('aria-label', '안내 닫기');
  Object.assign(close.style, {
    flex: '0 0 auto',
    width: '28px',
    height: '28px',
    borderRadius: '8px',
    border: '0',
    background: 'rgba(57, 213, 255, 0.14)',
    color: '#39d5ff',
    font: '13px/1 system-ui, sans-serif',
    pointerEvents: 'auto',
    cursor: 'pointer',
  });

  function remove(): void {
    close.removeEventListener('click', remove);
    banner.remove();
  }

  close.addEventListener('click', remove);
  banner.append(text, close);
  host.append(banner);

  return remove;
}
