// L3 — 최초 실행 설명서.
//
// 조작법을 아무 데도 적어두지 않으면 사용자는 화면을 튕겨봐야 한다는 것조차 모른다. 그래서
// 새 프로필의 첫 실행에서는 설명서 탭이 저절로 열린다. 다만 **한 번 본 뒤로는 다시 뜨지
// 않아야 한다** — 매번 뜨는 안내는 안내가 아니라 방해다.
//
// 여기서 검증하는 것:
//   1. 새 프로필이면 자동으로 열리고, 열린 탭이 설명서다.
//   2. 닫고 새로고침하면 다시 뜨지 않는다 (manualSeen 이 IndexedDB 에 남았다).
//   3. 저장소가 막힌 환경에서도 앱이 멀쩡하다 (남길 곳이 없으니 매번 뜨는 것은 감수한다).
import { expect, test } from '@playwright/test';

import { collectErrors, dismissFirstRunManual } from './helpers';

test('새 프로필로 들어오면 설명서가 저절로 열린다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  // 자동 열림은 storage.getSettings() 가 resolve 한 뒤다 — 로드 직후의 비동기 사건이라
  // 명시적으로 기다린다.
  await expect(page.locator('#stats-panel')).toBeVisible();
  await expect(page.locator('#tab-manual')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#section-manual')).toBeVisible();
  await expect(page.locator('#section-stats')).toBeHidden();
  await expect(page.locator('#section-settings')).toBeHidden();

  // 조작법이 실제로 적혀 있다 (빈 탭이 열리는 것과 구별한다).
  const manual = page.locator('#section-manual');
  await expect(manual).toContainText('돌리기');
  await expect(manual).toContainText('브레이크');
  await expect(manual).toContainText('진동');

  expect(errors).toEqual([]);
});

test('한 번 보고 나면 새로고침해도 다시 뜨지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await dismissFirstRunManual(page); // manualSeen 이 저장될 때까지 기다린다

  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();

  // 저절로 열리는 일이 정말 없는지 보려면 기다려봐야 한다. 첫 방문에서 자동 열림이 일어나는
  // 시점(getSettings resolve 직후)보다 넉넉히 지난 뒤에 확인한다.
  await page.waitForTimeout(600);
  await expect(page.locator('#stats-panel')).toBeHidden();
  await expect(page.locator('#stats-toggle')).toBeVisible();

  // 필요하면 언제든 직접 열어 볼 수 있다. 자동으로 안 뜰 뿐 사라진 것이 아니다.
  await page.locator('#stats-toggle').click();
  await page.locator('#tab-manual').click();
  await expect(page.locator('#section-manual')).toBeVisible();

  expect(errors).toEqual([]);
});

test('저장소가 막혀 있어도 설명서가 앱을 막지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get: () => ({
        open: (): never => {
          throw new Error('blocked');
        },
      }),
    });
  });

  await page.goto('/');
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('memory');

  // 인메모리 폴백도 설정을 돌려주므로 설명서는 뜬다. 남길 곳이 없어 매번 뜨지만, 그것이
  // "봤다는 표시를 못 남겼으니 안 띄운다"보다 낫다 — 안내를 영영 못 보는 쪽이 더 나쁘다.
  await dismissFirstRunManual(page);

  // 닫고 나면 캔버스가 그대로 손가락을 받는다.
  const box = await page.locator('#stage').boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.id ?? '',
    [box.width / 2, box.height / 2],
  );
  expect(hit).toBe('stage');

  expect(errors).toEqual([]);
});
