import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExactHostAllowlist } from '@workout/server-resource-ingestion';

import { runUrlIngestionWorker } from './url-ingestion-worker.js';

const WORKER_ROLE = 'workout_resource_ingestion_worker';

export interface ResourceUrlIngestionWorkerConfig {
  connectionString: string;
  storageRoot: string;
  allowedHosts: readonly string[];
}

function databaseUser(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === '/' ||
    !url.username ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'host') ||
    url.searchParams.getAll('host').length > 1
  )
    throw new Error(code);
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error(code);
  }
}

export function parseResourceUrlIngestionWorkerConfig(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ResourceUrlIngestionWorkerConfig {
  if (args.length !== 0) throw new Error('INVALID_RESOURCE_URL_INGESTION_WORKER_ARGUMENTS');
  const connectionString = environment['RESOURCE_URL_INGESTION_DATABASE_URL'];
  if (
    !connectionString ||
    databaseUser(connectionString, 'INVALID_RESOURCE_URL_INGESTION_DATABASE_URL') !== WORKER_ROLE
  )
    throw new Error('INVALID_RESOURCE_URL_INGESTION_DATABASE_ROLE');
  const apiConnectionString = environment['DATABASE_URL'];
  if (
    apiConnectionString &&
    databaseUser(apiConnectionString, 'INVALID_RESOURCE_URL_INGESTION_API_DATABASE_URL') ===
      WORKER_ROLE
  )
    throw new Error('RESOURCE_URL_INGESTION_DATABASE_ROLE_NOT_SEPARATE');
  const rawStorageRoot = environment['RESOURCE_STORAGE_ROOT'];
  if (!rawStorageRoot || rawStorageRoot.includes('\0') || !isAbsolute(rawStorageRoot))
    throw new Error('INVALID_RESOURCE_STORAGE_ROOT');
  const storageRoot = resolve(rawStorageRoot);
  if (storageRoot === parse(storageRoot).root) throw new Error('INVALID_RESOURCE_STORAGE_ROOT');
  const rawAllowedHosts = environment['RESOURCE_URL_ALLOWED_HOSTS'];
  if (!rawAllowedHosts) throw new Error('INVALID_RESOURCE_URL_ALLOWED_HOSTS');
  const hostTokens = rawAllowedHosts.split(',');
  if (hostTokens.some((host) => !host || host !== host.trim()))
    throw new Error('INVALID_RESOURCE_URL_ALLOWED_HOSTS');
  let allowedHosts: readonly string[];
  try {
    allowedHosts = [...createExactHostAllowlist(hostTokens)];
  } catch {
    throw new Error('INVALID_RESOURCE_URL_ALLOWED_HOSTS');
  }
  return { connectionString, storageRoot, allowedHosts };
}

async function main(): Promise<void> {
  const config = parseResourceUrlIngestionWorkerConfig(process.argv.slice(2), process.env);
  const result = await runUrlIngestionWorker(config);
  process.stdout.write(`${JSON.stringify({ kind: 'resource_url_ingestion_result', result })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // Do not expose URLs, credentials, IPs, object refs, SQL, or fetched content.
    process.stderr.write('RESOURCE_URL_INGESTION_FAILED\n');
    process.exitCode = 1;
  }
}
