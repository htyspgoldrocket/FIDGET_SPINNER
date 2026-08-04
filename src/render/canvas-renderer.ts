// Canvas 2D 렌더러. DPR 대응 및 회전 상태 시각화.
//
// 이 파일은 **그리기만** 한다. 각도를 인자로 받아 그 자세로 그릴 뿐, 물리는 건드리지 않는다
// (시뮬레이션은 core/physics 의 몫이다). 캔버스는 생성 시 주입받는다.
//
// 디자인 원본: docs/design/spinner-reference.svg (B. 네온 아웃라인).
// 아래 REF_* 값은 그 SVG 의 좌표를 그대로 옮긴 것이다 — viewBox 480×480, 중심 (240,240)
// 기준의 "레퍼런스 단위"이며, 화면 크기에 맞춘 배율 `unit` 을 곱해 픽셀이 된다.
//
// 성능: 글로우를 shadowBlur 로 매 프레임 그리면 프레임당 비용이 수 ms 단위로 뛴다.
// 그래서 **정지 자세의 스피너를 오프스크린 캔버스에 한 번만 그려두고**(스프라이트),
// 매 프레임은 rotate + drawImage 만 한다. 스프라이트는 크기나 DPR 이 바뀔 때만 다시 만든다.
// (RPM 에 따른 색 보간 같은 연출은 이 캐시와 상충하므로 넣지 않는다 — Phase 6 튜닝 여지.)

import type { Point2 } from '../core/input-model';

// ── 디자인 상수 (docs/design/spinner-reference.svg) ────────────
// 물리 상수가 아니므로 core/constants.ts 가 아니라 여기에 둔다 (CLAUDE.md 규칙 5는 물리 상수 대상).

/** 배경. index.html 의 body 배경 및 theme-color 와 같은 값이어야 한다. */
const COLOR_BACKGROUND = '#0e1116';
/** 몸체(중심 링·팔·로브 링) 색. */
const COLOR_BODY = '#39d5ff';
/** 포인트(로브 안쪽 링·중심 안쪽 링) 색. */
const COLOR_POINT = '#9ef01a';

const ARM_COUNT = 3;
const REF_ARM_LEN = 66;
const REF_LOBE_DIST = 124;
const REF_LOBE_R = 60;
const REF_LOBE_INNER_R = 28;
const REF_HUB_R = 48;
const REF_HUB_INNER_R = 20;
const REF_STROKE_BODY = 8;
const REF_STROKE_POINT = 6;

/** 글로우 반경. 원본 SVG 는 feGaussianBlur stdDeviation=7 이고,
 *  Canvas 의 shadowBlur 는 사양상 시그마의 2배로 정의된다 → 7 × 2 = 14. */
const REF_GLOW_BLUR = 14;

/** 스피너의 외곽 반경 (가장 바깥 로브 링의 스트로크 바깥선). 입력 판정의 기준 반경이기도 하다. */
const REF_OUTER = REF_LOBE_DIST + REF_LOBE_R + REF_STROKE_BODY / 2;

/** 스프라이트 캔버스의 반변 길이. 글로우가 잘리지 않도록 여유를 둔다. */
const REF_SPRITE_HALF = REF_OUTER + REF_GLOW_BLUR * 2;

/** 스피너 지름이 화면 짧은 변에서 차지하는 비율. */
const VIEWPORT_FILL = 0.88;

const TWO_PI = Math.PI * 2;

/** 스피너의 화면상 배치. 포인터 좌표와 같은 CSS 픽셀 공간이다 (캔버스 좌상단 기준). */
export interface SpinnerLayout {
  readonly center: Point2;
  /** 외곽 반경 [css px]. */
  readonly radius: number;
}

export interface CanvasRenderer {
  /** 캔버스의 CSS 크기와 devicePixelRatio 를 반영한다. 값이 바뀐 경우에만 스프라이트를 다시 만든다. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  /** 누적 회전각 theta [rad] 자세로 한 프레임 그린다. */
  render(theta: number): void;
  /** 현재 배치. 입력 레이어가 플릭 지렛대와 브레이크 히트 판정에 쓴다. */
  layout(): SpinnerLayout;
}

/**
 * 스피너 한 대를 그린다. 원점은 회전 중심이고, 호출 시점의 변환은 유지된다.
 *
 * 글로우 패스(shadowBlur 적용) → 선명 패스(shadow 없음) 순으로 두 번 그린다.
 * 원본 SVG 의 feMerge(블러를 아래, 원본을 위에 합성)와 같은 결과를 낸다.
 */
