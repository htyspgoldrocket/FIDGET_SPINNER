// L3 — Phase 6(플릭 민감도 설정)이 실브라우저에서 끝까지 이어지는지 확인한다.
//
// 검증 대상은 셋이다:
//   1. 슬라이더 → 다음 플릭의 세기 (조작 경로)
//   2. 슬라이더 → IndexedDB → 새로고침 후 복원 (저장 경로)
//   3. v1 DB(records + aggregate)를 쓰던 기존 사용자의 기록이 v2 승격에서 살아남는가 (마이그레이션)
//
// 3번은 단위 테스트로 대신할 수 없다. onupgradeneeded 가 기존 스토어를 보존하는지는
// IndexedDB 구현이 답하는 것이지 우리 코드가 답하는 것이 아니다 — 실물로 확인해야 한다.
import { expect, test, type Locator, type Page } from '@playwright/test';

/** v1 시절 저장돼 있던 기록. 승격 뒤에도 이 값이 그대로 보여야 한다. */
const V1_RECORD = {
  id: 'v1-seed-record',
  ts: 1_700_000_000_000,
  maxRpm: 777,
  durationMs: 4321,
  revolutions: 12.5,
  braked: false,
  schemaVersion: 1,
} as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function statValue(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-stat="${key}"]`).getAttribute('data-value');
  return text === null ? Number.NaN : Number(text);
}

async function openPanel(page: Page): Promise<void> {
  const panel = page.locator('#stats-panel');
  if (!(await panel.isVisible())) await page.locator('#stats-toggle').click();
  await expect(panel).toBeVisible();
}

async function closePanel(page: Page): Promise<void> {
  await page.locator('#stats-close').click();
  await expect(page.locator('#stats-panel')).toBeHidden();
}

/** 슬라이더를 특정 % 로 옮긴다. 사람이 끄는 것과 같은 input 이벤트를 발생시킨다. */
async function setSensitivityPercent(page: Page, percent: number): Promise<void> {
  await page.locator('#stats-sensitivity').evaluate((element, value) => {
    const slider = element as HTMLInputElement;
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, percent);
  await expect(page.locator('#stats-sensitivity-value')).toHaveText(`${String(percent)}%`);
}

async function sensitivityPercent(page: Page): Promise<number> {
  return Number(await page.locator('#stats-sensitivity').inputValue());
}

/** 캔버스 가로 한 줄의 체크섬 (app.spec.ts 와 같은 방식). 회전하면 값이 바뀐다. */
async function rowChecksum(canvas: Locator, yFraction: number): Promise<number> {
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

/**
 * 스피너를 튕긴다. 스와이프의 모양과 박자는 app.spec / stats.spec 과 같다.
 *
 * 이 박자를 그대로 쓰는 것이 중요하다. 간격을 늘려 "부드럽게" 튕기면 워커가 붐빌 때
 * mouse.move 사이의 실제 간격이 플릭 윈도(100ms)를 넘어서서 Δω 가 0 이 된다
 * (playwright.config.ts 의 workers 주석에 적힌 그 현상이다).
 */
async function flick(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
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

/**
 * 플릭 직후의 최고 ω [rad/s]. ?debug=1 오버레이의 판독값을 읽는다.
 *
 * 오버레이는 100ms 마다 다시 그리고 ω 는 그 사이에도 감속하므로, 한 번 읽는 대신 잠깐 동안
 * 여러 번 읽어 최댓값을 쓴다. 이 오버레이는 원래 "느낌이 이상하다"를 숫자로 잡으려고 만든
 * 도구다(CLAUDE.md 7장) — 검증용 출구를 새로 뚫는 대신 있는 것을 쓴다.
 */
async function peakOmega(page: Page): Promise<number> {
  const readout = page.locator('#debug-overlay');
  let peak = 0;
  for (let i = 0; i < 10; i += 1) {
    const text = (await readout.textContent()) ?? '';
    const matched = /ω\s+(-?[\d.]+)\s+rad\/s/.exec(text);
    if (matched !== null) peak = Math.max(peak, Math.abs(Number(matched[1])));
    await page.waitForTimeout(40);
  }
  return peak;
}

/** 더블탭으로 즉시 정지시킨다 (다음 측정이 이전 회전에 얹히지 않게). */
async function halt(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
}

/**
 * 정지 상태에서 한 번 튕기고 그때의 최고 ω 를 잰다. 측정이 끝나면 다시 세워둔다.
 *
 * 스와이프 시뮬레이션은 워커 부하에 따라 이따금 Δω = 0 으로 끝난다 (flick 주석 참조).
 * 그건 앱의 회귀가 아니라 입력 흉내의 실패이므로 다시 튕겨본다 — 세 번 다 0 이면 그때는
 * 진짜로 플릭이 먹지 않는 것이고, 호출부의 단언이 그것을 잡는다.
 */
async function flickAndMeasure(page: Page, canvas: Locator): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await halt(page, canvas);
    await flick(page, canvas);
    const peak = await peakOmega(page);
    if (peak > 0) return peak;
  }
  return 0;
}

test('민감도 슬라이더가 기록 패널에 있고 기본값은 100% 다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();

  await openPanel(page);

  const slider = page.locator('#stats-sensitivity');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('min', '25');
  await expect(slider).toHaveAttribute('max', '150');
  await expect(slider).toHaveAttribute('step', '5');
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('100%');
  expect(await sensitivityPercent(page)).toBe(100);

  expect(errors).toEqual([]);
});

test('슬라이더를 키보드로 움직이면 % 표시가 즉시 따라온다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openPanel(page);

  const slider = page.locator('#stats-sensitivity');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('95%');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('105%');

  // 끝까지 밀어도 범위를 넘지 않는다.
  await page.keyboard.press('End');
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('150%');
  await page.keyboard.press('Home');
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('25%');

  expect(errors).toEqual([]);
});

test('민감도를 낮추면 같은 플릭의 회전이 눈에 띄게 느려진다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?debug=1');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#debug-overlay')).toBeVisible();

  // 최대 민감도로 한 번
  await openPanel(page);
  await setSensitivityPercent(page, 150);
  await closePanel(page);
  const fast = await flickAndMeasure(page, canvas);

  // 같은 플릭을 최소 민감도로 (같은 페이지·같은 스크립트라 조건이 같다)
  await openPanel(page);
  await setSensitivityPercent(page, 25);
  await closePanel(page);
  const slow = await flickAndMeasure(page, canvas);

  expect(
    fast,
    '최대 민감도에서 회전이 시작되지 않았다 — 스와이프 시뮬레이션을 확인하라',
  ).toBeGreaterThan(0);
  expect(slow, '최소 민감도에서도 회전 자체는 일어나야 한다').toBeGreaterThan(0);
  // 배율 차이는 6배다. 감속과 샘플링 흔들림을 넉넉히 빼도 절반 아래여야 한다.
  expect(slow).toBeLessThan(fast * 0.5);

  expect(errors).toEqual([]);
});

test('설정한 민감도가 IndexedDB 에 남아 새로고침 뒤에도 유지된다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  await openPanel(page);
  await setSensitivityPercent(page, 40);

  // 저장은 디바운스(300ms) 뒤에 일어난다. 그 시간과 트랜잭션 커밋 여유를 준다.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();

  await openPanel(page);
  await expect.poll(() => sensitivityPercent(page)).toBe(40);
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('40%');

  expect(errors).toEqual([]);
});

test('IndexedDB 가 막혀 있어도 슬라이더는 동작한다 (저장만 안 될 뿐)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get: () => ({
        open: (): never => {
          throw new Error('blocked');
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('memory');

  await openPanel(page);
  await setSensitivityPercent(page, 65);
  await page.waitForTimeout(700); // 저장 시도가 조용히 실패할 시간

  // 이번 세션 동안은 값이 유지된다. 저장 실패가 화면이나 콘솔로 새지 않는다.
  expect(await sensitivityPercent(page)).toBe(65);
  expect(errors).toEqual([]);
});

test('슬라이더를 끌어도 스피너가 돌지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  // 먼저 이 스와이프가 정말 스피너를 돌린다는 것을 확인해둔다. 이게 없으면 아래 단언은
  // "플릭이 원래 안 먹는다"로도 통과해버린다.
  await flick(page, canvas);
  const spun = await rowChecksum(canvas, 0.35);
  await expect.poll(() => rowChecksum(canvas, 0.35)).not.toBe(spun);
  await halt(page, canvas);

  await openPanel(page);
  const box = await page.locator('#stats-sensitivity').boundingBox();
  if (box === null) throw new Error('슬라이더의 배치 상자를 얻지 못했다.');

  const before = await rowChecksum(canvas, 0.35);

  // 슬라이더 위를 가로질러 끈다 — 캔버스가 이걸 플릭으로 받으면 스피너가 돌기 시작한다.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(box.x + box.width * (0.2 + (0.6 * i) / 6), box.y + box.height / 2);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  // 값은 바뀌었지만
  expect(await sensitivityPercent(page)).toBeGreaterThan(25);
  // 화면은 그대로다.
  await page.waitForTimeout(250);
  expect(await rowChecksum(canvas, 0.35), '슬라이더 조작이 캔버스로 새어 스피너가 돌았다').toBe(
    before,
  );

  expect(errors).toEqual([]);
});

test('v1 DB 를 쓰던 사용자의 기록이 v2 승격에서 살아남는다', async ({ page }) => {
  // 앱 스크립트만 막고 같은 오리진의 셸을 띄운다 — 여기서 v1 DB 를 직접 만들어둔 뒤,
  // 스크립트를 풀고 다시 들어가면 그게 곧 "업데이트를 받은 기존 사용자"다.
  await page.route('**/main.ts*', (route) => route.abort());
  await page.goto('/');

  await page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('fidget-spinner', 1);
        request.onupgradeneeded = (): void => {
          const db = request.result;
          const store = db.createObjectStore('records', { keyPath: 'id' });
          store.createIndex('ts', 'ts');
          db.createObjectStore('aggregate');
        };
        request.onsuccess = (): void => {
          const db = request.result;
          const tx = db.transaction(['records', 'aggregate'], 'readwrite');
          tx.objectStore('records').put(record);
          tx.objectStore('aggregate').put(
            {
              totalRevolutions: record.revolutions,
              totalTimeMs: record.durationMs,
              bestRpm: record.maxRpm,
              bestDurationMs: record.durationMs,
              sessionCount: 1,
              schemaVersion: 1,
            },
            'current',
          );
          tx.oncomplete = (): void => {
            db.close();
            resolve();
          };
          tx.onerror = (): void => reject(new Error('v1 시드 트랜잭션이 실패했다.'));
        };
        request.onerror = (): void => reject(new Error('v1 DB 를 만들지 못했다.'));
      }),
    V1_RECORD,
  );

  await page.unroute('**/main.ts*');
  const errors = collectErrors(page); // 스크립트를 막았던 첫 로드의 잡음은 세지 않는다
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  // 기록이 그대로 읽힌다 — 마이그레이션이 스토어를 다시 만들지 않았다는 뜻이다.
  await openPanel(page);
  await expect.poll(() => statValue(page, 'bestRpm')).toBe(V1_RECORD.maxRpm);
  expect(await statValue(page, 'sessionCount')).toBe(1);
  expect(await statValue(page, 'bestDurationMs')).toBe(V1_RECORD.durationMs);
  expect(await statValue(page, 'totalRevolutions')).toBe(V1_RECORD.revolutions);

  // DB 는 v2 가 됐고 스토어가 셋 다 있다 (기존 둘 + settings).
  const schema = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
        const request = indexedDB.open('fidget-spinner');
        request.onsuccess = (): void => {
          const db = request.result;
          const info = { version: db.version, stores: [...db.objectStoreNames].sort() };
          db.close();
          resolve(info);
        };
        request.onerror = (): void => reject(new Error('DB 를 열지 못했다.'));
      }),
  );
  expect(schema.version).toBe(2);
  expect(schema.stores).toEqual(['aggregate', 'records', 'settings']);

  // 새로 생긴 settings 스토어도 정상 동작한다 (기본값 → 변경 → 새로고침 후 유지).
  expect(await sensitivityPercent(page)).toBe(100);
  await setSensitivityPercent(page, 75);
  await page.waitForTimeout(700);
  await page.reload();
  await openPanel(page);
  await expect.poll(() => sensitivityPercent(page)).toBe(75);
  expect(await statValue(page, 'bestRpm')).toBe(V1_RECORD.maxRpm); // 기록도 여전히 그대로다

  expect(errors).toEqual([]);
});

test('저장된 민감도가 없으면 기본 배율로 시작한다 (새 프로필)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  await openPanel(page);
  // 저장소를 읽고 온 뒤에도 100% 여야 한다 (빈 스토어를 잘못 읽어 0 이나 NaN 이 되지 않는다).
  await page.waitForTimeout(300);
  expect(await sensitivityPercent(page)).toBe(100);
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('100%');

  expect(errors).toEqual([]);
});
