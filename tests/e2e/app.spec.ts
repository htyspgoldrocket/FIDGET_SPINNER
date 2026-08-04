// L3 스모크 — Phase 2(렌더링 + 입력)가 실제 브라우저에서 붙어 도는지 확인한다.
// 브라우저 바이너리는 별도 설치가 필요하다: npx playwright install chromium
//
// 픽셀 값을 직접 읽어 검증한다. 스크린샷 비교(시각 회귀)는 Phase 5 항목이다.
import { expect, test, type Locator, type Page } from '@playwright/test';

/** 콘솔 error 와 잡히지 않은 예외를 모아둔다. 반환된 배열은 페이지가 도는 동안 계속 채워진다. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/**
 * 캔버스의 가로 한 줄을 픽셀 단위로 읽어 체크섬을 만든다.
 * 회전하면 값이 바뀌고, 멈춰 있으면 그대로다 — 정지/회전 판정에 쓴다.
 */
async function rowChecksum(canvas: Locator, yFraction: number): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement, fraction: number) => {
    const ctx = element.getContext('2d');
    if (ctx === null) return -1;
    const y = Math.floor(element.height * fraction);
    const { data } = ctx.getImageData(0, y, element.width, 1);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum = (sum * 31 + (data[i] ?? 0) * 7 + (data[i + 1] ?? 0) * 3 + (data[i + 2] ?? 0)) | 0;
    }
    return sum;
  }, yFraction);
}

/** 배경(#0e1116)이 아닌 픽셀 수. 스피너가 실제로 그려졌는지 본다. */
async function paintedPixels(canvas: Locator, yFraction: number): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement, fraction: number) => {
    const ctx = element.getContext('2d');
    if (ctx === null) return -1;
    const y = Math.floor(element.height * fraction);
    const { data } = ctx.getImageData(0, y, element.width, 1);
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x0e || data[i + 1] !== 0x11 || data[i + 2] !== 0x16) painted += 1;
    }
    return painted;
  }, yFraction);
}

test('앱 셸이 로드되고 캔버스가 뷰포트를 채운다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await expect(page).toHaveTitle('FIDGET SPINNER');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('뷰포트 크기를 알 수 없다.');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');

  expect(box.width).toBeCloseTo(viewport.width, 0);
  expect(box.height).toBeCloseTo(viewport.height, 0);

  // DPR 대응: 백버퍼는 CSS 크기 × devicePixelRatio 여야 한다 (반올림 오차 1px 허용).
  const buffer = await canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width,
    height: element.height,
    cssWidth: element.clientWidth,
    cssHeight: element.clientHeight,
    dpr: window.devicePixelRatio,
  }));
  expect(buffer.dpr).toBeGreaterThan(1); // Pixel 7 에뮬레이션은 고밀도 화면이다
  expect(Math.abs(buffer.width - buffer.cssWidth * buffer.dpr)).toBeLessThanOrEqual(1);
  expect(Math.abs(buffer.height - buffer.cssHeight * buffer.dpr)).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('정지 상태에서 스피너가 그려져 있다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  // 중앙 가로줄은 중심 링과 로브를 지나므로 반드시 배경이 아닌 픽셀이 있다.
  await expect.poll(() => paintedPixels(canvas, 0.5)).toBeGreaterThan(0);

  // 입력이 없으면 정지 상태 그대로여야 한다 (저절로 돌지 않는다).
  const before = await rowChecksum(canvas, 0.35);
  await page.waitForTimeout(250);
  expect(await rowChecksum(canvas, 0.35)).toBe(before);

  expect(errors).toEqual([]);
});

test('플릭하면 회전하고 더블탭하면 멈춘다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // 중심 위쪽을 가로지르는 접선 방향 스와이프. 각 이동을 개별 호출로 나눠 샘플마다
  // 실제 시간 간격이 생기게 한다 (한 번에 steps 로 밀면 timeStamp 가 붙어버릴 수 있다).
  const swipeY = centerY - box.height * 0.11;
  const startX = centerX - box.width * 0.28;
  await page.mouse.move(startX, swipeY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(startX + (box.width * 0.56 * i) / 8, swipeY);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  // 회전 중이면 같은 줄의 픽셀이 계속 바뀐다.
  const spinning = await rowChecksum(canvas, 0.35);
  await expect.poll(() => rowChecksum(canvas, 0.35)).not.toBe(spinning);

  // 더블탭 → ω = 0. 그 뒤로는 화면이 고정된다.
  await page.mouse.dblclick(centerX, centerY);
  await page.waitForTimeout(150);
  const halted = await rowChecksum(canvas, 0.35);
  await page.waitForTimeout(250);
  expect(await rowChecksum(canvas, 0.35)).toBe(halted);

  expect(errors).toEqual([]);
});
