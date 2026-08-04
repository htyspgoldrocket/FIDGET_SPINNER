import { defineConfig } from 'vitest/config';

// L1(물리 단위 테스트 + 골든 스냅샷) / L2(햅틱 스케줄러) 실행 대상.
// core 는 순수 로직이므로 DOM 환경이 필요 없다 — node 환경으로 돌린다.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/golden/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
