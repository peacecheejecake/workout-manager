import { describe, expect, it, vi } from 'vitest';

import type { CoursePosition } from '@workout/contracts/courses';
import type {
  CourseThumbnailFinalizeOutcome,
  CourseThumbnailLease,
  CourseThumbnailWorkerRepository,
} from '@workout/server-persistence/course-thumbnails';

import {
  auditLogLines,
  coordinateProbes,
  createLogCapture,
  formatLogFindings,
  valueProbes,
} from '@workout/server-courses/log-audit';

import {
  runCourseThumbnailWorker,
  type ClosableObjectStorage,
} from '../src/course-thumbnail-worker.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const courseId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const coordinates: readonly CoursePosition[] = [
  [126.92, 37.52],
  [126.93, 37.53],
];
const temporaryRef = `private/v1/tenants/${tenantId}/courses/${courseId}/thumbnails/temporary/${jobId}`;
const leaseToken = '55555555-5555-4555-8555-555555555555';
const workerRelease = 'test-release-c2';
const workerConfig = {
  connectionString: 'postgresql://ignored@localhost/ignored',
  storageRoot: '/ignored',
  release: workerRelease,
};

function leaseFixture(overrides: Partial<CourseThumbnailLease> = {}): CourseThumbnailLease {
  return {
    athleteId: tenantId,
    courseId,
    courseRevision: 2,
    revisionId,
    jobId,
    leaseToken,
    temporaryRef,
    coordinates,
    ...overrides,
  };
}

