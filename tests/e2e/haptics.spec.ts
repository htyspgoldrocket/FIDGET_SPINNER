// L3 — Phase 3(햅틱)이 실제 브라우저에서 붙어 도는지 확인한다.
//
// 단위 테스트는 스케줄러가 "언제 쏘라고 하는가"를 검증한다. 여기서는 그 결정이 실제
// navigator.vibrate 호출로 어떤 간격을 만드는지를 본다 — rAF 타이밍까지 포함한 진짜 시퀀스다.
// 브라우저 바이너리는 별도 설치가 필요하다: npx playwright install chromium

import { expect, test, type Page } from '@playwright/test';

import { MIN_PULSE_GAP_MS, PULSE_MS_FAST } from '../../src/core/constants';

interface VibrateCall {
  readonly t: number;
  readonly ms: number;
}

declare global {
  interface Window {
    __vibrateLog?: VibrateCall[];
  }
}

/** 콘솔 error 와 잡히지 않은 예외를 모아둔다. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** 앱 스크립트보다 먼저 navigator.vibrate 를 감싸 호출 시각·길이를 기록한다. */
async function instrumentVibrate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: VibrateCall[] = [];
    window.__vibrateLog = log;
    const original = navigator.vibrate.bind(navigator);
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value(pattern: number | number[]): boolean {
        log.push({ t: performance.now(), ms: typeof pattern === 'number' ? pattern : -1 });
        return original(pattern);
      },
    });
  });
}

/** 진동 미지원 브라우저를 흉내 낸다 (iOS / Firefox 대신 API 자체를 지운다). */
async function removeVibrate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value: undefined,
    });
  });
}

/** 스피너 중심 위쪽을 가로지르는 접선 스와이프. app.spec.ts 의 플릭과 같은 방식이다. */
async function flick(page: Page): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');

  const swipeY = box.y + box.height / 2 - box.height * 0.11;
  const startX = box.x + box.width / 2 - box.width * 0.28;
  await page.mouse.move(startX, swipeY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(startX + (box.width * 0.56 * i) / 8, swipeY);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

test('플릭하면 진동이 발사되고, 호출 간격이 MIN_PULSE_GAP_MS 밑으로 내려가지 않는다', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await instrumentVibrate(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  await flick(page);

  // 회전이 이어지는 동안 충분한 수의 펄스가 쌓일 때까지 기다린다.
  await expect
    .poll(() => page.evaluate(() => window.__vibrateLog?.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(12);

  const log = await page.evaluate(() => window.__vibrateLog ?? []);

  // 첫 호출은 최초 탭의 웜업 펄스다 (스케줄러를 거치지 않는 1회성 호출).
  expect(log[0]?.ms).toBe(PULSE_MS_FAST);
  const scheduled = log.slice(1);

  for (let i = 1; i < scheduled.length; i += 1) {
    const gap = (scheduled[i]?.t ?? 0) - (scheduled[i - 1]?.t ?? 0);
    // 스케줄러는 rAF 타임스탬프로 판정하고 실제 호출은 그 직후에 일어난다.
    // 프레임 안에서의 미세한 지연 차이만큼(1ms 미만) 여유를 준다.
    expect(gap).toBeGreaterThan(MIN_PULSE_GAP_MS - 1);
  }

  // 길이는 상수 범위 안이다 (최대 = FINAL_PULSE_MS 30, 브레이크 최대 27).
  for (const call of scheduled) {
    expect(call.ms).toBeGreaterThanOrEqual(PULSE_MS_FAST);
    expect(call.ms).toBeLessThanOrEqual(30);
  }

  expect(errors).toEqual([]);
});

test('탭이 숨겨지면 즉시 vibrate(0) 이 나간다', async ({ page }) => {
  const errors = collectErrors(page);
  await instrumentVibrate(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  await flick(page);
  await expect
    .poll(() => page.evaluate(() => window.__vibrateLog?.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(3);

  // visibilitychange 를 강제로 발생시킨다 (헤드리스에서 실제 탭 전환은 흉내 내기 어렵다).
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const log = await page.evaluate(() => window.__vibrateLog ?? []);
  expect(log[log.length - 1]?.ms).toBe(0);

  expect(errors).toEqual([]);
});

test('진동 미지원 브라우저에서는 안내 배너가 뜨고 닫을 수 있다', async ({ page }) => {
  const errors = collectErrors(page);
  await removeVibrate(page);
  await page.goto('/');

  const notice = page.locator('#haptic-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Android Chrome');

  // 배너는 캔버스 제스처를 가로채지 않는다 — 닫기 버튼만 포인터를 받는다.
  expect(await notice.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');

  await notice.getByRole('button', { name: '안내 닫기' }).click();
  await expect(notice).toHaveCount(0);

  // 진동이 없어도 회전은 정상 동작한다 (NoopDriver).
  await flick(page);
  await page.waitForTimeout(300);

  expect(errors).toEqual([]);
});

test('진동을 지원하면 안내 배너가 뜨지 않는다', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect(page.locator('#haptic-notice')).toHaveCount(0);
});

test('?debug=1 오버레이가 ω·펄스·프레임 통계를 표시한다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#debug-overlay')).toHaveCount(0); // 기본값에서는 없다

  await page.goto('/?debug=1');
  const overlay = page.locator('#debug-overlay');
  await expect(overlay).toBeVisible();

  await flick(page);
  // 펄스가 실제로 집계되어 표시될 때까지 기다린다.
  await expect
    .poll(async () => (await overlay.textContent()) ?? '', { timeout: 10_000 })
    .toMatch(/fired [1-9]/);

  const text = (await overlay.textContent()) ?? '';
  expect(text).toContain('rad/s');
  expect(text).toContain('RPM');
  expect(text).toContain('dropped');
  expect(text).toContain('hist');

  // 타임라인 캔버스가 실제로 그려져 있다.
  const timelinePixels = await overlay.locator('canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) painted += 1;
    return painted;
  });
  expect(timelinePixels).toBeGreaterThan(0);

  // 사람이 눈으로 확인할 수 있게 스크린샷을 남긴다 (경로가 주어졌을 때만).
  const shotPath = process.env['FIDGET_DEBUG_SHOT'];
  if (shotPath !== undefined && shotPath !== '') {
    await page.screenshot({ path: shotPath });
  }

  expect(errors).toEqual([]);
});
