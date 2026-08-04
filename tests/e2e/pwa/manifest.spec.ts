// L3 — 웹 앱 매니페스트 (CLAUDE.md 8장 1번).
//
// 이 스위트는 **빌드 산출물**(vite preview)을 상대로 돈다 — playwright.config 의
// android-chrome-pwa 프로젝트. 매니페스트와 아이콘은 dist 에만 존재한다.
//
// 필드 하나가 빠지면 설치 배너가 안 뜨거나 TWA 빌드가 거부되는데, 그 실패는 배포 뒤에야
// 드러난다. 그래서 "설치 가능 여부"가 아니라 **필드 하나하나**를 여기서 못 박는다.
import { expect, test, type Page } from '@playwright/test';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface WebManifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  orientation?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
}

async function fetchManifest(page: Page): Promise<WebManifest> {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href, 'index.html 에 manifest 링크가 없다').not.toBeNull();

  const response = await page.request.get(href ?? '');
  expect(response.status()).toBe(200);
  return response.json() as Promise<WebManifest>;
}

test('매니페스트가 TWA 필수 필드를 모두 갖췄다', async ({ page }) => {
  await page.goto('/');
  const manifest = await fetchManifest(page);

  expect(manifest.name).toBe('FIDGET SPINNER');
  expect(manifest.short_name).toBeTruthy();
  // 런처 아이콘 아래 이름은 12자 안팎에서 잘린다.
  expect((manifest.short_name ?? '').length).toBeLessThanOrEqual(12);

  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.id).toBe('/');

  // 이 셋은 TWA 의 전제다. standalone 이 아니면 주소창이 남고, portrait 가 아니면
  // 가로로 돌아가 스피너 조작이 깨진다.
  expect(manifest.display).toBe('standalone');
  expect(manifest.orientation).toBe('portrait');

  // index.html 의 theme-color, 캔버스 배경과 같은 값이어야 스플래시가 이어져 보인다.
  expect(manifest.theme_color).toBe('#0e1116');
  expect(manifest.background_color).toBe('#0e1116');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0e1116');
});

test('아이콘 192 / 512 / maskable 512 가 모두 있고 실제로 받아진다', async ({ page }) => {
  await page.goto('/');
  const manifest = await fetchManifest(page);
  const icons = manifest.icons ?? [];

  const any192 = icons.find((i) => i.sizes === '192x192' && i.purpose !== 'maskable');
  const any512 = icons.find((i) => i.sizes === '512x512' && i.purpose !== 'maskable');
  const maskable512 = icons.find((i) => i.sizes === '512x512' && i.purpose === 'maskable');

  expect(any192, '192x192 아이콘이 없다').toBeDefined();
  expect(any512, '512x512 아이콘이 없다').toBeDefined();
  expect(maskable512, 'maskable 512 아이콘이 없다 — CLAUDE.md 8장 1번').toBeDefined();

  // 선언만 하고 파일이 없는 것이 가장 흔한 실수다. 전부 실제로 받아본다.
  for (const icon of icons) {
    const response = await page.request.get(icon.src);
    expect(response.status(), `${icon.src} 를 받지 못했다`).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    expect((await response.body()).byteLength).toBeGreaterThan(0);
  }
});

test('홈 화면 아이콘과 파비콘이 연결되어 있다', async ({ page }) => {
  await page.goto('/');

  for (const selector of ['link[rel="icon"]', 'link[rel="apple-touch-icon"]']) {
    const href = await page.locator(selector).getAttribute('href');
    expect(href, `${selector} 가 없다`).not.toBeNull();
    const response = await page.request.get(href ?? '');
    expect(response.status(), `${href ?? ''} 를 받지 못했다`).toBe(200);
  }
});
