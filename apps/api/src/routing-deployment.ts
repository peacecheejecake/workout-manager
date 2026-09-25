import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  GraphHopperRoutingAdapter,
  WalkingRouteService,
  createRoutingEngineEndpoint,
  defaultRoutingEngineHosts,
  loadRoutingDeployment,
  type LoadRoutingDeploymentOptions,
  type RoutingAdmission,
  type RoutingClock,
} from '@workout/server-integrations/routing';
import { z } from 'zod';

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
/** Optional: the engine cap over every tenant (M2-01ah). Read by `routing-admission.ts`. */
export const ROUTING_ENGINE_CONCURRENCY = 'ROUTING_ENGINE_CONCURRENCY';

export class RoutingConfigurationError extends Error {
  constructor(
    readonly code:
      | 'ROUTING_CONFIGURATION_INCOMPLETE'
      | 'ROUTING_PATH_NOT_ABSOLUTE'
      | 'ROUTING_CONFIGURATION_INVALID',
    readonly keys: readonly string[],
  ) {
    super(`${code}: ${keys.join(', ')}`);
    this.name = 'RoutingConfigurationError';
  }
}

export interface ConfiguredWalkingRoutes {
  /**
   * The port every routing route uses. It reads the ACTIVE deployment once per computation
   * and uses that one deployment for the identity check and the route alike, so a switch
   * never mixes two graphs inside one computation.
   */
  readonly walkingRoutes: WalkingRoutePort;
  /** The verified build id at startup, for a startup log line. Not a secret and not a path. */
  readonly graphBuildId: string;
  /** Blue/green control: switch to another running engine, or roll back (M2-01k-e). */
  readonly deployments: RoutingDeploymentSwitch;
}

export interface ConfiguredWalkingRoutesOptions {
  /**
   * Where every computation takes its permit (M2-01ah). Required, so no composition falls
   * back to counting in its own process without saying so: production passes the shared
   * PostgreSQL limiter (`createConfiguredRoutingAdmission`); tests and offline probes pass an
   * in-process `TenantAdmissionControl` explicitly. One admission serves every deployment
   * this process switches between, so a switch does not reset a tenant's bounds.
   */
  readonly admission: RoutingAdmission;
  readonly clock?: RoutingClock;
  /** Test seam only; production uses the real fetch transport bound to the endpoint. */
  readonly transportFactory?: LoadRoutingDeploymentOptions['transportFactory'];
  /**
   * Probe seam only (M2-01k-e): TIGHTER bounds, so a bound this region never reaches at its
   * production value (an 8 s deadline, 20,000 response points) can still be observed
   * against the real engine through this exact composition. Production never sets it.
   */
  readonly adapterBounds?: {
    readonly deadlineMilliseconds?: number;
    readonly maxResponsePoints?: number;
  };
}

interface RoutingSettings {
  readonly engineUrl: string;
  readonly graphDirectory: string;
  readonly engineArtifact: string;
  readonly profileConfig: string;
}

