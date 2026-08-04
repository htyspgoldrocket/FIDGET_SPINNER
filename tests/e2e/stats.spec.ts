// L3 — Phase 4(기록 시스템)가 실제 브라우저에서 도는지 확인한다.
//
// **IndexedDB 백엔드의 계약은 여기서 검증한다.** 단위 테스트는 백엔드에 무관한 부분(백업 코드
// 형식·검증·집계·페이징)만 인메모리로 돌린다. IndexedDB 자체는 목킹 대신 실물로 확인하는 쪽이
// 낫다고 판단했다 — 폴리필로는 트랜잭션 커밋 타이밍이나 새로고침 후 영속성처럼 정작 깨지기 쉬운
// 부분을 보증할 수 없고, 그 보증이 없으면 폴리필 통과는 "기록이 남는다"의 근거가 되지 못한다.
// (부수 효과로 런타임/개발 의존성이 하나도 늘지 않는다 — CLAUDE.md 불변식 6.)
import { expect, test, type Locator, type Page } from '@playwright/test';

/** 콘솔 error 와 잡히지 않은 예외를 모아둔다. 저장 실패는 어떤 경우에도 콘솔로 새면 안 된다. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** 통계 항목의 원시값 (data-value). 화면 표기와 무관하게 숫자로 비교한다. */
async function statValue(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-stat="${key}"]`).getAttribute('data-value');
  return text === null ? Number.NaN : Number(text);
}

/**
 * 스피너를 튕겨 한 세션을 만들고 더블탭으로 닫는다.
 *
 * MIN_RECORDED_DURATION_MS(250) 를 넘겨야 기록으로 남으므로 정지 전에 충분히 돌려둔다.
 */
async function spinOnce(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  const swipeY = centerY - box.height * 0.11;
  const startX = centerX - box.width * 0.28;

  // 스와이프 시뮬레이션은 워커 부하에 따라 이따금 Δω = 0 으로 끝난다 — mouse.move 사이의
  // 실제 간격이 플릭 윈도(100ms)를 넘어 마지막 샘플만 남는 경우다 (sensitivity.spec 의
  // flickAndMeasure 와 같은 현상). 앱의 회귀가 아니라 입력 흉내의 실패이므로, 튕긴 뒤
  // 화면이 실제로 움직이는지 확인하고 안 움직였으면 다시 튕긴다. 세 번 다 실패하면 그대로
  // 진행한다 — 호출부의 세션 수 단언이 그것을 잡는다.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.move(startX, swipeY);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) {
      await page.mouse.move(startX + (box.width * 0.56 * i) / 8, swipeY);
      await page.waitForTimeout(12);
    }
    await page.mouse.up();

    const before = await canvas.screenshot();
    await page.waitForTimeout(120);
    const after = await canvas.screenshot();
    if (!before.equals(after)) break; // 회전 중
  }

  await page.waitForTimeout(500); // 기록 문턱을 넘기고
  await page.mouse.dblclick(centerX, centerY); // 더블탭으로 즉시 정지 → 세션 종료
  await page.waitForTimeout(150);
}

/**
 * 패널이 열린 상태로 만든다.
 *
 * 이미 열려 있으면 토글을 누르지 않는다 — Phase 5 부터 패널은 히스토리 엔트리에 대응하므로,
 * 패널을 연 채 새로고침하면 그대로 다시 열린 상태로 복원된다(tests/e2e/history.spec.ts).
 * 그때 토글 버튼은 카드에 가려 숨어 있어서 클릭할 수 없다.
 */
async function openPanel(page: Page): Promise<void> {
  const panel = page.locator('#stats-panel');
  if (!(await panel.isVisible())) await page.locator('#stats-toggle').click();
  await expect(panel).toBeVisible();
}

async function closePanel(page: Page): Promise<void> {
  await page.locator('#stats-close').click();
  await expect(page.locator('#stats-panel')).toBeHidden();
}

test('통계 패널이 열리고 회전 기록이 값으로 나타난다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  // 실브라우저에서는 인메모리 폴백이 아니라 IndexedDB 경로로 붙어야 한다.
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  // 패널은 닫혀 있고, 토글 버튼만 이벤트를 받는다.
  await expect(page.locator('#stats-panel')).toBeHidden();

  await openPanel(page);
  await expect(page.locator('#stats-toggle')).toBeHidden(); // 카드와 겹치지 않게 숨는다
  expect(await statValue(page, 'sessionCount')).toBe(0);
  expect(await statValue(page, 'bestRpm')).toBe(0);

  await closePanel(page);
  await spinOnce(page, canvas);
  await openPanel(page);

  expect(await statValue(page, 'sessionCount')).toBe(1);
  expect(await statValue(page, 'bestRpm')).toBeGreaterThan(0);
  expect(await statValue(page, 'totalRevolutions')).toBeGreaterThan(0);
  expect(await statValue(page, 'bestDurationMs')).toBeGreaterThan(250);

  // 네 항목 모두 사람이 읽을 수 있는 문자열로 채워져 있다.
  for (const key of ['bestRpm', 'totalRevolutions', 'bestDurationMs', 'sessionCount']) {
    await expect(page.locator(`[data-stat="${key}"]`)).not.toHaveText('—');
  }

  expect(errors).toEqual([]);
});

test('기록이 IndexedDB 에 남아 새로고침 뒤에도 유지된다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  await spinOnce(page, canvas);
  await openPanel(page);
  const bestRpm = await statValue(page, 'bestRpm');
  expect(await statValue(page, 'sessionCount')).toBe(1);

  await page.waitForTimeout(300); // 트랜잭션 커밋 여유
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();

  await openPanel(page);
  await expect.poll(() => statValue(page, 'sessionCount')).toBe(1);
  expect(await statValue(page, 'bestRpm')).toBeCloseTo(bestRpm, 6);

  expect(errors).toEqual([]);
});

test('백업 코드를 내보내고 다시 불러오면 그 시점의 기록으로 돌아간다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  // 세션 1개 → 백업 코드 확보
  await spinOnce(page, canvas);
  await openPanel(page);
  await page.locator('#stats-export').click();

  const code = page.locator('#stats-code');
  await expect.poll(async () => (await code.inputValue()).length).toBeGreaterThan(0);
  const backup = await code.inputValue();
  expect(backup).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  await expect(page.locator('#stats-message')).toContainText('백업 코드');

  const snapshot = {
    sessionCount: await statValue(page, 'sessionCount'),
    bestRpm: await statValue(page, 'bestRpm'),
    totalRevolutions: await statValue(page, 'totalRevolutions'),
  };
  expect(snapshot.sessionCount).toBe(1);

  // 세션을 하나 더 쌓아 상태를 바꾼다
  await closePanel(page);
  await spinOnce(page, canvas);
  await openPanel(page);
  expect(await statValue(page, 'sessionCount')).toBe(2);

  // 백업 코드를 불러오면 세션 1개 시점으로 교체된다
  await page.locator('#stats-import-code').fill(backup);
  await page.locator('#stats-import').click();

  await expect(page.locator('#stats-message')).toContainText('불러왔습니다');
  await expect.poll(() => statValue(page, 'sessionCount')).toBe(1);
  expect(await statValue(page, 'bestRpm')).toBeCloseTo(snapshot.bestRpm, 6);
  expect(await statValue(page, 'totalRevolutions')).toBeCloseTo(snapshot.totalRevolutions, 6);

  // 교체된 상태도 저장소에 반영되어 새로고침을 견딘다
  await page.waitForTimeout(300);
  await page.reload();
  await openPanel(page);
  await expect.poll(() => statValue(page, 'sessionCount')).toBe(1);

  expect(errors).toEqual([]);
});

test('잘못된 백업 코드는 에러 문구로 알리고 기록을 건드리지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  await spinOnce(page, canvas);
  await openPanel(page);
  const before = await statValue(page, 'sessionCount');
  expect(before).toBe(1);

  await page.locator('#stats-import-code').fill('이건 백업 코드가 아니다');
  await page.locator('#stats-import').click();
  await expect(page.locator('#stats-message')).toContainText('올바르지 않습니다');
  expect(await statValue(page, 'sessionCount')).toBe(before);

  // 빈 입력도 조용히 넘어가지 않고 안내한다
  await page.locator('#stats-import-code').fill('   ');
  await page.locator('#stats-import').click();
  await expect(page.locator('#stats-message')).toContainText('붙여넣으세요');

  // 어떤 실패도 콘솔로 새지 않는다 (throw 대신 문구로만 알린다)
  expect(errors).toEqual([]);
});

test('패널이 닫혀 있으면 플릭을 가로채지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  // 패널 루트는 화면 전체를 덮지만 pointer-events:none 이라 캔버스가 그대로 받는다.
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const middle = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.id ?? '',
    [box.width / 2, box.height / 2],
  );
  expect(middle).toBe('stage');

  expect(errors).toEqual([]);
});

test('IndexedDB 가 막혀 있어도 앱이 죽지 않고 인메모리로 동작한다', async ({ page }) => {
  const errors = collectErrors(page);

  // 저장소가 차단된 환경(사생활 보호 모드 등)을 흉내 낸다 — open 이 곧바로 던진다.
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
  const canvas = page.locator('#stage');
  await expect(canvas).toBeVisible();

  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('memory');

  // 폴백 경로에서도 회전·기록·백업 코드가 전부 평소대로 동작한다 (세션 한정일 뿐이다).
  await spinOnce(page, canvas);
  await openPanel(page);
  expect(await statValue(page, 'sessionCount')).toBe(1);

  await page.locator('#stats-export').click();
  await expect
    .poll(async () => (await page.locator('#stats-code').inputValue()).length)
    .toBeGreaterThan(0);

  // 열기 실패는 예외로 새지 않는다.
  expect(errors).toEqual([]);
});
