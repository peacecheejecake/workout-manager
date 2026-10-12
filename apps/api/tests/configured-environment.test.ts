import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredApi } from '../src/configured.js';
import { createCurrentRuntimeV9Repositories } from '../src/current-runtime-v9-repositories.js';
import { createCurrentRuntimeSourceBuildRepositoriesV1 } from '../src/current-runtime-source-build-repositories-v1.js';
import { createCurrentRuntimeSourceBuildRepositoriesV2 } from '../src/current-runtime-source-build-repositories-v2.js';
import { createCurrentRuntimeSourceBuildRepositoriesV3 } from '../src/current-runtime-source-build-repositories-v3.js';
import { createVerifiedGalleryNavigationServices } from '../src/gallery-navigation-services.js';
import { createVerifiedGalleryRenditionServices } from '../src/gallery-rendition-services.js';
import { createAiExecutionJobRepository } from '@workout/server-persistence/ai-execution-jobs';
import type * as AiExecutionJobsModule from '@workout/server-persistence/ai-execution-jobs';

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

vi.mock('../src/current-runtime-source-build-repositories-v1.js', () => ({
  createCurrentRuntimeSourceBuildRepositoriesV1: vi.fn(async () => {
    throw new Error('CURRENT_RUNTIME_SOURCE_BUILD_V1_UNAVAILABLE');
  }),
}));

vi.mock('../src/current-runtime-source-build-repositories-v2.js', () => ({
  createCurrentRuntimeSourceBuildRepositoriesV2: vi.fn(async () => {
    throw new Error('CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE');
  }),
}));

// The readiness v3 module behind this gate belongs to the proof/readiness v3 lane; the
// whole source-build v3 composition is replaced here, so nothing reaches a database.
vi.mock('../src/current-runtime-source-build-repositories-v3.js', () => ({
  createCurrentRuntimeSourceBuildRepositoriesV3: vi.fn(async () => {
    throw new Error('CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE');
  }),
}));
vi.mock('../src/gallery-navigation-services.js', () => ({
  createVerifiedGalleryNavigationServices: vi.fn(async () => {
    throw new Error('GALLERY_NAVIGATION_EXTENSION_UNAVAILABLE');
  }),
}));
vi.mock('../src/gallery-rendition-services.js', () => ({
  createVerifiedGalleryRenditionServices: vi.fn(async () => {
    throw new Error('GALLERY_RENDITION_EXTENSION_UNAVAILABLE');
  }),
}));
vi.mock('@workout/server-persistence/ai-execution-jobs', async (original) => {
  const actual = await original<typeof AiExecutionJobsModule>();
  return {
    ...actual,
    createAiExecutionJobRepository: vi.fn(() => ({ create: vi.fn(), read: vi.fn() })),
  };
});

