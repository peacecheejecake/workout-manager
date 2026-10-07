import { z } from 'zod';
import { foodDefinitionVersionSchema } from '@workout/contracts/nutrition-core';
import type { NutritionPlanVersionCompatibleV4 } from '@workout/contracts/nutrition-race-plan-v4';
import { planSnapshotSchema, type PlanSnapshot } from '@workout/contracts/planning';
import type { RaceEvent } from '@workout/contracts/races';
import type { Transaction } from './database.js';
import { readRaceMediaCleanupSource } from './race-media-cleanup-source.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest as digest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid(),
  localId = z.string().min(1).max(200),
  revision = z.number().int().min(0).max(2147483647),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
export interface SourceBudget {
  bytes: bigint;
  sources: number;
}
export function reserveSourceBudget(budget: SourceBudget, bytes: bigint, sources = 0) {
  budget.bytes += bytes;
  budget.sources += sources;
  if (budget.sources > 5000)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
  if (budget.bytes > 4194304n)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
}
async function reserveBody(tx: Transaction, budget: SourceBudget, sql: string, values: unknown[]) {
  const row = parse(
    z.strictObject({ bytes: z.string().regex(/^\d+$/) }),
    (await tx.query(sql, values)).rows[0],
  );
  reserveSourceBudget(budget, BigInt(row.bytes), 1);
}
function foodProvenanceFacts(value: z.infer<typeof foodDefinitionVersionSchema>['provenance']) {
  return {
    kind: value.kind,
    reviewState: value.reviewState,
    capturedAt: value.capturedAt,
    reference:
      value.reference === null
        ? { state: 'absent' as const }
        : { state: 'present' as const, digest: digest(value.reference) },
  };
}
/** Exact owned immutable food version plus separate current head/provenance facts.
 * This read establishes no permission, approval or source-authentication authority. */
