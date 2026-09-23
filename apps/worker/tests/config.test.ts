import { describe, expect, it } from 'vitest';
import {
  parseCourseThumbnailWorkerConfig,
  parseFixtureWorkerConfig,
  parseResourceCleanupWorkerConfig,
} from '../src/config.js';

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

describe('resource object cleanup worker configuration', () => {
  const cleanup = {
    RESOURCE_CLEANUP_DATABASE_URL:
      'postgres://workout_resource_cleanup_worker:secret@127.0.0.1/workout',
    DATABASE_URL: enabled.DATABASE_URL,
    RESOURCE_STORAGE_ROOT: '/var/lib/workout/resources',
  };

  it('uses a dedicated function-only role and an explicit absolute storage root', () => {
    expect(parseResourceCleanupWorkerConfig([], cleanup)).toEqual({
      connectionString: cleanup.RESOURCE_CLEANUP_DATABASE_URL,
      storageRoot: cleanup.RESOURCE_STORAGE_ROOT,
    });
    expect(() => parseResourceCleanupWorkerConfig(['--all'], cleanup)).toThrow(
      'INVALID_RESOURCE_CLEANUP_WORKER_ARGUMENTS',
    );
    expect(() =>
      parseResourceCleanupWorkerConfig([], {
        ...cleanup,
        RESOURCE_CLEANUP_DATABASE_URL: cleanup.DATABASE_URL,
      }),
    ).toThrow('INVALID_RESOURCE_CLEANUP_DATABASE_ROLE');
    expect(() =>
      parseResourceCleanupWorkerConfig([], {
        ...cleanup,
        DATABASE_URL: cleanup.RESOURCE_CLEANUP_DATABASE_URL,
      }),
    ).toThrow('RESOURCE_CLEANUP_DATABASE_ROLE_NOT_SEPARATE');
    expect(() =>
      parseResourceCleanupWorkerConfig([], {
        ...cleanup,
        RESOURCE_CLEANUP_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow('INVALID_RESOURCE_CLEANUP_DATABASE_URL');
    expect(() =>
      parseResourceCleanupWorkerConfig([], {
        ...cleanup,
        DATABASE_URL: 'not-a-url',
      }),
    ).toThrow('INVALID_RESOURCE_CLEANUP_API_DATABASE_URL');
    expect(() =>
      parseResourceCleanupWorkerConfig([], {
        ...cleanup,
        RESOURCE_CLEANUP_DATABASE_URL:
          'postgres://workout_resource_cleanup_worker@127.0.0.1/workout?user=workout_runtime',
      }),
    ).toThrow('INVALID_RESOURCE_CLEANUP_DATABASE_URL');
  });

  it.each([undefined, '', '.', '/', '/var/..', 'relative/resources', '/var/lib/\0resources'])(
    'rejects unsafe storage root %s',
    (RESOURCE_STORAGE_ROOT) => {
      expect(() =>
        parseResourceCleanupWorkerConfig([], { ...cleanup, RESOURCE_STORAGE_ROOT }),
      ).toThrow('INVALID_RESOURCE_STORAGE_ROOT');
    },
  );
});

describe('course thumbnail render worker configuration', () => {
  const thumbnails = {
    COURSE_THUMBNAIL_DATABASE_URL: 'postgres://workout_course_thumbnail_worker@127.0.0.1/workout',
    DATABASE_URL: 'postgres://workout_runtime@127.0.0.1/workout',
    RESOURCE_STORAGE_ROOT: '/var/lib/workout/objects',
  };

  it('accepts its own dedicated role and normalises the storage root', () => {
    expect(parseCourseThumbnailWorkerConfig([], thumbnails)).toEqual({
      connectionString: thumbnails.COURSE_THUMBNAIL_DATABASE_URL,
      storageRoot: '/var/lib/workout/objects',
    });
  });

  it('refuses to run as any role but its own, and never as the API role', () => {
    // The render worker is the only process that turns a private course line into a stored
    // object. Sharing a role with the API would give the API that capability by accident.
    expect(() =>
      parseCourseThumbnailWorkerConfig([], {
        ...thumbnails,
        COURSE_THUMBNAIL_DATABASE_URL: 'postgres://workout_runtime@127.0.0.1/workout',
      }),
    ).toThrow('INVALID_COURSE_THUMBNAIL_DATABASE_ROLE');
    expect(() =>
      parseCourseThumbnailWorkerConfig([], {
        ...thumbnails,
        DATABASE_URL: 'postgres://workout_course_thumbnail_worker@127.0.0.1/workout',
      }),
    ).toThrow('COURSE_THUMBNAIL_DATABASE_ROLE_NOT_SEPARATE');
    expect(() =>
      parseCourseThumbnailWorkerConfig([], {
        ...thumbnails,
        COURSE_THUMBNAIL_DATABASE_URL:
          'postgres://workout_course_thumbnail_worker@127.0.0.1/workout?user=workout_runtime',
      }),
    ).toThrow('INVALID_COURSE_THUMBNAIL_DATABASE_URL');
    expect(() => parseCourseThumbnailWorkerConfig(['--all'], thumbnails)).toThrow(
      'INVALID_COURSE_THUMBNAIL_WORKER_ARGUMENTS',
    );
  });

  it.each([undefined, '', '.', '/', '/var/..', 'relative/objects', '/var/lib/\0objects'])(
    'rejects unsafe storage root %s',
    (RESOURCE_STORAGE_ROOT) => {
      expect(() =>
        parseCourseThumbnailWorkerConfig([], { ...thumbnails, RESOURCE_STORAGE_ROOT }),
      ).toThrow('INVALID_RESOURCE_STORAGE_ROOT');
    },
  );
});
