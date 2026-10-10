import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as { emitter: EventEmitter; options: unknown }[]);
vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    Pool: class extends Emitter {
      constructor(options: unknown) {
        super();
        pools.push({ emitter: this, options });
      }
    },
  };
});

const { createDatabase } = await import('../src/database.js');
const { createIdentityRepository } = await import('../src/identity.js');
const { createGarminRevocationStore } = await import('../src/garmin.js');
const { createSharedCourseReader } = await import('../src/course-sharing.js');
const { createCourseThumbnailWorkerRepository } = await import('../src/course-thumbnails.js');
const { idlePoolErrorCode, observeIdlePoolErrors, stderrIdlePoolErrorSink } =
  await import('../src/pool-observation.js');

// Everything a raw pg error could carry that must never reach an observation.
const secret = 'postgresql://athlete_user:hunter2@db.internal:5432/workout';
function idleBackendLoss(code: unknown): Error {
  return Object.assign(new Error(`terminating connection due to administrator command ${secret}`), {
    code,
    severity: 'FATAL',
    host: 'db.internal',
    user: 'athlete_user',
    query: 'SELECT secret FROM athlete',
    detail: secret,
  });
}

afterEach(() => {
  pools.length = 0;
  vi.restoreAllMocks();
});

describe('idle pool error observation', () => {
  it('records exactly {poolId, code} and keeps the emitter from throwing', () => {
    const pool = new EventEmitter();
    const sink = vi.fn();
    observeIdlePoolErrors(pool as never, 'database', sink);
    expect(() => pool.emit('error', idleBackendLoss('57P01'))).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    const [observation] = sink.mock.calls[0] as [Record<string, unknown>];
    expect(observation).toStrictEqual({ poolId: 'database', code: '57P01' });
    expect(Object.keys(observation)).toEqual(['poolId', 'code']);
  });

  it('reduces every non-SQLSTATE code to one fixed category', () => {
    for (const code of [undefined, null, 57, 'ECONNRESET', '57p01', '57P012', secret, {}])
      expect(idlePoolErrorCode(idleBackendLoss(code))).toBe('NON_SQLSTATE');
    for (const error of [undefined, null, 'string error', 42])
      expect(idlePoolErrorCode(error)).toBe('NON_SQLSTATE');
    expect(idlePoolErrorCode(idleBackendLoss('08006'))).toBe('08006');
    expect(idlePoolErrorCode(idleBackendLoss('XX000'))).toBe('XX000');
  });

  it('contains a failing sink so the pool error cannot crash the process', () => {
    const pool = new EventEmitter();
    observeIdlePoolErrors(pool as never, 'identity', () => {
      throw new Error('sink failed');
    });
    expect(() => pool.emit('error', idleBackendLoss('57P01'))).not.toThrow();
  });

  it('defaults to one sanitized structured stderr line', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pool = new EventEmitter();
    observeIdlePoolErrors(pool as never, 'garmin_revocation');
    pool.emit('error', idleBackendLoss('57P01'));
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toStrictEqual({
      kind: 'database_pool_idle_error',
      poolId: 'garmin_revocation',
      code: '57P01',
    });
    for (const leak of ['hunter2', 'athlete_user', 'db.internal', 'SELECT', 'administrator'])
      expect(line).not.toContain(leak);
    stderrIdlePoolErrorSink({ poolId: 'database', code: 'NON_SQLSTATE' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('wires every long-lived pool factory with its fixed pool identifier', () => {
    const sink = vi.fn();
    const connectionString = secret;
    createDatabase({ connectionString, max: 3, idleErrorSink: sink });
    createIdentityRepository({ connectionString, idleErrorSink: sink });
    createGarminRevocationStore({ connectionString, idleErrorSink: sink });
    createSharedCourseReader({ connectionString, idleErrorSink: sink });
    createCourseThumbnailWorkerRepository({ connectionString, idleErrorSink: sink });
    expect(pools).toHaveLength(5);
    for (const { emitter, options } of pools) {
      expect(emitter.listenerCount('error')).toBe(1);
      // The sink is ours; it is never handed to pg as a pool option.
      expect(options).not.toHaveProperty('idleErrorSink');
      expect(() => emitter.emit('error', idleBackendLoss('57P01'))).not.toThrow();
    }
    expect(sink.mock.calls.map(([observation]) => observation)).toStrictEqual([
      { poolId: 'database', code: '57P01' },
      { poolId: 'identity', code: '57P01' },
      { poolId: 'garmin_revocation', code: '57P01' },
      { poolId: 'course_sharing_reader', code: '57P01' },
      { poolId: 'course_thumbnail_worker', code: '57P01' },
    ]);
    expect(pools[0]?.options).toMatchObject({ connectionString, max: 3 });
    expect(pools[2]?.options).toMatchObject({ max: 2 });
  });
});
