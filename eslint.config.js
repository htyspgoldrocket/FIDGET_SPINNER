// eslint.config.js — CLAUDE.md의 "절대 규칙"을 코드로 강제한다.
// 이 파일의 제약을 완화하려면 DECISIONS.md에 ADR을 먼저 작성할 것.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const STORAGE_MSG = 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.';

// 규칙 4/5: 어떤 객체를 경유하든 막는다.
// `object: 'window'` 로 열거하면 window.sessionStorage / globalThis.localStorage / self.localStorage
// 같은 우회 경로가 그대로 새어나간다 (실제로 프로브에서 새어나가는 것을 확인했다).
const NO_WEB_STORAGE = [
  {
    selector: "MemberExpression[property.name='localStorage']",
    message: STORAGE_MSG,
  },
  {
    selector: "MemberExpression[property.name='sessionStorage']",
    message: STORAGE_MSG,
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dev-dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 실행 환경별 전역 선언 ────────────────────────────────────
  // 이게 없으면 no-restricted-globals 가 "정의된 전역"을 못 보고 조용히 새어나간다.
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // ── 전역 규칙 ────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    rules: {
      // 규칙 4: localStorage/sessionStorage 전면 금지 (StorageAdapter + IndexedDB만 사용)
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.',
        },
        {
          name: 'sessionStorage',
          message: 'CLAUDE.md 규칙 4: StorageAdapter(IndexedDB)만 사용한다.',
        },
      ],
      // 규칙 2: navigator.vibrate 는 vibration-driver.ts 에서만 (아래 override로 해제)
      'no-restricted-syntax': [
        'error',
        ...NO_WEB_STORAGE,
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
        ...NO_WEB_STORAGE,
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
              group: [
                '**/platform/**',
                '**/render/**',
                '**/ui/**',
                '../platform/*',
                '../render/*',
                '../ui/*',
              ],
              message:
                'CLAUDE.md 아키텍처: 의존 방향은 단방향이다. core → 바깥 레이어 import 금지.',
            },
          ],
        },
      ],
    },
  },

  // ── 유일한 예외: 진동 드라이버 ───────────────────────────────
  // vibrate 셀렉터만 걷어낸다. 'off' 로 통째로 끄면 이 파일에서 웹 스토리지 금지까지 함께 풀린다.
  {
    files: ['src/platform/vibration-driver.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_WEB_STORAGE],
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
