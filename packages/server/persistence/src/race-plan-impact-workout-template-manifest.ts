import {
  mediaRetainedReadFactsSchema,
  validateMediaRetainedReadFacts,
} from './race-plan-impact-media-read-facts.js';
import { z } from 'zod';
import { workoutTemplateSourceFactsSchema } from './race-plan-impact-workout-template-sources.js';
import { impactDependencyDigest as digest } from './race-plan-impact-dependencies.js';
import {
  resourceRetainedReadFactsSchema,
  validateResourceRetainedReadFacts,
} from './race-plan-impact-resource-read-facts.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const request = workoutTemplateSourceFactsSchema.shape.requests.element;
const head = z.strictObject({ aggregate_id: uuid, version_id: uuid });
/** Same finite linked-exercise projection produced by source-permissions. No
 * editorial, physiology, deletion or processing permission is inferred here. */
export const workoutLinkedExerciseSchema = z.strictObject({
  requestedVersionId: uuid,
  state: z.enum(['owned', 'unavailable']),
  content: z
    .strictObject({
      exerciseId: uuid,
      versionId: uuid,
      digest: hash,
      resourceVersionIds: z.array(z.string().min(1).max(200)).max(20),
      mediaAssetIds: z.array(z.string().min(1).max(200)).max(20),
    })
    .nullable(),
  currentHead: head.nullable(),
});
export const workoutCatalogRowSchema = z.strictObject({
  requested: request,
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.string().max(200).nullable(),
  content: z.strictObject({ digest: hash }).nullable(),
  currentHead: head.nullable(),
  exercises: z.array(workoutLinkedExerciseSchema).max(300).optional(),
  provenance: z
    .strictObject({
      source: z.literal('user_recorded'),
      reviewState: z.literal('unreviewed'),
      reviewedAt: z.null(),
    })
    .nullable()
    .optional(),
});
export const workoutTemplateReadProjectionSchema = z.strictObject({
  athleteId: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => v === v.trim()),
  requests: z.array(request).max(5000),
  catalogRows: z.array(workoutCatalogRowSchema).max(5000),
  sourceFacts: workoutTemplateSourceFactsSchema.optional(),
  resourceReadFacts: resourceRetainedReadFactsSchema.optional(),
  mediaReadFacts: mediaRetainedReadFactsSchema.optional(),
});
export type WorkoutTemplateReadProjection = z.infer<typeof workoutTemplateReadProjectionSchema>;
export type WorkoutTemplateReadBlocker = {
  path: string;
  reason:
    | 'invalid_projection'
    | 'bounds_exceeded'
    | 'source_port_missing'
    | 'source_unavailable'
    | 'source_identity_mismatch'
    | 'source_digest_mismatch'
    | 'source_membership_mismatch'
    | 'catalog_exercise_port_missing'
    | 'unused_source'
    | 'resource_permission_port_missing'
    | 'media_permission_port_missing';
};
const key = (r: z.infer<typeof request>) => JSON.stringify([r.ref.id, r.ref.versionId]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const equal = (a: unknown, b: unknown) =>
  a !== undefined && b !== undefined && digest(a) === digest(b);
const publicHead = (
  h: z.infer<typeof workoutTemplateSourceFactsSchema>['templateFacts'][number]['currentHead'],
) => (h === null ? null : { aggregate_id: h.aggregate_id, version_id: h.version_id });
/** Structural correspondence of server-captured rows only. athleteId binds
 * the caller's expected capture scope, but source DTOs carry no tenant field;
 * matching client JSON never authenticates ownership or current permission. */
export function validateWorkoutTemplateReadSources(unknownProjection: unknown) {
  const blockers: WorkoutTemplateReadBlocker[] = [];
  const block = (path: string, reason: WorkoutTemplateReadBlocker['reason']) => {
    blockers.push({ path, reason });
  };
  const result = (value: unknown | null) => ({
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    complete: false as const,
    blockers,
    digest: value === null ? null : digest(value),
  });
  try {
    const json = JSON.stringify(unknownProjection);
    if (!json || Buffer.byteLength(json, 'utf8') > 4194304) {
      block('projection', 'bounds_exceeded');
      return result(null);
    }
  } catch {
    block('projection', 'invalid_projection');
    return result(null);
  }
  const decoded = workoutTemplateReadProjectionSchema.safeParse(unknownProjection);
  if (!decoded.success) {
    block('projection', 'invalid_projection');
    return result(null);
  }
  const c = decoded.data,
    expected = new Map(c.requests.map((r) => [key(r), r]));
  const rows = new Map(c.catalogRows.map((r) => [key(r.requested), r]));
  if (rows.size !== c.catalogRows.length) block('catalogRows', 'source_identity_mismatch');
  for (const k of rows.keys()) if (!expected.has(k)) block('catalogRows', 'unused_source');
  for (const k of expected.keys()) if (!rows.has(k)) block('catalogRows', 'source_unavailable');
  const f = c.sourceFacts;
  if (!f) {
    if (expected.size) block('sourceFacts', 'source_port_missing');
    return result(blockers.length ? null : c);
  }
  if (c.requests.length + f.targets.length + f.exerciseFacts.length > 5000)
    block('projection', 'bounds_exceeded');
  const sourceRequests = new Map(f.requests.map((r) => [key(r), r])),
    facts = new Map(f.templateFacts.map((r) => [key(r.requested), r]));
  if (sourceRequests.size !== f.requests.length || facts.size !== f.templateFacts.length)
    block('sourceFacts.requests', 'source_identity_mismatch');
  for (const k of expected.keys())
    if (!sourceRequests.has(k) || !facts.has(k))
      block('sourceFacts.requests', 'source_unavailable');
  for (const k of [...sourceRequests.keys(), ...facts.keys()])
    if (!expected.has(k)) block('sourceFacts.requests', 'unused_source');
  const bodies = new Map(f.templates.map((b) => [JSON.stringify([b.routineId, b.versionId]), b]));
  if (
    bodies.size !== f.templates.length ||
    new Set(f.templates.map((b) => b.versionId)).size !== f.templates.length
  )
    block('sourceFacts.templates', 'source_identity_mismatch');
  const exercises = new Map(f.exercises.map((e) => [e.record.versionId, e])),
    exerciseFacts = new Map(f.exerciseFacts.map((e) => [e.requestedVersionId, e]));
  if (exercises.size !== f.exercises.length || exerciseFacts.size !== f.exerciseFacts.length)
    block('sourceFacts.exercises', 'source_identity_mismatch');
  const consumedExercises = new Set<string>(),
    expectedTargets: string[] = [],
    usedBodies = new Set<string>();
  for (const [k, r] of expected) {
    const fact = facts.get(k),
      catalog = rows.get(k),
      body = bodies.get(k),
      path = `template:${r.ref.versionId}`;
    if (!fact || !catalog) continue;
    if (fact.state === 'unavailable' || catalog.state === 'unavailable') {
      block(path, 'source_unavailable');
      if (
        fact.state !== catalog.state ||
        fact.reason !== 'owned_version_unavailable' ||
        catalog.reason !== 'owned_version_unavailable' ||
        fact.content !== null ||
        catalog.content !== null ||
        fact.currentHead !== null ||
        catalog.currentHead !== null ||
        body
      )
        block(path, 'source_identity_mismatch');
      if (catalog.exercises?.length) block(path, 'unused_source');
      continue;
    }
    if (!body) {
      block(path, 'source_unavailable');
      continue;
    }
    usedBodies.add(k);
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1048576) block(path, 'bounds_exceeded');
    if (
      fact.reason !== null ||
      catalog.reason !== null ||
      fact.state !== catalog.state ||
      !equal(publicHead(fact.currentHead), catalog.currentHead) ||
      (fact.currentHead !== null && fact.currentHead.aggregate_id !== body.routineId) ||
      (fact.state === 'current') !== (fact.currentHead?.version_id === body.versionId)
    )
      block(path, 'source_identity_mismatch');
    if (fact.content?.digest !== digest(body) || catalog.content?.digest !== digest(body))
      block(path, 'source_digest_mismatch');
    const wanted = new Set<string>();
    for (const b of body.spec.blocks)
      for (const s of b.sets) {
        wanted.add(s.exerciseVersionId);
        consumedExercises.add(s.exerciseVersionId);
        expectedTargets.push(JSON.stringify([body.versionId, b.id, s.id, s.exerciseVersionId]));
      }
    const linked = catalog.exercises;
    if (!linked) {
      block(path, 'catalog_exercise_port_missing');
      continue;
    }
    const byLink = new Map(linked.map((e) => [e.requestedVersionId, e]));
    if (
      byLink.size !== linked.length ||
      byLink.size !== wanted.size ||
      [...byLink.keys()].some((v) => !wanted.has(v))
    )
      block(path, 'source_membership_mismatch');
    for (const id of wanted) {
      const e = exercises.get(id),
        ef = exerciseFacts.get(id),
        l = byLink.get(id),
        epath = `exercise:${id}`;
      if (!e || !ef || !l || ef.state === 'unavailable' || l.state === 'unavailable') {
        block(epath, 'source_unavailable');
        continue;
      }
      const b = e.record;
      if (Buffer.byteLength(JSON.stringify(b), 'utf8') > 65536) block(epath, 'bounds_exceeded');
      if (
        ef.reason !== null ||
        ef.content?.exerciseId !== b.exerciseId ||
        ef.content.versionId !== b.versionId ||
        l.content?.exerciseId !== b.exerciseId ||
        l.content.versionId !== b.versionId ||
        !equal(publicHead(ef.currentHead), l.currentHead) ||
        (ef.currentHead !== null &&
          (ef.currentHead.aggregate_id !== b.exerciseId ||
            ef.currentHead.version < e.version ||
            (ef.currentHead.version === e.version) !==
              (ef.currentHead.version_id === b.versionId))) ||
        (ef.state === 'current') !== (ef.currentHead?.version_id === b.versionId)
      )
        block(epath, 'source_identity_mismatch');
      if (ef.content?.digest !== digest(b) || l.content?.digest !== digest(b))
        block(epath, 'source_digest_mismatch');
      if (
        !equal(l.content?.resourceVersionIds, b.resourceVersionIds) ||
        !equal(l.content?.mediaAssetIds, b.mediaAssetIds)
      )
        block(epath, 'source_membership_mismatch');
      if (b.resourceVersionIds.length) {
        const retained = c.resourceReadFacts;
        if (!retained) block(epath, 'resource_permission_port_missing');
        else {
          if (validateResourceRetainedReadFacts(retained).status !== 'validated_read_sources')
            block(epath, 'source_unavailable');
          for (const resourceVersionId of b.resourceVersionIds) {
            const normalized = uuid.safeParse(resourceVersionId);
            const fact = retained.facts.find(
              (row) =>
                row.requestedVersionId ===
                (normalized.success ? normalized.data : resourceVersionId),
            );
            if (!fact || !fact.record || !['current', 'historical'].includes(fact.state))
              block(epath, 'source_unavailable');
          }
        }
      }
      if (b.mediaAssetIds.length) {
        const retained = c.mediaReadFacts;
        if (!retained) block(epath, 'media_permission_port_missing');
        else {
          if (validateMediaRetainedReadFacts(retained).status !== 'validated_read_sources')
            block(epath, 'source_unavailable');
          for (const mediaId of b.mediaAssetIds) {
            const normalized = uuid.safeParse(mediaId);
            const fact = retained.facts.find(
              (row) => row.requestedId === (normalized.success ? normalized.data : mediaId),
            );
            if (!fact || fact.state !== 'owned' || fact.record === null)
              block(epath, 'source_unavailable');
          }
        }
      }
    }
  }
  for (const k of bodies.keys())
    if (!usedBodies.has(k)) block('sourceFacts.templates', 'unused_source');
  for (const id of [...exercises.keys(), ...exerciseFacts.keys()])
    if (!consumedExercises.has(id)) block('sourceFacts.exercises', 'unused_source');
  const actualTargets = f.targets.map((t) =>
    JSON.stringify([t.routineVersionId, t.blockId, t.setId, t.exerciseVersionId]),
  );
  if (
    new Set(actualTargets).size !== actualTargets.length ||
    !equal(actualTargets.sort(order), expectedTargets.sort(order))
  )
    block('sourceFacts.targets', 'source_membership_mismatch');
  return result(blockers.length ? null : c);
}
