import type { BrowserContext, Page, Request, Route } from '@playwright/test';

/**
 * Probes for M2-01k-d: what a map screen loads, what it leaves behind, and where it asks to
 * connect. Every probe reads the browser itself — constructors, contexts, listeners and the
 * network — never a flag the screen sets about itself.
 */

/**
 * Track, from the first byte of every document, each resource a map can hold on to:
 * WebGL contexts, dedicated workers, window/document listeners, resize observers and blob
 * URLs. Each is stamped with a sequence number, so a test can ask "what that was created
 * after this mark is still held" and see exactly the map's own leftovers.
 *
 * Read with {@link lifecycleMark} and {@link heldSince}.
 */
export async function instrumentLifecycle(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Held {
      readonly seq: number;
      readonly label: string;
      readonly live: () => boolean;
      /** Listeners are judged per target and type, see `heldSince`. */
      readonly listener?: boolean;
    }
    let seq = 0;
    const held: Held[] = [];
    const track = (label: string, live: () => boolean, listener = false) => {
      seq += 1;
      held.push({ seq, label, live, listener });
    };
    /** Live listeners per `target:type` at each mark. */
    const listenersAt = new Map<number, Map<string, number>>();
    const liveListeners = () => {
      const counts = new Map<string, number>();
      for (const entry of held)
        if (entry.listener && entry.live())
          counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
      return counts;
    };

    // WebGL contexts: a released renderer loses its context (MapLibre calls loseContext).
    const getContext = HTMLCanvasElement.prototype.getContext;
    const contexts = new WeakSet<object>();
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      const context = (getContext as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      if (
        context !== null &&
        typeof context === 'object' &&
        kind.startsWith('webgl') &&
        !contexts.has(context)
      ) {
        contexts.add(context);
        const gl = context as WebGLRenderingContext;
        track(`webgl-context ${kind}`, () => !gl.isContextLost());
      }
      return context;
    } as typeof HTMLCanvasElement.prototype.getContext;

    // Dedicated workers: held until terminated. Wrapped as a plain function for the same
    // reason as the observers below.
    const NativeWorker = window.Worker;
    const terminated = new WeakSet<Worker>();
    const nativeTerminate = NativeWorker.prototype.terminate;
    NativeWorker.prototype.terminate = function (this: Worker) {
      terminated.add(this);
      nativeTerminate.call(this);
    };
    const TrackedWorker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new NativeWorker(url, options);
      const path = String(url).startsWith('blob:') ? 'blob:' : new URL(url, location.href).pathname;
      track(`worker ${path}`, () => !terminated.has(worker));
      return worker;
    } as unknown as typeof Worker;
    TrackedWorker.prototype = NativeWorker.prototype;
    window.Worker = TrackedWorker;

    // What a worker holds for one map. MapLibre shares one worker per page between maps and
    // keeps it for the page's lifetime; what belongs to a map there (its sources — our path —
    // layers and images) is held until the map's `removeMap` ('RM') message reaches the
    // worker. Every map id a worker is sent work for is held until that message is posted.
    const postMessage = NativeWorker.prototype.postMessage;
    const mapState = new Map<string, { on: boolean }>();
    NativeWorker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      ...rest: unknown[]
    ) {
      const envelope = message as { type?: unknown; sourceMapId?: unknown } | null;
      const mapId =
        typeof envelope?.sourceMapId === 'string' || typeof envelope?.sourceMapId === 'number'
          ? String(envelope.sourceMapId)
          : null;
      if (mapId !== null && mapId !== 'global-dispatcher') {
        let state = mapState.get(mapId);
        if (!state) {
          const created = { on: true };
          mapState.set(mapId, created);
          track('worker-map-state', () => created.on);
          state = created;
        }
        if (envelope?.type === 'RM') state.on = false;
      }
      return (postMessage as (...args: unknown[]) => void).call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;

    // Listeners on window and document: held until removed or aborted through their signal.
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    interface Listening {
      readonly target: EventTarget;
      readonly type: string;
      readonly capture: boolean;
      on: boolean;
    }
    const listening = new Map<unknown, Listening[]>();
    const captureOf = (options: unknown) =>
      typeof options === 'boolean'
        ? options
        : Boolean((options as { capture?: boolean } | undefined)?.capture);
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if ((this === window || this === document) && listener !== null) {
        const capture = captureOf(options);
        const entries = listening.get(listener) ?? [];
        const known = entries.find(
          (entry) =>
            entry.on && entry.target === this && entry.type === type && entry.capture === capture,
        );
        const once = typeof options === 'object' && options.once === true;
        // A `once` listener removes itself when it fires, which cannot be observed here, so
        // only persistent listeners are tracked.
        // Only listeners added by page code: those have a script URL on the stack. The
        // automation's own listeners (injected without a URL) are not the map's.
        const byPage = /https?:\/\//.test(new Error().stack?.split('\n').slice(2).join('\n') ?? '');
        if (!known && !once && byPage) {
          const entry: Listening = { target: this, type, capture, on: true };
          entries.push(entry);
          listening.set(listener, entries);
          const where = this === window ? 'window' : 'document';
          track(`listener ${where}:${type}`, () => entry.on, true);
          const signal = typeof options === 'object' ? options.signal : undefined;
          if (signal)
            add.call(signal, 'abort', () => {
              entry.on = false;
            });
        }
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if ((this === window || this === document) && listener !== null) {
        const capture = captureOf(options);
        for (const entry of listening.get(listener) ?? [])
          if (entry.target === this && entry.type === type && entry.capture === capture)
            entry.on = false;
      }
      return remove.call(this, type, listener, options);
    };

    // Resize observers: held while they still observe something. Patched on the prototype
    // with a side table rather than subclassed with private fields: this script is
    // transpiled for injection, and a class-field helper would not exist in the page.
    const observed = new WeakMap<ResizeObserver, Set<Element>>();
    const targetsOf = (observer: ResizeObserver) => {
      let targets = observed.get(observer);
      if (!targets) {
        const created = new Set<Element>();
        observed.set(observer, created);
        track('resize-observer', () => created.size > 0);
        targets = created;
      }
      return targets;
    };
    const observerPrototype = ResizeObserver.prototype;
    const observe = observerPrototype.observe;
    const unobserve = observerPrototype.unobserve;
    const disconnect = observerPrototype.disconnect;
    observerPrototype.observe = function (this: ResizeObserver, target, options) {
      targetsOf(this).add(target);
      observe.call(this, target, options);
    };
    observerPrototype.unobserve = function (this: ResizeObserver, target) {
      targetsOf(this).delete(target);
      unobserve.call(this, target);
    };
    observerPrototype.disconnect = function (this: ResizeObserver) {
      targetsOf(this).clear();
      disconnect.call(this);
    };

    // Blob URLs: held until revoked.
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    const blobs = new Map<string, { on: boolean }>();
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = createObjectURL(object);
      const state = { on: true };
      blobs.set(url, state);
      track('blob-url', () => state.on);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      const state = blobs.get(url);
      if (state) state.on = false;
      revokeObjectURL(url);
    };

    Object.defineProperty(window, '__mapLifecycle', {
      value: {
        mark: () => {
          listenersAt.set(seq, liveListeners());
          return seq;
        },
        // Everything but listeners: created after the mark and still held. Listeners: more
        // live than at the mark, per target and type. A screen that outlives the map may
        // swap its own listener for a new one (the workspace re-reads the session on
        // visibility); that is a replacement, not something the map left behind.
        heldSince: (mark: number) => {
          const others = held
            .filter((entry) => !entry.listener && entry.seq > mark && entry.live())
            .map((entry) => entry.label);
          const before = listenersAt.get(mark) ?? new Map<string, number>();
          const extra: string[] = [];
          for (const [label, count] of liveListeners())
            for (let index = before.get(label) ?? 0; index < count; index += 1) extra.push(label);
          return [...others, ...extra];
        },
        createdSince: (mark: number) =>
          held.filter((entry) => entry.seq > mark).map((entry) => entry.label),
      },
    });
  });
}

