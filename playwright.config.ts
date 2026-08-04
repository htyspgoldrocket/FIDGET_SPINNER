import { defineConfig, devices } from '@playwright/test';

// L3: 타겟은 Android Chrome 단일 플랫폼(CLAUDE.md 1장). 데스크톱 브라우저는 대상이 아니다.
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'android-chrome',
      use: { ...devices['Pixel 7'] },
    },
  ],

  // 브라우저 바이너리는 `npx playwright install chromium` 으로 별도 설치한다.
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
