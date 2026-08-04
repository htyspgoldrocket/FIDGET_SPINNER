import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// CLAUDE.md 규칙 6: 프로덕션 dependencies 0개. 번들 예산 ≤ 60KB gzip.
// vite-plugin-pwa 는 devDependency 다 — 산출물(sw.js/manifest)만 남고 런타임 import 는 없다.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
  },
  plugins: [
    VitePWA({
      // 서비스 워커는 직접 쓴다(src/sw.ts). 플러그인에게 맡기는 것은 "해시 박힌 산출물 목록"의
      // 주입뿐이다 — 사유는 src/sw.ts 머리말 참조.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // 등록 코드를 index.html 안에 인라인으로 넣는다. 별도 JS 파일이면 요청이 하나 더 생기고,
      // 그 파일 자체가 캐시에 없을 때 등록이 실패할 여지가 생긴다.
      injectRegister: 'inline',
      // dev 서버에는 서비스 워커를 올리지 않는다. dev 는 번들이 없어 프리캐시할 대상이 다르고,
      // 캐시가 남으면 소스 수정이 반영되지 않는다. PWA 검증은 preview(빌드 산출물)에서 한다.
      devOptions: { enabled: false },

      // 아이콘은 아래 globPatterns 가 이미 전부 잡는다. 이 옵션까지 켜두면 매니페스트 아이콘이
      // 목록에 한 번 더 들어가 중복 URL 이 생긴다 (sw.ts 의 중복 제거 주석 참조).
      includeManifestIcons: false,

      injectManifest: {
        // 아이콘/매니페스트까지 전부 프리캐시한다. 오프라인 100% 는 "앱이 뜬다"가 아니라
        // "설치·표시에 필요한 것이 전부 로컬에 있다"는 뜻이다.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },

      // CLAUDE.md 8장 1번 — TWA 필수 필드 완비.
      manifest: {
        // id 를 고정해두면 start_url 이 바뀌어도 같은 앱으로 인식된다 (설치본 갈아끼우기 방지).
        id: '/',
        name: 'FIDGET SPINNER',
        short_name: 'FIDGET',
        description: '손가락으로 튕겨 돌리는 햅틱 피젯 스피너. 회전에 맞춰 진동이 손에 전달된다.',
        lang: 'ko',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // index.html 의 theme-color, canvas-renderer 의 COLOR_BACKGROUND 와 같은 값이어야 한다.
        theme_color: '#0e1116',
        background_color: '#0e1116',
        categories: ['games', 'entertainment'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // maskable 은 별도 파일이다. 같은 파일에 purpose "any maskable" 을 겸하게 하면
          // 안전 영역 여백 때문에 일반 아이콘이 작아 보인다 (scripts/generate-icons.mjs 참조).
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
