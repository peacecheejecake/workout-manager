import { describe, expect, it } from 'vitest';

import { parseResourceUrlIngestionWorkerConfig } from '../src/url-ingestion.js';

const connectionString = 'postgres://workout_resource_ingestion_worker:secret@127.0.0.1/workout';

describe('resource URL ingestion worker config', () => {
  it('accepts only a dedicated role, absolute private storage root, and exact host list', () => {
    expect(
      parseResourceUrlIngestionWorkerConfig([], {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        RESOURCE_STORAGE_ROOT: '/var/lib/workout/resources/../resources',
        RESOURCE_URL_ALLOWED_HOSTS: 'example.com,docs.example.com',
      }),
    ).toEqual({
      connectionString,
      storageRoot: '/var/lib/workout/resources',
      allowedHosts: ['example.com', 'docs.example.com'],
    });
  });

  it.each([
    [['--all'], {}, 'INVALID_RESOURCE_URL_INGESTION_WORKER_ARGUMENTS'],
    [[], {}, 'INVALID_RESOURCE_URL_INGESTION_DATABASE_ROLE'],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: 'postgres://workout_api:secret@127.0.0.1/workout',
      },
      'INVALID_RESOURCE_URL_INGESTION_DATABASE_ROLE',
    ],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        DATABASE_URL: connectionString,
      },
      'RESOURCE_URL_INGESTION_DATABASE_ROLE_NOT_SEPARATE',
    ],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        RESOURCE_STORAGE_ROOT: 'relative',
      },
      'INVALID_RESOURCE_STORAGE_ROOT',
    ],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        RESOURCE_STORAGE_ROOT: '/',
      },
      'INVALID_RESOURCE_STORAGE_ROOT',
    ],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        RESOURCE_STORAGE_ROOT: '/var/lib/workout/resources',
      },
      'INVALID_RESOURCE_URL_ALLOWED_HOSTS',
    ],
    [
      [],
      {
        RESOURCE_URL_INGESTION_DATABASE_URL: connectionString,
        RESOURCE_STORAGE_ROOT: '/var/lib/workout/resources',
        RESOURCE_URL_ALLOWED_HOSTS: 'example.com, docs.example.com',
      },
      'INVALID_RESOURCE_URL_ALLOWED_HOSTS',
    ],
  ] as const)('rejects invalid or over-privileged configuration', (args, environment, code) => {
    expect(() => parseResourceUrlIngestionWorkerConfig(args, environment)).toThrow(code);
  });
});
