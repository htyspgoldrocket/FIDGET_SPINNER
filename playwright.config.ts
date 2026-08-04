import { defineConfig, devices } from '@playwright/test';

// L3: 타겟은 Android Chrome 단일 플랫폼(CLAUDE.md 1장). 데스크톱 브라우저는 대상이 아니다.
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : '50%',
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
