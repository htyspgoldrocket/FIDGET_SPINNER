import { defineConfig, devices } from '@playwright/test';

// L3: 타겟은 Android Chrome 단일 플랫폼(CLAUDE.md 1장). 데스크톱 브라우저는 대상이 아니다.
const DEV_PORT = 4173;
const PREVIEW_PORT = 4174;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // 이 스위트는 실시간 손가락 입력(플릭 스와이프)을 흉내 낸다. 워커가 코어를 포화시키면
  // mouse.move 사이의 **실제** 간격이 늘어나 마지막 샘플이 "멈췄다가 뗀" 모양이 되고,
  // input-model 이 Δω = 0 으로 판정해 회전이 시작되지 않는다 — 앱이 아니라 시뮬레이션의 문제다.
  // 16코어 8워커에서 재현되고 4워커에서는 재현되지 않아 상한을 둔다 (CI 는 원래 1워커다).
  workers: process.env['CI'] ? 1 : 4,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  expect: {
    toHaveScreenshot: {
      // 스피너는 shadowBlur 글로우를 오프스크린 캔버스에 한 번 굽고 매 프레임 그대로 붙인다.
      // 같은 기기에서는 픽셀이 완전히 같지만, 같은 OS 라도 GPU/드라이버가 다르면 글로우
      // 그라디언트의 마지막 1비트가 흔들린다. 형태가 무너지는 회귀는 0.5%로도 충분히 잡힌다.
      maxDiffPixelRatio: 0.005,
    },
  },

  projects: [
    {
      // 대부분의 e2e — dev 서버로 충분하고, 빌드를 기다리지 않아 반복이 빠르다.
      name: 'android-chrome',
      testIgnore: 'pwa/**',
      use: { ...devices['Pixel 7'], baseURL: DEV_URL },
    },
    {
      // PWA 는 **빌드 산출물**에서만 검증할 수 있다. 서비스 워커가 프리캐시하는 대상은
      // 해시가 박힌 dist 파일이고 dev 서버에는 그런 게 없다 (vite.config 의 devOptions 참조).
      name: 'android-chrome-pwa',
      testMatch: 'pwa/**',
      use: { ...devices['Pixel 7'], baseURL: PREVIEW_URL },
    },
  ],

  // 브라우저 바이너리는 `npx playwright install chromium` 으로 별도 설치한다.
  webServer: [
    {
      command: `npm run dev -- --port ${DEV_PORT} --strictPort`,
      url: DEV_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
      url: PREVIEW_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
