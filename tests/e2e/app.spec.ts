// L3 placeholder — 실제 E2E 는 렌더러/입력이 붙는 Phase 3 이후에 채운다.
// 브라우저 바이너리 미설치 상태에서는 실행되지 않는다: npx playwright install chromium
import { expect, test } from '@playwright/test';

test('앱 셸이 로드된다', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('FIDGET SPINNER');
  await expect(page.locator('#app')).toBeAttached();
});
