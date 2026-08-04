// StorageAdapter 의 IndexedDB 구현체.
//
// 구조: 저장 백엔드(Backend)는 "레코드와 집계값을 넣고 빼는" 최소 연산만 알고, 백업 코드의
// 인코딩·검증은 adapter.ts 가 한다. 그래서 IndexedDB 와 인메모리 폴백이 export/import 로직을
// 한 벌만 공유한다 — 폴백 경로가 본 경로와 다르게 동작할 여지가 없다.
//
// **실패 내성**: DB 를 열지 못하면(사생활 보호 모드, 저장소 차단, 미지원, 응답 없음) 예외를
// 밖으로 내보내지 않고 인메모리 백엔드로 떨어진다. 기록이 그 세션 동안만 유지되는 것은
// 앱이 아예 뜨지 않는 것보다 낫다. 열기에 성공한 뒤의 개별 실패는 그대로 reject 로 올라가고,
// 호출부(main.ts)가 삼킨다 — 게임 루프는 어떤 경우에도 멈추지 않는다.

import { mergeSpin, type SpinAggregate } from '../../core/stats';
import {
  BACKUP_RECORD_LIMIT,
  EMPTY_AGGREGATE,
  encodeBackup,
  decodeBackup,
  readAggregate,
  readRecord,
  toAggregate,
  toCompletedSpin,
  type Aggregate,
  type BackupPayload,
  type SpinRecord,
  type StorageAdapter,
} from './adapter';

const DB_NAME = 'fidget-spinner';

/** DB 스키마 버전. 스토어 구성을 바꿀 때만 올린다 (레코드의 schemaVersion 과 별개다). */
const DB_VERSION = 1;

const RECORD_STORE = 'records';
const AGGREGATE_STORE = 'aggregate';

/** 집계값은 스토어에 하나뿐이다. 고정 키로 덮어쓴다. */
const AGGREGATE_KEY = 'current';

/** 레코드를 최신순으로 훑기 위한 인덱스. */
const TS_INDEX = 'ts';

/** DB 열기 제한 시간 [ms]. 일부 환경은 저장소가 잠기면 성공도 실패도 통보하지 않는다. */
const OPEN_TIMEOUT_MS = 3000;

/** 백엔드가 알아야 하는 최소 연산. 백업 코드는 이 위에서 조립된다. */
interface Backend {
  getAggregate(): Promise<Aggregate>;
  putRecord(record: SpinRecord): Promise<void>;
  listRecords(limit: number, cursor?: string): Promise<SpinRecord[]>;
  /** 백업 불러오기. 기존 내용을 전부 지우고 payload 로 바꾼다. */
  replaceAll(payload: BackupPayload): Promise<void>;
  clear(): Promise<void>;
}

/** 페이지 커서. `listRecords` 가 돌려준 마지막 레코드로부터 다음 페이지의 커서를 만든다. */
export function recordCursor(record: SpinRecord): string {
  return `${String(record.ts)}:${record.id}`;
}

function parseCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  const separator = cursor.indexOf(':');
  if (separator <= 0) return null;
  const ts = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(ts) || id === '') return null;
  return { ts, id };
}

// ── 인메모리 백엔드 ───────────────────────────────────────────
// 폴백 경로이자 단위 테스트 대상이다. IndexedDB 백엔드와 같은 순서(ts 내림차순)를 지킨다.

export function createMemoryBackend(): Backend {
  let records: SpinRecord[] = [];
  let aggregate: Aggregate = EMPTY_AGGREGATE;

  /** ts 내림차순, 동률이면 id 내림차순 — IndexedDB 인덱스 순회와 순서를 맞춘다. */
  function sorted(): SpinRecord[] {
    return [...records].sort((a, b) => (b.ts === a.ts ? (a.id < b.id ? 1 : -1) : b.ts - a.ts));
  }

  return {
    getAggregate(): Promise<Aggregate> {
      return Promise.resolve(aggregate);
    },

    putRecord(record: SpinRecord): Promise<void> {
      records.push(record);
      aggregate = toAggregate(mergeSpin(aggregate, toCompletedSpin(record)));
      return Promise.resolve();
    },

    listRecords(limit: number, cursor?: string): Promise<SpinRecord[]> {
      const count = Math.max(0, Math.floor(limit));
      const ordered = sorted();
      const bound = parseCursor(cursor);
      let start = 0;
      if (bound !== null) {
        const found = ordered.findIndex((r) => r.id === bound.id);
        if (found >= 0) {
          start = found + 1;
        } else {
          // 커서가 가리키던 레코드가 사라졌으면 ts 가 더 오래된 첫 항목부터 잇는다.
          const next = ordered.findIndex((r) => r.ts < bound.ts);
          start = next >= 0 ? next : ordered.length;
        }
      }
      return Promise.resolve(ordered.slice(start, start + count));
    },

    replaceAll(payload: BackupPayload): Promise<void> {
      records = [...payload.records];
      aggregate = payload.aggregate;
      return Promise.resolve();
    },

    clear(): Promise<void> {
      records = [];
      aggregate = EMPTY_AGGREGATE;
      return Promise.resolve();
    },
  };
}

