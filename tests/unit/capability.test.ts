// 플랫폼 능력 판정. UA 파싱은 순수 함수이므로 DOM 없이 검증한다.
// (안내 배너의 DOM 조립은 e2e 에서 실제 브라우저로 확인한다.)

import { describe, expect, it } from 'vitest';

import { describePlatform, unsupportedMessage } from '../../src/platform/capability';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0',
} as const;

describe('describePlatform', () => {
  it('Android Chrome / Samsung Internet 은 진동을 쓴다', () => {
    for (const ua of [UA.androidChrome, UA.samsungInternet]) {
      expect(describePlatform(ua, true)).toEqual({ vibration: true, ios: false, firefox: false });
    }
  });

  it('API 가 없으면 UA 와 무관하게 미지원이다', () => {
    expect(describePlatform(UA.androidChrome, false).vibration).toBe(false);
  });

  it('iOS 는 API 가 있다고 주장해도 믿지 않는다', () => {
    const capability = describePlatform(UA.iphoneSafari, true);
    expect(capability).toEqual({ vibration: false, ios: true, firefox: false });
  });

  it('Firefox 는 API 가 있다고 주장해도 믿지 않는다', () => {
    const capability = describePlatform(UA.androidFirefox, true);
    expect(capability).toEqual({ vibration: false, ios: false, firefox: true });
  });

  it('iOS Firefox 는 둘 다로 판정된다', () => {
    const capability = describePlatform(UA.iosFirefox, true);
    expect(capability.ios).toBe(true);
    expect(capability.firefox).toBe(true);
    expect(capability.vibration).toBe(false);
  });

  it('빈 UA 여도 예외 없이 판정한다', () => {
    expect(describePlatform('', true).vibration).toBe(true);
    expect(describePlatform('', false).vibration).toBe(false);
  });
});

describe('unsupportedMessage', () => {
  it('원인별로 다른 안내를 준다', () => {
    const ios = unsupportedMessage(describePlatform(UA.iphoneSafari, false));
    const firefox = unsupportedMessage(describePlatform(UA.androidFirefox, false));
    const other = unsupportedMessage(describePlatform(UA.androidChrome, false));

    expect(ios).toContain('iOS');
    expect(firefox).toContain('Firefox');
    expect(other).not.toContain('Firefox');

    // 어떤 경우든 "어디로 가면 되는지"를 알려준다.
    for (const message of [ios, firefox, other]) {
      expect(message).toContain('Android Chrome');
    }
  });
});
