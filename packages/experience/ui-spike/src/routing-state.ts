import { createStore } from 'zustand/vanilla';

export const routingFixtureQueueLimit = 20;

export type RoutingScenario = '429' | 'timeout' | 'NoRoute' | 'success';
export type SyntheticDestination = 'B' | 'C';
export interface SyntheticPoint {
  x: number;
  y: number;
}
export interface RoutingRequest {
  requestId: number;
  draftRevision: number;
  destination: SyntheticDestination;
  scenario: RoutingScenario;
  signal: AbortSignal;
}
export type RoutingPort = (request: RoutingRequest) => Promise<unknown>;
export type RoutingResult =
  | { status: 'idle' | 'requesting' | 'cancelled' }
  | {
      status: 'error';
      reason: '429' | 'timeout' | 'NoRoute' | 'invalid_response' | 'request_failed';
    }
  | { status: 'computed'; points: SyntheticPoint[] };
export interface RoutingState {
  draftRevision: number;
  destination: SyntheticDestination;
  scenario: RoutingScenario;
  result: RoutingResult;
  setScenario(scenario: RoutingScenario): void;
  editDestination(): void;
  request(): Promise<void>;
  cancel(): void;
  activate(): void;
  dispose(): void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const point = (value: unknown): value is SyntheticPoint =>
  object(value) &&
  Object.keys(value).length === 2 &&
  typeof value['x'] === 'number' &&
  Number.isFinite(value['x']) &&
  value['x'] >= 0 &&
  value['x'] <= 100 &&
  typeof value['y'] === 'number' &&
  Number.isFinite(value['y']) &&
  value['y'] >= 0 &&
  value['y'] <= 100;
function decode(value: unknown, request: RoutingRequest): RoutingResult {
  if (
    !object(value) ||
    value['requestId'] !== request.requestId ||
    value['draftRevision'] !== request.draftRevision
  )
    return { status: 'error', reason: 'invalid_response' };
  if (
    value['kind'] === 'error' &&
    Object.keys(value).length === 4 &&
    (value['reason'] === '429' || value['reason'] === 'timeout' || value['reason'] === 'NoRoute')
  )
    return { status: 'error', reason: value['reason'] };
  const points: unknown = value['points'];
  if (
    value['kind'] !== 'success' ||
    Object.keys(value).length !== 4 ||
    !Array.isArray(points) ||
    points.length < 2 ||
    points.length > 100 ||
    !points.every(point)
  )
    return { status: 'error', reason: 'invalid_response' };
  const end = request.destination === 'B' ? { x: 80, y: 20 } : { x: 80, y: 80 };
  if (
    points[0]?.x !== 20 ||
    points[0]?.y !== 20 ||
    points.at(-1)?.x !== end.x ||
    points.at(-1)?.y !== end.y
  )
    return { status: 'error', reason: 'invalid_response' };
  return { status: 'computed', points: points.map(({ x, y }) => ({ x, y })) };
}
/** Memory-only factory: no provider, timers, persistent storage or inferred route fallback. */
export function createRoutingStore(port: RoutingPort) {
  let active = true;
  let sequence = 0;
  let controller: AbortController | null = null;
  const invalidate = () => {
    sequence += 1;
    controller?.abort();
    controller = null;
  };
  return createStore<RoutingState>()((set, get) => ({
    draftRevision: 1,
    destination: 'B',
    scenario: '429',
    result: { status: 'idle' },
    setScenario: (scenario) => {
      if (active) set({ scenario });
    },
    editDestination: () => {
      if (!active) return;
      invalidate();
      set((state) => ({
        draftRevision: state.draftRevision + 1,
        destination: state.destination === 'B' ? 'C' : 'B',
        result: { status: 'idle' },
      }));
    },
    async request() {
      if (!active || get().result.status === 'requesting') return;
      invalidate();
      const abort = new AbortController();
      controller = abort;
      const { draftRevision, destination, scenario } = get();
      const input: RoutingRequest = {
        requestId: sequence,
        draftRevision,
        destination,
        scenario,
        signal: abort.signal,
      };
      const current = () =>
        active &&
        !abort.signal.aborted &&
        sequence === input.requestId &&
        get().draftRevision === draftRevision;
      set({ result: { status: 'requesting' } });
      try {
        const response = await port(input);
        if (current()) set({ result: decode(response, input) });
      } catch {
        if (current()) set({ result: { status: 'error', reason: 'request_failed' } });
      } finally {
        if (controller === abort) controller = null;
      }
    },
    cancel: () => {
      if (!active) return;
      invalidate();
      set({ result: { status: 'cancelled' } });
    },
    activate: () => {
      active = true;
    },
    dispose: () => {
      active = false;
      invalidate();
    },
  }));
}
/** Explicit FIFO fixture deliberately permits late delivery after abort to exercise identity guards. */
export function createDeferredRoutingFixture() {
  const pending: { input: RoutingRequest; resolve(value: unknown): void }[] = [];
  const port: RoutingPort = (input) =>
    new Promise((resolve, reject) => {
      if (pending.length >= routingFixtureQueueLimit) {
        reject(new Error('FIXTURE_QUEUE_LIMIT'));
        return;
      }
      pending.push({ input, resolve });
    });
  return {
    port,
    count: () => pending.length,
    deliver(order: 'oldest' | 'latest' = 'oldest') {
      const entry = order === 'oldest' ? pending.shift() : pending.pop();
      if (!entry) return;
      const { input, resolve } = entry;
      resolve(
        input.scenario === 'success'
          ? {
              kind: 'success',
              requestId: input.requestId,
              draftRevision: input.draftRevision,
              points: [
                { x: 20, y: 20 },
                { x: 50, y: 45 },
                { x: 80, y: input.destination === 'B' ? 20 : 80 },
              ],
            }
          : {
              kind: 'error',
              requestId: input.requestId,
              draftRevision: input.draftRevision,
              reason: input.scenario,
            },
      );
    },
    clear() {
      for (const entry of pending.splice(0)) entry.resolve(null);
    },
  };
}
