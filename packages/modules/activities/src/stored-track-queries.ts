/**
 * Server cache for one stored activity track.
 *
 * TanStack Query owns this cache, keyed by the authenticated user, the session, the
 * activity and — for the geometry objects — the track revision and the content hashes the
 * server reported. A new revision therefore reads a new key instead of overwriting the
 * old entry, and nothing is copied into a Zustand store as a second source of truth.
 *
 * Every response is validated against the contract before it is used, and the two derived
 * objects are additionally checked to be the ones the metadata described: an object whose
 * provenance names a different activity, source revision or track revision is refused
 * rather than drawn.
 */
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import {
  activityTrackReadResultSchema,
  type ActivityTrackRevision,
} from '@workout/contracts/activity-tracks';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { mapPathSchema, recordedTrackSchema } from '@workout/contracts/tracks';
import type { MapPath, RecordedTrack } from '@workout/contracts/tracks';

export type TrackQueryScope = readonly (string | number)[];

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

function errorCode(body: unknown): string | null {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

/** `null` means the activity has no stored track — a state, not a failure. */
export type StoredTrackRead = ActivityTrackRevision | null;

export function storedTrackQueryKey(scope: TrackQueryScope, activityId: string) {
  return [...scope, 'stored-track', activityId] as const;
}

export function storedTrackQueryOptions(
  scope: TrackQueryScope,
  transport: AuthenticatedTransport,
  activityId: string,
) {
  return queryOptions({
    queryKey: storedTrackQueryKey(scope, activityId),
    queryFn: async ({ signal }): Promise<StoredTrackRead> => {
      const response = await transport.request({
        path: `/bff/v1/activities/${encodeURIComponent(activityId)}/track`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted) throw new Error('CANCELLED');
      if (response.status === 404) {
        // The route answers 404 both for "no track stored" and for an activity this
        // session cannot see. Only the first is a displayable empty state, and the code
        // is what separates them.
        if (errorCode(response.body) === 'ACTIVITY_TRACK_NOT_FOUND') return null;
        throw new Error('STORED_TRACK_UNAVAILABLE');
      }
      if (response.status !== 200) throw new Error('STORED_TRACK_UNAVAILABLE');
      const result = activityTrackReadResultSchema.parse(response.body);
      if (result.status !== 'available') return null;
      // The server already asserts this; asserting it again here means a mixed-up
      // response can never be shown under the wrong activity.
      if (result.track.activityId !== activityId) throw new Error('STORED_TRACK_MISMATCH');
      return result.track;
    },
  });
}

export interface StoredTrackArtifacts {
  readonly track: RecordedTrack;
  readonly mapPath: MapPath;
}

function derivativeHash(track: ActivityTrackRevision, kind: 'normalized' | 'map_path'): string {
  return track.derivatives.find((entry) => entry.kind === kind)?.sha256 ?? '';
}

export function storedTrackArtifactsQueryKey(scope: TrackQueryScope, track: ActivityTrackRevision) {
  return [
    ...scope,
    'stored-track-artifacts',
    track.activityId,
    track.trackId,
    track.trackRevision,
    derivativeHash(track, 'normalized'),
    derivativeHash(track, 'map_path'),
  ] as const;
}

/**
 * Both derived objects belong to the same revision and are fetched together: the screen
 * has no use for geometry without the samples it corresponds to, and a half-loaded pair
 * would let a vertex resolve to a sample id from a different revision.
 */
export function storedTrackArtifactsQueryOptions(
  scope: TrackQueryScope,
  transport: AuthenticatedTransport,
  track: ActivityTrackRevision,
) {
  return queryOptions({
    queryKey: storedTrackArtifactsQueryKey(scope, track),
    queryFn: async ({ signal }): Promise<StoredTrackArtifacts> => {
      const read = async (variant: 'normalized' | 'map_path'): Promise<unknown> => {
        const response = await transport.request({
          path: `/bff/v1/activities/${encodeURIComponent(track.activityId)}/track/content?variant=${variant}`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        });
        if (signal.aborted) throw new Error('CANCELLED');
        if (response.status !== 200) throw new Error('STORED_TRACK_CONTENT_UNAVAILABLE');
        return response.body;
      };
      const [normalizedBody, mapPathBody] = await Promise.all([
        read('normalized'),
        read('map_path'),
      ]);
      const normalized = recordedTrackSchema.parse(normalizedBody);
      const mapPath = mapPathSchema.parse(mapPathBody);
      assertArtifactProvenance(track, normalized.provenance);
      assertArtifactProvenance(track, mapPath.sourceRevision);
      return { track: normalized, mapPath };
    },
  });
}

/**
 * A derived object must name the exact revision the metadata described. Without this the
 * cache key alone would be trusted, and a server that answered with a neighbouring
 * revision's object would have its sample ids used as if they were this revision's.
 */
function assertArtifactProvenance(
  track: ActivityTrackRevision,
  provenance: RecordedTrack['provenance'] | MapPath['sourceRevision'],
): void {
  if (
    provenance.kind !== 'activity-source' ||
    provenance.activityId !== track.activityId ||
    provenance.sourceId !== track.sourceId ||
    provenance.sourceRevision !== track.sourceRevision ||
    provenance.trackRevision !== track.trackRevision
  )
    throw new Error('STORED_TRACK_ARTIFACT_MISMATCH');
}
