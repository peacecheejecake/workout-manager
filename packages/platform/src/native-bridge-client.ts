import {
  nativeBridgeRequestSchema,
  nativeBridgeReplySchema,
  nativeBridgeVersion,
  type NativeBridgeCapabilities,
  type NativeBridgeErrorCode,
  type NativeBridgeRequest,
} from '@workout/contracts/native-bridge';

export interface NativeBridgePort {
  exchange(request: NativeBridgeRequest, signal: AbortSignal): Promise<unknown>;
}

export type NativeBridgeClientResult<T> =
  { ok: true; value: T } | { ok: false; code: NativeBridgeErrorCode };

export interface NativeBridgeClientOptions {
  port: NativeBridgePort | null;
  createId: () => string;
  timeoutMs?: number;
}

export function createNativeBridgeClient({
  port,
  createId,
  timeoutMs = 5000,
}: NativeBridgeClientOptions) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('Expected a timeout between 1 and 60000 ms');
  }
  let capabilities: NativeBridgeCapabilities | null = null;
  let connectionGeneration = 0;

  async function exchange(
    request: NativeBridgeRequest,
    signal?: AbortSignal,
  ): Promise<NativeBridgeClientResult<unknown>> {
    if (!port) return { ok: false, code: 'UNAVAILABLE' };
    if (signal?.aborted) return { ok: false, code: 'CANCELLED' };
    if (!nativeBridgeRequestSchema.safeParse(request).success) {
      return { ok: false, code: 'INVALID_REQUEST' };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<NativeBridgeClientResult<unknown>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, code: 'TIMEOUT' });
      }, timeoutMs);
      onAbort = () => {
        controller.abort();
        resolve({ ok: false, code: 'CANCELLED' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const reply = await Promise.race([
        Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) throw new Error('Request stopped before dispatch');
            return port.exchange(request, controller.signal);
          })
          .then(
            (value): NativeBridgeClientResult<unknown> => ({ ok: true, value }),
            (): NativeBridgeClientResult<unknown> => ({ ok: false, code: 'UNAVAILABLE' }),
          ),
        stopped,
      ]);
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

  return { connect, openSettings, getCapabilities: () => capabilities };
}