const readyPorts = () => ({
  raceManualPublic: {},
  operations: { eraseAccount: vi.fn(), status: vi.fn(), exportAccount: vi.fn() },
  nutritionV4Writer: {},
  nutritionV4Preview: {},
  raceResultsV2: {},
});
const galleryNavigation = () => ({
  navigate: vi.fn(),
  listAlbums: vi.fn(),
  createAlbum: vi.fn(),
  renameAlbum: vi.fn(),
  deleteAlbum: vi.fn(),
  updateMembership: vi.fn(),
});

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
    'WORKOUT_GALLERY_NAVIGATION',
    'WORKOUT_GALLERY_RENDITIONS',
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
      expect(createCurrentRuntimeSourceBuildRepositoriesV1).not.toHaveBeenCalled();
      expect(createCurrentRuntimeSourceBuildRepositoriesV2).not.toHaveBeenCalled();
      expect(createCurrentRuntimeSourceBuildRepositoriesV3).not.toHaveBeenCalled();
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
  it('selects the named profile27 gate explicitly and refuses startup without readiness', async () => {
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile27');
    await expect(createConfiguredApi(process.env)).rejects.toThrow(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE',
    );
    expect(createCurrentRuntimeSourceBuildRepositoriesV3).toHaveBeenCalledTimes(1);
    expect(createCurrentRuntimeSourceBuildRepositoriesV2).not.toHaveBeenCalled();
    expect(createCurrentRuntimeSourceBuildRepositoriesV1).not.toHaveBeenCalled();
    expect(createCurrentRuntimeV9Repositories).not.toHaveBeenCalled();
    // The gallery and AI job ports are never composed before readiness passed.
    expect(createVerifiedGalleryNavigationServices).not.toHaveBeenCalled();
    expect(createVerifiedGalleryRenditionServices).not.toHaveBeenCalled();
    expect(createAiExecutionJobRepository).not.toHaveBeenCalled();
  });
  it('refuses profile27 startup when the gallery navigation installation is not verified', async () => {
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile27');
    vi.mocked(createCurrentRuntimeSourceBuildRepositoriesV3).mockResolvedValueOnce(
      readyPorts() as never,
    );
    await expect(createConfiguredApi(process.env)).rejects.toThrow(
      'GALLERY_NAVIGATION_EXTENSION_UNAVAILABLE',
    );
    expect(createVerifiedGalleryNavigationServices).toHaveBeenCalledTimes(1);
    expect(createVerifiedGalleryRenditionServices).not.toHaveBeenCalled();
  });
  it('refuses profile27 startup when the gallery rendition installation is not verified', async () => {
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile27');
    vi.mocked(createCurrentRuntimeSourceBuildRepositoriesV3).mockResolvedValueOnce(
      readyPorts() as never,
    );
    vi.mocked(createVerifiedGalleryNavigationServices).mockResolvedValueOnce(galleryNavigation());
    await expect(createConfiguredApi(process.env)).rejects.toThrow(
      'GALLERY_RENDITION_EXTENSION_UNAVAILABLE',
    );
    expect(createVerifiedGalleryRenditionServices).toHaveBeenCalledTimes(1);
  });
  it('profile27 always registers gallery navigation, renditions and AI execution jobs', async () => {
    // U3: no WORKOUT_GALLERY_* flag exists; a retired flag neither enables nor disables.
    vi.stubEnv('WORKOUT_GALLERY_NAVIGATION', 'off');
    vi.stubEnv('WORKOUT_GALLERY_RENDITIONS', 'off');
    vi.stubEnv('WORKOUT_RUNTIME_PROFILE', 'installed-current-profile27');
    vi.mocked(createCurrentRuntimeSourceBuildRepositoriesV3).mockResolvedValueOnce(
      readyPorts() as never,
    );
    vi.mocked(createVerifiedGalleryNavigationServices).mockResolvedValueOnce(galleryNavigation());
    vi.mocked(createVerifiedGalleryRenditionServices).mockResolvedValueOnce({
      reader: { list: vi.fn(), readContent: vi.fn() },
      storage: { open: vi.fn() },
    } as never);
    const app = await createConfiguredApi(process.env);
    try {
      expect(createVerifiedGalleryRenditionServices).toHaveBeenCalledExactlyOnceWith(
        vi.mocked(createVerifiedGalleryNavigationServices).mock.calls[0]?.[0],
        expect.objectContaining({ open: expect.any(Function) }),
      );
      expect(createAiExecutionJobRepository).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        policy: { id: 'running-core-v2-training', version: '1' },
        registry: [],
      });
      for (const [method, url] of [
        ['GET', '/bff/v1/gallery/albums'],
        ['GET', '/bff/v1/gallery/media/navigation'],
        ['GET', '/bff/v1/gallery/media/:mediaItemId/renditions'],
        ['POST', '/bff/v1/coaching-threads/:threadId/ai-execution-jobs'],
        ['GET', '/bff/v1/ai-execution-jobs/:jobId'],
        ['GET', '/bff/v1/check-in-templates'],
        ['POST', '/bff/v1/operations/export'],
      ] as const)
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    } finally {
      await app.close();
    }
  });
  it('baseline107 registers no gallery navigation, rendition or AI execution job route', async () => {
    const app = await createConfiguredApi(process.env);
    try {
      for (const [method, url] of [
        ['GET', '/bff/v1/gallery/albums'],
        ['GET', '/bff/v1/gallery/media/navigation'],
        ['GET', '/bff/v1/gallery/media/:mediaItemId/renditions'],
        ['POST', '/bff/v1/coaching-threads/:threadId/ai-execution-jobs'],
        ['GET', '/bff/v1/ai-execution-jobs/:jobId'],
        ['GET', '/bff/v1/check-in-templates'],
      ] as const)
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      expect(app.hasRoute({ method: 'POST', url: '/bff/v1/operations/export' })).toBe(true);
      expect(createVerifiedGalleryNavigationServices).not.toHaveBeenCalled();
      expect(createVerifiedGalleryRenditionServices).not.toHaveBeenCalled();
      expect(createAiExecutionJobRepository).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  // U6: the retired profile26 name is an unknown profile now, like profile25 before it. It
  // is refused at environment parse, so no v1, v2 or v3 gate is ever selected.
  it.each([
    'installed-current-profile25',
    'installed-current-profile26',
    'installed-current-profile28',
    'Installed-Current-Profile27',
    ' installed-current-profile27',
  ])(
    'refuses retired or unknown runtime profile %s before selecting a repository',
    async (profile) => {
      vi.stubEnv('WORKOUT_RUNTIME_PROFILE', profile);
      await expect(createConfiguredApi(process.env)).rejects.toThrow();
      expect(createCurrentRuntimeV9Repositories).not.toHaveBeenCalled();
      expect(createCurrentRuntimeSourceBuildRepositoriesV1).not.toHaveBeenCalled();
      expect(createCurrentRuntimeSourceBuildRepositoriesV2).not.toHaveBeenCalled();
      expect(createCurrentRuntimeSourceBuildRepositoriesV3).not.toHaveBeenCalled();
    },
  );
});
