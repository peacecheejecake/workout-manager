import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { createGalleryCodecSupervisor } from '@workout/server-media/gallery-codec-supervisor';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import type { ObjectScopeEnumeration, ObjectStorage } from '@workout/server-media/object-storage';
import { probeGalleryRenditionRuntimeV1In } from '@workout/server-persistence/gallery-rendition-pins-v1';
import { createGalleryRenditionWorkerStore } from '@workout/server-persistence/gallery-renditions';

import type { GalleryRenditionWorkerConfig } from './config.js';
import {
  createGalleryRenditionRuntime,
  type GalleryRenditionRuntimeDependencies,
} from './gallery-rendition-runtime.js';

/** At most this many jobs and one sweep per invocation; a scheduler re-invokes the CLI. */
export const GALLERY_RENDITION_JOBS_PER_RUN = 10;
const LEASE_SECONDS = 60;
const JOB_DEADLINE_MS = 30000;

/**
 * The one event a run emits. Every field is fixed vocabulary, a count, a random id or the
 * release: no tenant, media id, object key, path, codec text or SQL ever appears.
 */
export interface GalleryRenditionRunEvent {
  readonly event: 'gallery_rendition_run_finished';
  readonly result: 'completed' | 'unavailable' | 'error';
  readonly jobs: Readonly<Record<string, number>>;
  readonly sweep: 'no_sweep' | 'complete' | 'incomplete' | 'not_run';
  readonly runId: string;
  readonly version: string;
}

export interface GalleryRenditionRunConnection {
  /** Worker-role capability probe: its five RPCs only, no API RPC, no table access. */
  probe(): Promise<'available' | 'unavailable'>;
  store: GalleryRenditionRuntimeDependencies['store'];
  end(): Promise<void>;
}

export interface GalleryRenditionRunDependencies {
  connect(connectionString: string): GalleryRenditionRunConnection;
  createStorage(rootDirectory: string): Promise<ObjectStorage & ObjectScopeEnumeration>;
  createCodec(config: GalleryRenditionWorkerConfig): GalleryRenditionRuntimeDependencies['codec'];
  /** The codec opens FFmpeg/ffprobe with O_NOFOLLOW: both must be regular, non-symlink files. */
  checkBinaries(config: GalleryRenditionWorkerConfig): Promise<boolean>;
  logger?: (event: GalleryRenditionRunEvent) => void;
  shutdownSignal?: AbortSignal;
}

async function checkBinaries(config: GalleryRenditionWorkerConfig): Promise<boolean> {
  try {
    for (const path of [config.ffmpegPath, config.ffprobePath])
      if (!(await lstat(path)).isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

function connect(connectionString: string): GalleryRenditionRunConnection {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
  });
  return {
    async probe() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const state = await probeGalleryRenditionRuntimeV1In(client, 'worker');
        await client.query('ROLLBACK');
        return state;
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
        return 'unavailable';
      } finally {
        client.release();
      }
    },
    store: createGalleryRenditionWorkerStore(pool, { leaseSeconds: LEASE_SECONDS }),
    end: () => pool.end(),
  };
}

function createCodec(config: GalleryRenditionWorkerConfig) {
  // The supervised child sits next to the supervisor module and runs under the tsx loader,
  // exactly as the codec e2e drives it.
  const childModulePath = join(
    dirname(fileURLToPath(import.meta.resolve('@workout/server-media/gallery-codec-supervisor'))),
    'gallery-codec-child.ts',
  );
  return createGalleryCodecSupervisor({
    nodePath: process.execPath,
    childModulePath,
    typescriptLoaderPath: fileURLToPath(import.meta.resolve('tsx')),
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    ...(config.scratchRoot === null ? {} : { scratchRoot: config.scratchRoot }),
  });
}

const defaults: GalleryRenditionRunDependencies = {
  connect,
  createStorage: createLocalFilesystemObjectStorage,
  createCodec,
  checkBinaries,
};

/** One bounded run: probe, up to N jobs until none is due, then at most one sweep. */
export async function runGalleryRenditionWorker(
  config: GalleryRenditionWorkerConfig,
  overrides: Partial<GalleryRenditionRunDependencies> = {},
): Promise<GalleryRenditionRunEvent> {
  const d = { ...defaults, ...overrides };
  const runId = randomUUID();
  const jobs: Record<string, number> = {};
  let sweep: GalleryRenditionRunEvent['sweep'] = 'not_run';
  const emit = (result: GalleryRenditionRunEvent['result']) => {
    const event: GalleryRenditionRunEvent = {
      event: 'gallery_rendition_run_finished',
      result,
      jobs: { ...jobs },
      sweep,
      runId,
      version: config.release,
    };
    d.logger?.(event);
    return event;
  };
  const connection = d.connect(config.connectionString);
  try {
    // A symlinked or missing binary would only burn leased attempts as codec_unavailable.
    if (!(await d.checkBinaries(config)) || (await connection.probe()) !== 'available')
      return emit('unavailable');
    const runtime = createGalleryRenditionRuntime({
      store: connection.store,
      storage: await d.createStorage(config.storageRoot),
      codec: d.createCodec(config),
      clock: {
        nowMs: () => Date.now(),
        schedule: (delay, callback) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      workerId: runId,
      deadlineMs: JOB_DEADLINE_MS,
      ...(d.shutdownSignal ? { signal: d.shutdownSignal } : {}),
    });
    for (let index = 0; index < GALLERY_RENDITION_JOBS_PER_RUN; index++) {
      if (d.shutdownSignal?.aborted) break;
      const result = await runtime.runJob();
      if (result.state === 'no_job') break;
      // Finite vocabulary only: state, reason and the codec's fixed code.
      const key =
        result.state === 'failed'
          ? `failed:${result.reason}:${result.codecCode}`
          : result.state === 'rejected'
            ? `rejected:${result.reason}`
            : result.state;
      jobs[key] = (jobs[key] ?? 0) + 1;
    }
    if (!d.shutdownSignal?.aborted) {
      const swept = await runtime.runSweep();
      sweep = swept.state === 'no_sweep' ? 'no_sweep' : swept.complete ? 'complete' : 'incomplete';
    }
    return emit('completed');
  } catch (error) {
    emit('error');
    throw error;
  } finally {
    await connection.end();
  }
}
