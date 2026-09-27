import {
  nativeBridgeRequestSchema,
  nativeBridgeReplySchema,
  nativeBridgeVersion,
  type NativeBridgeCapabilities,
  type NativeBridgeErrorCode,
  type NativeBridgeRequest,
  type NativeBridgeReadPath,
  type NativeBridgeSession,
  type NativeBridgeHealthKitConsentWrite,
  type NativeBridgeHealthKitStatus,
} from '@workout/contracts/native-bridge';

const signInTimeoutMs = 10 * 60_000;
const defaultNetworkTimeoutMs = 35_000;
const cancellationSettleTimeoutMs = 1200;

export interface NativeBridgePort {
  exchange(request: NativeBridgeRequest, signal: AbortSignal): Promise<unknown>;
  /** Exchange settles after native cancellation acknowledgement when the signal aborts. */
  cancellationSettlesExchangeOnAbort?: true;
}

export type NativeBridgeClientResult<T> =
  { ok: true; value: T } | { ok: false; code: NativeBridgeErrorCode };

export interface NativeBridgeClientOptions {
  port: NativeBridgePort | null;
  createId: () => string;
  timeoutMs?: number;
  networkTimeoutMs?: number;
}

export function createNativeBridgeClient({
  port,
  createId,
  timeoutMs = 5000,
  networkTimeoutMs = defaultNetworkTimeoutMs,
}: NativeBridgeClientOptions) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('Expected a timeout between 1 and 60000 ms');
  }
  if (
    !Number.isSafeInteger(networkTimeoutMs) ||
    networkTimeoutMs < 1 ||
    networkTimeoutMs > 60_000
  ) {
    throw new RangeError('Expected a network timeout between 1 and 60000 ms');
  }
  let capabilities: NativeBridgeCapabilities | null = null;
  let connectionGeneration = 0;

  async function exchange(
    request: NativeBridgeRequest,
    signal?: AbortSignal,
    requestTimeoutMs = timeoutMs,
  ): Promise<NativeBridgeClientResult<unknown>> {
    if (!port) return { ok: false, code: 'UNAVAILABLE' };
    if (signal?.aborted) return { ok: false, code: 'CANCELLED' };
    if (!nativeBridgeRequestSchema.safeParse(request).success) {
      return { ok: false, code: 'INVALID_REQUEST' };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let stopCode: 'TIMEOUT' | 'CANCELLED' | undefined;
    const stopped = new Promise<NativeBridgeClientResult<unknown>>((resolve) => {
      timer = setTimeout(() => {
        stopCode = 'TIMEOUT';
        controller.abort();
        resolve({ ok: false, code: 'TIMEOUT' });
      }, requestTimeoutMs);
      onAbort = () => {
        stopCode = 'CANCELLED';
        controller.abort();
        resolve({ ok: false, code: 'CANCELLED' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const portReply = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw new Error('Request stopped before dispatch');
          return port.exchange(request, controller.signal);
        })
        .then(
          (value): NativeBridgeClientResult<unknown> => ({ ok: true, value }),
          (): NativeBridgeClientResult<unknown> => ({ ok: false, code: 'UNAVAILABLE' }),
        );
      const reply = await Promise.race([portReply, stopped]);
      if (stopCode) {
        if (port.cancellationSettlesExchangeOnAbort) {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              portReply,
              new Promise<void>((resolve) => {
                settleTimer = setTimeout(resolve, cancellationSettleTimeoutMs);
              }),
            ]);
          } finally {
            if (settleTimer !== undefined) clearTimeout(settleTimer);
          }
        }
        return { ok: false, code: stopCode };
      }
      if (!reply.ok) return reply;
      if (
        typeof reply.value === 'object' &&
        reply.value !== null &&
        'version' in reply.value &&
        reply.value.version !== nativeBridgeVersion
      ) {
        return { ok: false, code: 'UNSUPPORTED_VERSION' };
      }
      const parsed = nativeBridgeReplySchema.safeParse(reply.value);
      if (!parsed.success || parsed.data.id !== request.id) {
        return { ok: false, code: 'INVALID_REPLY' };
      }
      if (parsed.data.kind === 'error') return { ok: false, code: parsed.data.code };
      return { ok: true, value: parsed.data };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async function connect(
    signal?: AbortSignal,
  ): Promise<NativeBridgeClientResult<NativeBridgeCapabilities>> {
    const generation = ++connectionGeneration;
    capabilities = null;
    const id = createId();
    const result = await exchange({ kind: 'hello', version: nativeBridgeVersion, id }, signal);
    if (generation !== connectionGeneration) return { ok: false, code: 'CANCELLED' };
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'hello.result') return { ok: false, code: 'INVALID_REPLY' };
    capabilities = Object.freeze({ ...reply.capabilities });
    return { ok: true, value: capabilities };
  }

  async function openSettings(signal?: AbortSignal): Promise<NativeBridgeClientResult<void>> {
    if (!capabilities?.['app.openSettings']) return { ok: false, code: 'UNAVAILABLE' };
    const id = createId();
    const result = await exchange(
      {
        kind: 'command',
        version: nativeBridgeVersion,
        id,
        method: 'app.openSettings',
        payload: {},
      },
      signal,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== 'app.openSettings') {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    return { ok: true, value: undefined };
  }

  async function authSessionCommand(
    method: 'auth.signIn' | 'auth.session',
    signal?: AbortSignal,
  ): Promise<NativeBridgeClientResult<NativeBridgeSession>> {
    if (!capabilities?.['auth.transport']) return { ok: false, code: 'UNAVAILABLE' };
    const result = await exchange(
      { kind: 'command', version: nativeBridgeVersion, id: createId(), method, payload: {} },
      signal,
      method === 'auth.signIn' ? signInTimeoutMs : networkTimeoutMs,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== method || !('session' in reply)) {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    return { ok: true, value: reply.session };
  }

  async function signOut(signal?: AbortSignal): Promise<NativeBridgeClientResult<void>> {
    if (!capabilities?.['auth.transport']) return { ok: false, code: 'UNAVAILABLE' };
    const result = await exchange(
      {
        kind: 'command',
        version: nativeBridgeVersion,
        id: createId(),
        method: 'auth.signOut',
        payload: {},
      },
      signal,
      networkTimeoutMs,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== 'auth.signOut') {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    return { ok: true, value: undefined };
  }

  async function read(
    path: NativeBridgeReadPath,
    signal?: AbortSignal,
  ): Promise<NativeBridgeClientResult<{ status: 200 | 401; body: unknown }>> {
    if (!capabilities?.['auth.transport']) return { ok: false, code: 'UNAVAILABLE' };
    const result = await exchange(
      {
        kind: 'command',
        version: nativeBridgeVersion,
        id: createId(),
        method: 'api.read',
        payload: { path },
      },
      signal,
      networkTimeoutMs,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== 'api.read' || reply.path !== path) {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    return { ok: true, value: { status: reply.status, body: reply.body } };
  }

  async function writeHealthKitConsent(
    payload: NativeBridgeHealthKitConsentWrite,
    signal?: AbortSignal,
  ): Promise<
    NativeBridgeClientResult<
      | { status: 200; body: { kind: 'healthkit'; granted: boolean; revision: number } }
      | { status: 401 | 409; body: null }
    >
  > {
    if (!capabilities?.['auth.transport']) return { ok: false, code: 'UNAVAILABLE' };
    const result = await exchange(
      {
        kind: 'command',
        version: nativeBridgeVersion,
        id: createId(),
        method: 'api.healthkitConsent.write',
        payload,
      },
      signal,
      networkTimeoutMs,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== 'api.healthkitConsent.write') {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    if (reply.status === 200) {
      return { ok: true, value: { status: 200, body: reply.body } };
    }
    return { ok: true, value: { status: reply.status, body: null } };
  }

  async function workoutCommand(
    method: 'healthkit.workouts.requestAccess' | 'healthkit.workouts.status',
    signal?: AbortSignal,
  ): Promise<NativeBridgeClientResult<'requested' | NativeBridgeHealthKitStatus>> {
    if (!capabilities?.['healthkit.workouts'] || !capabilities['auth.transport']) {
      return { ok: false, code: 'UNAVAILABLE' };
    }
    const result = await exchange(
      {
        kind: 'command',
        version: nativeBridgeVersion,
        id: createId(),
        method,
        payload: {},
      },
      signal,
      method === 'healthkit.workouts.requestAccess' ? 60_000 : networkTimeoutMs,
    );
    if (!result.ok) return result;
    const reply = nativeBridgeReplySchema.parse(result.value);
    if (reply.kind !== 'command.result' || reply.method !== method || !('status' in reply)) {
      return { ok: false, code: 'INVALID_REPLY' };
    }
    return { ok: true, value: reply.status };
  }

  return {
    connect,
    openSettings,
    signIn: (signal?: AbortSignal) => authSessionCommand('auth.signIn', signal),
    session: (signal?: AbortSignal) => authSessionCommand('auth.session', signal),
    signOut,
    read,
    writeHealthKitConsent,
    requestHealthKitWorkoutAccess: (signal?: AbortSignal) =>
      workoutCommand('healthkit.workouts.requestAccess', signal),
    healthKitWorkoutStatus: (signal?: AbortSignal) =>
      workoutCommand('healthkit.workouts.status', signal),
    getCapabilities: () => capabilities,
  };
}