export async function captureRaceFoodVersionSourceIn(
  tx: Transaction,
  requestedVersionId: string,
  budget: SourceBudget,
) {
  const versionId = parse(uuid, requestedVersionId).toLowerCase();
  if (
    typeof budget.bytes !== 'bigint' ||
    budget.bytes < 0n ||
    !Number.isSafeInteger(budget.sources) ||
    budget.sources < 0
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  reserveSourceBudget(budget, 0n);
  await reserveBody(
    tx,
    budget,
    'SELECT coalesce(sum(octet_length(v.record_json::text)+coalesce(octet_length(c.record_json::text),0)+2048),0)::text AS bytes FROM food_definition_version v LEFT JOIN food_definition_head h ON h.athlete_id=v.athlete_id AND h.food_id=v.food_id LEFT JOIN food_definition_version c ON c.athlete_id=h.athlete_id AND c.version_id=h.version_id WHERE v.athlete_id=$1 AND v.version_id=$2::uuid',
    [tx.athleteId, versionId],
  );
  const rows = (
    await tx.query(
      `SELECT v.food_id,v.version_id,v.record_json,h.version_id AS current_version_id,c.record_json->'provenance' AS current_provenance FROM food_definition_version v LEFT JOIN food_definition_head h ON h.athlete_id=v.athlete_id AND h.food_id=v.food_id LEFT JOIN food_definition_version c ON c.athlete_id=h.athlete_id AND c.version_id=h.version_id WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
      [tx.athleteId, versionId],
    )
  ).rows;
  if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (!rows[0])
    return {
      requestedVersionId: versionId,
      state: 'unavailable' as const,
      content: null,
      currentHead: null,
    };
  const row = parse(
    z.strictObject({
      food_id: localId,
      version_id: uuid,
      record_json: z.unknown(),
      current_version_id: uuid.nullable(),
      current_provenance: foodDefinitionVersionSchema.shape.provenance.nullable(),
    }),
    rows[0],
  );
  const record = parse(foodDefinitionVersionSchema, row.record_json);
  if (
    record.foodId !== row.food_id ||
    record.versionId !== row.version_id ||
    row.version_id !== versionId
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return {
    requestedVersionId: versionId,
    state: row.current_version_id === versionId ? ('current' as const) : ('historical' as const),
    content: {
      foodId: record.foodId,
      versionId: record.versionId,
      digest: digest(record),
      record,
      provenance: foodProvenanceFacts(record.provenance),
    },
    currentHead: row.current_version_id
      ? {
          versionId: row.current_version_id,
          provenance: row.current_provenance ? foodProvenanceFacts(row.current_provenance) : null,
        }
      : { state: 'absent' as const },
  };
}
export type RaceFoodVersionSource = Awaited<ReturnType<typeof captureRaceFoodVersionSourceIn>>;
/** Exact versions and current heads are separate. Newly consumed plans are returned to
 * the parent cache before supplementary copy capture. No period filtering or provider I/O. */
export async function captureNestedNutritionSources(
  tx: Transaction,
  records: readonly NutritionPlanVersionCompatibleV4[],
  budget: SourceBudget,
  ports?: { plan(id: string): Promise<PlanSnapshot>; race(id: string): Promise<RaceEvent> },
) {
  const unique = [...new Map(records.map((record) => [record.versionId, record])).values()].sort(
    (a, b) => a.versionId.localeCompare(b.versionId),
  );
  const foodCache = new Map<string, Promise<unknown>>(),
    planCache = new Map<string, Promise<PlanSnapshot | null>>(),
    raceCache = new Map<string, Promise<unknown>>();
  const loadedPlans: PlanSnapshot[] = [];
  async function food(versionId: string) {
    const old = foodCache.get(versionId);
    if (old) return old;
    const pending = captureRaceFoodVersionSourceIn(tx, versionId, budget);
    foodCache.set(versionId, pending);
    return pending;
  }
  async function plan(versionId: string) {
    const old = planCache.get(versionId);
    if (old) return old;
    const pending = (async () => {
      // Include new exact supplementary bodies/target metadata before the parent reads them.
      await reserveBody(
        tx,
        budget,
        `WITH links AS (SELECT * FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=$2::uuid),
    routines AS (SELECT v.* FROM supplementary_routine_version v WHERE v.athlete_id=$1 AND v.version_id IN (SELECT routine_version_id FROM links)),
    targets AS (SELECT to_jsonb(t) AS body,t.exercise_version_id FROM supplementary_session_target_ref t WHERE t.athlete_id=$1 AND t.plan_version_id=$2::uuid UNION ALL SELECT to_jsonb(t),t.exercise_version_id FROM supplementary_routine_target_ref t WHERE t.athlete_id=$1 AND t.routine_version_id IN (SELECT version_id FROM routines)),
    bodies AS (SELECT draft AS body FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid UNION ALL SELECT embedded_spec_json FROM links UNION ALL SELECT record_json FROM routines UNION ALL SELECT body FROM targets UNION ALL SELECT record_json FROM supplementary_exercise_version WHERE athlete_id=$1 AND version_id IN (SELECT exercise_version_id FROM targets))
    SELECT coalesce(sum(octet_length(body::text)+1024),0)::text AS bytes FROM bodies`,
        [tx.athleteId, versionId],
      );
      const exists = (
        await tx.query('SELECT 1 FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid', [
          tx.athleteId,
          versionId,
        ])
      ).rows;
      if (exists.length === 0) return null;
      let record: PlanSnapshot;
      if (ports) record = await ports.plan(versionId);
      else {
        const row = parse(
          z.strictObject({
            id: uuid,
            version: revision.min(1),
            created_at: z.date(),
            draft: z.unknown(),
          }),
          (
            await tx.query(
              'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid',
              [tx.athleteId, versionId],
            )
          ).rows[0],
        );
        record = parse(planSnapshotSchema, {
          id: row.id,
          version: row.version,
          createdAt: row.created_at.toISOString(),
          draft: row.draft,
        });
      }
      loadedPlans.push(record);
      return record;
    })();
    planCache.set(versionId, pending);
    return pending;
  }
  async function race(id: string) {
    const old = raceCache.get(id);
    if (old) return old;
    const pending = (async () => {
      await reserveBody(
        tx,
        budget,
        `SELECT coalesce(sum(octet_length(e.values_json::text)+octet_length(h.values_json::text)+2048),0)::text AS bytes FROM race_event e LEFT JOIN race_event_revision h ON h.athlete_id=e.athlete_id AND h.entity_id=e.id AND h.revision=e.revision WHERE e.athlete_id=$1 AND e.id=$2::uuid`,
        [tx.athleteId, id],
      );
      const rows = (
        await tx.query(
          'SELECT revision,deleted FROM race_event WHERE athlete_id=$1 AND id=$2::uuid',
          [tx.athleteId, id],
        )
      ).rows;
      if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      if (!rows[0]) return { requestedId: id, state: 'unavailable' as const, content: null };
      const row = parse(
        z.strictObject({ revision: revision.min(1), deleted: z.boolean() }),
        rows[0],
      );
      if (row.deleted)
        return {
          requestedId: id,
          state: 'deleted' as const,
          revision: row.revision,
          content: null,
        };
      // Parent uses its one-query-per-source validated race/history cache. Standalone
      // companion records only the head when that canonical reader was not supplied.
      const record = ports ? await ports.race(id) : null;
      return {
        requestedId: id,
        state: 'current' as const,
        revision: row.revision,
        content: record ? { digest: digest(record) } : null,
      };
    })();
    raceCache.set(id, pending);
    return pending;
  }
  const nutrition = [];
  for (const record of unique) {
    const linked = record.linkedTrainingPlanVersionId
      ? await plan(record.linkedTrainingPlanVersionId)
      : null;
    const heads = linked
      ? (
          await tx.query('SELECT aggregate_id,version_id FROM plan_head WHERE athlete_id=$1', [
            tx.athleteId,
          ])
        ).rows
      : [];
    if (heads.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const head = heads[0]
      ? parse(z.strictObject({ aggregate_id: uuid, version_id: uuid }), heads[0])
      : null;
    const foods = await Promise.all(
      [
        ...new Set(
          record.items.flatMap((item) =>
            item.foods.flatMap((portion) => (portion.foodVersionId ? [portion.foodVersionId] : [])),
          ),
        ),
      ]
        .sort()
        .map(food),
    );
    const anchors = [];
    for (const item of record.items) {
      if (item.anchor.kind !== 'relative') continue;
      const anchor = item.anchor;
      if (item.anchor.entity === 'race')
        anchors.push({
          itemId: item.id,
          anchor: item.anchor,
          source: await race(parse(uuid, item.anchor.entityId)),
        });
      else
        anchors.push({
          itemId: item.id,
          anchor: item.anchor,
          source: linked?.draft.sessions.some((session) => session.id === anchor.entityId)
            ? { state: 'owned' as const, planVersionId: linked.id }
            : { state: 'unavailable' as const, content: null },
        });
    }
    nutrition.push({
      versionId: record.versionId,
      ...('schemaVersion' in record ? { recordDigest: digest(record) } : {}),
      foods,
      anchors,
      linkedPlan:
        record.linkedTrainingPlanVersionId === null
          ? { state: 'absent' as const }
          : linked
            ? {
                state:
                  head?.version_id === linked.id ? ('current' as const) : ('historical' as const),
                requestedVersionId: record.linkedTrainingPlanVersionId,
                content: { digest: digest(linked) },
                currentHead: head,
              }
            : {
                state: 'unavailable' as const,
                requestedVersionId: record.linkedTrainingPlanVersionId,
                content: null,
                currentHead: null,
              },
    });
  }
  return { nutrition, loadedPlans };
}

/** Tenant-wide Activity head inventory, consumed media metadata and genuinely linked
 * provider lineage. FIT without a Garmin ledger link stays unattributed. */
export async function captureActivityAndMediaPermissions(
  tx: Transaction,
  mediaIds: readonly string[],
  budget: SourceBudget,
) {
  const ids = [...new Set(parse(z.array(localId).max(5000), mediaIds))].sort();
  reserveSourceBudget(budget, BigInt(ids.length * 2048), ids.length);
  const activitySql = `SELECT c.id,c.revision,c.deleted,h.kind,h.source_id,h.source_revision,h.content_hash,
   (SELECT max(revision) FROM activity_overlay_revision o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id) AS overlay_revision,
   EXISTS(SELECT 1 FROM activity_overlay o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id) AS overlay_present,
   EXISTS(SELECT 1 FROM activity_suppression s WHERE s.athlete_id=c.athlete_id AND s.kind=h.kind AND s.source_id=h.source_id) AS suppressed,
   (SELECT r.content_hash FROM activity_source_revision r WHERE r.athlete_id=c.athlete_id AND r.kind=h.kind AND r.source_id=h.source_id AND r.source_revision=h.source_revision) AS revision_content_hash,
   EXISTS(SELECT 1 FROM activity_source_revision r WHERE r.athlete_id=c.athlete_id AND r.kind=h.kind AND r.source_id=h.source_id AND r.source_revision=h.source_revision AND r.content_hash=h.content_hash) AS source_revision_present
   FROM activity_canonical c LEFT JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id WHERE c.athlete_id=$1`;
  const garminSql = `SELECT s.kind,s.source_id,l.provider,l.official,l.outcome FROM garmin_activity_ledger_source s JOIN garmin_activity_ledger l ON l.athlete_id=s.athlete_id AND l.garmin_activity_id=s.garmin_activity_id WHERE s.athlete_id=$1`;
  const hkSql = `WITH refs AS (SELECT source_id::uuid AS id FROM activity_source_head WHERE athlete_id=$1 AND kind='healthkit' UNION SELECT sample_id FROM healthkit_existing_binding WHERE athlete_id=$1)
   SELECT refs.id,s.state,s.payload_digest,l.state AS lineage_state,c.claim_epoch,c.consent_revision,
   b.activity_id,b.target_revision,b.sample_digest FROM refs
   LEFT JOIN healthkit_workout_sample s ON s.athlete_id=$1 AND s.sample_id=refs.id
   LEFT JOIN healthkit_workout_lineage l ON l.athlete_id=$1 AND l.sample_id=refs.id
   LEFT JOIN healthkit_workout_claim c ON c.athlete_id=$1 AND c.sample_id=refs.id
   LEFT JOIN healthkit_existing_binding b ON b.athlete_id=$1 AND b.sample_id=refs.id`;
  async function metadata(sql: string) {
    const size = parse(
      z.strictObject({ bytes: z.string().regex(/^\d+$/), count: z.string().regex(/^\d+$/) }),
      (
        await tx.query(
          `SELECT coalesce(sum(octet_length(to_jsonb(f)::text)+1024),0)::text AS bytes,count(*)::text AS count FROM (${sql} LIMIT 5001) f`,
          [tx.athleteId],
        )
      ).rows[0],
    );
    reserveSourceBudget(budget, BigInt(size.bytes), Number(size.count));
    return (await tx.query(`${sql} ORDER BY 1,2 LIMIT 5001`, [tx.athleteId])).rows;
  }
  const activities = (await metadata(activitySql)).map((value) => {
    const row = parse(
      z.strictObject({
        id: uuid,
        revision: revision.min(1),
        deleted: z.boolean(),
        kind: z.enum(['fit', 'fixture', 'manual', 'healthkit']).nullable(),
        source_id: localId.nullable(),
        source_revision: revision.min(1).nullable(),
        content_hash: hash.nullable(),
        overlay_revision: revision.min(1).nullable(),
        overlay_present: z.boolean(),
        suppressed: z.boolean(),
        source_revision_present: z.boolean(),
        revision_content_hash: hash.nullable(),
      }),
      value,
    );
    if (
      (row.kind === null) !== (row.source_id === null) ||
      (row.kind === null) !== (row.source_revision === null) ||
      (row.kind === null) !== (row.content_hash === null)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (row.revision_content_hash !== null && row.revision_content_hash !== row.content_hash)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (row.kind === 'healthkit') parse(uuid, row.source_id);
    return {
      id: row.id,
      revision: row.revision,
      deleted: row.deleted,
      overlay: row.overlay_present
        ? { state: 'present' as const, revision: row.overlay_revision }
        : { state: 'absent' as const, revision: row.overlay_revision },
      source:
        row.kind === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              kind: row.kind,
              sourceId: row.source_id,
              revision: row.source_revision,
              contentHash: row.content_hash,
              suppressed: row.suppressed,
              revisionRecord: {
                state: row.source_revision_present ? ('present' as const) : ('absent' as const),
              },
            },
    };
  });
  const garminLineage = (await metadata(garminSql)).map((row) =>
    parse(
      z.strictObject({
        kind: z.enum(['fit', 'fixture', 'manual', 'healthkit']),
        source_id: localId,
        provider: z.enum(['garmin-official', 'garmin-connect-unofficial']),
        official: z.boolean(),
        outcome: z.enum(['imported', 'unchanged', 'stale', 'suppressed']),
      }),
      row,
    ),
  );
  const healthkit = (await metadata(hkSql)).map((value) => {
    const row = parse(
      z.strictObject({
        id: uuid,
        state: z.enum(['active', 'deleted']).nullable(),
        payload_digest: hash.nullable(),
        lineage_state: z
          .enum(['pending_review', 'linked_existing', 'created_activity', 'suppressed', 'deleted'])
          .nullable(),
        claim_epoch: uuid.nullable(),
        consent_revision: revision.min(1).nullable(),
        activity_id: uuid.nullable(),
        target_revision: revision.min(1).nullable(),
        sample_digest: hash.nullable(),
      }),
      value,
    );
    if (
      (row.claim_epoch === null) !== (row.consent_revision === null) ||
      (row.activity_id === null) !== (row.target_revision === null) ||
      (row.activity_id === null) !== (row.sample_digest === null)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    return {
      id: row.id,
      sample:
        row.state === null
          ? { state: 'absent' as const }
          : { state: 'present' as const, status: row.state, payloadDigest: row.payload_digest },
      lineage:
        row.lineage_state === null
          ? { state: 'absent' as const }
          : { state: 'present' as const, status: row.lineage_state },
      claim:
        row.claim_epoch === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              epoch: row.claim_epoch,
              consentRevision: row.consent_revision,
            },
      binding:
        row.activity_id === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              activityId: row.activity_id,
              targetRevision: row.target_revision,
              sampleDigest: row.sample_digest,
            },
    };
  });
  const registry = (
    await tx.query('SELECT revision FROM healthkit_workout_registry_head WHERE athlete_id=$1', [
      tx.athleteId,
    ])
  ).rows;
  if (registry.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const consentRows = (
    await tx.query(
      "SELECT kind,granted,revision FROM consent WHERE athlete_id=$1 AND kind IN ('provider','healthkit','media') ORDER BY kind",
      [tx.athleteId],
    )
  ).rows.map((row) =>
    parse(
      z.strictObject({
        kind: z.enum(['provider', 'healthkit', 'media']),
        granted: z.boolean(),
        revision: revision.min(1),
      }),
      row,
    ),
  );
  const consents = ['provider', 'healthkit', 'media'].map((kind) => {
    const row = consentRows.find((row) => row.kind === kind);
    return row ? { ...row, state: 'present' as const } : { kind, state: 'absent' as const };
  });
  const connections = (
    await metadata(
      'SELECT generation,state,permissions,access_expires_at,refresh_expires_at FROM garmin_connection WHERE athlete_id=$1',
    )
  ).map((row) =>
    parse(
      z.strictObject({
        generation: revision,
        state: z.enum(['disconnected', 'connecting', 'connected', 'reconnect_required']),
        permissions: z.array(z.string().min(1).max(100)).max(32),
        access_expires_at: z
          .date()
          .nullable()
          .transform((value) => value?.toISOString() ?? null),
        refresh_expires_at: z
          .date()
          .nullable()
          .transform((value) => value?.toISOString() ?? null),
      }),
      row,
    ),
  );
  const unofficial = (
    await metadata(
      'SELECT session_generation,state,schedule_enabled,schedule_paused FROM garmin_unofficial_connection WHERE athlete_id=$1',
    )
  ).map((row) =>
    parse(
      z.strictObject({
        session_generation: revision,
        state: z.enum(['not_connected', 'connected', 'reconnect_required']),
        schedule_enabled: z.boolean(),
        schedule_paused: z.boolean(),
      }),
      row,
    ),
  );
  if (connections.length > 1 || unofficial.length > 1)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const media = [];
  for (const id of ids) {
    if (!uuid.safeParse(id).success) {
      media.push({ requestedId: id, state: 'unavailable' as const, content: null });
      continue;
    }
    const rows = (
      await tx.query(
        `SELECT m.id,m.access_revision,m.deleted_at IS NOT NULL AS deleted,m.visibility,m.include_for_coach,
   m.media_kind,m.content_hash,o.content_hash AS object_hash,o.storage_ref AS object_ref,
   EXISTS(SELECT 1 FROM gallery_media_derivative d WHERE d.athlete_id=m.athlete_id AND d.media_item_id=m.id) AS preview_present
   FROM gallery_media_item m LEFT JOIN gallery_media_object o ON o.athlete_id=m.athlete_id AND o.storage_ref=m.storage_ref WHERE m.athlete_id=$1 AND m.id=$2::uuid`,
        [tx.athleteId, id],
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) {
      media.push({ requestedId: id, state: 'unavailable' as const, content: null });
      continue;
    }
    const row = parse(
      z.strictObject({
        id: uuid,
        access_revision: revision.min(1),
        deleted: z.boolean(),
        visibility: z.literal('private'),
        include_for_coach: z.literal(false),
        media_kind: z.enum(['image', 'video']),
        content_hash: hash,
        object_hash: hash.nullable(),
        object_ref: z.string().min(1).max(512).nullable(),
        preview_present: z.boolean(),
      }),
      rows[0],
    );
    // The reader returns at most64 hashed refs and a16KiB finite DTO. Reserve
    // that bound before transporting private cleanup facts into the capture.
    reserveSourceBudget(budget, 16384n, 1);
    const cleanup = await readRaceMediaCleanupSource(tx, {
      mediaItemId: row.id,
      expectedAccessRevision: row.access_revision,
    });
    media.push({
      requestedId: id,
      state: row.deleted ? ('deleted' as const) : ('owned' as const),
      accessRevision: row.access_revision,
      visibility: row.visibility,
      includeForCoach: row.include_for_coach,
      content: row.deleted
        ? null
        : {
            kind: row.media_kind,
            objectIdentity: row.object_hash
              ? {
                  state: 'present' as const,
                  contentHash: row.object_hash,
                  idDigest: digest(row.object_ref),
                }
              : { state: 'absent' as const },
            contentHash: row.content_hash,
            previewPresent: row.preview_present,
          },
      cleanup:
        cleanup.status === 'available'
          ? cleanup.source
          : { state: 'unavailable' as const, reason: cleanup.reason },
    });
  }
  return {
    activities,
    garminLineage,
    healthkit,
    healthkitRegistry: registry[0]
      ? {
          state: 'present' as const,
          ...parse(z.strictObject({ revision: revision.min(1) }), registry[0]),
        }
      : { state: 'absent' as const },
    consents,
    garmin: connections[0]
      ? { state: 'present' as const, connection: connections[0] }
      : { state: 'absent' as const },
    garminUnofficial: unofficial[0]
      ? { state: 'present' as const, connection: unofficial[0] }
      : { state: 'absent' as const },
    media,
  };
}
