import { isAbsolute } from 'node:path';

import {
  GraphHopperRoutingAdapter,
  TenantAdmissionControl,
  WalkingRouteService,
  createRoutingEngineEndpoint,
  defaultRoutingEngineHosts,
  loadRoutingDeployment,
  type LoadRoutingDeploymentOptions,
  type RoutingClock,
} from '@workout/server-integrations/routing';

import type { WalkingRoutePort } from './routing-routes.js';

/**
 * Operations wiring for the self-hosted pedestrian routing engine (M2-01k).
 *
 * Until this existed, `configured.ts` never built a `walkingRoutes` port, so a production
 * composition registered neither the route-proposal nor the target-distance candidate
 * routes, and every end-to-end run of those features went through a fixture engine.
 *
 * The only way from configuration to a port is {@link loadRoutingDeployment}. It verifies
 * the graph files, the engine jar and the profile configuration on disk against the graph
 * manifest before anything can be computed, and the adapter additionally asks the running
 * engine who it is on every computation. Nothing here constructs an identity by hand.
 *
 * Three states, and they are kept apart on purpose:
 *
 * - **Not configured** (none of the variables set): `null`. The routes stay unregistered
 *   and the screens say "this server has no route computation", exactly as before.
 * - **Half configured** (some set, some not): startup fails. A typo in one variable must
 *   not look like a deliberate choice to switch the feature off.
 * - **Configured but unverifiable** (graph changed, wrong jar, wrong profile, disallowed
 *   host): startup fails with the verification error. Serving routes under an identity
 *   nothing has checked is the failure the deployment guard exists to prevent, and turning
 *   it into "feature off" would hide it.
 *
 * The engine does not have to be reachable at startup. It is asked for its identity on
 * every computation, and an engine that is down answers `engine_unavailable` per request;
 * a startup probe would only prove it was up at one instant.
 */
export const routingEnvironmentKeys = Object.freeze([
  'ROUTING_ENGINE_URL',
  'ROUTING_GRAPH_DIRECTORY',
  'ROUTING_ENGINE_ARTIFACT',
  'ROUTING_PROFILE_CONFIG',
] as const);

/**
 * `ROUTING_GRAPH_DIRECTORY` names the graph directory itself — the one holding
 * `routing-graph-manifest.json` next to the graph files, e.g. `.geo-build/routing-graph/foot`
 * — not its parent. The parent hashes to something else and is refused at startup with
 * `GRAPH_CONTENT_CHANGED`. `ROUTING_PROFILE_CONFIG` is the serving profile the engine is
 * started with (`.geo-build/routing-graph/config-serving.yml`), not the M2-01d measurement
 * profile.
 */
/** Optional: comma-separated hosts the engine may live on. Defaults to loopback only. */
export const ROUTING_ENGINE_ALLOWED_HOSTS = 'ROUTING_ENGINE_ALLOWED_HOSTS';

export class RoutingConfigurationError extends Error {
  constructor(
    readonly code: 'ROUTING_CONFIGURATION_INCOMPLETE' | 'ROUTING_PATH_NOT_ABSOLUTE',
    readonly keys: readonly string[],
  ) {
    super(`${code}: ${keys.join(', ')}`);
    this.name = 'RoutingConfigurationError';
  }
}

export interface ConfiguredWalkingRoutes {
  readonly walkingRoutes: WalkingRoutePort;
  /** The verified build id, for a startup log line. Not a secret and not a path. */
  readonly graphBuildId: string;
}

export interface ConfiguredWalkingRoutesOptions {
  readonly clock?: RoutingClock;
  /** Test seam only; production uses the real fetch transport bound to the endpoint. */
  readonly transportFactory?: LoadRoutingDeploymentOptions['transportFactory'];
}

function readSetting(environment: Readonly<Record<string, unknown>>, key: string) {
  const value = environment[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export async function createConfiguredWalkingRoutes(
  environment: Readonly<Record<string, unknown>>,
  options: ConfiguredWalkingRoutesOptions = {},
): Promise<ConfiguredWalkingRoutes | null> {
  const settings = routingEnvironmentKeys.map((key) => [key, readSetting(environment, key)]);
  const missing = settings.filter(([, value]) => value === undefined).map(([key]) => key ?? '');
  const allowedHostsSetting = readSetting(environment, ROUTING_ENGINE_ALLOWED_HOSTS);
  if (missing.length === routingEnvironmentKeys.length) {
    // An allowlist on its own configures nothing, and saying nothing about it would hide
    // an operator's half-finished change just as a missing path would.
    if (allowedHostsSetting !== undefined)
      throw new RoutingConfigurationError('ROUTING_CONFIGURATION_INCOMPLETE', [
        ...routingEnvironmentKeys,
      ]);
    return null;
  }
  if (missing.length > 0)
    throw new RoutingConfigurationError('ROUTING_CONFIGURATION_INCOMPLETE', missing);
  const value = (key: (typeof routingEnvironmentKeys)[number]) =>
    readSetting(environment, key) as string;
  const paths = [
    'ROUTING_GRAPH_DIRECTORY',
    'ROUTING_ENGINE_ARTIFACT',
    'ROUTING_PROFILE_CONFIG',
  ] as const;
  const relative = paths.filter((key) => !isAbsolute(value(key)));
  if (relative.length > 0)
    throw new RoutingConfigurationError('ROUTING_PATH_NOT_ABSOLUTE', relative);

  const endpoint = createRoutingEngineEndpoint(value('ROUTING_ENGINE_URL'), {
    allowedHosts:
      allowedHostsSetting === undefined
        ? defaultRoutingEngineHosts
        : allowedHostsSetting
            .split(',')
            .map((host) => host.trim())
            .filter((host) => host !== ''),
  });
  const deployment = await loadRoutingDeployment({
    graphDirectory: value('ROUTING_GRAPH_DIRECTORY'),
    engineArtifactPath: value('ROUTING_ENGINE_ARTIFACT'),
    profileConfigPath: value('ROUTING_PROFILE_CONFIG'),
    endpoint,
    ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
  });
  const clock = options.clock ?? { now: () => new Date() };
  const service = new WalkingRouteService({
    adapter: new GraphHopperRoutingAdapter({ deployment, clock }),
    admission: new TenantAdmissionControl({ now: () => clock.now().getTime() }),
    clock,
  });
  return {
    graphBuildId: deployment.graphBuildId,
    walkingRoutes: {
      compute: (athleteId, request, context) => service.compute(athleteId, request, context),
    },
  };
}
