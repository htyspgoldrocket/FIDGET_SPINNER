// StorageAdapter 인터페이스 + SpinRecord / Aggregate 타입 (CLAUDE.md 6장). 원격 구현 확장 지점.
//
// 이 파일에는 **저장 백엔드에 무관한 것만** 둔다: 타입, 백업 코드의 인코딩/검증, 레코드 생성.
// IndexedDB 를 아는 코드는 indexeddb.ts 에만 있다. 나중에 remote.ts 를 붙일 때 이 파일은
// 그대로 재사용된다.
//
// platform 레이어이므로 crypto / Date.now / btoa 를 써도 된다 (core 순수성 규칙은 src/core/** 에만).

import { FLICK_SENSITIVITY_DEFAULT } from '../../core/constants';
import { clampFlickSensitivity } from '../../core/input-model';
import type { CompletedSpin, SpinAggregate } from '../../core/stats';
import { aggregateOf, EMPTY_SPIN_AGGREGATE } from '../../core/stats';

/** 저장 스키마 버전. 모든 레코드·집계·백업 코드에 박힌다 (서버 마이그레이션의 근거). */
export const SCHEMA_VERSION = 1;

// CLAUDE.md 6장의 타입 정의를 그대로 옮긴 것이다. 필드를 늘리거나 이름을 바꾸지 않는다.

export type SpinRecord = {
  id: string; // UUID v4
  ts: number; // epoch ms
  maxRpm: number;
  durationMs: number;
  revolutions: number;
  braked: boolean;
  schemaVersion: 1;
};

export type Aggregate = {
  totalRevolutions: number;
  totalTimeMs: number;
  bestRpm: number;
  bestDurationMs: number;
  sessionCount: number;
  schemaVersion: 1;
};

export interface StorageAdapter {
  getAggregate(): Promise<Aggregate>;
  putRecord(r: SpinRecord): Promise<void>;
  listRecords(limit: number, cursor?: string): Promise<SpinRecord[]>;
  export(): Promise<string>; // 백업 코드 (Base64 JSON)
  import(code: string): Promise<void>;
  clear(): Promise<void>;
}

// ── 사용자 설정 ───────────────────────────────────────────────
//
// **StorageAdapter 와 분리한 이유**: 그 인터페이스는 CLAUDE.md 6장에 명세로 못박혀 있고, 원격
// 백엔드를 붙일 때 그대로 재구현될 계약이다. 설정은 성격이 다르다 — 기록은 "이 사람이 남긴 것"이라
// 언젠가 서버로 올라가지만, 민감도는 **이 기기의 손가락에 맞춘 값**이라 기기를 옮겨 다닐 이유가
// 없다. 한 인터페이스에 섞으면 원격 구현체가 옮길 필요 없는 것까지 옮겨야 한다.

/** 사용자 설정. 기록과 달리 백업 코드에 포함되지 않는다 (아래 BackupPayload 주석 참조). */
export type Settings = {
  /** 플릭 민감도 배율. FLICK_SENSITIVITY_MIN ~ MAX 범위 (core 가 사용 직전에 다시 클램프한다). */
  flickSensitivity: number;
  /** 최초 실행 설명서를 본 적이 있는가. 한 번 닫으면 다시 자동으로 띄우지 않는다. */
  manualSeen: boolean;
  schemaVersion: 1;
};

/** 설정을 읽고 쓰는 최소 계약. 스토어가 하나뿐이라 목록·커서 개념이 없다. */
export interface SettingsStore {
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
}

/** 설정을 건드린 적 없는 사용자의 값. manualSeen: false — 첫 실행에는 설명서가 뜬다. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  flickSensitivity: FLICK_SENSITIVITY_DEFAULT,
  manualSeen: false,
  schemaVersion: SCHEMA_VERSION,
});

/** 기록이 없는 상태의 집계값. */
export const EMPTY_AGGREGATE: Aggregate = Object.freeze({
  ...EMPTY_SPIN_AGGREGATE,
  schemaVersion: SCHEMA_VERSION,
});

/** 백업 코드 한 장에 담는 최대 레코드 수.
 *
 *  집계값(Aggregate)이 총계의 단일 출처이므로 레코드를 잘라도 통계는 손실되지 않는다.
 *  잘리는 것은 오래된 개별 회전의 상세뿐이다. 코드가 수천 줄이 되면 사람이 복사할 수 없다. */
export const BACKUP_RECORD_LIMIT = 500;

