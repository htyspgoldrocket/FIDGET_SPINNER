// tests/e2e 공용 유틸. 스펙 파일이 아니므로 Playwright 의 기본 testMatch 에 걸리지 않는다.
//
// 여기 모아둔 것은 **여러 스펙이 똑같이 필요로 하는 준비 절차**뿐이다. 특히 최초 실행 설명서
// 처리(dismissFirstRunManual)는 스펙마다 따로 쓰면 반드시 어긋난다 — 자동 열림이 비동기라
// "보이면 닫는다" 식으로 쓰는 순간 워커 부하에 따라 열리기 전에 지나가버리고, 그 뒤 아무 때나
// 패널이 튀어나와 무관한 단언을 깨뜨린다. 기다리는 방법은 한 곳에만 있어야 한다.

import { expect, type Locator, type Page } from '@playwright/test';

/** 패널 탭 식별자. DOM 은 #tab-<tab> / #section-<tab> 규칙을 따른다 (src/ui/panel.ts). */
export type PanelTab = 'stats' | 'settings' | 'manual';

/** 콘솔 error 와 잡히지 않은 예외를 모아둔다. 반환된 배열은 페이지가 도는 동안 계속 채워진다. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

// ── 최초 실행 설명서 ──────────────────────────────────────────

/**
 * 저장된 설정에 manualSeen 이 참으로 남았는지 본다. 저장소가 막힌 환경(인메모리 폴백)에서는
 * 확인할 길이 없으므로 null 을 돌려준다 — 호출부는 그때 기다림을 건너뛴다.
 *
 * 앱이 이미 v2 로 DB 를 만들어 둔 뒤에만 부른다. 버전을 지정하지 않고 열기 때문에 앱보다
 * 먼저 열면 v1 DB 를 만들어버린다.
 */
async function readStoredManualSeen(page: Page): Promise<boolean | null> {
  return page.evaluate(
    () =>
      new Promise<boolean | null>((resolve) => {
        let request: IDBOpenDBRequest;
        try {
          request = indexedDB.open('fidget-spinner');
        } catch {
          resolve(null); // 저장소가 막힌 환경
          return;
        }
        request.onerror = (): void => resolve(null);
        request.onsuccess = (): void => {
          const db = request.result;
          if (!db.objectStoreNames.contains('settings')) {
            db.close();
            resolve(null);
            return;
          }
          const get = db.transaction('settings', 'readonly').objectStore('settings').get('current');
          get.onsuccess = (): void => {
            const value: unknown = get.result;
            db.close();
            resolve(
              typeof value === 'object' &&
                value !== null &&
                (value as Record<string, unknown>)['manualSeen'] === true,
            );
          };
          get.onerror = (): void => {
            db.close();
            resolve(null);
          };
        };
      }),
  );
}

/**
 * 최초 실행 설명서가 **열리기를 기다렸다가** 닫는다.
 *
 * 자동 열림은 storage.getSettings() 가 resolve 한 뒤에 일어난다 — 로드 직후의 비동기 사건이다.
 * 열림을 명시적으로 기다려야 이후 단계가 결정론적이 된다.
 *
 * 닫은 뒤에는 manualSeen 이 실제로 저장될 때까지 기다린다. 이 스위트에는 곧바로 새로고침하는
 * 테스트가 있는데, 저장이 커밋되기 전에 다시 로드하면 설명서가 한 번 더 뜬다.
 */
