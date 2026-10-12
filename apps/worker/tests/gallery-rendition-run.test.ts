import { describe, expect, it, vi } from 'vitest';

import {
  parseGalleryRenditionWorkerConfig,
  type GalleryRenditionWorkerConfig,
} from '../src/config.js';
import {
  GALLERY_RENDITION_JOBS_PER_RUN,
  runGalleryRenditionWorker,
  type GalleryRenditionRunConnection,
  type GalleryRenditionRunEvent,
} from '../src/gallery-rendition-run.js';

const enabled = {
  GALLERY_RENDITION_DATABASE_URL:
    'postgres://workout_gallery_rendition_worker:secret@127.0.0.1/workout',
  DATABASE_URL: 'postgres://workout_api:secret@127.0.0.1/workout',
  RESOURCE_STORAGE_ROOT: '/var/lib/workout/objects/',
  GALLERY_RENDITION_FFMPEG_PATH: '/opt/ffmpeg/bin/ffmpeg',
  GALLERY_RENDITION_FFPROBE_PATH: '/opt/ffmpeg/bin/ffprobe',
};

describe('gallery rendition worker configuration', () => {
  it('has no deployment switch: the retired gallery flag neither enables nor disables it', () => {
    // Renditions are a mandatory profile27 member (U3); the worker role probe gates each run.
    for (const WORKOUT_GALLERY_RENDITIONS of [undefined, 'off', 'installed-extension-v1'])
      expect(
        parseGalleryRenditionWorkerConfig([], { ...enabled, WORKOUT_GALLERY_RENDITIONS })
          .connectionString,
      ).toBe(enabled.GALLERY_RENDITION_DATABASE_URL);
  });

  it('accepts its own role with absolute binaries and normalises paths', () => {
    expect(parseGalleryRenditionWorkerConfig([], enabled)).toEqual({
      connectionString: enabled.GALLERY_RENDITION_DATABASE_URL,
      storageRoot: '/var/lib/workout/objects',
      ffmpegPath: '/opt/ffmpeg/bin/ffmpeg',
      ffprobePath: '/opt/ffmpeg/bin/ffprobe',
      scratchRoot: null,
      release: 'unreleased',
    });
    expect(
      parseGalleryRenditionWorkerConfig([], {
        ...enabled,
        GALLERY_RENDITION_SCRATCH_ROOT: '/var/tmp/wm-codec',
      }).scratchRoot,
    ).toBe('/var/tmp/wm-codec');
  });

  it('refuses any other role, a shared API role, arguments and relative or root paths', () => {
    expect(() => parseGalleryRenditionWorkerConfig(['--all'], enabled)).toThrow(
      'INVALID_GALLERY_RENDITION_WORKER_ARGUMENTS',
    );
    expect(() =>
      parseGalleryRenditionWorkerConfig([], {
        ...enabled,
        GALLERY_RENDITION_DATABASE_URL: 'postgres://workout_api:secret@127.0.0.1/workout',
      }),
    ).toThrow('INVALID_GALLERY_RENDITION_DATABASE_ROLE');
    expect(() =>
      parseGalleryRenditionWorkerConfig([], {
        ...enabled,
        GALLERY_RENDITION_DATABASE_URL: `${enabled.GALLERY_RENDITION_DATABASE_URL}?user=workout_owner`,
      }),
    ).toThrow('INVALID_GALLERY_RENDITION_DATABASE_URL');
    expect(() =>
      parseGalleryRenditionWorkerConfig([], {
        ...enabled,
        DATABASE_URL: enabled.GALLERY_RENDITION_DATABASE_URL,
      }),
    ).toThrow('GALLERY_RENDITION_DATABASE_ROLE_NOT_SEPARATE');
    for (const [key, code] of [
      ['RESOURCE_STORAGE_ROOT', 'INVALID_RESOURCE_STORAGE_ROOT'],
      ['GALLERY_RENDITION_FFMPEG_PATH', 'INVALID_GALLERY_RENDITION_FFMPEG_PATH'],
      ['GALLERY_RENDITION_FFPROBE_PATH', 'INVALID_GALLERY_RENDITION_FFPROBE_PATH'],
      ['GALLERY_RENDITION_SCRATCH_ROOT', 'INVALID_GALLERY_RENDITION_SCRATCH_ROOT'],
    ] as const)
      for (const value of ['relative/path', '/', '/x\0y'])
        expect(() => parseGalleryRenditionWorkerConfig([], { ...enabled, [key]: value })).toThrow(
          code,
        );
  });
});

const config: GalleryRenditionWorkerConfig = {
  connectionString: 'postgres://workout_gallery_rendition_worker@127.0.0.1/workout',
  storageRoot: '/var/lib/workout/objects',
  ffmpegPath: '/opt/ffmpeg/bin/ffmpeg',
  ffprobePath: '/opt/ffmpeg/bin/ffprobe',
  scratchRoot: null,
  release: 'synthetic-release',
};

