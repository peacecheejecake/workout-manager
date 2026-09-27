import { Capacitor, registerPlugin } from '@capacitor/core';
import type { NativeBridgeRequest } from '@workout/contracts/native-bridge';
import type { NativeBridgePort } from './native-bridge-client.js';

const pluginName = 'WorkoutNativeBridge';

interface WorkoutNativeBridgePlugin {
  exchange(options: { request: NativeBridgeRequest }): Promise<unknown>;
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

/** Native-only transport. The client owns request/reply schema validation and timeouts. */
export function createCapacitorBridgePort(
  environment: CapacitorBridgeEnvironment = defaultEnvironment,
): NativeBridgePort {
  return {
    async exchange(request, signal) {
      if (signal.aborted) throw new Error('Native bridge request was cancelled');
      if (!environment.isNativePlatform() || !environment.isPluginAvailable(pluginName)) {
        throw new Error('Native bridge plugin is unavailable');
      }
      const envelope: unknown = await environment.plugin.exchange({ request });
      if (typeof envelope !== 'object' || envelope === null || !('reply' in envelope)) {
        return undefined;
      }
      return envelope.reply;
    },
  };
}