/** 백업 코드의 평문(Base64 로 감싸기 전) 구조. */
export interface BackupPayload {
  readonly schemaVersion: 1;
  readonly aggregate: Aggregate;
  readonly records: readonly SpinRecord[];
}

/** 백업 코드가 잘못됐을 때 던진다. 사용자에게 그대로 보여줄 수 있는 한국어 메시지를 담는다. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** core 의 순수 집계값에 스키마 버전을 붙여 저장 타입으로 만든다. */
export function toAggregate(stats: SpinAggregate): Aggregate {
  return {
    totalRevolutions: stats.totalRevolutions,
    totalTimeMs: stats.totalTimeMs,
    bestRpm: stats.bestRpm,
    bestDurationMs: stats.bestDurationMs,
    sessionCount: stats.sessionCount,
    schemaVersion: SCHEMA_VERSION,
  };
}

/** 저장 레코드에서 core 가 이해하는 측정값만 꺼낸다 (집계 갱신용). */
export function toCompletedSpin(record: SpinRecord): CompletedSpin {
  return {
    maxRpm: record.maxRpm,
    durationMs: record.durationMs,
    revolutions: record.revolutions,
    braked: record.braked,
  };
}

/**
 * UUID v4 를 만든다.
 *
 * `crypto.randomUUID` 는 보안 컨텍스트(https / localhost)에서만 존재한다. 없으면
 * `getRandomValues` 로 직접 조립하고, 그것도 없으면 예외를 던지지 않고 시각 기반 id 로 떨어진다
 * — 기록을 저장하지 못하는 것보다 충돌 확률이 아주 낮은 id 쪽이 낫다.
 */
