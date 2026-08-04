// L3 — 안드로이드 백버튼 대응 (CLAUDE.md 8장 3번).
//
// TWA 로 감싸면 안드로이드 백버튼이 그대로 브라우저 뒤로가기가 된다. 여기서 검증하는 것은
// 두 가지이고, **두 번째가 더 중요하다**:
//   1. 패널이 열려 있으면 뒤로가기가 패널을 닫는다.
//   2. 루트 상태에서는 뒤로가기가 **앱 바깥으로 나간다** — TWA 에서 이것이 앱 종료다.
//      자리 채우기용 엔트리를 쌓아두면 사용자가 앱을 나가려고 백버튼을 두 번 눌러야 한다.
//
// `history.length` 로는 2번을 검증할 수 없다. back() 은 포인터만 뒤로 옮길 뿐 길이를 줄이지
// 않기 때문이다(앞쪽 엔트리는 다음 pushState 까지 남는다). 그래서 길이 대신 **실제로 뒤로
// 가보고** 앱을 벗어났는지를 본다. 이것이 사용자가 겪는 동작 그대로다.
import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/**
 * "지금 뒤로가면 앱이 종료되는 자리"인지 확인한다.
 *
 * 우리 엔트리 위가 아니어야 하고(state 가 null), 실제로 뒤로 가면 앱 문서를 벗어나야 한다.
 * Playwright 의 첫 엔트리는 about:blank 라 그것이 TWA 의 "앱 밖"에 해당한다.
 * 확인 뒤에는 다시 앱으로 들어와 원래 자리로 되돌려 놓는다.
 */
async function expectBackWouldExitApp(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.history.state)).toBeNull();

  await page.goBack();
  await expect(page.locator('#stage')).toHaveCount(0);

  await page.goForward();
  await expect(page.locator('#stage')).toBeVisible();
}

test('루트 상태에서는 뒤로가기가 곧바로 앱을 나간다 (가짜 엔트리를 쌓지 않는다)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  // 앱이 뜨고 잠시 돌아도 히스토리에는 아무것도 쌓이지 않는다.
  await page.waitForTimeout(250);
  await expectBackWouldExitApp(page);

  expect(errors).toEqual([]);
});

test('패널을 열면 히스토리가 쌓이고 뒤로가기가 패널을 닫는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  const panel = page.locator('#stats-panel');
  await expect(panel).toBeHidden();

  await page.locator('#stats-toggle').click();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => window.history.state)).toEqual({ screen: 'stats' });

  // 안드로이드 백버튼 = 브라우저 뒤로가기. 앱을 나가는 것이 아니라 패널만 닫혀야 한다.
  await page.goBack();
  await expect(panel).toBeHidden();
  await expect(page.locator('#stats-toggle')).toBeVisible();
  await expect(page.locator('#stage')).toBeVisible();

  // 그리고 지금은 다시 루트다 — 여기서 한 번 더 뒤로가면 앱이 종료된다.
  await expectBackWouldExitApp(page);

  expect(errors).toEqual([]);
});

test('닫기 버튼으로 닫아도 히스토리가 되감긴다 (엔트리가 새지 않는다)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  const panel = page.locator('#stats-panel');
  const toggle = page.locator('#stats-toggle');

  // 열고 닫기를 세 번 반복한다. ✕ 가 history.back 이 아니라 그냥 close 를 부르면, 열 때
  // push 한 엔트리가 매번 그대로 남아 백버튼을 네 번 눌러야 앱을 나가게 된다.
  for (let i = 0; i < 3; i += 1) {
    await toggle.click();
    await expect(panel).toBeVisible();
    await page.locator('#stats-close').click();
    await expect(panel).toBeHidden();
  }

  await expectBackWouldExitApp(page);

  expect(errors).toEqual([]);
});

test('배경을 탭해 닫아도 뒤로가기 한 번이면 앱을 나간다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  const panel = page.locator('#stats-panel');
  await page.locator('#stats-toggle').click();
  await expect(panel).toBeVisible();

  // 카드 바깥(패널 하단 여백)을 탭한다.
  const box = await panel.boundingBox();
  if (box === null) throw new Error('패널의 배치 상자를 얻지 못했다.');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);

  await expect(panel).toBeHidden();
  await expectBackWouldExitApp(page);

  expect(errors).toEqual([]);
});

test('패널을 연 채 새로고침하면 패널이 그대로 열려 있다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  await page.locator('#stats-toggle').click();
  await expect(page.locator('#stats-panel')).toBeVisible();

  // 새로고침해도 히스토리 위치는 그대로다. 화면이 히스토리와 어긋나면 백버튼 한 번이 헛돈다.
  await page.reload();
  await expect(page.locator('#stats-panel')).toBeVisible();

  await page.goBack();
  await expect(page.locator('#stats-panel')).toBeHidden();

  expect(errors).toEqual([]);
});
