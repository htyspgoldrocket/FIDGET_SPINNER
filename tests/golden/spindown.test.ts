// 골든 스냅샷 회귀 — 감속 곡선이 어제와 같은가.
//
// 기준값은 이 디렉토리의 JSON 파일이다. vitest 의 toMatchSnapshot 대신 JSON 을 쓰는 이유:
// 기준값이 사람이 읽을 수 있는 (t, ω, θ) 표로 남고, diff 에서 "얼마나" 달라졌는지 바로 보인다.
//
// 갱신 방법 (CLAUDE.md 불변식 8 — "테스트가 실패하니까" 갱신하는 것은 금지):
//   FIDGET_UPDATE_GOLDEN=1 npx vitest run tests/golden && npm run format
// 물리를 의도적으로 바꿨을 때만 실행하고, 커밋 메시지에 변경 사유와 전후 수치를 적는다.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildGoldenFile,
  GOLDEN_SCENARIOS,
  PHYSICS_CONSTANTS,
  type GoldenFile,
  type GoldenSample,
} from './scenario-runner';

const UPDATE = process.env.FIDGET_UPDATE_GOLDEN === '1';
const IN_CI = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';

// CI 에서 기준값을 새로 쓰는 순간 이 테스트는 아무것도 지키지 않는 무의미한 통과가 된다.
if (UPDATE && IN_CI) {
  throw new Error('FIDGET_UPDATE_GOLDEN 은 CI 에서 사용할 수 없다. 로컬에서 갱신하고 커밋하라.');
}

const goldenPath = (name: string): URL => new URL(`./${name}.json`, import.meta.url);

/**
 * 부동소수는 **정확히** 비교한다.
 * physics.ts 는 +, -, *, / 와 Math.abs/sign/min/max 만 쓴다. 전부 IEEE-754 로 결과가
 * 규정된 연산이라 ubuntu CI 와 windows 로컬에서 비트 단위로 같은 값이 나온다.
 * 허용오차를 두면 "미세하게 다른 물리"가 조용히 통과하므로 두지 않는다.
 */
function firstMismatch(
  actual: readonly GoldenSample[],
  expected: readonly GoldenSample[],
): string | null {
  if (actual.length !== expected.length) {
    return `샘플 개수가 다르다: 실제 ${actual.length} / 기준 ${expected.length}`;
  }
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined || e === undefined) return `샘플 ${i} 이 비어 있다`;
    for (let k = 0; k < 3; k += 1) {
      const field = (['t', 'omega', 'theta'] as const)[k] ?? '?';
      if (!Object.is(a[k], e[k])) {
        return (
          `샘플 #${i} (t=${e[0]}) 의 ${field} 가 다르다: 실제 ${a[k]} / 기준 ${e[k]} ` +
          `(차이 ${(a[k] ?? 0) - (e[k] ?? 0)})`
        );
      }
    }
  }
  return null;
}

describe('골든 스냅샷: 감속 곡선', () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    it(scenario.name, () => {
      const actual = buildGoldenFile(scenario);
      const path = goldenPath(scenario.name);

      if (UPDATE) {
        writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      }

      expect(
        existsSync(path),
        `기준값 파일이 없다: tests/golden/${scenario.name}.json — FIDGET_UPDATE_GOLDEN=1 로 생성하라`,
      ).toBe(true);

      const expected = JSON.parse(readFileSync(path, 'utf8')) as GoldenFile;

      // 상수가 바뀌면 곡선보다 먼저 여기서 걸리게 한다 — 원인이 한눈에 보이도록.
      expect(
        expected.constants,
        '물리 상수가 기준값과 다르다. 의도한 튜닝이라면 DECISIONS.md 에 사유를 남기고 골든을 갱신하라.',
      ).toEqual(PHYSICS_CONSTANTS);

      // 시나리오 서술도 고정한다 (기준값이 다른 조건으로 만들어진 것이면 비교가 무의미하다).
      expect(expected.scenario).toEqual(actual.scenario);

      const mismatch = firstMismatch(actual.samples, expected.samples);
      expect(mismatch, `감속 곡선이 기준값과 다르다 — ${mismatch}`).toBeNull();

      expect(actual.totals).toEqual(expected.totals);
    });
  }

  it('같은 시나리오를 두 번 돌리면 완전히 같은 결과가 나온다 (결정론)', () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      const a = buildGoldenFile(scenario);
      const b = buildGoldenFile(scenario);
      expect(firstMismatch(a.samples, b.samples), scenario.name).toBeNull();
      expect(a.totals).toEqual(b.totals);
    }
  });

  it('stall-recovery 는 death spiral 가드가 실제로 걸린 기록을 담고 있다', () => {
    const stall = GOLDEN_SCENARIOS.find((s) => s.name === 'stall-recovery');
    if (stall === undefined) throw new Error('stall-recovery 시나리오가 사라졌다');
    // 이 시나리오가 폐기 0 이 되면 가드를 검증하지 못하는 죽은 스냅샷이 된다.
    expect(buildGoldenFile(stall).totals.droppedSec).toBeGreaterThan(0);
  });
});
