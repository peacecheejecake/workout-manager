import type * as GarminUnofficialModule from '@workout/server-integrations/garmin-unofficial-service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createConfiguredApi } from '../src/configured.js';

const fixture = vi.hoisted(() => {
  const callbacks: {
    oidcHook?: (event: object) => void;
    routingHook?: (event: object) => void;
    garminHook?: (event: object) => void;
    sensitive: string;
  } = { sensitive: 'PRIVATE_HEALTH_PROVIDER_SECRET' };
  return callbacks;
});
vi.mock('@workout/server-identity/oidc', () => ({
  createOidcProvider: vi.fn(
    async (_input: unknown, hooks: { onEvent: (event: object) => void }) => {
      fixture.oidcHook = hooks.onEvent;
      hooks.onEvent({ event: 'oidc_discovery_failed', reason: 'network', body: fixture.sensitive });
      return { authorizationUrl: vi.fn(), exchange: vi.fn() };
    },
  ),
}));
vi.mock('../src/routing-admission.js', () => ({
  ROUTING_PERMIT_LEASE_MILLISECONDS: 30000,
  createConfiguredRoutingAdmission: vi.fn(
    (_database: unknown, _environment: unknown, hooks: { onRefusal: (event: object) => void }) => {
      fixture.routingHook = hooks.onRefusal;
      hooks.onRefusal({
        reason: 'limiter_unavailable',
        engineInFlight: null,
        engineConcurrency: 2,
        raw: fixture.sensitive,
      });
      return { engineConcurrency: 2, tryAcquire: vi.fn(), drain: vi.fn(async () => undefined) };
    },
  ),
}));
vi.mock('../src/routing-deployment.js', () => ({
  createConfiguredWalkingRoutes: vi.fn(async () => null),
}));
vi.mock('../src/garmin-unofficial-deployment.js', () => ({
  configuredGarminUnofficial: vi.fn(() => ({
    ownerAthleteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    python: '/unused-python',
    cipher: {},
    profilePin: {},
  })),
}));
vi.mock('@workout/server-integrations/garmin-unofficial-worker', () => ({
  createGarminUnofficialWorker: vi.fn(() => ({})),
}));
vi.mock('@workout/server-integrations/garmin-unofficial-service', async (importOriginal) => {
  const actual = await importOriginal<typeof GarminUnofficialModule>();
  return {
    GarminUnofficialError: actual.GarminUnofficialError,
    createGarminUnofficialService: vi.fn((options: { onEvent: (event: object) => void }) => {
      fixture.garminHook = options.onEvent;
      return {
        start: () =>
          options.onEvent({ event: 'garmin_unofficial_connected', raw: fixture.sensitive }),
        close: vi.fn(async () => undefined),
        isOwner: vi.fn(() => true),
      };
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  delete fixture.oidcHook;
  delete fixture.routingHook;
  delete fixture.garminHook;
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordSchema = z.record(z.string(), z.unknown());
function records(text: string) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => recordSchema.parse(JSON.parse(line)));
}
async function environment(release?: string) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'workout-configured-log-'));
  directories.push(storageRoot);
  return {
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://runtime:${fixture.sensitive}@127.0.0.1:1/workout`,
    PUBLIC_ORIGIN: 'http://127.0.0.1:4301',
    OIDC_ISSUER: `http://127.0.0.1:4302/${fixture.sensitive}`,
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: fixture.sensitive,
    ALLOW_INSECURE_LOCALHOST: 'true',
    PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot,
    ...(release === undefined ? {} : { WORKOUT_RELEASE: release }),
  };
}
function captureStream(write: (text: string) => void) {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      write(chunk.toString());
      done();
    },
  });
}

