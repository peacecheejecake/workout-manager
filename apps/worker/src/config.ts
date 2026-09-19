import { isAbsolute, parse, resolve } from 'node:path';

const ATHLETE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_ROLE = 'workout_coaching_worker';
const RESOURCE_CLEANUP_WORKER_ROLE = 'workout_resource_cleanup_worker';

export interface FixtureWorkerConfig {
  athleteId: string;
  connectionString: string;
  policy: { id: 'running-core-v2-training'; version: '1' };
  source: { kind: 'deterministic_fixture'; fixtureId: 'synthetic-v1' };
}

export interface ResourceCleanupWorkerConfig {
  connectionString: string;
  storageRoot: string;
}

function databaseUser(value: string, invalidUrlCode: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(invalidUrlCode);
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === '/' ||
    !url.username ||
    url.hash ||
    // pg connection strings let query parameters override URL credentials.
    [...url.searchParams.keys()].some((key) => key !== 'host') ||
    url.searchParams.getAll('host').length > 1
  ) {
    throw new Error(invalidUrlCode);
  }
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error(invalidUrlCode);
  }
}

/** The fixture can run only by explicit tenant dispatch with a dedicated DB role. */
export function parseFixtureWorkerConfig(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): FixtureWorkerConfig {
  if (
    (environment['NODE_ENV'] !== 'development' && environment['NODE_ENV'] !== 'test') ||
    environment['COACHING_FIXTURE_ENABLED'] !== 'true' ||
    environment['COACHING_FIXTURE_ID'] !== 'synthetic-v1'
  ) {
    throw new Error('COACHING_FIXTURE_WORKER_DISABLED');
  }
  const athleteId = args[1];
  if (
    args.length !== 2 ||
    args[0] !== '--athlete-id' ||
    !athleteId ||
    !ATHLETE_ID_PATTERN.test(athleteId)
  ) {
    throw new Error('INVALID_COACHING_WORKER_ARGUMENTS');
  }
  const connectionString = environment['COACHING_WORKER_DATABASE_URL'];
  if (
    !connectionString ||
    databaseUser(connectionString, 'INVALID_COACHING_WORKER_DATABASE_URL') !== WORKER_ROLE
  ) {
    throw new Error('INVALID_COACHING_WORKER_DATABASE_ROLE');
  }
  const apiConnectionString = environment['DATABASE_URL'];
  if (
    apiConnectionString &&
    databaseUser(apiConnectionString, 'INVALID_COACHING_WORKER_DATABASE_URL') === WORKER_ROLE
  ) {
    throw new Error('COACHING_WORKER_DATABASE_ROLE_NOT_SEPARATE');
  }
  return {
    athleteId,
    connectionString,
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  };
}

export function parseResourceCleanupWorkerConfig(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ResourceCleanupWorkerConfig {
  if (args.length !== 0) throw new Error('INVALID_RESOURCE_CLEANUP_WORKER_ARGUMENTS');
  const connectionString = environment['RESOURCE_CLEANUP_DATABASE_URL'];
  if (
    !connectionString ||
    databaseUser(connectionString, 'INVALID_RESOURCE_CLEANUP_DATABASE_URL') !==
      RESOURCE_CLEANUP_WORKER_ROLE
  ) {
    throw new Error('INVALID_RESOURCE_CLEANUP_DATABASE_ROLE');
  }
  const apiConnectionString = environment['DATABASE_URL'];
  if (
    apiConnectionString &&
    databaseUser(apiConnectionString, 'INVALID_RESOURCE_CLEANUP_API_DATABASE_URL') ===
      RESOURCE_CLEANUP_WORKER_ROLE
  ) {
    throw new Error('RESOURCE_CLEANUP_DATABASE_ROLE_NOT_SEPARATE');
  }
  const storageRoot = environment['RESOURCE_STORAGE_ROOT'];
  if (!storageRoot || storageRoot.includes('\0') || !isAbsolute(storageRoot)) {
    throw new Error('INVALID_RESOURCE_STORAGE_ROOT');
  }
  const normalizedStorageRoot = resolve(storageRoot);
  if (normalizedStorageRoot === parse(normalizedStorageRoot).root) {
    throw new Error('INVALID_RESOURCE_STORAGE_ROOT');
  }
  return { connectionString, storageRoot: normalizedStorageRoot };
}
