import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredApi } from '../src/configured.js';
import { createCurrentRuntimeV9Repositories } from '../src/current-runtime-v9-repositories.js';

// Startup OIDC discovery is a network call; this test is about what the entrypoint hands the
// factory, so the provider is replaced and nothing here reaches the network or a database.
vi.mock('@workout/server-identity/oidc', () => ({
  createOidcProvider: vi.fn(async () => ({
    authorizationUrl: vi.fn(),
    exchange: vi.fn(),
  })),
}));
vi.mock('../src/current-runtime-v9-repositories.js', () => ({
  createCurrentRuntimeV9Repositories: vi.fn(async () => {
    throw new Error('CURRENT_RUNTIME_V9_UNAVAILABLE');
  }),
}));

let storageRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  storageRoot = await mkdtemp(join(tmpdir(), 'workout-configured-env-'));
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DATABASE_URL', 'postgres://runtime:secret@127.0.0.1:1/workout');
  vi.stubEnv('PUBLIC_ORIGIN', 'http://127.0.0.1:4301');
  vi.stubEnv('OIDC_ISSUER', 'http://127.0.0.1:4302');
  vi.stubEnv('OIDC_CLIENT_ID', 'client');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'secret');
  vi.stubEnv('ALLOW_INSECURE_LOCALHOST', 'true');
  vi.stubEnv('PRIVATE_RESOURCE_STORAGE_ROOT', storageRoot);
  for (const key of [
    'COACHING_FIXTURE_ENABLED',
    'COACHING_FIXTURE_ID',
    'GARMIN_CLIENT_ID',
    'GARMIN_CLIENT_SECRET',
    'GARMIN_TOKEN_KEY_ID',
    'GARMIN_TOKEN_KEYS_JSON',
    'GEO_DATA_DIR',
    'ROUTING_ENGINE_URL',
    'ROUTING_GRAPH_DIRECTORY',
    'ROUTING_ENGINE_ARTIFACT',
    'ROUTING_PROFILE_CONFIG',
    'ROUTING_ENGINE_ALLOWED_HOSTS',
    'WORKOUT_RELEASE',
    'WORKOUT_RUNTIME_PROFILE',
  ])
    vi.stubEnv(key, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('createConfiguredApi given the real process environment (M2-01aa)', () => {
  it('accepts process.env itself, whose prototype is not Object.prototype', async () => {
    // start.ts passes this exact object. It is not a plain object, which a zod record refuses.
    expect(Object.getPrototypeOf(process.env)).not.toBe(Object.prototype);
    const app = await createConfiguredApi(process.env);
    try {
      expect(createCurrentRuntimeV9Repositories).not.toHaveBeenCalled();
      expect((await app.inject('/health')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('still reads and validates routing settings from process.env', async () => {
    // An allowlist on its own is a half-finished routing configuration and must refuse to
    // start; normalising the environment must not drop the values it carries.
    vi.stubEnv('ROUTING_ENGINE_ALLOWED_HOSTS', '127.0.0.1');
    await expect(createConfiguredApi(process.env)).rejects.toThrow(
      'ROUTING_CONFIGURATION_INCOMPLETE',
    );
  });

  it('starts with a bounded release name and refuses anything else (M2-01k-c2)', async () => {
    vi.stubEnv('WORKOUT_RELEASE', '2026.09.24+abc1234');
    const app = await createConfiguredApi(process.env);
    await app.close();
    // The release is written into every log line, so it may hold nothing but a name.
    vi.stubEnv('WORKOUT_RELEASE', 'token=secret value');
    await expect(createConfiguredApi(process.env)).rejects.toThrow();
  });
  it('selects the named profile25 gate explicitly and refuses startup without readiness', async () => {
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile25');
    await expect(createConfiguredApi(process.env)).rejects.toThrow(
      'CURRENT_RUNTIME_V9_UNAVAILABLE',
    );
    expect(createCurrentRuntimeV9Repositories).toHaveBeenCalledTimes(1);
  });
  it('refuses unknown runtime profiles before selecting a repository', async () => {
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile26');
    await expect(createConfiguredApi(process.env)).rejects.toThrow();
    expect(createCurrentRuntimeV9Repositories).not.toHaveBeenCalled();
  });
});
