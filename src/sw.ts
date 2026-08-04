// 서비스 워커 — 오프라인 100% (CLAUDE.md 8장 2번). 네트워크 의존 0.
//
// **왜 workbox 런타임을 쓰지 않는가**
// vite-plugin-pwa 는 쓰되 `generateSW` 가 아니라 `injectManifest` 전략을 골랐다. 우리가 자동화가
// 필요한 부분은 단 하나 — "해시가 박힌 산출물 목록"이고, 그건 `self.__WB_MANIFEST` 주입으로
// 이미 해결된다. 나머지(프리캐시·정리·응답)는 아래 60줄이면 끝나는 반면, generateSW 를 쓰면
// 이 앱보다 큰 워크박스 런타임이 번들 예산 안으로 들어온다. 런타임 의존성 0개를 지키는
// 프로젝트에서 "서비스 워커라서 예외"라고 할 이유가 없다.
//
// **캐시 전략**: 프리캐시 온리. 빌드 산출물 전체를 install 에서 한 번에 받아두고, 그 뒤로는
// 프리캐시에 있는 URL 만 캐시에서 돌려준다. 런타임 캐싱(네트워크 우선/stale-while-revalidate)은
// 두지 않는다 — 이 앱은 바깥에서 가져오는 것이 하나도 없으므로 캐시에 없는 요청은 애초에 없다.
//
// **업데이트 정책**: autoUpdate. install 에서 곧바로 skipWaiting, activate 에서 clients.claim.
// 프리캐시 목록이 바뀌면 캐시 이름(지문)이 바뀌고 옛 캐시는 activate 에서 지워진다.

// ── 서비스 워커 전역의 최소 타입 ────────────────────────────────
// tsconfig 의 lib 는 DOM 이다. WebWorker lib 를 함께 켜면 DOM 과 식별자가 충돌해 tsc 가 깨지므로,
// 이 파일에서 실제로 쓰는 것만 선언해 전역 `self` 를 가린다.

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface PrecacheEntry {
  readonly url: string;
  readonly revision: string | null;
}

interface ServiceWorkerScope {
  readonly location: { readonly href: string; readonly origin: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  /** vite-plugin-pwa(workbox)가 빌드 시점에 실제 산출물 목록으로 치환한다. */
  readonly __WB_MANIFEST: PrecacheEntry[];
}

declare const self: ServiceWorkerScope;

// ── 프리캐시 목록과 캐시 이름 ───────────────────────────────────

const CACHE_PREFIX = 'fidget-spinner-precache-';

/**
 * 프리캐시 목록의 지문(FNV-1a). 빌드가 바뀌면 값이 바뀌고, 바뀌지 않으면 같은 값이 나온다.
 * 캐시 이름에 넣어두면 새 버전이 옛 캐시를 건드리지 않고 자기 캐시를 새로 만든다.
 */
function fingerprint(entries: readonly PrecacheEntry[]): string {
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    const key = `${entry.url}|${entry.revision ?? ''}|`;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(36);
}

const PRECACHE_ENTRIES = self.__WB_MANIFEST;
const CACHE_NAME = `${CACHE_PREFIX}${fingerprint(PRECACHE_ENTRIES)}`;

/** 상대 URL 을 워커 기준으로 절대화한다. fetch 이벤트의 request.url 과 같은 형태여야 비교된다. */
function absolute(url: string): string {
  return new URL(url, self.location.href).href;
}

// Set 을 거쳐 중복을 없앤다. 같은 URL 이 두 번 들어오면 Cache.addAll 이 InvalidStateError 로
// 거부해 install 자체가 실패한다 — 주입 목록이 어디서 겹치든(매니페스트 아이콘 등) 여기서 막힌다.
const PRECACHE_SET = new Set(PRECACHE_ENTRIES.map((entry) => absolute(entry.url)));
const PRECACHE_URLS = [...PRECACHE_SET];

/** 내비게이션은 경로가 무엇이든(`/`, `/?debug=1`) 앱 셸 하나로 받는다. */
const SHELL_URL = absolute('index.html');

// ── 수명 주기 ───────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async (): Promise<void> => {
      const cache = await caches.open(CACHE_NAME);
      // `cache: 'reload'` 로 HTTP 캐시를 건너뛴다 — 중간 캐시에 남은 옛 index.html 을
      // 새 버전의 프리캐시로 굳혀버리면 그 캐시가 지워질 때까지 옛 앱이 뜬다.
      // addAll 은 하나라도 실패하면 통째로 던진다: 반쪽짜리 프리캐시로 activate 되지 않는다.
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async (): Promise<void> => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── 응답 ────────────────────────────────────────────────────────

async function fromCache(target: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(target);
  // 프리캐시가 성공했다면 여기서 빗나갈 일은 없다. 그래도 네트워크로 한 번 더 시도한다 —
  // 캐시 축출 같은 예외 상황에서 오프라인이 아니라면 앱이 계속 떠야 한다.
  return hit ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const target = request.mode === 'navigate' ? SHELL_URL : request.url;
  // 프리캐시 밖의 요청은 손대지 않고 브라우저에 그대로 맡긴다.
  if (!PRECACHE_SET.has(target)) return;

  event.respondWith(fromCache(target, request));
});