// ── IndexedDB 백엔드 ──────────────────────────────────────────

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('IndexedDB 요청이 실패했다.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 실패했다.'));
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 중단됐다.'));
  });
}

/**
 * DB 를 연다. 스토어가 없으면 onupgradeneeded 에서 만든다.
 *
 * 스토어를 `contains` 로 확인하고 만드는 것은 앞으로 DB_VERSION 을 올릴 때를 위한 것이다.
 * 버전 2 로 올라가는 기존 사용자의 DB 에는 이미 스토어가 있으므로 그때도 이 코드가 그대로 돈다.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 환경에는 IndexedDB 가 없다.'));
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('IndexedDB 를 열 수 없다.'));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('IndexedDB 열기가 응답하지 않는다.'));
    }, OPEN_TIMEOUT_MS);

    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const store = db.createObjectStore(RECORD_STORE, { keyPath: 'id' });
        store.createIndex(TS_INDEX, 'ts');
      }
      if (!db.objectStoreNames.contains(AGGREGATE_STORE)) {
        db.createObjectStore(AGGREGATE_STORE);
      }
    };

    request.onsuccess = (): void => {
      clearTimeout(timer);
      const db = request.result;
      // 다른 탭이 스키마를 올리려 하면 길을 비켜준다. 막고 있으면 그쪽이 영영 열리지 않는다.
      db.onversionchange = (): void => db.close();
      resolve(db);
    };

    request.onerror = (): void => {
      clearTimeout(timer);
      reject(request.error ?? new Error('IndexedDB 를 열 수 없다.'));
    };

    request.onblocked = (): void => {
      clearTimeout(timer);
      reject(new Error('다른 탭이 IndexedDB 를 잡고 있다.'));
    };
  });
}

function createIndexedDbBackend(db: IDBDatabase): Backend {
  async function readStoredAggregate(store: IDBObjectStore): Promise<Aggregate> {
    return readAggregate(await requestToPromise(store.get(AGGREGATE_KEY))) ?? EMPTY_AGGREGATE;
  }

  return {
    async getAggregate(): Promise<Aggregate> {
      const tx = db.transaction(AGGREGATE_STORE, 'readonly');
      return readStoredAggregate(tx.objectStore(AGGREGATE_STORE));
    },

    /**
     * 레코드 저장과 집계 갱신은 **한 트랜잭션**이다. 둘이 갈라지면 앱이 중간에 죽었을 때
     * 집계값이 레코드와 어긋난 채로 남는다. 집계 계산은 core 의 mergeSpin 을 그대로 쓴다
     * (main 이 화면에 즉시 반영하는 값과 같은 함수 — 두 값이 벌어질 수 없다).
     */
    async putRecord(record: SpinRecord): Promise<void> {
      const tx = db.transaction([RECORD_STORE, AGGREGATE_STORE], 'readwrite');
      const done = transactionDone(tx);
      const aggregateStore = tx.objectStore(AGGREGATE_STORE);

      const current = await readStoredAggregate(aggregateStore);
      tx.objectStore(RECORD_STORE).put(record);
      aggregateStore.put(toAggregate(mergeSpin(current, toCompletedSpin(record))), AGGREGATE_KEY);

      await done;
    },

    /**
     * ts 인덱스를 최신순('prev')으로 훑는다.
     *
     * 커서는 `ts:id` 다. ts 만으로는 같은 밀리초에 들어온 레코드를 가를 수 없어서, 경계
     * 지점에서는 id 가 일치하는 항목을 지날 때까지 건너뛴다. 그 id 가 사라졌으면(삭제·불러오기)
     * ts 가 더 작은 첫 항목부터 이어간다.
     */
    listRecords(limit: number, cursor?: string): Promise<SpinRecord[]> {
      const count = Math.max(0, Math.floor(limit));
      if (count === 0) return Promise.resolve([]);

      const bound = parseCursor(cursor);
      const tx = db.transaction(RECORD_STORE, 'readonly');
      const index = tx.objectStore(RECORD_STORE).index(TS_INDEX);
      const range = bound === null ? null : IDBKeyRange.upperBound(bound.ts);
      const request = index.openCursor(range, 'prev');

      const out: SpinRecord[] = [];
      let skipping = bound !== null;

      return new Promise<SpinRecord[]>((resolve, reject) => {
        request.onsuccess = (): void => {
          const idbCursor = request.result;
          if (idbCursor === null) {
            resolve(out);
            return;
          }

          const record = readRecord(idbCursor.value);
          if (record !== null) {
            if (skipping && bound !== null) {
              if (record.id === bound.id) {
                skipping = false; // 이 항목까지가 이전 페이지다
              } else if (record.ts < bound.ts) {
                skipping = false;
                out.push(record);
              }
            } else {
              out.push(record);
            }
          }

          if (out.length >= count) {
            resolve(out);
            return;
          }
          idbCursor.continue();
        };

        request.onerror = (): void =>
          reject(request.error ?? new Error('IndexedDB 커서가 실패했다.'));
      });
    },

    async replaceAll(payload: BackupPayload): Promise<void> {
      const tx = db.transaction([RECORD_STORE, AGGREGATE_STORE], 'readwrite');
      const done = transactionDone(tx);

      const recordStore = tx.objectStore(RECORD_STORE);
      recordStore.clear();
      for (const record of payload.records) recordStore.put(record);

      const aggregateStore = tx.objectStore(AGGREGATE_STORE);
      aggregateStore.clear();
      aggregateStore.put(payload.aggregate, AGGREGATE_KEY);

      await done;
    },

    async clear(): Promise<void> {
      const tx = db.transaction([RECORD_STORE, AGGREGATE_STORE], 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(RECORD_STORE).clear();
      tx.objectStore(AGGREGATE_STORE).clear();
      await done;
    },
  };
}

