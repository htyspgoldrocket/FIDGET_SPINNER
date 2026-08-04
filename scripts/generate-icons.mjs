#!/usr/bin/env node
// PWA 아이콘 생성 — docs/design/spinner-reference.svg 를 유일한 원본으로 삼는다.
//
// 아이콘을 손으로 그려 넣으면 시안이 바뀔 때마다 조용히 어긋난다. 여기서는 기준 시안을
// 그대로 읽어 Chromium(Playwright)으로 래스터화하므로, 시안을 고치고 이 스크립트를 다시
// 돌리는 것만으로 모든 크기가 함께 갱신된다.
//
//   node scripts/generate-icons.mjs
//
// 산출물은 public/ 에 들어가고 그대로 커밋한다 (빌드에 Playwright 를 요구하지 않기 위해서다 —
// CI 의 budget 잡에는 브라우저 바이너리가 없다).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'docs/design/spinner-reference.svg');
const OUT_DIR = join(ROOT, 'public');

// 기준 시안의 좌표계 (viewBox 480, 회전 중심 240,240).
const VIEWBOX = 480;

// 날개가 3개라 도형은 회전 중심에 대해 **위아래로 대칭이 아니다**: 위쪽 날개 때문에 상단
// 끝은 -188(로브 중심 124 + 로브 반지름 60 + 선 굵기 절반 4), 아래쪽 두 날개의 하단 끝은
// +126(124·cos120 + 64) 이다. 회전 중심을 아이콘 중앙에 두면 아래가 휑하게 비어 보인다.
// 그래서 **외곽 상자** 기준으로 세로를 맞춘다 — 정지 이미지에 회전 중심은 의미가 없다.
const TOP_EXTENT = 188;
const BOTTOM_EXTENT = 126;
const CENTERING_SHIFT = (TOP_EXTENT - BOTTOM_EXTENT) / 2; // = 31, 아래로 내린다

// 상자 중심을 기준으로 다시 잰 최대 반경(글로우 stdDeviation 7 이 대략 14 만큼 더 번진다).
// 옆 로브가 최대점이다: hypot(124·sin120, 62 + 31) + 64 ≈ 176.
const CONTENT_RADIUS = 176;
const GLOW_BLEED = 14;

/** 일반(purpose "any") 아이콘 배율. 상자를 맞추고 남은 여백을 회수해 아이콘을 꽉 채운다. */
const STANDARD_SCALE = 1.15;

/**
 * maskable 축소 배율.
 *
 * maskable 아이콘은 런처가 원/스퀘어클/물방울 등 임의의 모양으로 잘라낸다. 안전 영역은
 * 아이콘 폭의 80%에 해당하는 중앙 원(= 반지름 0.4 × 폭 = 192)이고, 그 밖의 픽셀은 잘려
 * 나간다고 가정해야 한다. 0.92 배에서 글로우까지 포함한 반경이
 * (176 + 14) × 0.92 ≈ 175 < 192 라 어떤 마스크에서도 날개가 잘리지 않는다.
 */
const MASKABLE_SCALE = 0.92;

const TARGETS = [
  { file: 'icon-192.png', size: 192, scale: STANDARD_SCALE },
  { file: 'icon-512.png', size: 512, scale: STANDARD_SCALE },
  { file: 'icon-maskable-512.png', size: 512, scale: MASKABLE_SCALE },
  // iOS/Safari 홈 화면용. 이 프로젝트는 iOS 를 지원 대상으로 삼지 않지만(CLAUDE.md 1장),
  // 아이콘이 없으면 홈 화면에 스크린샷 썸네일이 박히므로 파일만 갖춰둔다.
  // iOS 는 아이콘을 스스로 둥글게 깎으므로 maskable 과 같은 여유를 준다.
  { file: 'apple-touch-icon.png', size: 180, scale: MASKABLE_SCALE },
];

/**
 * 애니메이션을 걷어내고(정지 프레임이어야 재실행 결과가 바이트 단위로 같다) 크기·배율·세로
 * 보정을 박은 SVG 문자열을 만든다.
 */
function buildStaticSvg(source, size, scale) {
  const still = source.replace(/\s*<animateTransform[^>]*\/>/g, '');
  // 보정량에도 배율을 함께 먹여야(scale 이 뒤에 오므로) 어느 배율에서든 상자가 중앙에 온다.
  const y = VIEWBOX / 2 + CENTERING_SHIFT * scale;
  const placed = still.replace(
    '<g transform="translate(240,240)">',
    `<g transform="translate(240,${y.toFixed(3)}) scale(${String(scale)})">`,
  );
  return placed.replace(
    /width="480" height="480"/,
    `width="${String(size)}" height="${String(size)}"`,
  );
}

const source = await readFile(SOURCE, 'utf8');
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  for (const { file, size, scale } of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // 배경은 시안의 <rect> 가 이미 채우지만, 페이지 여백이 1px 이라도 새면 마스크 경계에
    // 흰 테두리가 생긴다. body 여백을 0 으로 두고 뷰포트를 정확히 아이콘 크기로 맞춘다.
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;background:#0e1116;overflow:hidden}` +
        `svg{display:block}</style>` +
        buildStaticSvg(source, size, scale),
    );
    await page.screenshot({ path: join(OUT_DIR, file), type: 'png' });
    await page.close();
    console.log(`[icons] ${file}  ${String(size)}×${String(size)}  scale=${String(scale)}`);
  }

  // 브라우저 탭/주소창용. 벡터라 크기 걱정이 없고 정지 프레임이라 탭에서 돌지 않는다.
  await writeFile(
    join(OUT_DIR, 'favicon.svg'),
    buildStaticSvg(source, VIEWBOX, STANDARD_SCALE),
    'utf8',
  );
  console.log('[icons] favicon.svg');
} finally {
  await browser.close();
}

console.log(
  `[icons] 완료 — 콘텐츠 반경 ${String(CONTENT_RADIUS)}/${String(VIEWBOX / 2)}, ` +
    `글로우 여유 ${String(GLOW_BLEED)}`,
);