export async function dismissFirstRunManual(page: Page): Promise<void> {
  const panel = page.locator('#stats-panel');
  await expect(panel, '최초 실행 설명서가 자동으로 열리지 않았다').toBeVisible();
  await expect(page.locator('#tab-manual')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#section-manual')).toBeVisible();

  await page.locator('#stats-close').click();
  await expect(panel).toBeHidden();

  // 저장소가 살아 있는 환경에서만 확인한다 (인메모리 폴백은 애초에 남지 않는다).
  if ((await readStoredManualSeen(page)) !== null) {
    await expect.poll(() => readStoredManualSeen(page)).toBe(true);
  }
}

/**
 * 새 프로필로 앱을 띄우고 최초 실행 설명서를 치운다.
 *
 * 이미 한 번 방문한 컨텍스트(두 번째 goto / reload)에서는 설명서가 뜨지 않으므로 이 함수를
 * 쓰면 안 된다 — 그때는 그냥 page.goto 를 쓴다.
 */
export async function gotoFirstRun(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#stage')).toBeVisible();
  await dismissFirstRunManual(page);
}

// ── 패널 조작 ─────────────────────────────────────────────────

/** 탭을 고르고 그 탭의 본문만 보이는 상태가 될 때까지 기다린다. */
export async function selectTab(page: Page, tab: PanelTab): Promise<void> {
  const button = page.locator(`#tab-${tab}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#section-${tab}`)).toBeVisible();
}

/**
 * 패널을 열고 원하는 탭을 고른다.
 *
 * 이미 열려 있으면 토글을 누르지 않는다 — 패널은 히스토리 엔트리에 대응하므로 연 채로
 * 새로고침하면 그대로 다시 열린 상태로 복원된다(tests/e2e/history.spec.ts). 그때 토글 버튼은
 * 카드에 가려 숨어 있어서 클릭할 수 없다.
 *
 * 탭은 항상 명시한다. 패널은 마지막 활성 탭을 기억하므로, 설명서를 닫고 나면 다음에 열 때도
 * 설명서가 펼쳐진 채다 — 기록 항목을 읽으려는 테스트가 숨은 요소를 보게 된다.
 */
export async function openPanel(page: Page, tab: PanelTab = 'stats'): Promise<void> {
  const panel = page.locator('#stats-panel');
  if (!(await panel.isVisible())) await page.locator('#stats-toggle').click();
  await expect(panel).toBeVisible();
  await selectTab(page, tab);
}

export async function closePanel(page: Page): Promise<void> {
  await page.locator('#stats-close').click();
  await expect(page.locator('#stats-panel')).toBeHidden();
}

