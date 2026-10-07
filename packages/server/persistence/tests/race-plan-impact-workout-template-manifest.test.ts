import { mediaRetainedReadFactsSchema } from '../src/race-plan-impact-media-read-facts.js';
import { expect, it } from 'vitest';
import {
  routineTemplateVersionSchema,
  supplementaryExerciseVersionSchema,
} from '@workout/contracts/supplementary-core';
import { workoutTemplateSourceFactsSchema } from '../src/race-plan-impact-workout-template-sources.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
import {
  validateWorkoutTemplateReadSources,
  workoutTemplateReadProjectionSchema,
} from '../src/race-plan-impact-workout-template-manifest.js';
const start = '2026-09-18T09:00:00+09:00';
const ids = {
  exercise: '11111111-1111-4111-8111-111111111111',
  exerciseVersion: '22222222-2222-4222-8222-222222222222',
  routine: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  routineVersion: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  planVersion: '55555555-5555-4555-8555-555555555555',
  activity: '66666666-6666-4666-8666-666666666666',
  execution: '77777777-7777-4777-8777-777777777777',
  log: '88888888-8888-4888-8888-888888888888',
  revision: '99999999-9999-4999-8999-999999999999',
  timer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nextVersion: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  otherActivity: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const target = {
  id: 'target-1',
  exerciseVersionId: ids.exerciseVersion,
  side: 'left',
  count: {
    target: { min: 8, max: 10, unit: 'count', basis: 'user_confirmed', evidenceIds: [] },
    definition: { kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' },
  },
  durationSeconds: null,
  externalResistance: { kind: 'no_added_load' },
  restAfterSeconds: 60,
  tempo: null,
  effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
};
const spec = {
  schemaVersion: 2,
  kind: 'supplementary',
  routineVersionId: ids.routineVersion,
  blocks: [
    {
      id: 'block-1',
      mode: 'single',
      rounds: 2,
      sets: [target],
      restBetweenRoundsSeconds: null,
    },
  ],
};
const definition = {
  schemaVersion: 2,
  exerciseId: ids.exercise,
  versionId: ids.exerciseVersion,
  name: 'Single-leg balance',
  family: 'balance_stability',
  equipment: ['bodyweight'],
  tags: ['balance'],
  countDefinitions: [{ kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' }],
  mediaAssetIds: [],
  resourceVersionIds: [],
  reviewState: 'unreviewed',
  description: 'User-defined movement',
  safetyNotes: '',
  supportedMetrics: ['count', 'duration', 'effort'],
  createdAt: start,
};
const template = {
  schemaVersion: 2,
  routineId: ids.routine,
  versionId: ids.routineVersion,
  title: 'Balance routine',
  purpose: 'User-defined practice',
  requiredEquipment: ['bodyweight'],
  spec,
  createdAt: start,
};

const body = routineTemplateVersionSchema.parse(template),
  exercise = supplementaryExerciseVersionSchema.parse(definition);
const req = workoutTemplateSourceFactsSchema.shape.requests.element.parse({
  kind: 'workout_template',
  ref: { id: body.routineId, versionId: body.versionId },
});

function fixture() {
  const head = { aggregate_id: body.routineId, version_id: body.versionId },
    eh = { aggregate_id: exercise.exerciseId, version_id: exercise.versionId };
  return workoutTemplateReadProjectionSchema.parse({
    athleteId: 'owner',
    requests: [req],
    catalogRows: [
      {
        requested: req,
        state: 'current',
        reason: null,
        content: { digest: digest(body) },
        currentHead: head,
        exercises: [
          {
            requestedVersionId: exercise.versionId,
            state: 'owned',
            content: {
              exerciseId: exercise.exerciseId,
              versionId: exercise.versionId,
              digest: digest(exercise),
              resourceVersionIds: [],
              mediaAssetIds: [],
            },
            currentHead: eh,
          },
        ],
      },
    ],
    sourceFacts: {
      requests: [req],
      templates: [body],
      templateFacts: [
        {
          requested: req,
          state: 'current',
          reason: null,
          content: { digest: digest(body) },
          currentHead: { ...head, version: 1 },
        },
      ],
      exercises: [{ record: exercise, version: 1 }],
      exerciseFacts: [
        {
          requestedVersionId: exercise.versionId,
          state: 'current',
          reason: null,
          content: {
            exerciseId: exercise.exerciseId,
            versionId: exercise.versionId,
            digest: digest(exercise),
          },
          currentHead: { ...eh, version: 1 },
        },
      ],
      targets: [
        {
          routineVersionId: body.versionId,
          blockId: 'block-1',
          setId: 'target-1',
          exerciseVersionId: exercise.versionId,
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
    },
  });
}
function owned() {
  const c = fixture();
  if (!c.sourceFacts) throw Error('facts');
  return { c, f: c.sourceFacts };
}
function blocks(value: unknown, reason: string) {
  const r = validateWorkoutTemplateReadSources(value);
  expect(r).toMatchObject({
    status: 'blocked',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    digest: null,
  });
  expect(r.blockers.some((b) => b.reason === reason)).toBe(true);
}
function refresh(c: ReturnType<typeof fixture>) {
  const f = c.sourceFacts;
  if (!f) throw Error('facts');
  const b = f.templates[0],
    e = f.exercises[0],
    tf = f.templateFacts[0],
    ef = f.exerciseFacts[0],
    row = c.catalogRows[0],
    linked = row?.exercises?.[0];
  if (!b || !e || !tf || !ef || !row || !linked) throw Error('fixture');
  tf.content = { digest: digest(b) };
  row.content = { digest: digest(b) };
  ef.content = {
    exerciseId: e.record.exerciseId,
    versionId: e.record.versionId,
    digest: digest(e.record),
  };
  linked.content = {
    ...ef.content,
    resourceVersionIds: e.record.resourceVersionIds,
    mediaAssetIds: e.record.mediaAssetIds,
  };
}
it('validates exact current full template/exercise/targets only as readonly source correspondence', () => {
  const c = fixture(),
    before = structuredClone(c),
    r = validateWorkoutTemplateReadSources(c);
  expect(r).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    blockers: [],
  });
  expect(r.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(c).toEqual(before);
});
it('closed empty workload requires no invented source port', () => {
  expect(
    validateWorkoutTemplateReadSources({ athleteId: 'owner', requests: [], catalogRows: [] }),
  ).toMatchObject({ status: 'validated_read_sources' });
  expect(
    validateWorkoutTemplateReadSources({
      athleteId: 'owner',
      requests: [],
      catalogRows: [],
      sourceFacts: workoutTemplateSourceFactsSchema.parse({
        requests: [],
        templates: [],
        templateFacts: [],
        exercises: [],
        exerciseFacts: [],
        targets: [],
        authority: 'none',
        freshness: 'not_checked',
      }),
    }),
  ).toMatchObject({ status: 'validated_read_sources' });
});
it('normalizes UUID case and duplicate consumedbindings without accepting duplicate catalog rows', () => {
  const c = fixture();
  c.requests.push({
    ...req,
    ref: { id: body.routineId.toUpperCase(), versionId: body.versionId.toUpperCase() },
  });
  expect(validateWorkoutTemplateReadSources(c).status).toBe('validated_read_sources');
  const row = c.catalogRows[0];
  if (!row) throw Error('row');
  c.catalogRows.push(row);
  blocks(c, 'source_identity_mismatch');
});
it('supports actual historical pins with later head or absent head', () => {
  for (const later of [true, false]) {
    const { c, f } = owned();
    const tf = f.templateFacts[0],
      ef = f.exerciseFacts[0],
      row = c.catalogRows[0],
      link = row?.exercises?.[0];
    if (!tf || !ef || !row || !link) throw Error('row');
    tf.state = 'historical';
    ef.state = 'historical';
    row.state = 'historical';
    tf.currentHead = later
      ? { aggregate_id: body.routineId, version_id: ids.nextVersion, version: 2 }
      : null;
    ef.currentHead = later
      ? { aggregate_id: exercise.exerciseId, version_id: ids.nextVersion, version: 2 }
      : null;
    row.currentHead = later ? { aggregate_id: body.routineId, version_id: ids.nextVersion } : null;
    link.currentHead = later
      ? { aggregate_id: exercise.exerciseId, version_id: ids.nextVersion }
      : null;
    expect(validateWorkoutTemplateReadSources(c).status).toBe('validated_read_sources');
  }
});
it('nonempty missing source port remains specifically blocked', () => {
  const c = fixture();
  const { sourceFacts: _source, ...input } = c;
  void _source;
  blocks(input, 'source_port_missing');
});
it('absent foreign/erased body is unavailable, never completed catalog proof', () => {
  const { c, f } = owned(),
    row = c.catalogRows[0],
    fact = f.templateFacts[0];
  if (!row || !fact) throw Error('row');
  f.templates = [];
  f.targets = [];
  f.exercises = [];
  f.exerciseFacts = [];
  fact.state = 'unavailable';
  fact.reason = 'owned_version_unavailable';
  fact.content = null;
  fact.currentHead = null;
  row.state = 'unavailable';
  row.reason = 'owned_version_unavailable';
  row.content = null;
  row.currentHead = null;
  delete row.exercises;
  blocks(c, 'source_unavailable');
});
it.each(['templateFacts', 'requests', 'templates'] as const)(
  'missing exact source %s never substitutes a latest body',
  (field) => {
    const { c, f } = owned();
    f[field] = [];
    blocks(c, 'source_unavailable');
  },
);
it.each(['requests', 'templateFacts', 'templates', 'exerciseFacts', 'exercises'] as const)(
  'rejects duplicate source roster %s',
  (field) => {
    const { c, f } = owned();
    const rows = f[field];
    const first = rows[0];
    if (!first) throw Error('row');
    blocks({ ...c, sourceFacts: { ...f, [field]: [...rows, first] } }, 'source_identity_mismatch');
  },
);
it.each(['template', 'exercise', 'catalog', 'linked'] as const)(
  'rejects exactbody digest mismatch %s',
  (kind) => {
    const { c, f } = owned(),
      tf = f.templateFacts[0],
      ef = f.exerciseFacts[0],
      row = c.catalogRows[0],
      link = row?.exercises?.[0];
    if (!tf?.content || !ef?.content || !row?.content || !link?.content) throw Error('row');
    if (kind === 'template') tf.content.digest = '0'.repeat(64);
    else if (kind === 'exercise') ef.content.digest = '0'.repeat(64);
    else if (kind === 'catalog') row.content.digest = '0'.repeat(64);
    else link.content.digest = '0'.repeat(64);
    blocks(c, 'source_digest_mismatch');
  },
);
it.each(['aggregate', 'version', 'state', 'ordinal'] as const)(
  'rejects inconsistent exercise head %s',
  (kind) => {
    const { c, f } = owned(),
      ef = f.exerciseFacts[0],
      row = c.catalogRows[0],
      link = row?.exercises?.[0];
    if (!ef?.currentHead || !link) throw Error('head');
    if (kind === 'aggregate') ef.currentHead.aggregate_id = ids.otherActivity;
    else if (kind === 'version') ef.currentHead.version_id = ids.nextVersion;
    else if (kind === 'state') ef.state = 'historical';
    else ef.currentHead.version = 2;
    blocks(c, 'source_identity_mismatch');
  },
);
it.each(['blockId', 'setId', 'exerciseVersionId', 'routineVersionId'] as const)(
  'rejects target multiset wrong %s',
  (field) => {
    const { c, f } = owned(),
      t = f.targets[0];
    if (!t) throw Error('target');
    t[field] = field === 'blockId' || field === 'setId' ? 'foreign' : ids.otherActivity;
    blocks(c, 'source_membership_mismatch');
  },
);
it('rejects unused catalog and unused full source bodies', () => {
  const { c, f } = owned(),
    e = f.exercises[0],
    row = c.catalogRows[0];
  if (!e || !row) throw Error('row');
  c.catalogRows.push({
    ...row,
    requested: {
      kind: 'workout_template',
      ref: { id: ids.otherActivity, versionId: ids.otherActivity },
    },
  });
  blocks(c, 'unused_source');
  const other = owned();
  other.f.exercises.push({
    record: supplementaryExerciseVersionSchema.parse({
      ...exercise,
      exerciseId: ids.otherActivity,
      versionId: ids.otherActivity,
    }),
    version: 1,
  });
  blocks(other.c, 'unused_source');
});
it('requires linked exercise roster exactcoverage and actual full exercise facts', () => {
  const { c, f } = owned(),
    row = c.catalogRows[0];
  if (!row) throw Error('row');
  row.exercises = [];
  blocks(c, 'source_membership_mismatch');
  const other = owned();
  other.f.exercises = [];
  blocks(other.c, 'source_unavailable');
  f.exerciseFacts = [];
  blocks(c, 'source_unavailable');
});
it('catalog exercise port absence is explicit instead of generic JSON admission', () => {
  const c = fixture(),
    row = c.catalogRows[0];
  if (!row) throw Error('row');
  delete row.exercises;
  blocks(c, 'catalog_exercise_port_missing');
});
it.each(['mediaAssetIds', 'resourceVersionIds'] as const)(
  'preserves %s refs but cannot mint their permission',
  (field) => {
    const { c, f } = owned(),
      e = f.exercises[0];
    if (!e) throw Error('record');
    e.record[field] = ['asset-own'];
    refresh(c);
    blocks(
      c,
      field === 'mediaAssetIds'
        ? 'media_permission_port_missing'
        : 'resource_permission_port_missing',
    );
  },
);
it('rejects linked asset roster mismatch even if full record digest matches', () => {
  const c = fixture(),
    link = c.catalogRows[0]?.exercises?.[0];
  if (!link?.content) throw Error('content');
  link.content.mediaAssetIds = ['unconsumed'];
  blocks(c, 'source_membership_mismatch');
});
it('null linked content or missing requested exercise never throws or becomes positive', () => {
  const c = fixture(),
    link = c.catalogRows[0]?.exercises?.[0];
  if (!link) throw Error('link');
  link.content = null;
  blocks(c, 'source_identity_mismatch');
  const other = owned(),
    ef = other.f.exerciseFacts[0];
  if (!ef) throw Error('fact');
  other.f.exercises = [];
  ef.state = 'unavailable';
  ef.reason = 'owned_version_unavailable';
  ef.content = null;
  ef.currentHead = null;
  blocks(other.c, 'source_unavailable');
});
it('unknown tombstone or ownership truth flags are rejected rather than inferred', () => {
  const c = fixture();
  blocks({ ...c, authorized: true }, 'invalid_projection');
  blocks({ ...c, sourceFacts: { ...c.sourceFacts, deleted: false } }, 'invalid_projection');
  const row = c.catalogRows[0];
  if (!row) throw Error('row');
  blocks(
    {
      ...c,
      catalogRows: [
        {
          ...row,
          exercises: [
            {
              requestedVersionId: exercise.versionId,
              state: 'owned',
              content: null,
              currentHead: null,
              granted: true,
            },
          ],
        },
      ],
    },
    'invalid_projection',
  );
});
it('retains withdrawal/zero/null content strictly without eligibility or performance claim', () => {
  const { c, f } = owned(),
    e = f.exercises[0];
  if (!e) throw Error('exercise');
  e.record.reviewState = 'withdrawn';
  refresh(c);
  expect(validateWorkoutTemplateReadSources(c).status).toBe('validated_read_sources');
  expect(f.templates[0]?.spec.blocks[0]?.sets[0]?.durationSeconds).toBeNull();
  expect(f.templates[0]?.spec.blocks[0]?.sets[0]?.effort?.rir).toBe(0);
});
it('counts incoming visits before deduplication', () => {
  const c = fixture();
  c.requests = Array.from({ length: 5000 }, () => req);
  blocks(c, 'bounds_exceeded');
});
it('bounds whole projection at4MiB before schema decoding', () => {
  blocks({ padding: 'x'.repeat(4194304) }, 'bounds_exceeded');
});
it('cycle cannot escape unknown-boundary validation', () => {
  const value: { self?: unknown } = {};
  value.self = value;
  blocks(value, 'invalid_projection');
});

function withOwnedMedia() {
  const { c, f } = owned(),
    e = f.exercises[0];
  if (!e) throw Error('exercise');
  e.record.mediaAssetIds = [ids.activity];
  refresh(c);
  const hash = 'a'.repeat(64);
  c.mediaReadFacts = mediaRetainedReadFactsSchema.parse({
    requestedIds: [ids.activity],
    authority: 'none',
    freshness: 'not_checked',
    sourceScope: 'db_recorded_descriptor_only',
    facts: [
      {
        requestedId: ids.activity,
        state: 'owned',
        reason: null,
        record: {
          id: ids.activity,
          mediaKind: 'image',
          visibility: 'private',
          includeForCoach: false,
          album: null,
          caption: null,
          activityId: null,
          capturedAt: null,
          capturedLocalDate: null,
          file: {
            originalFileName: 'synthetic.png',
            mediaType: 'image/png',
            byteSize: 2,
            sha256: hash,
          },
          preview: null,
          accessRevision: 1,
          createdAt: start,
          updatedAt: start,
        },
        current: { mediaItemId: ids.activity, accessRevision: 1, deleted: false },
        originalLedger: { sha256: hash, byteSize: 2, mediaType: 'image/png' },
        originalObjectIdentityDigest: 'b'.repeat(64),
        previewLedger: null,
        cleanup: {
          status: 'available',
          source: {
            schemaVersion: 1,
            authority: 'db_cleanup_status_only',
            mediaItemId: ids.activity,
            expectedAccessRevision: 1,
            observedAccessRevision: 1,
            deleted: false,
            inventoryComplete: true,
            state: 'absent',
            reason: null,
            refs: [{ digest: 'c'.repeat(64), reason: null, state: 'absent' }],
            digestVersion: 'postgres-jsonb-v1',
            sourceDigest: 'd'.repeat(64),
          },
        },
      },
    ],
  });
  return c;
}
it('accepts exact consumed media descriptors while retaining no authority or byte existence claim', () => {
  const result = validateWorkoutTemplateReadSources(withOwnedMedia());
  expect(result.status).toBe('validated_read_sources');
  expect(result.authority).toBe('none');
  expect(result.freshness).toBe('not_checked');
});
it('blocks consumed media when its descriptor source changes or cleanup port is absent', () => {
  const c = withOwnedMedia(),
    fact = c.mediaReadFacts?.facts[0];
  if (!fact?.record) throw Error('media');
  fact.record.file.sha256 = 'e'.repeat(64);
  blocks(c, 'source_unavailable');
  const unavailable = withOwnedMedia(),
    source = unavailable.mediaReadFacts?.facts[0];
  if (!source) throw Error('media');
  source.cleanup = { status: 'unavailable', reason: 'READ_CAPABILITY_UNAVAILABLE' };
  blocks(unavailable, 'source_unavailable');
});
