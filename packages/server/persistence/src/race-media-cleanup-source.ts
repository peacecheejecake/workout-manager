import { z } from 'zod';
import type { Transaction } from './database.js';

const revision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().refine((id) => id === id.toLowerCase());
const requestSchema = z.strictObject({
  mediaItemId: z.uuid().transform((id) => id.toLowerCase()),
  expectedAccessRevision: revision,
});
export const raceMediaCleanupSourceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    authority: z.literal('db_cleanup_status_only'),
    mediaItemId: uuid,
    expectedAccessRevision: revision,
    observedAccessRevision: revision.nullable(),
    deleted: z.boolean().nullable(),
    inventoryComplete: z.boolean(),
    state: z.enum(['absent', 'pending', 'completed', 'unavailable']),
    reason: z
      .enum([
        'OWNED_MEDIA_UNAVAILABLE',
        'ACCESS_REVISION_STALE',
        'INVENTORY_UNAVAILABLE',
        'QUEUE_TUPLE_UNAVAILABLE',
        'REFERENCE_PRESENT',
      ])
      .nullable(),
    refs: z
      .array(
        z.strictObject({
          digest: hash,
          reason: z.enum(['resource_deleted', 'account_erased', 'upload_abandoned']).nullable(),
          state: z.enum(['absent', 'pending', 'completed', 'unavailable']),
        }),
      )
      .max(64),
    digestVersion: z.literal('postgres-jsonb-v1'),
    sourceDigest: hash,
  })
  .superRefine((source, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(source.refs.map((ref) => ref.digest)).size !== source.refs.length)
      fail('Duplicate reference digest');
    if (source.state === 'unavailable') {
      if (source.inventoryComplete || source.reason === null)
        fail('Unavailable inventory cannot claim completeness');
      return;
    }
    if (
      !source.inventoryComplete ||
      source.reason !== null ||
      source.refs.length === 0 ||
      source.observedAccessRevision !== source.expectedAccessRevision
    )
      fail('Available state requires exact complete nonempty inventory');
    if (source.state === 'absent') {
      if (
        source.deleted !== false ||
        source.refs.some((ref) => ref.state !== 'absent' || ref.reason !== null)
      )
        fail('Absence is only no cleanup requested for live owned media');
    } else {
      if (
        source.deleted !== true ||
        source.refs.some(
          (ref) =>
            ref.reason !== 'resource_deleted' || !['pending', 'completed'].includes(ref.state),
        )
      )
        fail('Deletion status requires exact resource_deleted queue tuples');
      if (source.state === 'completed' && source.refs.some((ref) => ref.state !== 'completed'))
        fail('Every reference must be DB completed');
      if (source.state === 'pending' && !source.refs.some((ref) => ref.state === 'pending'))
        fail('Pending requires unfinished references');
    }
  });
export type RaceMediaCleanupSource = z.infer<typeof raceMediaCleanupSourceSchema>;
export type RaceMediaCleanupRead =
  | { readonly status: 'available'; readonly source: RaceMediaCleanupSource }
  | {
      readonly status: 'unavailable';
      readonly reason: 'INVALID_REQUEST' | 'READ_CAPABILITY_UNAVAILABLE' | 'INVALID_CLEANUP_SOURCE';
    };

/** Only the narrow DB function may observe the private queue. A parsed DTO/hash
 * is not caller authorization or evidence of actual external object deletion.
 * SQL function/role/lifecycle/source checks, not this codec, supply DB authority. */
export async function readRaceMediaCleanupSource(
  tx: Transaction,
  input: unknown,
): Promise<RaceMediaCleanupRead> {
  const request = requestSchema.safeParse(input);
  if (!request.success) return { status: 'unavailable', reason: 'INVALID_REQUEST' };
  // Missing EXECUTE/function is detected without issuing a failing statement:
  // swallowing 42501/42883 would leave the caller transaction aborted.
  const capability = await tx.query(
    "SELECT CASE WHEN to_regprocedure('public.read_race_media_cleanup(uuid,integer)') IS NULL THEN false ELSE has_function_privilege(current_user,to_regprocedure('public.read_race_media_cleanup(uuid,integer)'),'EXECUTE') END AS available",
  );
  const available = z
    .array(z.strictObject({ available: z.boolean() }))
    .length(1)
    .safeParse(capability.rows);
  if (!available.success) return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  if (available.data[0]?.available !== true)
    return { status: 'unavailable', reason: 'READ_CAPABILITY_UNAVAILABLE' };
  // Actual caller/restore/lifecycle violations propagate for outer rollback.
  const result = await tx.query(
    'SELECT source FROM public.read_race_media_cleanup($1::uuid,$2::integer)',
    [request.data.mediaItemId, request.data.expectedAccessRevision],
  );
  if (result.rows.length !== 1) return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  const row = result.rows[0];
  if (!row || Object.keys(row).length !== 1 || !('source' in row))
    return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  try {
    if (Buffer.byteLength(JSON.stringify(row['source']), 'utf8') > 16384)
      return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  } catch {
    return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  }
  const source = raceMediaCleanupSourceSchema.safeParse(row['source']);
  if (
    !source.success ||
    source.data.mediaItemId !== request.data.mediaItemId ||
    source.data.expectedAccessRevision !== request.data.expectedAccessRevision
  )
    return { status: 'unavailable', reason: 'INVALID_CLEANUP_SOURCE' };
  return { status: 'available', source: source.data };
}
