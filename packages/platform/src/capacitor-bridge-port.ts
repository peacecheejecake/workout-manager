import { Capacitor, registerPlugin } from '@capacitor/core';
import type { NativeBridgeRequest } from '@workout/contracts/native-bridge';
import type { NativeBridgePort } from './native-bridge-client.js';

const pluginName = 'WorkoutNativeBridge';

interface WorkoutNativeBridgePlugin {
  exchange(options: { request: NativeBridgeRequest }): Promise<unknown>;
  cancel(options: { id: string }): Promise<unknown>;
}

export interface CapacitorBridgeEnvironment {
  isNativePlatform(): boolean;
  isPluginAvailable(name: string): boolean;
  plugin: WorkoutNativeBridgePlugin;
}

const defaultEnvironment: CapacitorBridgeEnvironment = {
  isNativePlatform: () => Capacitor.isNativePlatform(),
  isPluginAvailable: (name) => Capacitor.isPluginAvailable(name),
  plugin: registerPlugin<WorkoutNativeBridgePlugin>(pluginName),
};

const cancellationAckTimeoutMs = 1000;

async function waitForCancellationAck(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, cancellationAckTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Native-only transport. The client owns request/reply schema validation and timeouts. */
export function createCapacitorBridgePort(
  environment: CapacitorBridgeEnvironment = defaultEnvironment,
): NativeBridgePort {
  return {
    cancellationSettlesExchangeOnAbort: true,
    async exchange(request, signal) {
      if (signal.aborted) throw new Error('Native bridge request was cancelled');
      if (!environment.isNativePlatform() || !environment.isPluginAvailable(pluginName)) {
        throw new Error('Native bridge plugin is unavailable');
      }
      let dispatched = false;
      const cancelled = Symbol('cancelled');
      let completeStop: (value: typeof cancelled) => void = () => undefined;
      const stopped = new Promise<typeof cancelled>((resolve) => {
        completeStop = resolve;
      });
      const stop = () => {
        signal.removeEventListener('abort', stop);
        if (!dispatched) {
          completeStop(cancelled);
          return;
        }
        void waitForCancellationAck(
          Promise.resolve().then(() => environment.plugin.cancel({ id: request.id })),
        ).then(() => completeStop(cancelled));
      };
      signal.addEventListener('abort', stop, { once: true });
      try {
        if (signal.aborted) throw new Error('Native bridge request was cancelled');
        dispatched = true;
        const envelope: unknown = await Promise.race([
          environment.plugin.exchange({ request }),
          stopped,
        ]);
        if (signal.aborted) await stopped;
        if (envelope === cancelled || signal.aborted) {
          throw new Error('Native bridge request was cancelled');
        }
        if (typeof envelope !== 'object' || envelope === null || !('reply' in envelope)) {
          return undefined;
        }
        return envelope.reply;
      } finally {
        signal.removeEventListener('abort', stop);
      }
    },
  };
}
