// L3 — 시각 회귀.
//
// ## CI 베이스라인 전략 (읽고 나서 손댈 것)
//
// Playwright 의 스냅샷 파일 이름에는 **플랫폼 접미사**가 붙는다 (`-win32`, `-linux`). 같은
// 코드라도 OS 가 다르면 글꼴 힌팅과 안티에일리어싱이 달라 픽셀이 일치하지 않기 때문이다.
// 그래서 개발 기기(win32)에서 만든 베이스라인은 CI(ubuntu)에서 쓸 수 없고, linux 베이스라인이
// 없는 채로 CI 를 돌리면 **첫 실행이 통째로 실패한다** — 회귀가 없는데도.
//
// 선택지는 셋이었다:
//   (a) CI 에서 `--update-snapshots` 로 자동 생성 → 회귀를 "정답"으로 덮어쓰므로 게이트가 아니다.
//   (b) 시각 회귀를 로컬 전용 태그로 빼기 → CI 에서 영영 안 돈다.
//   (c) **베이스라인이 있는 플랫폼에서만 비교한다** (아래 구현).
//
// (c) 를 골랐다. 베이스라인 파일이 없으면 그 검사만 skip 되고 CI 는 녹색을 유지한다. 나중에
// 누군가 linux 에서 `--update-snapshots` 로 베이스라인을 만들어 커밋하면 **자동으로 게이트가
// 켜진다** — 코드를 고칠 필요가 없다. 최우선 순위는 "CI 를 깨뜨리지 않는 것"이다.
//
// 다만 skip 되는 검사만 남기면 CI 에서 시각 신호가 0 이 된다. 그래서 베이스라인이 필요 없는
// **자기 기준 검사**를 함께 둔다: 정지 상태에서 시간 간격을 두고 두 번 찍은 화면이 바이트
// 단위로 같아야 한다. 베이스라인 없이도 "정지했는데 화면이 흔들린다"류의 회귀를 어디서나 잡는다.
import { existsSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// 베이스라인 생성은 골든 스냅샷과 같은 규약을 쓴다 (tests/golden/spindown.test.ts):
//
//   FIDGET_UPDATE_VISUAL=1 npx playwright test visual --update-snapshots
//
// Playwright 의 `--update-snapshots` 만으로 판단하지 않는 이유가 있다. 이 옵션의 기본값은
// `missing` 이라 **아무 플래그 없이 돌려도** 없는 베이스라인은 그냥 만들어진다. CI 에서 그러면
// 그날 CI 가 그린 화면이 곧 정답이 되어버린다 — 회귀를 잡는 게 아니라 회귀를 승인하는 게이트다.
// 그래서 명시적 환경변수를 요구하고, 골든과 마찬가지로 CI 에서는 아예 금지한다.
const UPDATE_VISUAL = process.env['FIDGET_UPDATE_VISUAL'] === '1';
const IN_CI =
  process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false';

if (UPDATE_VISUAL && IN_CI) {
  throw new Error('FIDGET_UPDATE_VISUAL 은 CI 에서 사용할 수 없다. 로컬에서 갱신하고 커밋하라.');
}

/**
 * 이 플랫폼의 베이스라인이 없으면 비교를 건너뛴다.
 *
 * 새 스냅샷을 만들려면 위의 명령을 돌리고 생성된 파일을 커밋한다.
 */
function skipWithoutBaseline(testInfo: TestInfo, name: string): void {
  if (UPDATE_VISUAL) return;
  const baseline = testInfo.snapshotPath(name);
  test.skip(
    !existsSync(baseline),
    `이 플랫폼(${process.platform})의 베이스라인이 없다: ${baseline} — ` +
      `FIDGET_UPDATE_VISUAL=1 ... --update-snapshots 로 만들어 커밋하면 자동으로 켜진다.`,
  );
}

/** 정지 상태의 앱을 띄운다. 스피너는 입력이 없으면 θ = 0 에서 움직이지 않는다. */
async function gotoIdle(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  // 첫 프레임과 오프스크린 글로우 캐시가 완성될 시간을 준다.
  await page.waitForTimeout(300);
}

test('정지 상태 스피너', async ({ page }, testInfo) => {
  await gotoIdle(page);
  skipWithoutBaseline(testInfo, 'spinner-idle.png');

  await expect(page.locator('#stage')).toHaveScreenshot('spinner-idle.png', {
    animations: 'disabled',
  });
});

test('통계 패널', async ({ page }, testInfo) => {
  await gotoIdle(page);
  await page.locator('#stats-toggle').click();
  await expect(page.locator('#stats-panel')).toBeVisible();

  skipWithoutBaseline(testInfo, 'stats-panel.png');

  // 기록이 없는 새 프로필이라 숫자는 전부 0 이다 — 실행마다 값이 달라지지 않는다.
  await expect(page.locator('#stats-panel')).toHaveScreenshot('stats-panel.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('정지 상태에서는 화면이 한 픽셀도 변하지 않는다', async ({ page }) => {
  // 베이스라인이 필요 없는 자기 기준 검사 — 어느 플랫폼에서도 돈다 (파일 머리말 참조).
  await gotoIdle(page);
  const canvas = page.locator('#stage');

  const first = await canvas.screenshot({ animations: 'disabled' });
  await page.waitForTimeout(500);
  const second = await canvas.screenshot({ animations: 'disabled' });

  expect(
    Buffer.compare(first, second),
    '입력이 없는데 화면이 바뀌었다 — 저절로 도는 회귀이거나 렌더가 결정론적이지 않다.',
  ).toBe(0);
});
