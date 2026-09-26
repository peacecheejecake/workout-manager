/**
 * M0-06b-odbl: the ODbL distribution check for built artifacts, read-only.
 *
 *   node --import tsx scripts/check-odbl-artifacts.mts \
 *     [--basemap <deployment directory>] [--graph <graph directory>]
 *
 * For a background tile deployment (`<dist>/<deploymentId>`): every attribution names the OSM
 * copyright page and the ODbL 1.0 licence URI, and `ATTRIBUTION.txt` is exactly the rendering
 * of the deployment's own `odbl-disclosure.json` (`verifyOdblArtifacts`, the check the build
 * runs before it publishes). For a routing graph directory: the graph verifies against its
 * manifest and its `ATTRIBUTION.txt` is what the manifest and derivation render to
 * (`verifyRoutingGraphAttribution`).
 *
 * It writes nothing and prints one JSON line per artifact. The exit code is 1 when any artifact
 * fails: an artifact built before this node carries no licence URI and must be rebuilt before it
 * is distributed. This is the licence as self-hosted-map-adr.md §6 reads it, not legal review.
 */
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyRoutingGraphAttribution } from '../packages/server/integrations/src/routing/index.js';
import { verifyOdblArtifacts } from './build-basemap.mjs';

export interface OdblCheck {
  readonly artifact: 'basemap-deployment' | 'routing-graph';
  /** The directory's last path segment only: no host path leaves the check. */
  readonly name: string;
  readonly passed: boolean;
  readonly code: string | null;
}

function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
  if (typeof code === 'string') return code;
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+/.exec(message)?.[0] ?? 'CHECK_FAILED';
}

export async function checkBasemapDeployment(directory: string): Promise<OdblCheck> {
  try {
    const style = JSON.parse(await readFile(join(directory, 'style.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    await verifyOdblArtifacts(directory, style);
    return { artifact: 'basemap-deployment', name: basename(directory), passed: true, code: null };
  } catch (error) {
    return {
      artifact: 'basemap-deployment',
      name: basename(directory),
      passed: false,
      code:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'ODBL_DISCLOSURE_MISSING'
          : codeOf(error),
    };
  }
}

export async function checkRoutingGraph(directory: string): Promise<OdblCheck> {
  try {
    await verifyRoutingGraphAttribution(directory);
    return { artifact: 'routing-graph', name: basename(directory), passed: true, code: null };
  } catch (error) {
    return {
      artifact: 'routing-graph',
      name: basename(directory),
      passed: false,
      code: codeOf(error),
    };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const checks: Promise<OdblCheck>[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !['--basemap', '--graph'].includes(flag ?? '')) {
      console.log(
        'Usage: node --import tsx scripts/check-odbl-artifacts.mts [--basemap <deployment dir>] [--graph <graph dir>] ...',
      );
      process.exitCode = 2;
      return;
    }
    checks.push(
      flag === '--basemap'
        ? checkBasemapDeployment(resolve(value))
        : checkRoutingGraph(resolve(value)),
    );
  }
  const results = await Promise.all(checks);
  for (const result of results) console.log(JSON.stringify(result));
  if (results.length === 0 || results.some((result) => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