function paintSpinner(ctx: CanvasRenderingContext2D, unit: number): void {
  ctx.save();
  ctx.scale(unit, unit);
  ctx.lineCap = 'round';

  for (let pass = 0; pass < 2; pass += 1) {
    const glow = pass === 0;
    // shadowBlur 는 CTM 의 영향을 받지 않는다(사양). 배율을 직접 곱해야 한다.
    ctx.shadowBlur = glow ? REF_GLOW_BLUR * unit : 0;

    // 파랑 몸체: 팔 3개 + 로브 링 3개 + 중심 링. 한 경로로 묶어 한 번에 스트로크한다.
    ctx.strokeStyle = COLOR_BODY;
    ctx.shadowColor = glow ? COLOR_BODY : 'transparent';
    ctx.lineWidth = REF_STROKE_BODY;
    ctx.beginPath();
    for (let i = 0; i < ARM_COUNT; i += 1) {
      const a = (TWO_PI * i) / ARM_COUNT;
      const dirX = Math.sin(a);
      const dirY = -Math.cos(a);
      ctx.moveTo(0, 0);
      ctx.lineTo(dirX * REF_ARM_LEN, dirY * REF_ARM_LEN);
      const lobeX = dirX * REF_LOBE_DIST;
      const lobeY = dirY * REF_LOBE_DIST;
      ctx.moveTo(lobeX + REF_LOBE_R, lobeY);
      ctx.arc(lobeX, lobeY, REF_LOBE_R, 0, TWO_PI);
    }
    ctx.moveTo(REF_HUB_R, 0);
    ctx.arc(0, 0, REF_HUB_R, 0, TWO_PI);
    ctx.stroke();

    // 라임 포인트: 로브 안쪽 링 3개 + 중심 안쪽 링.
    ctx.strokeStyle = COLOR_POINT;
    ctx.shadowColor = glow ? COLOR_POINT : 'transparent';
    ctx.lineWidth = REF_STROKE_POINT;
    ctx.beginPath();
    for (let i = 0; i < ARM_COUNT; i += 1) {
      const a = (TWO_PI * i) / ARM_COUNT;
      const lobeX = Math.sin(a) * REF_LOBE_DIST;
      const lobeY = -Math.cos(a) * REF_LOBE_DIST;
      ctx.moveTo(lobeX + REF_LOBE_INNER_R, lobeY);
      ctx.arc(lobeX, lobeY, REF_LOBE_INNER_R, 0, TWO_PI);
    }
    ctx.moveTo(REF_HUB_INNER_R, 0);
    ctx.arc(0, 0, REF_HUB_INNER_R, 0, TWO_PI);
    ctx.stroke();
  }

  ctx.restore();
}

function get2dContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d');
  if (ctx === null) throw new Error('Canvas 2D 컨텍스트를 얻지 못했다.');
  return ctx;
}

/** 주어진 캔버스에 그리는 렌더러를 만든다. 2D 컨텍스트를 얻지 못하면 던진다. */
export function createCanvasRenderer(canvas: HTMLCanvasElement): CanvasRenderer {
  const ctx = get2dContext(canvas);
  const sprite = document.createElement('canvas');
  const spriteCtx = get2dContext(sprite);

  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;
  /** 레퍼런스 단위 1 이 몇 CSS 픽셀인가. 0 이면 아직 그릴 수 없는 크기다. */
  let unitCss = 0;
  let spriteHalfCss = 0;

  function rebuildSprite(): void {
    const side = Math.max(1, Math.round(spriteHalfCss * 2 * dpr));
    sprite.width = side;
    sprite.height = side;
    // 크기 대입은 캔버스를 지우고 컨텍스트 상태까지 초기화한다 — 매번 원점부터 다시 잡는다.
    spriteCtx.setTransform(1, 0, 0, 1, 0, 0);
    spriteCtx.translate(side / 2, side / 2);
    paintSpinner(spriteCtx, unitCss * dpr);
  }

  return {
    resize(nextCssWidth: number, nextCssHeight: number, nextDpr: number): void {
      const w = Number.isFinite(nextCssWidth) ? Math.max(0, nextCssWidth) : 0;
      const h = Number.isFinite(nextCssHeight) ? Math.max(0, nextCssHeight) : 0;
      const d = Number.isFinite(nextDpr) && nextDpr > 0 ? nextDpr : 1;
      if (w === cssWidth && h === cssHeight && d === dpr) return;

      cssWidth = w;
      cssHeight = h;
      dpr = d;

      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));

      const shortSide = Math.min(cssWidth, cssHeight);
      unitCss = shortSide * VIEWPORT_FILL * 0.5 * (1 / REF_OUTER);
      spriteHalfCss = REF_SPRITE_HALF * unitCss;
      if (unitCss > 0) rebuildSprite();
    },

    render(theta: number): void {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLOR_BACKGROUND;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      if (unitCss <= 0) return;

      // theta 는 누적값이라 오래 돌리면 절댓값이 커진다. 2π 로 접어 부동소수 정밀도를 지킨다.
      const angle = Number.isFinite(theta) ? theta % TWO_PI : 0;
      ctx.translate(cssWidth / 2, cssHeight / 2);
      ctx.rotate(angle);
      ctx.drawImage(sprite, -spriteHalfCss, -spriteHalfCss, spriteHalfCss * 2, spriteHalfCss * 2);
    },

    layout(): SpinnerLayout {
      return {
        center: { x: cssWidth / 2, y: cssHeight / 2 },
        radius: REF_OUTER * unitCss,
      };
    },
  };
}