function fakeConnection(
  probe: 'available' | 'unavailable',
  store: Partial<GalleryRenditionRunConnection['store']> = {},
) {
  const end = vi.fn(async () => undefined);
  const connection: GalleryRenditionRunConnection = {
    probe: async () => probe,
    store: {
      claim: vi.fn(async () => null),
      settle: vi.fn(),
      release: vi.fn(),
      claimSweep: vi.fn(async () => null),
      finishSweep: vi.fn(),
      ...store,
    } as GalleryRenditionRunConnection['store'],
    end,
  };
  return { connection, end };
}
const storage = vi.fn(async () => {
  throw new Error('storage_not_expected');
});

describe('bounded gallery rendition run', () => {
  it('fails closed without touching storage or the codec when the worker probe fails', async () => {
    const { connection, end } = fakeConnection('unavailable');
    const events: GalleryRenditionRunEvent[] = [];
    const createCodec = vi.fn();
    const event = await runGalleryRenditionWorker(config, {
      connect: () => connection,
      checkBinaries: async () => true,
      createStorage: storage,
      createCodec,
      logger: (value) => events.push(value),
    });
    expect(event).toMatchObject({ result: 'unavailable', jobs: {}, sweep: 'not_run' });
    expect(events).toEqual([event]);
    expect(storage).not.toHaveBeenCalled();
    expect(createCodec).not.toHaveBeenCalled();
    expect(connection.store.claim).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('runs until no job is due, then one sweep, and logs only finite fields', async () => {
    const { connection, end } = fakeConnection('available');
    const listScopeObjects = vi.fn(async () => ({ keys: [], truncated: false }));
    const events: GalleryRenditionRunEvent[] = [];
    const event = await runGalleryRenditionWorker(config, {
      connect: () => connection,
      checkBinaries: async () => true,
      createStorage: async () => ({ listScopeObjects }) as never,
      createCodec: () => ({ render: vi.fn() }) as never,
      logger: (value) => events.push(value),
    });
    expect(event).toEqual({
      event: 'gallery_rendition_run_finished',
      result: 'completed',
      jobs: {},
      sweep: 'no_sweep',
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: 'synthetic-release',
    });
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(
      ['event', 'jobs', 'result', 'runId', 'sweep', 'version'].sort(),
    );
    expect(connection.store.claim).toHaveBeenCalledTimes(1);
    expect(connection.store.claimSweep).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(GALLERY_RENDITION_JOBS_PER_RUN).toBe(10);
  });

  it('does not start work after shutdown was requested', async () => {
    const { connection } = fakeConnection('available');
    const controller = new AbortController();
    controller.abort();
    const event = await runGalleryRenditionWorker(config, {
      connect: () => connection,
      checkBinaries: async () => true,
      createStorage: async () => ({}) as never,
      createCodec: () => ({}) as never,
      shutdownSignal: controller.signal,
    });
    expect(event).toMatchObject({ result: 'completed', jobs: {}, sweep: 'not_run' });
    expect(connection.store.claim).not.toHaveBeenCalled();
    expect(connection.store.claimSweep).not.toHaveBeenCalled();
  });

  it('bounds repeated claim failures to the per-run budget without leaking their text', async () => {
    const secret = 'postgres://secret@host/db SELECT private/v1/tenants/x';
    const { connection, end } = fakeConnection('available', {
      claim: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const event = await runGalleryRenditionWorker(config, {
      connect: () => connection,
      checkBinaries: async () => true,
      createStorage: async () =>
        ({ listScopeObjects: async () => ({ keys: [], truncated: false }) }) as never,
      createCodec: () => ({}) as never,
    });
    expect(event.jobs).toEqual({ 'failed:io_failed:not_observed': GALLERY_RENDITION_JOBS_PER_RUN });
    expect(connection.store.claim).toHaveBeenCalledTimes(GALLERY_RENDITION_JOBS_PER_RUN);
    expect(JSON.stringify(event)).not.toMatch(/secret|SELECT|private\//);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('reports a thrown sweep as a finite error event, rethrows and still closes the pool', async () => {
    const { connection, end } = fakeConnection('available', {
      claimSweep: vi.fn(async () => {
        throw new Error('postgres://secret@host/db');
      }),
    });
    const events: GalleryRenditionRunEvent[] = [];
    await expect(
      runGalleryRenditionWorker(config, {
        connect: () => connection,
        checkBinaries: async () => true,
        createStorage: async () => ({}) as never,
        createCodec: () => ({}) as never,
        logger: (value) => events.push(value),
      }),
    ).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe('error');
    expect(JSON.stringify(events)).not.toMatch(/secret/);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('fails closed before any claim when a codec binary is a symlink or missing', async () => {
    const { connection, end } = fakeConnection('available');
    const event = await runGalleryRenditionWorker(config, {
      connect: () => connection,
      createStorage: storage,
      createCodec: () => ({}) as never,
    });
    // The fixture binaries under /opt/ffmpeg do not exist on this machine.
    expect(event).toMatchObject({ result: 'unavailable', jobs: {}, sweep: 'not_run' });
    expect(connection.store.claim).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
