import { describe, expect, it } from 'vitest';
import { parseFixtureWorkerConfig } from '../src/config.js';

const athleteId = 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa';
const args = ['--athlete-id', athleteId];
const enabled = {
  NODE_ENV: 'test',
  COACHING_FIXTURE_ENABLED: 'true',
  COACHING_FIXTURE_ID: 'synthetic-v1',
  COACHING_WORKER_DATABASE_URL: 'postgres://workout_coaching_worker:secret@127.0.0.1/workout',
  DATABASE_URL: 'postgres://workout_api:secret@127.0.0.1/workout',
};

describe('coaching fixture worker configuration', () => {
  it('requires explicit dispatch and separates the worker DB role', () => {
    expect(parseFixtureWorkerConfig(args, enabled)).toEqual({
      athleteId,
      connectionString: enabled.COACHING_WORKER_DATABASE_URL,
      policy: { id: 'running-core-v2-training', version: '1' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    });
    expect(() => parseFixtureWorkerConfig([], enabled)).toThrow(
      'INVALID_COACHING_WORKER_ARGUMENTS',
    );
    expect(() => parseFixtureWorkerConfig([...args, '--all'], enabled)).toThrow(
      'INVALID_COACHING_WORKER_ARGUMENTS',
    );
    expect(() =>
      parseFixtureWorkerConfig(['--athlete-id', athleteId.toUpperCase()], enabled),
    ).toThrow('INVALID_COACHING_WORKER_ARGUMENTS');
  });

  it.each(['production', '', undefined])('cannot run in NODE_ENV=%s', (NODE_ENV) => {
    expect(() => parseFixtureWorkerConfig(args, { ...enabled, NODE_ENV })).toThrow(
      'COACHING_FIXTURE_WORKER_DISABLED',
    );
  });

  it('requires both the exact fixture flag and fixture identifier', () => {
    expect(() =>
      parseFixtureWorkerConfig(args, { ...enabled, COACHING_FIXTURE_ENABLED: '1' }),
    ).toThrow('COACHING_FIXTURE_WORKER_DISABLED');
    expect(() =>
      parseFixtureWorkerConfig(args, { ...enabled, COACHING_FIXTURE_ID: 'other' }),
    ).toThrow('COACHING_FIXTURE_WORKER_DISABLED');
  });

  it('rejects API and privileged credentials in place of the dedicated worker role', () => {
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        COACHING_WORKER_DATABASE_URL: enabled.DATABASE_URL,
      }),
    ).toThrow('INVALID_COACHING_WORKER_DATABASE_ROLE');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        DATABASE_URL: enabled.COACHING_WORKER_DATABASE_URL,
      }),
    ).toThrow('COACHING_WORKER_DATABASE_ROLE_NOT_SEPARATE');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        COACHING_WORKER_DATABASE_URL: 'postgres://postgres@127.0.0.1/workout',
      }),
    ).toThrow('INVALID_COACHING_WORKER_DATABASE_ROLE');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        COACHING_WORKER_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow('INVALID_COACHING_WORKER_DATABASE_URL');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        COACHING_WORKER_DATABASE_URL:
          'postgres://workout_coaching_worker@127.0.0.1/workout?user=workout_runtime',
      }),
    ).toThrow('INVALID_COACHING_WORKER_DATABASE_URL');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        DATABASE_URL: 'postgres://workout_api@127.0.0.1/workout?user=workout_coaching_worker',
      }),
    ).toThrow('INVALID_COACHING_WORKER_DATABASE_URL');
    expect(() =>
      parseFixtureWorkerConfig(args, {
        ...enabled,
        COACHING_WORKER_DATABASE_URL:
          'postgres://workout_coaching_worker@localhost/workout?host=%2Ftmp%2Fcoaching-test',
      }),
    ).not.toThrow();
  });
});