function readSetting(environment: Readonly<Record<string, unknown>>, key: string) {
  const value = environment[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** `null` when none of the four is set; throws on a half-set or relative configuration. */
function routingSettings(environment: Readonly<Record<string, unknown>>): RoutingSettings | null {
  const settings = routingEnvironmentKeys.map((key) => [key, readSetting(environment, key)]);
  const missing = settings.filter(([, value]) => value === undefined).map(([key]) => key ?? '');
  if (missing.length === routingEnvironmentKeys.length) return null;
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
  return {
    engineUrl: value('ROUTING_ENGINE_URL'),
    graphDirectory: value('ROUTING_GRAPH_DIRECTORY'),
    engineArtifact: value('ROUTING_ENGINE_ARTIFACT'),
    profileConfig: value('ROUTING_PROFILE_CONFIG'),
  };
}

/** One verified deployment, bound to its own engine, ready to serve. */
interface ServingDeployment {
  readonly graphBuildId: string;
  /** Origin of the engine this deployment talks to; blue and green must differ. */
  readonly engineOrigin: string;
  readonly adapter: GraphHopperRoutingAdapter;
  readonly service: WalkingRouteService;
}

export class RoutingSwitchError extends Error {
  constructor(
    readonly code:
      | 'ROUTING_SWITCH_ENGINE_NOT_SERVING'
      | 'ROUTING_SWITCH_SAME_ENGINE'
      | 'ROUTING_ROLLBACK_UNAVAILABLE',
    /** The adapter outcome that refused the engine, when one did. Never a path or URL. */
    readonly engineOutcome: string | null = null,
  ) {
    super(engineOutcome === null ? code : `${code}: ${engineOutcome}`);
    this.name = 'RoutingSwitchError';
  }
}

export interface RoutingSwitchResult {
  readonly from: string;
  readonly to: string;
}

/**
 * Atomic blue/green graph replacement (M2-01k-e).
 *
 * THE DECISION. A new graph is served by a SECOND engine instance on its own port, never by
 * restarting the running one. The API holds one reference to the active deployment — the
 * verified pin AND the engine endpoint together — and a switch replaces that reference in a
 * single synchronous assignment. Before, replacing a graph was two independent steps
 * (restart the engine, redeploy the API) with a window between them in which every request
 * failed `graph_mismatch`, and a window between `/info` and `/route` in which a restart
 * could land unseen.
 *
 * What holds now, per API process:
 *
 * - No mixed state. A computation reads the active deployment once and asks that
 *   deployment's engine both who it is and for the route. Before the switch every
 *   computation is (pin A, engine A); after it, (pin B, engine B). There is no moment at
 *   which the API is pinned to one graph and pointed at an engine serving another.
 * - Nothing is switched in unchecked. The candidate is verified on disk (graph, jar and
 *   profile hashes, exactly as at startup) and its running engine must report exactly the
 *   pinned identity before the reference moves. A failed check leaves the active
 *   deployment untouched.
 * - In-place replacement is refused. A candidate on the active engine's own origin is
 *   `ROUTING_SWITCH_SAME_ENGINE`: restarting the serving engine in place is the old,
 *   non-atomic procedure, and this control does not pretend to make it atomic.
 * - In-flight work finishes where it started. A computation that began on blue completes
 *   on blue, which is why blue keeps running until it is drained; its result carries
 *   blue's identity, and saving it across graphs still needs the two-sided acknowledgement.
 * - Rollback is the same single assignment back to the previous deployment, which is kept
 *   verified in memory. Its engine must still be serving exactly its graph.
 * - Tenant permits are shared across deployments: switching does not reset a tenant's
 *   concurrency or rate bound.
 * - The engine host allowlist is fixed at startup. A switch cannot widen it.
 *
 * What does NOT hold: the switch is atomic within one API process. Several API instances
 * switch one after another; during that roll-out some instances answer from blue and some
 * from green, each consistently, and stored revisions record which graph computed them.
 * Retiring blue is an operator step after every instance has switched and drained.
 */
export class RoutingDeploymentSwitch {
  #active: ServingDeployment;
  #previous: ServingDeployment | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  readonly #prepare: (settings: RoutingSettings) => Promise<ServingDeployment>;
  readonly walkingRoutes: WalkingRoutePort;

  constructor(
    initial: ServingDeployment,
    prepare: (settings: RoutingSettings) => Promise<ServingDeployment>,
  ) {
    this.#active = initial;
    this.#prepare = prepare;
    this.walkingRoutes = {
      // One read of the active deployment per computation; never re-read mid-computation.
      compute: (athleteId, request, context) =>
        this.#active.service.compute(athleteId, request, context),
    };
  }

  get activeGraphBuildId(): string {
    return this.#active.graphBuildId;
  }

  get previousGraphBuildId(): string | null {
    return this.#previous?.graphBuildId ?? null;
  }

  /**
   * Switch to the deployment the given settings describe: the same four `ROUTING_*` keys as
   * startup, naming a graph served by another, already running engine.
   */
  switchTo(environment: Readonly<Record<string, unknown>>): Promise<RoutingSwitchResult> {
    return this.#serialized(async () => {
      const settings = routingSettings(environment);
      if (settings === null)
        throw new RoutingConfigurationError('ROUTING_CONFIGURATION_INCOMPLETE', [
          ...routingEnvironmentKeys,
        ]);
      const candidate = await this.#prepare(settings);
      if (candidate.engineOrigin === this.#active.engineOrigin)
        throw new RoutingSwitchError('ROUTING_SWITCH_SAME_ENGINE');
      await assertServing(candidate);
      const from = this.#active;
      // The switch: one synchronous step, nothing awaited between these two lines.
      this.#previous = from;
      this.#active = candidate;
      return { from: from.graphBuildId, to: candidate.graphBuildId };
    });
  }

  /** Switch back to the deployment that was active before the last switch. */
  rollback(): Promise<RoutingSwitchResult> {
    return this.#serialized(async () => {
      const previous = this.#previous;
      if (previous === null) throw new RoutingSwitchError('ROUTING_ROLLBACK_UNAVAILABLE');
      await assertServing(previous);
      const from = this.#active;
      this.#active = previous;
      this.#previous = from;
      return { from: from.graphBuildId, to: previous.graphBuildId };
    });
  }

  /** Switches run one at a time; a second waits for the first rather than interleaving. */
  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#pending.then(work, work);
    this.#pending = run.catch(() => undefined);
    return run;
  }
}

async function assertServing(deployment: ServingDeployment): Promise<void> {
  const check = await deployment.adapter.verifyEngineIdentity();
  if (!check.ok) throw new RoutingSwitchError('ROUTING_SWITCH_ENGINE_NOT_SERVING', check.outcome);
}

