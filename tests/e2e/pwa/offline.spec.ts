// L3 — 서비스 워커 / 오프라인 100% (CLAUDE.md 8장 2번).
//
// 이 스위트는 **빌드 산출물**(vite preview)을 상대로 돈다 — 프리캐시 대상이 해시가 박힌
// dist 파일이라 dev 서버에서는 검증 자체가 성립하지 않는다.
//
// 검증은 "서비스 워커가 등록됐다"에서 끝내지 않는다. 그건 등록만 되고 아무것도 캐시하지
// 못한 상태와 구별되지 않는다. 실제로 네트워크를 끊고 새로 띄워 **스피너가 그려지는지**까지 본다.
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
 * 서비스 워커가 이 페이지를 **제어**할 때까지 기다린다.
 *
 * controller 가 잡혔다는 것은 install(= 프리캐시 addAll 완료) → activate → clients.claim 이
 * 모두 끝났다는 뜻이다. 프리캐시가 절반만 된 상태에서 오프라인 검증에 들어가는 것을 막는다.
 */
async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

/** 배경(#0e1116)이 아닌 픽셀 수. 스피너가 실제로 그려졌는지 본다. */
async function paintedPixels(page: Page): Promise<number> {
  return page.locator('#stage').evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext('2d');
    if (ctx === null) return -1;
    const y = Math.floor(element.height * 0.5);
    const { data } = ctx.getImageData(0, y, element.width, 1);
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x0e || data[i + 1] !== 0x11 || data[i + 2] !== 0x16) painted += 1;
    }
    return painted;
  });
}

test('서비스 워커가 앱 셸과 아이콘을 프리캐시한다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
    }
    return { names, urls };
  });

  // 캐시 이름에 프리캐시 목록의 지문이 붙는다 — 빌드가 바뀌면 새 캐시가 생기고 옛것은 지워진다.
  expect(cached.names).toHaveLength(1);
  expect(cached.names[0]).toMatch(/^fidget-spinner-precache-/);

  expect(cached.urls).toContain('/index.html');
  expect(cached.urls).toContain('/manifest.webmanifest');
  expect(cached.urls).toContain('/icon-512.png');
  expect(cached.urls).toContain('/icon-maskable-512.png');
  // 해시가 박힌 앱 번들도 들어 있어야 한다 (이게 없으면 오프라인에서 흰 화면이 뜬다).
  expect(cached.urls.some((url) => /^\/assets\/index-.*\.js$/.test(url))).toBe(true);

  expect(errors).toEqual([]);
});

test('네트워크를 끊고 새로고침해도 앱이 그대로 뜬다', async ({ page, context }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  await page.reload();

  await expect(page).toHaveTitle('FIDGET SPINNER');
  await expect(page.locator('#stage')).toBeVisible();
  // 흰 화면이나 셸만 뜬 상태와 구별하기 위해 실제로 그려진 픽셀을 센다.
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0);
  await expect(page.locator('#stats-toggle')).toBeVisible();

  expect(errors).toEqual([]);
});

test('오프라인에서 처음 여는 주소(쿼리 포함)도 앱 셸로 받는다', async ({ page, context }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);

  // 프리캐시에는 `/index.html` 만 있다. `/` 나 `/?debug=1` 같은 내비게이션을 셸로 이어주지
  // 않으면 오프라인에서 이 주소들이 전부 실패한다.
  await page.goto('/?debug=1');
  await expect(page.locator('#stage')).toBeVisible();
  await expect(page.locator('#debug-overlay')).toBeVisible();

  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});

test('오프라인에서도 매니페스트와 아이콘을 받을 수 있다', async ({ page, context }) => {
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);

  // page.request 는 서비스 워커를 거치지 않으므로 페이지 안에서 fetch 한다.
  const results = await page.evaluate(async () => {
    const targets = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
    const out: Record<string, number> = {};
    for (const target of targets) {
      try {
        out[target] = (await fetch(target)).status;
      } catch {
        out[target] = 0; // 네트워크 실패 = 캐시에 없었다는 뜻
      }
    }
    return out;
  });

  expect(results).toEqual({
    '/manifest.webmanifest': 200,
    '/icon-192.png': 200,
    '/icon-512.png': 200,
  });
});