/** 통계 항목의 원시값 (data-value). 화면 표기와 무관하게 숫자로 비교한다. */
export async function statValue(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-stat="${key}"]`).getAttribute('data-value');
  return text === null ? Number.NaN : Number(text);
}

// ── 민감도 슬라이더 ───────────────────────────────────────────

/** 슬라이더를 특정 % 로 옮긴다. 사람이 끄는 것과 같은 input 이벤트를 발생시킨다. */
export async function setSensitivityPercent(page: Page, percent: number): Promise<void> {
  await page.locator('#stats-sensitivity').evaluate((element, value) => {
    const slider = element as HTMLInputElement;
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, percent);
  await expect(page.locator('#stats-sensitivity-value')).toHaveText(`${String(percent)}%`);
}

export async function sensitivityPercent(page: Page): Promise<number> {
  return Number(await page.locator('#stats-sensitivity').inputValue());
}

// ── 캔버스 읽기 ───────────────────────────────────────────────

/**
 * 캔버스의 가로 한 줄을 픽셀 단위로 읽어 체크섬을 만든다.
 * 회전하면 값이 바뀌고, 멈춰 있으면 그대로다 — 정지/회전 판정에 쓴다.
 */
export async function rowChecksum(canvas: Locator, yFraction: number): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement, fraction: number) => {
    const ctx = element.getContext('2d');
    if (ctx === null) return -1;
    const y = Math.floor(element.height * fraction);
    const { data } = ctx.getImageData(0, y, element.width, 1);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum = (sum * 31 + (data[i] ?? 0) * 7 + (data[i + 1] ?? 0) * 3 + (data[i + 2] ?? 0)) | 0;
    }
    return sum;
  }, yFraction);
}

/** 배경(#0e1116)이 아닌 픽셀 수. 스피너가 실제로 그려졌는지 본다. */
export async function paintedPixels(canvas: Locator, yFraction = 0.5): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement, fraction: number) => {
    const ctx = element.getContext('2d');
    if (ctx === null) return -1;
    const y = Math.floor(element.height * fraction);
    const { data } = ctx.getImageData(0, y, element.width, 1);
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x0e || data[i + 1] !== 0x11 || data[i + 2] !== 0x16) painted += 1;
    }
    return painted;
  }, yFraction);
}

// ── 입력 흉내 ─────────────────────────────────────────────────

/**
 * 스피너 중심 위쪽을 가로지르는 접선 스와이프로 한 번 튕긴다.
 *
 * **이 박자를 바꾸지 마라.** 간격을 늘려 "부드럽게" 튕기면 워커가 붐빌 때 mouse.move 사이의
 * 실제 간격이 플릭 윈도(100ms)를 넘어서서 Δω 가 0 이 된다 (playwright.config.ts 의 workers
 * 주석에 적힌 그 현상이다).
 */
export async function flick(page: Page): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');

  const swipeY = box.y + box.height / 2 - box.height * 0.11;
  const startX = box.x + box.width / 2 - box.width * 0.28;

  await page.mouse.move(startX, swipeY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(startX + (box.width * 0.56 * i) / 8, swipeY);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

/** 더블탭으로 즉시 정지시킨다 (다음 측정이 이전 회전에 얹히지 않게). */
export async function halt(page: Page): Promise<void> {
  const box = await page.locator('#stage').boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
}

// ── ω 실측 (?debug=1) ─────────────────────────────────────────

/** 디버그 오버레이가 지금 보여주는 ω [rad/s] 의 절댓값. 읽지 못하면 0. */
export async function readOmega(page: Page): Promise<number> {
  const text = (await page.locator('#debug-overlay').textContent()) ?? '';
  const matched = /ω\s+(-?[\d.]+)\s+rad\/s/.exec(text);
  return matched === null ? 0 : Math.abs(Number(matched[1]));
}

/**
 * 잠깐 동안 여러 번 읽어 최고 ω 를 잡는다.
 *
 * 오버레이는 100ms 마다 다시 그리고 ω 는 그 사이에도 감속하므로 한 번만 읽으면 최고점을
 * 놓친다. 이 오버레이는 원래 "느낌이 이상하다"를 숫자로 잡으려고 만든 도구다(CLAUDE.md 7장)
 * — 검증용 출구를 새로 뚫는 대신 있는 것을 쓴다.
 */
export async function peakOmega(page: Page, samples = 10, intervalMs = 40): Promise<number> {
  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    peak = Math.max(peak, await readOmega(page));
    await page.waitForTimeout(intervalMs);
  }
  return peak;
}

/**
 * 정지 상태에서 한 번 튕기고 그때의 최고 ω 를 잰다. 측정 전에 항상 세워둔다.
 *
 * 스와이프 시뮬레이션은 워커 부하에 따라 이따금 Δω = 0 으로 끝난다 (flick 주석 참조).
 * 그건 앱의 회귀가 아니라 입력 흉내의 실패이므로 다시 튕겨본다 — 세 번 다 0 이면 그때는
 * 진짜로 플릭이 먹지 않는 것이고, 호출부의 단언이 그것을 잡는다.
 */
export async function flickAndMeasure(page: Page): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await halt(page);
    await flick(page);
    const peak = await peakOmega(page);
    if (peak > 0) return peak;
  }
  return 0;
}

/**
 * 정지 상태에서 **쉬지 않고** 여러 번 튕기고 마지막 플릭 직후의 ω 를 잰다.
 *
 * 한 번의 플릭이 아니라 누적을 본다 — 민감도가 도달 가능한 최고 속도까지 낮추는지는 연속
 * 플릭으로만 드러난다. 사이사이 읽지 않는 것이 핵심이다: 읽는 동안 스피너가 감속하면 누적이
 * 감속과 균형을 이뤄 상한에 닿기 전에 멈춰버리고, 그러면 이 측정은 상한을 검증하지 못한다.
 *
 * 최고점은 마지막 플릭 직후이므로(플릭마다 상한으로 클램프된다) 그때부터 잠깐 샘플링하면 된다.
 */
export async function flickRepeatedlyAndMeasure(page: Page, times: number): Promise<number> {
  await halt(page);
  for (let i = 0; i < times; i += 1) await flick(page);
  return peakOmega(page, 6, 25);
}
