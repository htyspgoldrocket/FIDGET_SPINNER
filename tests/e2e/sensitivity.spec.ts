// L3 — Phase 6(플릭 민감도 설정)이 실브라우저에서 끝까지 이어지는지 확인한다.
//
// 검증 대상은 넷이다:
//   1. 슬라이더 → 다음 플릭의 세기 (조작 경로)
//   2. 슬라이더 → **도달 가능한 최고 속도** (연속 플릭으로만 드러나는 상한)
//   3. 슬라이더 → IndexedDB → 새로고침 후 복원 (저장 경로)
//   4. v1 DB(records + aggregate)를 쓰던 기존 사용자의 기록이 v2 승격에서 살아남는가 (마이그레이션)
//
// 4번은 단위 테스트로 대신할 수 없다. onupgradeneeded 가 기존 스토어를 보존하는지는
// IndexedDB 구현이 답하는 것이지 우리 코드가 답하는 것이 아니다 — 실물로 확인해야 한다.
//
// 슬라이더는 이제 **설정 탭** 안에 있다. 패널을 여는 것만으로는 닿지 않으므로 openPanel 에
// 탭을 명시한다 (helpers.ts).
import { expect, test } from '@playwright/test';

import { flickOmegaCap } from '../../src/core/input-model';

import {
  closePanel,
  collectErrors,
  flick,
  flickAndMeasure,
  flickRepeatedlyAndMeasure,
  gotoFirstRun,
  halt,
  openPanel,
  rowChecksum,
  sensitivityPercent,
  setSensitivityPercent,
  statValue,
} from './helpers';

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

/** 최소 민감도(25%)에서 플릭으로 도달할 수 있는 최고 각속도 [rad/s]. = OMEGA_MAX × 0.25 = 52.5 */
const CAP_AT_MIN = flickOmegaCap(0.25);

test('민감도 슬라이더가 설정 탭에 있고 기본값은 100% 다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);

  await openPanel(page, 'settings');

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
  await gotoFirstRun(page);
  await openPanel(page, 'settings');

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
  await gotoFirstRun(page, '/?debug=1');
  await expect(page.locator('#debug-overlay')).toBeVisible();

  // 최대 민감도로 한 번
  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 150);
  await closePanel(page);
  const fast = await flickAndMeasure(page);

  // 같은 플릭을 최소 민감도로 (같은 페이지·같은 스크립트라 조건이 같다)
  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 25);
  await closePanel(page);
  const slow = await flickAndMeasure(page);

  expect(
    fast,
    '최대 민감도에서 회전이 시작되지 않았다 — 스와이프 시뮬레이션을 확인하라',
  ).toBeGreaterThan(0);
  expect(slow, '최소 민감도에서도 회전 자체는 일어나야 한다').toBeGreaterThan(0);
  // 배율 차이는 6배다. 감속과 샘플링 흔들림을 넉넉히 빼도 절반 아래여야 한다.
  expect(slow).toBeLessThan(fast * 0.5);

  expect(errors).toEqual([]);
});

