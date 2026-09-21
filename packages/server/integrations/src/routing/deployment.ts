import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { RoutingEngineEndpoint } from './endpoint.js';
import {
  GraphManifestError,
  graphBuildIdFromManifest,
  loadVerifiedRoutingGraph,
  type RoutingGraphManifest,
} from './graph-manifest.js';
import { createFetchRoutingTransport, type RoutingEngineTransport } from './transport.js';

/**
 * One immutable routing deployment: a verified graph, the engine artifact and profile
 * configuration that graph was built from, and the endpoint they are served on.
 *
 * The point of this class is that an UNVERIFIED identity cannot be constructed, and that
 * it is a runtime property rather than a typing convention. Two earlier attempts were not:
 * a `PinnedGraph` interface anyone could fill in, and then a `private constructor` plus a
 * `fromVerifiedParts` static marked "not public API" in a comment. The second was worse
 * than useless — the static was callable from any TypeScript file, and a comment restricts
 * nothing at runtime.
 *
 * What holds now:
 *
 * - The constructor demands {@link constructionKey}, a module-private symbol that is never
 *   exported. `new RoutingDeployment(...)` from outside this module throws, including
 *   through `as any`, because the check is a value comparison and survives type erasure.
 * - Every instance the constructor produces is registered in a module-private `WeakSet`,
 *   and {@link assertVerifiedDeployment} checks membership through a module-private
 *   predicate, so no public member sits on the trust path. Guarding construction alone
 *   was not enough: a plain object with the same public fields satisfied the type and was
 *   accepted by the adapter, which then reported a route under a hash nothing had checked.
 *   Consumption is now guarded too, at the adapter's entry point.
 * - A private field makes the class nominal, so a structurally identical object literal
 *   is rejected by the compiler as well as at runtime. Its value is unrelated to the
 *   construction key, because a guard is only as good as the reachability of what it
 *   trusts: nothing on a valid instance may be usable to construct another one.
 * - The manifest is stored as a frozen copy. Verification reads bytes at one instant; if
 *   the object it produced could be edited afterwards, the hash the adapter records would
 *   be whatever someone last wrote, not what was checked.
 * - The instance itself is frozen, so its fields cannot be swapped after construction.
 *
 * Identity here is proved, not asserted.
 */
const constructionKey = Symbol('routing-deployment-construction');

const verifiedDeployments = new WeakSet<RoutingDeployment>();
/**
 * Captured at module load so the trust path does not read a mutable global at call time.
 * Bounded honestly: if something runs before this module initialises, nothing here helps.
 */
const weakSetHas = WeakSet.prototype.has;

/**
 * The trust path, module-private and unreachable from outside. Nothing public may sit on
 * it: `assertVerifiedDeployment` used to call the public `RoutingDeployment.isVerified`
 * static, and assigning `RoutingDeployment.isVerified = () => true` through the ordinary
 * public API was enough to get a forged object accepted by the adapter.
 */
function isRegisteredDeployment(candidate: unknown): candidate is RoutingDeployment {
  return (
    candidate instanceof RoutingDeployment &&
    weakSetHas.call(verifiedDeployments, candidate as object)
  );
}

export class RoutingDeployment {
  /**
   * Nominal typing only. Deliberately a value with no relationship to
   * {@link constructionKey}: an earlier version stored the key here and exposed it
   * through a getter added to satisfy a lint rule, which let a caller read the key off any
   * valid instance and construct a forged deployment that the constructor then registered
   * as verified. Nothing the guard depends on may be reachable from an instance.
   */
  readonly #nominal = true;
  readonly manifest: RoutingGraphManifest;
  readonly graphBuildId: string;
  readonly graphDirectory: string;
  readonly endpoint: RoutingEngineEndpoint;
  readonly transport: RoutingEngineTransport;

