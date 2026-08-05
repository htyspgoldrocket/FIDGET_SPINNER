// L3 스모크 — Phase 2(렌더링 + 입력)가 실제 브라우저에서 붙어 도는지 확인한다.
// 브라우저 바이너리는 별도 설치가 필요하다: npx playwright install chromium
//
// 픽셀 값을 직접 읽어 검증한다. 스크린샷 비교(시각 회귀)는 Phase 5 항목이다.
//
// 새 프로필로 뜨면 설명서 패널이 자동으로 열려 화면을 덮는다. 캔버스를 만지기 전에 반드시
// 치워야 한다 — 열려 있으면 스와이프가 패널 배경으로 가고 캔버스는 아무것도 받지 못한다.
import { expect, test } from '@playwright/test';

import { collectErrors, flick, gotoFirstRun, paintedPixels, rowChecksum } from './helpers';

test('앱 셸이 로드되고 캔버스가 뷰포트를 채운다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);

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
  await gotoFirstRun(page);
  const canvas = page.locator('#stage');

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
  await gotoFirstRun(page);
  const canvas = page.locator('#stage');

  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // 중심 위쪽을 가로지르는 접선 방향 스와이프. 각 이동을 개별 호출로 나눠 샘플마다
  // 실제 시간 간격이 생기게 한다 (한 번에 steps 로 밀면 timeStamp 가 붙어버릴 수 있다).
  await flick(page);

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