export function newRecordId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

    if (typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  return `t${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

/** 끝난 회전 하나를 저장 레코드로 만든다. id 와 ts 는 여기(platform)에서 붙인다. */
export function newSpinRecord(spin: CompletedSpin, ts: number = Date.now()): SpinRecord {
  return {
    id: newRecordId(),
    ts,
    maxRpm: spin.maxRpm,
    durationMs: spin.durationMs,
    revolutions: spin.revolutions,
    braked: spin.braked,
    schemaVersion: SCHEMA_VERSION,
  };
}

// ── 값 검증 ───────────────────────────────────────────────────
// IndexedDB 에서 읽은 값도, 사용자가 붙여넣은 백업 코드도 전부 신뢰하지 않는다.
// 형태가 맞지 않으면 null 을 돌려주고 호출부가 건너뛴다 — 깨진 레코드 하나가 전체를 막지 않는다.

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 음수가 될 수 없는 값들. 손상된 백업이 통계를 음수로 만들지 못하게 0 으로 자른다. */
function nonNegative(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? null : Math.max(0, n);
}

/** 형태가 맞으면 SpinRecord 로, 아니면 null. */
export function readRecord(value: unknown): SpinRecord | null {
  if (!isRecordObject(value)) return null;
  if (value['schemaVersion'] !== SCHEMA_VERSION) return null;
  if (typeof value['id'] !== 'string' || value['id'] === '') return null;
  if (typeof value['braked'] !== 'boolean') return null;

  const ts = finiteNumber(value['ts']);
  const maxRpm = nonNegative(value['maxRpm']);
  const durationMs = nonNegative(value['durationMs']);
  const revolutions = nonNegative(value['revolutions']);
  if (ts === null || maxRpm === null || durationMs === null || revolutions === null) return null;

  return {
    id: value['id'],
    ts,
    maxRpm,
    durationMs,
    revolutions,
    braked: value['braked'],
    schemaVersion: SCHEMA_VERSION,
  };
}

/** 형태가 맞으면 Aggregate 로, 아니면 null. */
export function readAggregate(value: unknown): Aggregate | null {
  if (!isRecordObject(value)) return null;
  if (value['schemaVersion'] !== SCHEMA_VERSION) return null;

  const totalRevolutions = nonNegative(value['totalRevolutions']);
  const totalTimeMs = nonNegative(value['totalTimeMs']);
  const bestRpm = nonNegative(value['bestRpm']);
  const bestDurationMs = nonNegative(value['bestDurationMs']);
  const sessionCount = nonNegative(value['sessionCount']);
  if (
    totalRevolutions === null ||
    totalTimeMs === null ||
    bestRpm === null ||
    bestDurationMs === null ||
    sessionCount === null
  ) {
    return null;
  }

  return {
    totalRevolutions,
    totalTimeMs,
    bestRpm,
    bestDurationMs,
    sessionCount: Math.floor(sessionCount),
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * 저장된 설정을 읽는다. 형태가 어긋나면 null — 호출부가 DEFAULT_SETTINGS 로 떨어진다.
 *
 * 레코드와 달리 **값이 범위를 벗어났다고 버리지는 않는다.** 기록은 틀린 숫자면 없느니만 못하지만,
 * 설정은 사용자가 직접 맞춰둔 것이라 최대한 살려서 가장 가까운 유효값으로 붙여준다.
 */
export function readSettings(value: unknown): Settings | null {
  if (!isRecordObject(value)) return null;
  if (value['schemaVersion'] !== SCHEMA_VERSION) return null;

  const flickSensitivity = finiteNumber(value['flickSensitivity']);
  if (flickSensitivity === null) return null;

  return {
    flickSensitivity: clampFlickSensitivity(flickSensitivity),
    // manualSeen 이 없던 버전(v2 초기)이 저장한 설정도 그대로 읽힌다. 필드가 없으면 "안 봤다"로
    // 두는 쪽이 안전하다 — 설명서가 한 번 더 뜨는 것은 사고가 아니지만, 영영 안 뜨는 것은 사고다.
    manualSeen: value['manualSeen'] === true,
    schemaVersion: SCHEMA_VERSION,
  };
}

// ── 백업 코드 ─────────────────────────────────────────────────
//
// **백업 코드에는 설정을 넣지 않는다 (기록 전용).** 백업의 용도는 "브라우저 저장소가 날아가도
// 기록은 되살린다"이고, 실제로 가장 흔한 사용법은 **다른 기기로 옮기기**다. 민감도는 그 기기의
// 화면 크기·손가락·터치 샘플링에 맞춰 맞춘 값이라, 함께 실려 가면 옮긴 쪽에서 조작감이 도리어
// 어긋난다. 게다가 import 는 병합이 아니라 교체이므로(indexeddb.ts) 코드 한 장을 넣는 순간
// 지금 기기에서 맞춰둔 민감도가 말없이 덮인다. 그래서 BackupPayload 에는 aggregate 와 records 뿐이다.

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(code: string): string {
  const binary = atob(code);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 백업 코드를 만든다. Base64(JSON). */
export function encodeBackup(payload: BackupPayload): string {
  return toBase64(
    JSON.stringify({
      schemaVersion: payload.schemaVersion,
      aggregate: payload.aggregate,
      records: payload.records,
    }),
  );
}

/**
 * 백업 코드를 해석한다. 형태가 조금이라도 어긋나면 BackupError 를 던진다.
 *
 * 공백·줄바꿈은 먼저 걷어낸다 — 사용자가 메모장을 거쳐 붙여넣으면 줄이 접혀 들어온다.
 * 개별 레코드는 깨진 것만 건너뛰지만, 집계값이 깨졌으면 남은 레코드로 다시 접어 만든다
 * (레코드가 잘려 저장됐을 수 있으므로 이 값은 원본보다 작을 수 있다 — 아예 0 이 되는 것보다 낫다).
 */
export function decodeBackup(code: string): BackupPayload {
  const compact = code.replace(/\s+/g, '');
  if (compact === '') throw new BackupError('백업 코드가 비어 있습니다.');

  let json: string;
  try {
    json = fromBase64(compact);
  } catch {
    throw new BackupError('백업 코드 형식이 올바르지 않습니다.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BackupError('백업 코드 형식이 올바르지 않습니다.');
  }

  if (!isRecordObject(parsed)) throw new BackupError('백업 코드 형식이 올바르지 않습니다.');

  if (parsed['schemaVersion'] !== SCHEMA_VERSION) {
    throw new BackupError(
      `지원하지 않는 백업 버전입니다 (이 앱은 버전 ${String(SCHEMA_VERSION)} 만 읽습니다).`,
    );
  }

  const rawRecords = parsed['records'];
  if (!Array.isArray(rawRecords)) throw new BackupError('백업 코드에 기록 목록이 없습니다.');

  const records: SpinRecord[] = [];
  for (const raw of rawRecords) {
    const record = readRecord(raw);
    if (record !== null) records.push(record);
  }

  const aggregate = readAggregate(parsed['aggregate']);
  if (aggregate === null && records.length === 0) {
    throw new BackupError('백업 코드에서 읽을 수 있는 기록이 없습니다.');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    aggregate: aggregate ?? toAggregate(aggregateOfRecords(records)),
    records,
  };
}

function aggregateOfRecords(records: readonly SpinRecord[]): SpinAggregate {
  return aggregateOf(records.map(toCompletedSpin));
}