  constructor(
    key: symbol,
    manifest: RoutingGraphManifest,
    graphDirectory: string,
    endpoint: RoutingEngineEndpoint,
    transport: RoutingEngineTransport,
  ) {
    if (key !== constructionKey)
      throw new GraphManifestError(
        'DEPLOYMENT_NOT_VERIFIED',
        'A RoutingDeployment can only be produced by loadRoutingDeployment, which verifies the graph, engine artifact and profile configuration on disk.',
      );
    void this.#nominal;
    // A frozen copy: later edits to the caller's manifest cannot change what was verified.
    this.manifest = Object.freeze({ ...manifest });
    this.graphBuildId = graphBuildIdFromManifest(this.manifest);
    this.graphDirectory = graphDirectory;
    this.endpoint = endpoint;
    this.transport = transport;
    Object.freeze(this);
    verifiedDeployments.add(this);
  }

  /**
   * Convenience predicate for callers. It delegates to the module-private check and is
   * NOT on the trust path — replacing it changes nothing about what is accepted. The
   * class and its prototype are frozen below, so it cannot be replaced anyway.
   */
  static isVerified(candidate: unknown): candidate is RoutingDeployment {
    return isRegisteredDeployment(candidate);
  }
}

// Defence in depth: with the class frozen, assigning or redefining a static throws in
// strict mode instead of quietly swapping a member out.
Object.freeze(RoutingDeployment);
Object.freeze(RoutingDeployment.prototype);

/**
 * Gate for anything that consumes a deployment. A value that merely has the right shape
 * is refused: the WeakSet holds only instances this module built from verified files.
 *
 * It consults {@link isRegisteredDeployment} directly. No public member sits between this
 * check and the WeakSet, so there is nothing on the trust path a caller can replace.
 */
export function assertVerifiedDeployment(candidate: unknown): RoutingDeployment {
  if (!isRegisteredDeployment(candidate))
    throw new GraphManifestError(
      'DEPLOYMENT_NOT_VERIFIED',
      'This value was not produced by loadRoutingDeployment, so nothing has checked the graph, engine artifact or profile configuration it claims.',
    );
  return candidate;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface LoadRoutingDeploymentOptions {
  readonly graphDirectory: string;
  /** The engine jar this deployment will actually run. */
  readonly engineArtifactPath: string;
  /** The profile configuration this deployment will actually start the engine with. */
  readonly profileConfigPath: string;
  readonly endpoint: RoutingEngineEndpoint;
  /** Seam for tests; production uses the real fetch transport bound to `endpoint`. */
  readonly transportFactory?: (endpoint: RoutingEngineEndpoint) => RoutingEngineTransport;
}

/**
 * Verify a deployment against the files on disk, then bind it to its endpoint.
 *
 * Three things are checked, because the manifest only means something if all three hold:
 * the graph files still hash to what the manifest recorded, the engine artifact on disk
 * is the one that built it, and the profile configuration on disk is the one it was built
 * with. Verifying the graph directory alone would leave the jar and the profile free to
 * change underneath a graph that still verifies.
 */
export async function loadRoutingDeployment(
  options: LoadRoutingDeploymentOptions,
): Promise<RoutingDeployment> {
  const verified = await loadVerifiedRoutingGraph(options.graphDirectory);
  const engineArtifactSha256 = await sha256File(options.engineArtifactPath);
  if (engineArtifactSha256 !== verified.manifest.engineArtifactSha256)
    throw new GraphManifestError(
      'ENGINE_ARTIFACT_MISMATCH',
      `manifest ${verified.manifest.engineArtifactSha256.slice(0, 12)} but ${options.engineArtifactPath} is ${engineArtifactSha256.slice(0, 12)}`,
    );
  const profileConfigSha256 = await sha256File(options.profileConfigPath);
  if (profileConfigSha256 !== verified.manifest.profileConfigSha256)
    throw new GraphManifestError(
      'PROFILE_CONFIG_MISMATCH',
      `manifest ${verified.manifest.profileConfigSha256.slice(0, 12)} but ${options.profileConfigPath} is ${profileConfigSha256.slice(0, 12)}`,
    );
  const transport = (options.transportFactory ?? createFetchRoutingTransport)(options.endpoint);
  return new RoutingDeployment(
    constructionKey,
    verified.manifest,
    verified.graphDirectory,
    options.endpoint,
    transport,
  );
}
