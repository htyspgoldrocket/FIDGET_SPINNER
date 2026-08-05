// L3 — 메뉴 패널의 탭 세 개 (기록 / 설정 / 설명서).
//
// 세 화면이 한 오버레이 안에 들어오면서 생긴 위험은 두 가지다:
//   1. 감춰야 할 섹션이 남아 스크롤로 딸려 나온다 — 활성 탭 하나만 보여야 한다.
//   2. 탭마다 히스토리 엔트리가 쌓여 백버튼이 헛돈다 → tests/e2e/history.spec.ts 가 맡는다.
//
// 여기서는 1번과, 탭이 바뀌어도 각 탭의 내용물(슬라이더 값·기록 숫자)이 살아 있는지를 본다.
import { expect, test, type Page } from '@playwright/test';

import {
  closePanel,
  collectErrors,
  gotoFirstRun,
  openPanel,
  selectTab,
  sensitivityPercent,
  setSensitivityPercent,
  statValue,
  type PanelTab,
} from './helpers';

const TABS: readonly PanelTab[] = ['stats', 'settings', 'manual'];

/** 활성 탭의 본문만 보이고 나머지는 숨어 있는지 확인한다. */
async function expectOnlyTabVisible(page: Page, active: PanelTab): Promise<void> {
  for (const tab of TABS) {
    const selected = tab === active ? 'true' : 'false';
    await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-selected', selected);
    if (tab === active) await expect(page.locator(`#section-${tab}`)).toBeVisible();
    else await expect(page.locator(`#section-${tab}`)).toBeHidden();
  }
}

test('탭을 바꾸면 그 탭의 본문만 보인다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);

  await page.locator('#stats-toggle').click();
  await expect(page.locator('#stats-panel')).toBeVisible();

  // 기록 ↔ 설정 ↔ 설명서 를 오가며 매번 하나만 보이는지 본다.
  for (const tab of ['stats', 'settings', 'manual', 'settings', 'stats'] as const) {
    await selectTab(page, tab);
    await expectOnlyTabVisible(page, tab);
  }

  expect(errors).toEqual([]);
});

test('탭 제목이 카드 머리말에 그대로 반영된다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);
  await openPanel(page, 'stats');

  const heading = page.locator('#stats-panel h2');
  await expect(heading).toHaveText('기록');
  await selectTab(page, 'settings');
  await expect(heading).toHaveText('설정');
  await selectTab(page, 'manual');
  await expect(heading).toHaveText('설명서');

  expect(errors).toEqual([]);
});

test('탭을 오가도 각 탭의 상태가 유지된다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);

  await openPanel(page, 'settings');
  await setSensitivityPercent(page, 55);

  // 다른 탭을 들렀다 돌아와도 슬라이더는 방금 맞춘 값 그대로다 (다시 그리며 초기화되지 않는다).
  await selectTab(page, 'manual');
  await selectTab(page, 'stats');
  expect(await statValue(page, 'sessionCount')).toBe(0);
  await selectTab(page, 'settings');
  expect(await sensitivityPercent(page)).toBe(55);

  // 패널을 닫았다 열어도 마찬가지다. 마지막으로 보던 탭이 그대로 열린다.
  await closePanel(page);
  await page.locator('#stats-toggle').click();
  await expect(page.locator('#stats-panel')).toBeVisible();
  await expectOnlyTabVisible(page, 'settings');
  expect(await sensitivityPercent(page)).toBe(55);

  expect(errors).toEqual([]);
});

test('닫혀 있는 패널의 어느 탭도 화면을 가리지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoFirstRun(page);

  // 설명서를 펼쳐 둔 채로 닫아도 캔버스가 그대로 손가락을 받아야 한다.
  await openPanel(page, 'manual');
  await closePanel(page);

  const box = await page.locator('#stage').boundingBox();
  if (box === null) throw new Error('캔버스의 배치 상자를 얻지 못했다.');
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.id ?? '',
    [box.width / 2, box.height / 2],
  );
  expect(hit).toBe('stage');

  expect(errors).toEqual([]);
});