interface LifecycleProbe {
  mark(): number;
  heldSince(mark: number): string[];
  createdSince(mark: number): string[];
}

export function lifecycleMark(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __mapLifecycle: LifecycleProbe }).__mapLifecycle.mark(),
  );
}

/** What was created after `mark` and is still held, e.g. `webgl-context webgl2`. */
export function heldSince(page: Page, mark: number): Promise<string[]> {
  return page.evaluate(
    (from) =>
      (window as unknown as { __mapLifecycle: LifecycleProbe }).__mapLifecycle.heldSince(from),
    mark,
  );
}

/** Everything created after `mark`, held or released: the positive control. */
export function createdSince(page: Page, mark: number): Promise<string[]> {
  return page.evaluate(
    (from) =>
      (window as unknown as { __mapLifecycle: LifecycleProbe }).__mapLifecycle.createdSince(from),
    mark,
  );
}

/**
 * Strings that exist only in the map code, so a script body carrying one of them is map
 * code. ASCII only: bundlers may escape other characters.
 *
 * - `view`: the kit's `MapView` (its evidence attribute).
 * - `adapter`: the kit's MapLibre adapter (its line layer id).
 * - `sdk`: MapLibre GL itself (the class it puts on its canvas).
 * - `panel`: the S09 stored-track panel, which is lazy too but is not map code.
 */
