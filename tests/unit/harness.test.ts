// L0 스모크 — 하네스 자체가 살아있는지 검증한다.
// 물리/햅틱 로직 테스트가 아니라, "명령어 계약과 불변식 6이 깨지지 않았는가"를 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageJson;

describe('harness contract', () => {
  // test-harness-engineer.md 의 "명령어 계약" — 이 이름들은 CI와 CLAUDE.md가 참조한다.
  it.each([
    'typecheck',
    'lint',
    'test:unit',
    'test:e2e',
    'test:perf',
    'verify',
    'verify:full',
    'format:check',
    'build',
  ])('npm run %s 스크립트가 존재한다', (name) => {
    expect(pkg.scripts?.[name], `package.json 에 "${name}" 스크립트가 없다`).toBeTypeOf('string');
  });

  it('프로덕션 dependencies 는 0개다 (CLAUDE.md 불변식 6)', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
