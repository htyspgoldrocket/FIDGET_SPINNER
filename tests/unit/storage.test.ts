// 저장 계약 — 백업 코드 인코딩/검증(adapter)과 어댑터 동작(인메모리 백엔드).
//
// IndexedDB 백엔드 자체는 실브라우저 e2e 로 검증한다 (tests/e2e/stats.spec.ts).
// 여기서 다루는 것은 백엔드에 무관한 부분이다: 백업 코드 형식, 검증, 집계 누적, 페이징,
// 그리고 import 가 병합이 아니라 교체라는 계약.
import { describe, expect, it } from 'vitest';

import { aggregateOf, EMPTY_SPIN_AGGREGATE, type CompletedSpin } from '../../src/core/stats';
import {
  FLICK_SENSITIVITY_DEFAULT,
  FLICK_SENSITIVITY_MAX,
  FLICK_SENSITIVITY_MIN,
} from '../../src/core/constants';
import {
  BackupError,
  decodeBackup,
  DEFAULT_SETTINGS,
  EMPTY_AGGREGATE,
  encodeBackup,
  newSpinRecord,
  readAggregate,
  readRecord,
  readSettings,
  SCHEMA_VERSION,
  toAggregate,
  toCompletedSpin,
  type BackupPayload,
  type SpinRecord,
} from '../../src/platform/storage/adapter';
import { createMemoryStorage, recordCursor } from '../../src/platform/storage/indexeddb';

function spin(over: Partial<CompletedSpin> = {}): CompletedSpin {
  return { maxRpm: 240, durationMs: 3000, revolutions: 12, braked: false, ...over };
}

function record(index: number, over: Partial<SpinRecord> = {}): SpinRecord {
  return {
    ...newSpinRecord(
      spin({ maxRpm: 100 + index, durationMs: 1000 + index }),
      1_700_000_000_000 + index,
    ),
    ...over,
  };
}

function payloadOf(records: readonly SpinRecord[]): BackupPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    aggregate: toAggregate(aggregateOf(records.map(toCompletedSpin))),
    records,
  };
}

describe('SpinRecord 생성', () => {
  it('스키마 버전이 박히고 id 가 서로 다르다', () => {
    const a = newSpinRecord(spin(), 123);
    const b = newSpinRecord(spin(), 123);

    expect(a.schemaVersion).toBe(1);
    expect(a.ts).toBe(123);
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(8);
  });

  it('측정값을 그대로 옮긴다', () => {
    const source = spin({ maxRpm: 1234.5, durationMs: 42, revolutions: 7.25, braked: true });
    const created = newSpinRecord(source, 9);
    expect(toCompletedSpin(created)).toEqual(source);
  });
});

describe('값 검증', () => {
  it('정상 레코드는 그대로 통과한다', () => {
    const valid = record(0);
    expect(readRecord(valid)).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['배열', []],
    ['문자열', 'nope'],
    ['schemaVersion 없음', { ...record(0), schemaVersion: undefined }],
    ['schemaVersion 2', { ...record(0), schemaVersion: 2 }],
    ['id 없음', { ...record(0), id: '' }],
    ['ts 가 NaN', { ...record(0), ts: Number.NaN }],
    ['durationMs 가 문자열', { ...record(0), durationMs: '3000' }],
    ['braked 가 숫자', { ...record(0), braked: 1 }],
  ])('깨진 레코드(%s)는 null 이다', (_label, value) => {
    expect(readRecord(value)).toBeNull();
  });

  it('음수 측정값은 0 으로 자른다 (손상된 백업이 통계를 음수로 만들지 못한다)', () => {
    expect(readRecord({ ...record(0), revolutions: -5 })?.revolutions).toBe(0);
    expect(readAggregate({ ...EMPTY_AGGREGATE, totalTimeMs: -1 })?.totalTimeMs).toBe(0);
  });

  it('집계값의 세션 수는 정수로 떨어진다', () => {
    expect(readAggregate({ ...EMPTY_AGGREGATE, sessionCount: 3.7 })?.sessionCount).toBe(3);
  });

  it('schemaVersion 이 맞지 않는 집계값은 null 이다', () => {
    expect(readAggregate({ ...EMPTY_AGGREGATE, schemaVersion: 99 })).toBeNull();
  });
});

