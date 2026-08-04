import { defineConfig } from 'vite';

// CLAUDE.md 규칙 6: 프로덕션 dependencies 0개. 번들 예산 ≤ 60KB gzip.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
  },
});