const markers = {
  view: 'data-rendered-lines',
  adapter: 'geo-kit-path-line',
  sdk: 'maplibregl-canvas',
  panel: 'stored-track-panes',
} as const;
export type ScriptMarker = keyof typeof markers;

/**
 * Wait until the page has made no new request for a second (at most 20 s). `networkidle`
 * is not used: a map with a background keeps fetching tiles as it settles, and after the
 * load event the state is not re-armed, so it can either pass too early or never come.
 */
export async function settleRequests(page: Page): Promise<void> {
  let requests = 0;
  const count = () => {
    requests += 1;
  };
  page.on('request', count);
  try {
    let before = -1;
    for (let round = 0; round < 20 && before !== requests; round += 1) {
      before = requests;
      await page.waitForTimeout(1_000);
    }
  } finally {
    page.off('request', count);
  }
}

/**
 * Every script this page receives, read for the markers above. `reset` starts a new
 * observation, normally right before a navigation.
 */
export async function recordScripts(page: Page) {
  // With the HTTP cache on, a chunk the page already fetched for an earlier screen is served
  // from memory without a response event, and the screen that needs it again would look as
  // if it had loaded nothing. Every script is fetched, so every one is seen.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  let bodies: Promise<string>[] = [];
  // Every script request, answered or not: a chunk still on its way counts as unsettled.
  let requested = 0;
  page.on('request', (request) => {
    if (/\.m?js$/.test(new URL(request.url()).pathname)) requested += 1;
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!/\.m?js$/.test(path)) return;
    bodies.push(response.text().catch(() => ''));
  });
  return {
    reset() {
      bodies = [];
    },
    /**
     * Wait until no script has been requested for a second (at most 20 s), so a map chunk
     * that a screen prefetches a little after it renders is caught too.
     */
    async settle(): Promise<void> {
      let before = -1;
      for (let round = 0; round < 20 && before !== requested; round += 1) {
        before = requested;
        await page.waitForTimeout(1_000);
      }
    },
    /** Which markers have arrived since the last reset. */
    async seen(): Promise<Record<ScriptMarker, boolean>> {
      const texts = await Promise.all(bodies);
      const found = (marker: string) => texts.some((text) => text.includes(marker));
      return {
        view: found(markers.view),
        adapter: found(markers.adapter),
        sdk: found(markers.sdk),
        panel: found(markers.panel),
      };
    },
  };
}

/**
 * Every request any page of this context **attempts**, recorded before it reaches the
 * network: routed requests (including workers'), WebSocket attempts, and — because a
 * Content-Security-Policy blocks a request before any route sees it — every CSP violation
 * each document reports. A request to anywhere but `allowedOrigin` is aborted, so nothing
 * leaves the machine, and is still recorded.
 */
export async function recordAttemptedRequests(context: BrowserContext, allowedOrigin: string) {
  const attempts: string[] = [];
  const allowed = (url: string) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return true;
    try {
      return new URL(url).origin === allowedOrigin;
    } catch {
      return false;
    }
  };
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    attempts.push(url);
    if (allowed(url)) await route.continue();
    else await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (socket) => {
    attempts.push(socket.url());
    if (allowed(socket.url())) socket.connectToServer();
    else void socket.close();
  });
  await context.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: violations });
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.blockedURI || `${event.violatedDirective} (no URI)`),
    );
  });
  return {
    attempts: () => [...attempts],
    external: () => attempts.filter((url) => !allowed(url)),
    /** CSP violations the page reported; they never reach a route. */
    violations: (page: Page) =>
      page.evaluate(() => [
        ...((window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []),
      ]),
  };
}

/**
 * Hold every request matching `pattern` until {@link releaseAll}: the requests the screen
 * has in flight when it goes away. Each held request also reports whether the page itself
 * gave up on it (`requestfailed`), which is what "the request was cancelled" means here.
 */
export async function holdRequests(page: Page, pattern: RegExp) {
  const held: { request: Request; route: Route }[] = [];
  const failed = new Set<Request>();
  page.on('requestfailed', (request) => {
    if (pattern.test(request.url())) failed.add(request);
  });
  await page.route(pattern, (route) => {
    held.push({ request: route.request(), route });
  });
  return {
    count: () => held.length,
    /** Held requests the page has not cancelled. */
    stillWanted: () =>
      held.filter(({ request }) => !failed.has(request)).map(({ request }) => request.url()),
    async releaseAll() {
      await page.unroute(pattern);
      for (const { route } of held.splice(0)) await route.continue().catch(() => undefined);
    },
  };
}
