import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  storedTrackArtifactsQueryKey,
  storedTrackArtifactsQueryOptions,
  storedTrackQueryKey,
  storedTrackQueryOptions,
} from '../src/stored-track-queries';
import { activityId, storedMapPath, storedRevision, storedTrack } from './stored-track-fixtures';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const scope = ['users', 'alice', 'sessions', 'session-a'] as const;

function transportOf(handler: (input: TransportRequest) => Reply): AuthenticatedTransport {
  return { request: (input) => Promise.resolve(handler(input)) };
}

const context = () => ({ signal: new AbortController().signal }) as never;

async function runMetadata(handler: (input: TransportRequest) => Reply) {
  const options = storedTrackQueryOptions(scope, transportOf(handler), activityId);
  return options.queryFn?.(context());
}

describe('stored track metadata query', () => {
  it('scopes the key by user, session and activity', () => {
    expect(storedTrackQueryKey(scope, activityId)).toEqual([
      'users',
      'alice',
      'sessions',
      'session-a',
      'stored-track',
      activityId,
    ]);
  });

  it('treats a missing track as an empty state and any other 404 as a failure', async () => {
    await expect(
      runMetadata(() => reply({ error: { code: 'ACTIVITY_TRACK_NOT_FOUND' } }, 404)),
    ).resolves.toBeNull();
    await expect(runMetadata(() => reply({ error: { code: 'NOT_FOUND' } }, 404))).rejects.toThrow(
      'STORED_TRACK_UNAVAILABLE',
    );
    await expect(runMetadata(() => reply({}, 500))).rejects.toThrow('STORED_TRACK_UNAVAILABLE');
  });

  it('returns the revision and refuses one belonging to another activity', async () => {
    const track = storedRevision();
    await expect(runMetadata(() => reply({ status: 'available', track }))).resolves.toEqual(track);
    await expect(
      runMetadata(() =>
        reply({
          status: 'available',
          track: { ...track, activityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        }),
      ),
    ).rejects.toThrow('STORED_TRACK_MISMATCH');
    await expect(
      runMetadata(() => reply({ status: 'unavailable', activityId })),
    ).resolves.toBeNull();
  });

  it('requests only a GET with no body and no idempotency key', async () => {
    const request = vi.fn((_input: TransportRequest) =>
      Promise.resolve(reply({ status: 'unavailable', activityId })),
    );
    await storedTrackQueryOptions(scope, { request }, activityId).queryFn?.(context());
    expect(request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/activities/${activityId}/track`,
      method: 'GET',
      body: null,
      idempotencyKey: null,
      signal: expect.anything(),
    });
  });
});

describe('stored track artifact query', () => {
  const track = storedRevision();
  const artifacts = (overrides: { sourceRevision?: number; trackRevision?: number } = {}) =>
    transportOf((input) =>
      input.path.endsWith('variant=normalized')
        ? reply(storedTrack(overrides))
        : reply(storedMapPath(overrides)),
    );

  it('keys the cache by track revision and by both content hashes', () => {
    expect(storedTrackArtifactsQueryKey(scope, track)).toEqual([
      ...scope,
      'stored-track-artifacts',
      track.activityId,
      track.trackId,
      1,
      'b'.repeat(64),
      'c'.repeat(64),
    ]);
    // A new revision reads a different key instead of overwriting the previous entry.
    expect(storedTrackArtifactsQueryKey(scope, { ...track, trackRevision: 2 })).not.toEqual(
      storedTrackArtifactsQueryKey(scope, track),
    );
  });

  it('returns both validated objects when their provenance matches the revision', async () => {
    const result = await storedTrackArtifactsQueryOptions(scope, artifacts(), track).queryFn?.(
      context(),
    );
    expect(result?.track.samples).toHaveLength(5);
    expect(result?.mapPath.geometry.coordinates).toHaveLength(2);
  });

  it('refuses an object whose provenance names another revision', async () => {
    // Same activity and source, different track revision: the cache key would have been
    // satisfied, so only this check stops the wrong sample ids from being used.
    await expect(
      storedTrackArtifactsQueryOptions(scope, artifacts({ trackRevision: 2 }), track).queryFn?.(
        context(),
      ),
    ).rejects.toThrow('STORED_TRACK_ARTIFACT_MISMATCH');
    await expect(
      storedTrackArtifactsQueryOptions(scope, artifacts({ sourceRevision: 3 }), track).queryFn?.(
        context(),
      ),
    ).rejects.toThrow('STORED_TRACK_ARTIFACT_MISMATCH');
  });

  it('refuses a document that does not satisfy the contract', async () => {
    const broken = transportOf((input) =>
      input.path.endsWith('variant=normalized')
        ? reply({ ...storedTrack(), samples: [] })
        : reply(storedMapPath()),
    );
    await expect(
      storedTrackArtifactsQueryOptions(scope, broken, track).queryFn?.(context()),
    ).rejects.toThrow();
  });

  it('fails when either object is unavailable', async () => {
    const half = transportOf((input) =>
      input.path.endsWith('variant=map_path') ? reply({}, 503) : reply(storedTrack()),
    );
    await expect(
      storedTrackArtifactsQueryOptions(scope, half, track).queryFn?.(context()),
    ).rejects.toThrow('STORED_TRACK_CONTENT_UNAVAILABLE');
  });
});