export async function createConfiguredWalkingRoutes(
  environment: Readonly<Record<string, unknown>>,
  options: ConfiguredWalkingRoutesOptions,
): Promise<ConfiguredWalkingRoutes | null> {
  const allowedHostsSetting = readSetting(environment, ROUTING_ENGINE_ALLOWED_HOSTS);
  const settings = routingSettings(environment);
  if (settings === null) {
    // An allowlist or an engine cap on its own configures nothing, and saying nothing about
    // it would hide an operator's half-finished change just as a missing path would.
    if (
      allowedHostsSetting !== undefined ||
      readSetting(environment, ROUTING_ENGINE_CONCURRENCY) !== undefined
    )
      throw new RoutingConfigurationError('ROUTING_CONFIGURATION_INCOMPLETE', [
        ...routingEnvironmentKeys,
      ]);
    return null;
  }
  const allowedHosts =
    allowedHostsSetting === undefined
      ? defaultRoutingEngineHosts
      : allowedHostsSetting
          .split(',')
          .map((host) => host.trim())
          .filter((host) => host !== '');
  const clock = options.clock ?? { now: () => new Date() };
  // One admission for every deployment this process will ever serve.
  const admission = options.admission;
  const prepare = async (next: RoutingSettings): Promise<ServingDeployment> => {
    const endpoint = createRoutingEngineEndpoint(next.engineUrl, { allowedHosts });
    const deployment = await loadRoutingDeployment({
      graphDirectory: next.graphDirectory,
      engineArtifactPath: next.engineArtifact,
      profileConfigPath: next.profileConfig,
      endpoint,
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    });
    const adapter = new GraphHopperRoutingAdapter({
      deployment,
      clock,
      ...(options.adapterBounds?.deadlineMilliseconds === undefined
        ? {}
        : { deadlineMilliseconds: options.adapterBounds.deadlineMilliseconds }),
      ...(options.adapterBounds?.maxResponsePoints === undefined
        ? {}
        : { maxResponsePoints: options.adapterBounds.maxResponsePoints }),
    });
    return {
      graphBuildId: deployment.graphBuildId,
      engineOrigin: endpoint.resolve('/info').origin,
      adapter,
      service: new WalkingRouteService({ adapter, admission, clock }),
    };
  };
  const initial = await prepare(settings);
  const deployments = new RoutingDeploymentSwitch(initial, prepare);
  return {
    graphBuildId: initial.graphBuildId,
    walkingRoutes: deployments.walkingRoutes,
    deployments,
  };
}

/** Largest switch file read; it holds four paths and a URL. */
const SWITCH_FILE_MAX_BYTES = 16 * 1024;

const switchFileSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('switch'),
    ROUTING_ENGINE_URL: z.string().min(1).max(512),
    ROUTING_GRAPH_DIRECTORY: z.string().min(1).max(4096),
    ROUTING_ENGINE_ARTIFACT: z.string().min(1).max(4096),
    ROUTING_PROFILE_CONFIG: z.string().min(1).max(4096),
  }),
  z.strictObject({ action: z.literal('rollback') }),
]);

/**
 * The operator's trigger (M2-01k-e): `start.ts` calls this on SIGHUP with
 * `ROUTING_SWITCH_FILE`. The file is either `{"action":"switch", <the four ROUTING_* keys>}`
 * naming a graph already served by another running engine, or `{"action":"rollback"}`.
 * It cannot carry `ROUTING_ENGINE_ALLOWED_HOSTS`: the host allowlist is startup
 * configuration and a switch file may not widen it. The file must be owned by the API's
 * own uid and not writable by group or others. A refused switch changes nothing.
 */
export async function applyRoutingSwitchFile(
  control: RoutingDeploymentSwitch,
  path: string,
): Promise<RoutingSwitchResult> {
  if (!isAbsolute(path))
    throw new RoutingConfigurationError('ROUTING_PATH_NOT_ABSOLUTE', ['ROUTING_SWITCH_FILE']);
  // O_NONBLOCK: opening a FIFO for reading would otherwise block until a writer appears,
  // before any check below could run. On a regular file it changes nothing.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    // The file points the API at an engine, so only the account running the API may write
    // it: owned by this process's uid, a regular file, and neither group- nor
    // world-writable. Checked on the open descriptor, so a swapped path cannot slip past.
    const info = await file.stat();
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== uid) throw new Error('ROUTING_SWITCH_FILE_NOT_OWNED');
    if (!info.isFile()) throw new Error('ROUTING_SWITCH_FILE_NOT_REGULAR');
    if ((info.mode & 0o022) !== 0) throw new Error('ROUTING_SWITCH_FILE_WRITABLE_BY_OTHERS');
    const buffer = Buffer.alloc(SWITCH_FILE_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SWITCH_FILE_MAX_BYTES) throw new Error('ROUTING_SWITCH_FILE_TOO_LARGE');
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const parsed = switchFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('ROUTING_SWITCH_FILE_INVALID');
  if (parsed.data.action === 'rollback') return control.rollback();
  const { action: _action, ...settings } = parsed.data;
  return control.switchTo(settings);
}

/**
 * A loggable reason for a refused switch: the error's own code (`ROUTING_SWITCH_*`,
 * `GRAPH_CONTENT_CHANGED`, `ENDPOINT_HOST_NOT_ALLOWED`, ...) and never its message, which
 * can carry paths and hashes.
 */
export function switchRefusalCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (error instanceof Error && /^ROUTING_SWITCH_FILE_[A-Z_]+$/.test(error.message))
    return error.message;
  return 'ROUTING_SWITCH_FAILED';
}