// ── 어댑터 조립 ───────────────────────────────────────────────

/**
 * 백엔드 위에 StorageAdapter 를 씌운다. export/import 는 백엔드 종류와 무관하게 여기 한 벌뿐이다.
 *
 * **import 는 병합이 아니라 교체다.** 병합을 하려면 두 백업의 레코드를 id 로 합치고 집계값을
 * 다시 접어야 하는데, 백업 코드의 레코드는 BACKUP_RECORD_LIMIT 로 잘려 있어서 집계값을 레코드로부터
 * 복원할 수 없다. 그렇다고 두 집계값을 그냥 더하면 양쪽에 함께 들어 있는 회전이 두 번 세어진다
 * (같은 기기에서 뽑은 코드를 다시 넣는 것이 가장 흔한 사용법인데, 그때마다 통계가 부푼다).
 * 교체는 "코드를 넣으면 그 코드의 상태가 된다"는 한 문장으로 설명되고, 되돌리려면 넣기 전에
 * 내보내둔 코드를 다시 넣으면 된다 — 정확히 대칭이다.
 */
function createAdapter(backendPromise: Promise<Backend>): StorageAdapter {
  return {
    async getAggregate(): Promise<Aggregate> {
      return (await backendPromise).getAggregate();
    },

    async putRecord(r: SpinRecord): Promise<void> {
      await (await backendPromise).putRecord(r);
    },

    async listRecords(limit: number, cursor?: string): Promise<SpinRecord[]> {
      return (await backendPromise).listRecords(limit, cursor);
    },

    async export(): Promise<string> {
      const backend = await backendPromise;
      const [aggregate, records] = await Promise.all([
        backend.getAggregate(),
        backend.listRecords(BACKUP_RECORD_LIMIT),
      ]);
      return encodeBackup({ schemaVersion: 1, aggregate, records });
    },

    async import(code: string): Promise<void> {
      // 해석이 먼저다. 코드가 잘못됐으면 기존 기록을 건드리지 않고 BackupError 로 끝난다.
      const payload = decodeBackup(code);
      await (await backendPromise).replaceAll(payload);
    },

    async clear(): Promise<void> {
      await (await backendPromise).clear();
    },
  };
}

/**
 * 실제 저장소를 만든다. DB 열기는 비동기지만 어댑터는 즉시 돌려준다 — 앱 조립이 저장소를
 * 기다리지 않는다. 열기에 실패하면 인메모리로 떨어지고, 그 사실을 `usingFallback` 으로 알린다.
 */
export function createStorage(): StorageAdapter & { readonly usingFallback: Promise<boolean> } {
  let resolveFallback: (value: boolean) => void = () => {};
  const usingFallback = new Promise<boolean>((resolve) => {
    resolveFallback = resolve;
  });

  const backendPromise = openDatabase().then(
    (db) => {
      resolveFallback(false);
      return createIndexedDbBackend(db);
    },
    () => {
      resolveFallback(true);
      return createMemoryBackend();
    },
  );

  return { ...createAdapter(backendPromise), usingFallback };
}

/** 인메모리 전용 저장소. 단위 테스트와 폴백 검증에 쓴다. */
export function createMemoryStorage(): StorageAdapter {
  return createAdapter(Promise.resolve(createMemoryBackend()));
}

/** 이 기기의 저장 데이터를 통째로 지운다 (개발·복구용). */
export async function deleteDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = (): void => resolve();
    request.onerror = (): void => resolve();
    request.onblocked = (): void => resolve();
  });
}

/** 집계값을 화면용 순수 타입으로 좁힌다 (UI 가 schemaVersion 을 알 필요는 없다). */
export function aggregateStats(aggregate: Aggregate): SpinAggregate {
  return {
    totalRevolutions: aggregate.totalRevolutions,
    totalTimeMs: aggregate.totalTimeMs,
    bestRpm: aggregate.bestRpm,
    bestDurationMs: aggregate.bestDurationMs,
    sessionCount: aggregate.sessionCount,
  };
}