describe('백업 코드', () => {
  it('인코딩 → 디코딩 라운드트립이 원본과 같다', () => {
    const payload = payloadOf([record(0), record(1), record(2)]);
    const decoded = decodeBackup(encodeBackup(payload));

    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.aggregate).toEqual(payload.aggregate);
    expect(decoded.records).toEqual(payload.records);
  });

  it('코드는 Base64 문자만으로 이루어진다 (복사·붙여넣기 안전)', () => {
    const code = encodeBackup(payloadOf([record(0)]));
    expect(code).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('붙여넣다 섞인 공백과 줄바꿈은 무시한다', () => {
    const code = encodeBackup(payloadOf([record(0)]));
    const mangled = `${code.slice(0, 10)}\n  ${code.slice(10)}\n`;
    expect(decodeBackup(mangled).records).toHaveLength(1);
  });

  it.each([
    ['빈 문자열', ''],
    ['공백뿐', '   \n '],
    ['Base64 가 아님', '!!!not base64!!!'],
    ['JSON 이 아님', btoa('hello world')],
    ['객체가 아님', btoa('[1,2,3]')],
    ['records 가 없음', btoa(JSON.stringify({ schemaVersion: 1, aggregate: EMPTY_AGGREGATE }))],
  ])('잘못된 코드(%s)는 BackupError 다', (_label, code) => {
    expect(() => decodeBackup(code)).toThrow(BackupError);
  });

  it('다른 스키마 버전은 버전을 짚어 거절한다', () => {
    const code = btoa(
      JSON.stringify({ schemaVersion: 2, aggregate: EMPTY_AGGREGATE, records: [] }),
    );
    expect(() => decodeBackup(code)).toThrow(/버전/);
  });

  it('깨진 레코드는 건너뛰고 성한 것만 남긴다', () => {
    const good = record(0);
    const code = btoa(
      JSON.stringify({
        schemaVersion: 1,
        aggregate: toAggregate(aggregateOf([toCompletedSpin(good)])),
        records: [good, { id: 'broken' }, null, 42],
      }),
    );
    expect(decodeBackup(code).records).toEqual([good]);
  });

  it('집계값이 깨졌으면 남은 레코드로 다시 접어 만든다', () => {
    const records = [record(0), record(1)];
    const code = btoa(JSON.stringify({ schemaVersion: 1, aggregate: 'corrupt', records }));
    expect(decodeBackup(code).aggregate).toEqual(
      toAggregate(aggregateOf(records.map(toCompletedSpin))),
    );
  });

  it('집계값도 레코드도 못 읽으면 거절한다', () => {
    const code = btoa(JSON.stringify({ schemaVersion: 1, aggregate: null, records: [] }));
    expect(() => decodeBackup(code)).toThrow(BackupError);
  });

  it('한글이 섞여도 (미래 필드 대비) 왕복한다', () => {
    const code = btoa(unescape(encodeURIComponent(JSON.stringify({ note: '한글 메모' }))));
    expect(() => decodeBackup(code)).toThrow(BackupError); // 형식은 여전히 거절한다
    const payload = payloadOf([record(0, { id: '한글-아이디' })]);
    expect(decodeBackup(encodeBackup(payload)).records[0]?.id).toBe('한글-아이디');
  });
});

describe('StorageAdapter 계약 (인메모리 백엔드)', () => {
  it('기록이 없으면 빈 집계값이다', async () => {
    const storage = createMemoryStorage();
    expect(await storage.getAggregate()).toEqual(EMPTY_AGGREGATE);
    expect(await storage.listRecords(10)).toEqual([]);
  });

  it('putRecord 가 집계값을 함께 갱신한다 (core 의 mergeSpin 과 같은 결과)', async () => {
    const storage = createMemoryStorage();
    const records = [
      newSpinRecord(spin({ maxRpm: 100, durationMs: 500, revolutions: 2 }), 1),
      newSpinRecord(spin({ maxRpm: 800, durationMs: 200, revolutions: 9 }), 2),
      newSpinRecord(spin({ maxRpm: 300, durationMs: 9000, revolutions: 40 }), 3),
    ];
    for (const r of records) await storage.putRecord(r);

    expect(await storage.getAggregate()).toEqual(
      toAggregate(aggregateOf(records.map(toCompletedSpin))),
    );
    expect((await storage.getAggregate()).bestRpm).toBe(800);
    expect((await storage.getAggregate()).bestDurationMs).toBe(9000);
  });

  it('listRecords 는 최신순이고 limit 을 지킨다', async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 5; i += 1) await storage.putRecord(record(i));

    const page = await storage.listRecords(3);
    expect(page).toHaveLength(3);
    expect(page.map((r) => r.ts)).toEqual([...page.map((r) => r.ts)].sort((a, b) => b - a));
    expect(page[0]?.ts).toBe(1_700_000_000_004);
    expect(await storage.listRecords(0)).toEqual([]);
  });

  it('커서로 다음 페이지를 이어 받으면 전체가 중복 없이 나온다', async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 7; i += 1) await storage.putRecord(record(i));

    const first = await storage.listRecords(3);
    const last = first[first.length - 1];
    if (last === undefined) throw new Error('첫 페이지가 비었다.');
    const second = await storage.listRecords(3, recordCursor(last));
    const third = await storage.listRecords(
      3,
      recordCursor(second[second.length - 1] as SpinRecord),
    );

    const ids = [...first, ...second, ...third].map((r) => r.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it('export → import 라운드트립으로 상태가 그대로 복원된다', async () => {
    const source = createMemoryStorage();
    for (let i = 0; i < 4; i += 1) await source.putRecord(record(i));
    const code = await source.export();

    const target = createMemoryStorage();
    await target.import(code);

    expect(await target.getAggregate()).toEqual(await source.getAggregate());
    expect(await target.listRecords(10)).toEqual(await source.listRecords(10));
  });

  it('import 는 병합이 아니라 교체다 (같은 코드를 두 번 넣어도 통계가 부풀지 않는다)', async () => {
    const storage = createMemoryStorage();
    await storage.putRecord(record(0));
    const code = await storage.export();
    const before = await storage.getAggregate();

    await storage.putRecord(record(1));
    await storage.putRecord(record(2));
    expect((await storage.getAggregate()).sessionCount).toBe(3);

    await storage.import(code);
    expect(await storage.getAggregate()).toEqual(before);
    expect(await storage.listRecords(10)).toHaveLength(1);

    await storage.import(code); // 두 번째 적용도 같은 상태다 (멱등)
    expect(await storage.getAggregate()).toEqual(before);
  });

  it('잘못된 코드를 넣으면 기존 기록이 그대로 남는다', async () => {
    const storage = createMemoryStorage();
    await storage.putRecord(record(0));
    const before = await storage.getAggregate();

    await expect(storage.import('완전히 잘못된 코드')).rejects.toThrow(BackupError);

    expect(await storage.getAggregate()).toEqual(before);
    expect(await storage.listRecords(10)).toHaveLength(1);
  });

  it('clear 는 레코드와 집계값을 함께 비운다', async () => {
    const storage = createMemoryStorage();
    await storage.putRecord(record(0));
    await storage.clear();

    expect(await storage.getAggregate()).toEqual(EMPTY_AGGREGATE);
    expect(await storage.listRecords(10)).toEqual([]);
  });

  it('빈 저장소의 백업 코드도 유효하다', async () => {
    const storage = createMemoryStorage();
    const code = await storage.export();
    const decoded = decodeBackup(code);

    expect(decoded.records).toEqual([]);
    expect(decoded.aggregate).toEqual(toAggregate(EMPTY_SPIN_AGGREGATE));
  });
});