test('민감도가 도달 가능한 최고 속도까지 낮춘다 (연속 플릭으로도 상한을 넘지 못한다)', async ({
  page,
}) => {
  // 이 테스트는 플릭 시퀀스를 여러 번 재시도할 수 있다 (아래 flickSequenceUntil). 워커 4개가
  // 동시에 돌 때는 mouse.move 간격이 늘어나 시퀀스 전체가 약해지는 구간이 있는데, 그 구간은
  // 다른 워커의 무거운 테스트가 끝나면 지나간다 — 기본 30초 안에는 다 못 기다릴 수 있다.
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await gotoFirstRun(page, '/?debug=1');
  await expect(page.locator('#debug-overlay')).toBeVisible();

  // 25%: 상한 52.5 rad/s. 쉬지 않고 열네 번 튕기면 감속을 앞질러 상한까지 밀어올린다.
  // 횟수에 여유를 둔 이유: 스와이프 흉내는 워커가 붐빌 때 이따금 Δω = 0 으로 끝난다
  // (helpers.ts 의 flick 주석). 몇 번 헛나가도 누적이 상한에 닿도록 넉넉히 튕긴다 —
  // 여분의 플릭이 결과를 흔들지는 않는다. 상한 위로는 어차피 올라가지 못하기 때문이다.
  // 시퀀스 전체가 헛나가는 경우(워커 포화로 mouse.move 간격이 플릭 윈도를 넘는 경우)에는
  // 시퀀스째 다시 시도한다. 재시도는 "목표 밑"일 때만 하므로 상한 초과(진짜 회귀)를 가리지
  // 못한다 — 초과한 값은 재시도 없이 그대로 아래 단언에서 걸린다.
  async function flickSequenceUntil(times: number, atLeast: number): Promise<number> {
    let peak = 0;
    for (let attempt = 0; attempt < 5 && peak <= atLeast; attempt += 1) {
      peak = await flickRepeatedlyAndMeasure(page, times);
    }
    return peak;
  }

  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 25);
  await closePanel(page);
  const capped = await flickSequenceUntil(14, CAP_AT_MIN * 0.7);

  // 100%: 같은 플릭 시퀀스가 그 상한을 훌쩍 넘어선다 — 상한을 만든 것이 감속이 아니라
  // 설정이라는 증거다. 이 대조가 없으면 위 단언은 "플릭이 원래 약하다"로도 통과한다.
  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 100);
  await closePanel(page);
  const uncapped = await flickSequenceUntil(14, CAP_AT_MIN * 1.8);

  expect(capped, '최소 민감도에서 회전이 시작되지 않았다').toBeGreaterThan(0);
  // 상한을 넘지 않는다 (오버레이 판독 시점의 감속·반올림 여유 3%).
  expect(capped, `25% 에서 ω 가 상한 ${String(CAP_AT_MIN)} rad/s 를 넘었다`).toBeLessThan(
    CAP_AT_MIN * 1.03,
  );
  // 그러면서 상한 **가까이까지는** 올라간다. 이게 없으면 상한이 아무리 낮아도 통과한다.
  expect(capped, '25% 에서 상한 근처에 닿지 못했다 — 플릭 누적이 부족하다').toBeGreaterThan(
    CAP_AT_MIN * 0.7,
  );
  expect(uncapped, '기본 민감도에서는 같은 시퀀스가 상한을 훌쩍 넘어야 한다').toBeGreaterThan(
    CAP_AT_MIN * 1.8,
  );

  expect(errors).toEqual([]);
});

test('설정한 민감도가 IndexedDB 에 남아 새로고침 뒤에도 유지된다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 40);

  // 저장은 디바운스(300ms) 뒤에 일어난다. 그 시간과 트랜잭션 커밋 여유를 준다.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();

  await openPanel(page, 'settings');
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

  await gotoFirstRun(page);
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('memory');

  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 65);
  await page.waitForTimeout(700); // 저장 시도가 조용히 실패할 시간

  // 이번 세션 동안은 값이 유지된다. 저장 실패가 화면이나 콘솔로 새지 않는다.
  expect(await sensitivityPercent(page)).toBe(65);
  expect(errors).toEqual([]);
});

test('슬라이더를 끌어도 스피너가 돌지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);
  const canvas = page.locator('#stage');

  // 먼저 이 스와이프가 정말 스피너를 돌린다는 것을 확인해둔다. 이게 없으면 아래 단언은
  // "플릭이 원래 안 먹는다"로도 통과해버린다.
  await flick(page);
  const spun = await rowChecksum(canvas, 0.35);
  await expect.poll(() => rowChecksum(canvas, 0.35)).not.toBe(spun);
  await halt(page);

  await openPanel(page, 'settings');
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

  // v1 사용자에게도 설정 스토어는 이번에 처음 생긴다 — manualSeen 이 없으니 설명서가 뜬다.
  await gotoFirstRun(page);
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  // 기록이 그대로 읽힌다 — 마이그레이션이 스토어를 다시 만들지 않았다는 뜻이다.
  await openPanel(page, 'stats');
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
  await openPanel(page, 'settings');
  expect(await sensitivityPercent(page)).toBe(100);
  await setSensitivityPercent(page, 75);
  await page.waitForTimeout(700);
  await page.reload();
  await openPanel(page, 'settings');
  await expect.poll(() => sensitivityPercent(page)).toBe(75);
  await openPanel(page, 'stats');
  expect(await statValue(page, 'bestRpm')).toBe(V1_RECORD.maxRpm); // 기록도 여전히 그대로다

  expect(errors).toEqual([]);
});

test('저장된 민감도가 없으면 기본 배율로 시작한다 (새 프로필)', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);
  await expect.poll(() => page.locator('html').getAttribute('data-storage')).toBe('indexeddb');

  await openPanel(page, 'settings');
  // 저장소를 읽고 온 뒤에도 100% 여야 한다 (빈 스토어를 잘못 읽어 0 이나 NaN 이 되지 않는다).
  await page.waitForTimeout(300);
  expect(await sensitivityPercent(page)).toBe(100);
  await expect(page.locator('#stats-sensitivity-value')).toHaveText('100%');

  expect(errors).toEqual([]);
});
