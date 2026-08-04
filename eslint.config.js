// eslint.config.js — CLAUDE.md의 "절대 규칙"을 코드로 강제한다.
// 이 파일의 제약을 완화하려면 DECISIONS.md에 ADR을 먼저 작성할 것.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 전역 규칙 ────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    rules: {
      // 규칙 4: localStorage/sessionStorage 전면 금지 (StorageAdapter + IndexedDB만 사용)
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.' },
        { name: 'sessionStorage', message: 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message: 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.',
        },
      ],
      // 규칙 2: navigator.vibrate 는 vibration-driver.ts 에서만 (아래 override로 해제)
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='vibrate']",
          message:
            'CLAUDE.md 규칙 2: navigator.vibrate 호출은 src/platform/vibration-driver.ts 에서만 허용된다.',
        },
      ],
    },
  },

  // ── src/core/** : 순수 레이어 ────────────────────────────────
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // 규칙 1: 브라우저 API 참조 금지
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'document', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'navigator', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'localStorage', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'sessionStorage', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'performance', message: 'CLAUDE.md 규칙 1: 시간은 인자로 주입받는다.' },
        { name: 'requestAnimationFrame', message: 'CLAUDE.md 규칙 1: core는 순수해야 한다.' },
        { name: 'setTimeout', message: 'CLAUDE.md 규칙 1: 시간은 인자로 주입받는다.' },
        { name: 'setInterval', message: 'CLAUDE.md 규칙 1: 시간은 인자로 주입받는다.' },
      ],
      // ADR-003: 결정론 보장 — Date.now / Math.random 금지
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'ADR-003: 결정론을 위해 시간은 인자로 주입받는다.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'ADR-003: 결정론을 위해 시간은 인자로 주입받는다.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'ADR-003: 결정론을 위해 난수는 시드 기반으로 주입받는다.',
        },
        {
          selector: "MemberExpression[property.name='vibrate']",
          message: 'CLAUDE.md 규칙 2: core는 진동을 직접 호출하지 않는다. 시점만 계산한다.',
        },
      ],
      // 규칙: 단방향 의존 — core는 바깥 레이어를 import 할 수 없다
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/platform/**', '**/render/**', '**/ui/**', '../platform/*', '../render/*', '../ui/*'],
              message: 'CLAUDE.md 아키텍처: 의존 방향은 단방향이다. core → 바깥 레이어 import 금지.',
            },
          ],
        },
      ],
    },
  },

  // ── 유일한 예외: 진동 드라이버 ───────────────────────────────
  {
    files: ['src/platform/vibration-driver.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // ── 테스트 코드는 목킹을 위해 일부 완화 ──────────────────────
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