describe('configured API instance log context', () => {
  it.each(['log-release-42', undefined])(
    'correlates safe bootstrap and background logs with release %s',
    async (release) => {
      let early = '';
      let logged = '';
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        early += String(chunk);
        return true;
      });
      const app = await createConfiguredApi(await environment(release), {
        logStream: captureStream((text) => {
          logged += text;
        }),
      });
      try {
        stderr.mockRestore();
        const expectedVersion = release ?? 'unreleased';
        const bootstrap = records(early);
        expect(bootstrap).toHaveLength(2);
        const runId = z.string().regex(uuid).parse(bootstrap[0]?.['runId']);
        for (const line of bootstrap) {
          expect(line['runId']).toBe(runId);
          expect(line['version']).toBe(expectedVersion);
        }
        expect(bootstrap[0]).toEqual({
          event: 'oidc_discovery_failed',
          reason: 'network',
          runId,
          version: expectedVersion,
        });
        expect(bootstrap[1]).toEqual({
          event: 'routing_admission_refused',
          reason: 'limiter_unavailable',
          engineInFlight: null,
          engineConcurrency: 2,
          runId,
          version: expectedVersion,
        });
        fixture.oidcHook?.({
          event: 'oidc_discovery_failed',
          reason: 'issuer_mismatch',
          error: new Error(fixture.sensitive),
          body: fixture.sensitive,
        });
        fixture.oidcHook?.({ event: 'oidc_discovery_failed', reason: fixture.sensitive });
        fixture.routingHook?.({
          reason: 'engine_capacity',
          engineInFlight: 2,
          engineConcurrency: 2,
          coordinates: fixture.sensitive,
        });
        fixture.routingHook?.({
          reason: fixture.sensitive,
          engineInFlight: null,
          engineConcurrency: 2,
        });
        fixture.garminHook?.({
          event: 'garmin_collection_activity_failed',
          code: fixture.sensitive,
          health: fixture.sensitive,
        });
        fixture.garminHook?.({
          event: 'garmin_collection_failed',
          code: 'WORKER_TIMEOUT',
          token: fixture.sensitive,
        });
        fixture.garminHook?.({ event: fixture.sensitive, code: fixture.sensitive });
        const background = records(logged);
        expect(background.map((line) => line['event'])).toEqual([
          'garmin_unofficial_enabled',
          'garmin_unofficial_connected',
          'oidc_discovery_failed',
          'oidc_event_refused',
          'routing_admission_refused',
          'routing_admission_event_refused',
          'garmin_collection_activity_failed',
          'garmin_collection_failed',
          'garmin_unofficial_event_refused',
        ]);
        for (const line of background) {
          expect(line['runId']).toBe(runId);
          expect(line['version']).toBe(expectedVersion);
          expect(line['reqId']).toBeUndefined();
          expect(line['pid']).toBe(process.pid);
          expect(line['hostname']).toEqual(expect.any(String));
        }
        expect(
          background.find((line) => line['event'] === 'garmin_collection_activity_failed')?.[
            'code'
          ],
        ).toBe('other');
        expect(
          background.find((line) => line['event'] === 'garmin_collection_failed')?.['code'],
        ).toBe('WORKER_TIMEOUT');
        const response = await app.inject({
          method: 'POST',
          url: `/missing?health=${fixture.sensitive}`,
          headers: {
            authorization: `Bearer ${fixture.sensitive}`,
            'content-type': 'application/json',
          },
          payload: { health: fixture.sensitive },
        });
        expect(response.statusCode).toBe(404);
        const request = records(logged).find((line) => line['event'] === 'request_completed');
        expect(request?.['reqId']).toEqual(expect.stringMatching(uuid));
        expect(request?.['reqId']).not.toBe(runId);
        expect(request?.['runId']).toBeUndefined();
        expect(request?.['version']).toBe(expectedVersion);
        const invalid = await app.inject({
          method: 'GET',
          url: `/bff/v1/auth/login?health=${fixture.sensitive}`,
          headers: { authorization: `Bearer ${fixture.sensitive}` },
        });
        expect(invalid.statusCode).toBe(400);
        const failed = records(logged).find((line) => line['event'] === 'request_failed');
        expect(failed?.['reqId']).toEqual(expect.stringMatching(uuid));
        expect(failed?.['version']).toBe(expectedVersion);
        expect(failed?.['runId']).toBeUndefined();
        expect(failed?.['code']).toBe('INVALID_REQUEST');

        expect(`${early}${logged}`).not.toContain(fixture.sensitive);
        expect(`${early}${logged}`).not.toContain('Bearer');
        expect(`${early}${logged}`).not.toContain('postgres://');
      } finally {
        await app.close();
      }
    },
  );

  it('uses distinct instance IDs and rejects an unsafe release before emitting logs', async () => {
    let early = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      early += String(chunk);
      return true;
    });
    const first = await createConfiguredApi(await environment(), {
      logStream: captureStream(() => undefined),
    });
    await first.close();
    const firstId = records(early)[0]?.['runId'];
    early = '';
    const second = await createConfiguredApi(await environment(), {
      logStream: captureStream(() => undefined),
    });
    await second.close();
    const secondId = records(early)[0]?.['runId'];
    expect(firstId).toEqual(expect.stringMatching(uuid));
    expect(secondId).toEqual(expect.stringMatching(uuid));
    expect(firstId).not.toBe(secondId);
    early = '';
    for (const release of [`secret ${fixture.sensitive}`, 'x'.repeat(65), '-invalid']) {
      await expect(createConfiguredApi(await environment(release))).rejects.toThrow();
    }
    expect(early).toBe('');
  });
});