describe('설정 값 검증', () => {
  it('정상 설정은 그대로 통과한다', () => {
    const settings = { flickSensitivity: 0.75, schemaVersion: 1 } as const;
    expect(readSettings(settings)).toEqual(settings);
  });

  it.each([
    ['null', null],
    ['배열', []],
    ['문자열', 'nope'],
    ['빈 객체', {}],
    ['schemaVersion 없음', { flickSensitivity: 1 }],
    ['schemaVersion 2', { flickSensitivity: 1, schemaVersion: 2 }],
    ['배율이 문자열', { flickSensitivity: '1.0', schemaVersion: 1 }],
    ['배율이 NaN', { flickSensitivity: Number.NaN, schemaVersion: 1 }],
  ])('%s 은 읽지 않는다 (호출부가 기본값으로 떨어진다)', (_label, value) => {
    expect(readSettings(value)).toBeNull();
  });

  it('범위를 벗어난 배율은 버리지 않고 경계로 붙여준다', () => {
    // 레코드와 다른 정책이다. 기록은 틀린 숫자면 없느니만 못하지만, 설정은 사용자가 맞춰둔
    // 의도가 담긴 값이라 최대한 살린다.
    expect(readSettings({ flickSensitivity: 99, schemaVersion: 1 })?.flickSensitivity).toBe(
      FLICK_SENSITIVITY_MAX,
    );
    expect(readSettings({ flickSensitivity: -5, schemaVersion: 1 })?.flickSensitivity).toBe(
      FLICK_SENSITIVITY_MIN,
    );
  });

  it('기본 설정은 기본 배율이고 스키마 버전이 박혀 있다', () => {
    expect(DEFAULT_SETTINGS.flickSensitivity).toBe(FLICK_SENSITIVITY_DEFAULT);
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(SCHEMA_VERSION);
    expect(readSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('SettingsStore 계약 (인메모리 백엔드)', () => {
  it('아무것도 저장한 적 없으면 기본값이다', async () => {
    const storage = createMemoryStorage();
    expect(await storage.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('저장한 값이 그대로 돌아온다 (라운드트립)', async () => {
    const storage = createMemoryStorage();
    await storage.putSettings({ flickSensitivity: 0.45, schemaVersion: 1 });
    expect(await storage.getSettings()).toEqual({ flickSensitivity: 0.45, schemaVersion: 1 });

    await storage.putSettings({ flickSensitivity: 1.25, schemaVersion: 1 });
    expect((await storage.getSettings()).flickSensitivity).toBe(1.25);
  });

  it('폴백 경로에서도 범위 밖 값은 읽을 때 잘린다 (IndexedDB 경로와 같은 지점)', async () => {
    const storage = createMemoryStorage();
    // 타입을 우회해 손상된 값을 밀어넣는다 — 예전 버전이나 다른 탭이 써넣은 상황이다.
    await storage.putSettings({ flickSensitivity: 42, schemaVersion: 1 });
    expect((await storage.getSettings()).flickSensitivity).toBe(FLICK_SENSITIVITY_MAX);

    await storage.putSettings({ flickSensitivity: Number.NaN, schemaVersion: 1 });
    expect(await storage.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('설정은 백업 코드에 실리지 않는다 (백업은 기록 전용)', async () => {
    const storage = createMemoryStorage();
    await storage.putSettings({ flickSensitivity: 0.3, schemaVersion: 1 });
    await storage.putRecord(record(0));

    const decoded = decodeBackup(await storage.export());
    expect(Object.keys(decoded).sort()).toEqual(['aggregate', 'records', 'schemaVersion']);
    expect(JSON.stringify(decoded)).not.toContain('flickSensitivity');
  });

  it('백업을 불러와도 이 기기의 민감도는 그대로다', async () => {
    const source = createMemoryStorage();
    await source.putRecord(record(0));
    const code = await source.export();

    const target = createMemoryStorage();
    await target.putSettings({ flickSensitivity: 0.5, schemaVersion: 1 });
    await target.import(code);

    expect((await target.getSettings()).flickSensitivity).toBe(0.5);
    expect(await target.listRecords(10)).toHaveLength(1);
  });

  it('clear 는 기록만 지우고 설정은 남긴다', async () => {
    const storage = createMemoryStorage();
    await storage.putSettings({ flickSensitivity: 1.5, schemaVersion: 1 });
    await storage.putRecord(record(0));
    await storage.clear();

    expect(await storage.getAggregate()).toEqual(EMPTY_AGGREGATE);
    expect((await storage.getSettings()).flickSensitivity).toBe(1.5);
  });
});