function storageFixture(options: { publishFailure?: Error; leftoverTemporary?: boolean } = {}) {
  const written = new Map<string, Uint8Array>();
  const published = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  if (options.leftoverTemporary) written.set(temporaryRef, new Uint8Array([1]));
  const storage: {
    -readonly [K in keyof ClosableObjectStorage]: ClosableObjectStorage[K];
  } = {
    writeTemporary: vi.fn(async (key, body) => {
      // The real store opens with `O_EXCL`. A name that already exists is a hard failure,
      // not an overwrite.
      if (written.has(key)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      written.set(key, bytes);
      return { key, sizeBytes: size, modifiedAt: new Date(0) };
    }),
    publishTemporary: vi.fn(async (temporaryKey, finalKey, expectation) => {
      if (options.publishFailure) throw options.publishFailure;
      const bytes = written.get(temporaryKey);
      if (!bytes) throw new Error('nothing to publish');
      published.set(finalKey, bytes);
      written.delete(temporaryKey);
      return {
        key: finalKey,
        outcome: 'published' as const,
        sizeBytes: expectation.sizeBytes,
        sha256: expectation.sha256,
      };
    }),
    open: vi.fn(async () => null),
    stat: vi.fn(async () => null),
    delete: vi.fn(async (key) => {
      deleted.push(key);
      written.delete(key);
    }),
  };
  return { storage, written, published, deleted };
}

function repositoryFixture(
  options: {
    lease?: CourseThumbnailLease | null;
    prepared?: boolean;
    fenceOpen?: boolean;
    finalize?: CourseThumbnailFinalizeOutcome;
  } = {},
) {
  const repository: CourseThumbnailWorkerRepository = {
    lease: vi.fn(async () => (options.lease === undefined ? leaseFixture() : options.lease)),
    prepare: vi.fn(async () => options.prepared ?? true),
    publicationFenceOpen: vi.fn(async () => options.fenceOpen ?? true),
    finalize: vi.fn(async () => options.finalize ?? 'ready'),
    markUnavailable: vi.fn(async () => true),
    release: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    requeueRefs: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };
  return repository;
}

function run(
  repository: CourseThumbnailWorkerRepository,
  storage: ClosableObjectStorage,
  events: unknown[] = [],
) {
  return runCourseThumbnailWorker(workerConfig, {
    createStorage: async () => storage,
    createRepository: () => repository,
    logger: (event) => events.push(event),
  });
}

describe('course thumbnail render worker', () => {
  it('does nothing when there is nothing to draw', async () => {
    const repository = repositoryFixture({ lease: null });
    const { storage } = storageFixture();
    expect(await run(repository, storage)).toBe('empty');
    expect(storage.writeTemporary).not.toHaveBeenCalled();
    expect(repository.close).toHaveBeenCalled();
  });

  it('publishes the picture under the key the revision names, then finalizes it', async () => {
    const repository = repositoryFixture();
    const fixture = storageFixture();
    expect(await run(repository, fixture.storage)).toBe('ready');
    const prepared = vi.mocked(repository.prepare).mock.calls[0]?.[1];
    if (!prepared) throw new Error('the render never reached preparation');
    expect(prepared.storageRef).toBe(
      `private/v1/tenants/${tenantId}/courses/${courseId}/thumbnails/revisions/${revisionId}/sha256/${prepared.sha256}.svg`,
    );
    expect([...fixture.published.keys()]).toEqual([prepared.storageRef]);
    const document = new TextDecoder().decode(fixture.published.get(prepared.storageRef));
    expect(document.startsWith('<svg')).toBe(true);
    // The object is recorded in the ledger before it exists, and the fence is checked
    // immediately before it becomes visible.
    const order = [
      vi.mocked(repository.prepare).mock.invocationCallOrder[0] ?? 0,
      vi.mocked(repository.publicationFenceOpen).mock.invocationCallOrder[0] ?? 0,
      vi.mocked(fixture.storage.publishTemporary).mock.invocationCallOrder[0] ?? 0,
    ];
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('gives the object back when the course moved on while it drew', async () => {
    const repository = repositoryFixture({ finalize: 'superseded' });
    const fixture = storageFixture();
    // This is the late-arriving writer this repository keeps reproducing. It is not caught
    // by a check here: the database refused to make the picture current, and the only thing
    // left for the worker to do is hand the bytes to the cleanup manifest.
    expect(await run(repository, fixture.storage)).toBe('superseded');
    expect(repository.requeueRefs).toHaveBeenCalledTimes(1);
  });

  it('records a line it cannot draw as a permanent answer and writes nothing', async () => {
    const repository = repositoryFixture({
      lease: leaseFixture({ coordinates: [[126.92, 37.52]] }),
    });
    const fixture = storageFixture();
    expect(await run(repository, fixture.storage)).toBe('unavailable');
    expect(repository.markUnavailable).toHaveBeenCalledWith(
      expect.anything(),
      'line_too_short_to_draw',
    );
    expect(fixture.storage.writeTemporary).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('publishes nothing when the ledger refuses the preparation', async () => {
    const repository = repositoryFixture({ prepared: false });
    const fixture = storageFixture();
    expect(await run(repository, fixture.storage)).toBe('lease_lost');
    expect(fixture.storage.publishTemporary).not.toHaveBeenCalled();
    expect(fixture.deleted).toContain(temporaryRef);
  });

  it('publishes nothing when its publication fence has closed', async () => {
    const repository = repositoryFixture({ fenceOpen: false });
    const fixture = storageFixture();
    expect(await run(repository, fixture.storage)).toBe('lease_lost');
    expect(fixture.storage.publishTemporary).not.toHaveBeenCalled();
    expect(repository.requeueRefs).not.toHaveBeenCalled();
  });

  it('schedules a retry when publishing fails, and clears its temporary name', async () => {
    const repository = repositoryFixture();
    const fixture = storageFixture({ publishFailure: new Error('store unavailable') });
    expect(await run(repository, fixture.storage)).toBe('failed');
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'RENDER_FAILED', {
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(fixture.deleted).toContain(temporaryRef);
  });

  it('records a ledger disagreement as a state instead of vanishing', async () => {
    const repository = repositoryFixture({
      lease: leaseFixture({ temporaryRef: `${temporaryRef}-tampered` }),
    });
    const fixture = storageFixture();
    // Thrown out of the guarded path this ended with no durable state at all, which made
    // "every failure ends as a state the read model can name" false for exactly the failure
    // that means the ledger and the code disagree.
    expect(await run(repository, fixture.storage)).toBe('failed');
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'RENDER_REF_MISMATCH', {
      retryable: false,
    });
    expect(fixture.storage.writeTemporary).not.toHaveBeenCalled();
  });

  it('rewrites over its own leftover temporary object instead of failing forever', async () => {
    // An attempt that died after `writeTemporary` leaves that name behind, and the store
    // refuses to overwrite it. Without clearing its own name first, every retry of this job
    // fails with EEXIST — permanently, for a render that is otherwise perfectly possible.
    const repository = repositoryFixture();
    const fixture = storageFixture({ leftoverTemporary: true });
    expect(await run(repository, fixture.storage)).toBe('ready');
    expect(fixture.deleted[0]).toBe(temporaryRef);
  });

  it('hands an unprepared render back on shutdown instead of holding its lease', async () => {
    const repository = repositoryFixture();
    const fixture = storageFixture();
    const stopping = new AbortController();
    stopping.abort();
    expect(
      await runCourseThumbnailWorker(workerConfig, {
        createStorage: async () => fixture.storage,
        createRepository: () => repository,
        shutdownSignal: stopping.signal,
      }),
    ).toBe('released');
    // Nothing was drawn, nothing was recorded, and the attempt was handed back with the
    // lease — a few restarts must not be able to spend a render's five attempts.
    expect(repository.release).toHaveBeenCalledTimes(1);
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    // Not a byte was drawn or written either: a worker told to stop before it started does
    // not spend the work only to give it back.
    expect(fixture.storage.writeTemporary).not.toHaveBeenCalled();
  });

  it('gives the lease back rather than publish when it is stopped mid-render', async () => {
    const repository = repositoryFixture();
    const stopping = new AbortController();
    const fixture = storageFixture();
    const write = fixture.storage.writeTemporary.bind(fixture.storage);
    // The stop arrives while the picture is being written: the last moment at which nothing
    // is recorded and the name can simply be cleared.
    fixture.storage.writeTemporary = vi.fn(async (key, body) => {
      stopping.abort();
      return write(key, body);
    });
    expect(
      await runCourseThumbnailWorker(workerConfig, {
        createStorage: async () => fixture.storage,
        createRepository: () => repository,
        shutdownSignal: stopping.signal,
      }),
    ).toBe('released');
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(fixture.storage.publishTemporary).not.toHaveBeenCalled();
    expect(fixture.deleted).toContain(temporaryRef);
  });

  it('says nothing about the line, the course or the object in what it logs', async () => {
    const repository = repositoryFixture();
    const fixture = storageFixture();
    const events: unknown[] = [];
    await run(repository, fixture.storage, events);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('course_thumbnail_render_finished');
    for (const secret of ['126.9', '37.5', tenantId, courseId, revisionId, 'private/v1'])
      expect(serialized).not.toContain(secret);
  });

  it('logs every outcome with a run id and the release, and nothing of the lease', async () => {
    // Every way a run can end, each with its own lease, storage and stop signal. The lease
    // token is a UUID, so a leak of it is caught by its probe rather than by its shape.
    const stopped = new AbortController();
    stopped.abort();
    const scenarios = [
      { expected: 'empty', repository: repositoryFixture({ lease: null }), storage: {} },
      { expected: 'ready', repository: repositoryFixture(), storage: {} },
      {
        expected: 'superseded',
        repository: repositoryFixture({ finalize: 'superseded' }),
        storage: {},
      },
      {
        expected: 'unavailable',
        repository: repositoryFixture({ lease: leaseFixture({ coordinates: [[126.92, 37.52]] }) }),
        storage: {},
      },
      { expected: 'lease_lost', repository: repositoryFixture({ prepared: false }), storage: {} },
      {
        expected: 'failed',
        repository: repositoryFixture(),
        storage: { publishFailure: new Error(`store unavailable at ${temporaryRef}`) },
      },
      {
        expected: 'released',
        repository: repositoryFixture(),
        storage: {},
        shutdownSignal: stopped.signal,
      },
    ] as const;
    const capture = createLogCapture();
    const results: string[] = [];
    for (const scenario of scenarios) {
      results.push(
        await runCourseThumbnailWorker(workerConfig, {
          createStorage: async () => storageFixture(scenario.storage).storage,
          createRepository: () => scenario.repository,
          logger: capture.sink,
          ...('shutdownSignal' in scenario ? { shutdownSignal: scenario.shutdownSignal } : {}),
        }),
      );
    }
    expect(results).toEqual(scenarios.map((scenario) => scenario.expected));

    const lines = capture.lines();
    const findings = auditLogLines(lines, {
      traceField: 'runId',
      version: workerRelease,
      probes: [
        ...coordinateProbes([...coordinates, [126.92, 37.52]]),
        ...valueProbes('object_key', [temporaryRef, 'thumbnails/revisions', '/ignored']),
        ...valueProbes('token', [leaseToken]),
      ],
      minRecords: scenarios.length,
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);
    // One line per run, each run traced by its own id.
    expect(lines).toHaveLength(scenarios.length);
    const runIds = lines.map((line) => (JSON.parse(line) as { runId: string }).runId);
    expect(new Set(runIds).size).toBe(scenarios.length);
  });

  it('takes its lease under the run id it logs, so a line joins to the ledger row', async () => {
    const repository = repositoryFixture();
    const created: { workerId?: string }[] = [];
    const capture = createLogCapture();
    await runCourseThumbnailWorker(workerConfig, {
      createStorage: async () => storageFixture().storage,
      createRepository: (options) => {
        created.push(options);
        return repository;
      },
      logger: capture.sink,
    });
    const [line] = capture.lines();
    expect(created).toHaveLength(1);
    expect(created[0]?.workerId).toBe((JSON.parse(line ?? '{}') as { runId: string }).runId);
  });

  it('leaves one correlated line when it cannot start, without the error text', async () => {
    const secret = `postgres://thumbs:hunter2@db/workout at ${temporaryRef}`;
    const capture = createLogCapture();
    const unreachableDatabase = repositoryFixture();
    unreachableDatabase.lease = vi.fn(async () => {
      throw new Error(secret);
    });
    await expect(
      runCourseThumbnailWorker(workerConfig, {
        createStorage: async () => storageFixture().storage,
        createRepository: () => unreachableDatabase,
        logger: capture.sink,
      }),
    ).rejects.toThrow(secret);
    // The pool is still released.
    expect(unreachableDatabase.close).toHaveBeenCalled();
    await expect(
      runCourseThumbnailWorker(workerConfig, {
        createStorage: async () => {
          throw new Error(secret);
        },
        createRepository: () => repositoryFixture(),
        logger: capture.sink,
      }),
    ).rejects.toThrow(secret);

    const lines = capture.lines();
    const findings = auditLogLines(lines, {
      traceField: 'runId',
      version: workerRelease,
      probes: [
        ...valueProbes('object_key', [temporaryRef]),
        ...valueProbes('token', ['hunter2', secret]),
      ],
      minRecords: 2,
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);
    expect(lines.map((line) => (JSON.parse(line) as { result: string }).result)).toEqual([
      'error',
      'error',
    ]);
  });
});
