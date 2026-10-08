import { expect, it } from 'vitest';
import type { Transaction } from '../src/database.js';
import { readManualRetainedSourceExportBatchV1In } from '../src/manual-retained-source-export-batch-reader.js';
import { mapManualSourcePersonalExportV1 } from '../src/manual-source-personal-export.js';
import { normalizeRaceManualImpactProjectionCapture } from '../src/race-manual-public-impact.js';
import { raceImpactConsumedCaptureSchema } from '../src/race-plan-impact-complete-manifest.js';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
} from '../src/race-plan-impact-projection-input.js';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExport,
} from '../src/race-manual-internal-personal-export-renderer.js';
import { enumerateRaceManualReviewFullCopiedSourcesV2 } from '../src/race-manual-review-full-copied-inventory-v2.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  athlete = 'synthetic-impact',
  now = '2026-10-08T00:00:00.123456Z';
function fixture() {
  const absent = { state: 'absent' };
  const c = raceImpactConsumedCaptureSchema.parse({
    status: 'blocked',
    coverage: {
      complete: false,
      missing: [
        'complete_catalog_and_actual_manifest',
        'supplementary_reference_manifest',
        'routine_occurrences_and_started_runs',
        'complete_source_permission_manifest',
        'manual_purpose_app_and_policy_binding',
      ],
      captured: [
        'integrated_dependency_inventory',
        'immutable_supplementary_copy_references',
        'routine_occurrence_run_and_actual_reference_facts',
        'partial_owned_planned_reference_and_resource_permission_facts',
        'nested_nutrition_plan_food_anchor_and_activity_media_provider_facts',
        'manual_purpose_app_and_policy_facts',
      ],
    },
    athleteId: athlete,
    restoreGeneration: id(1),
    manualBasis: {
      purpose: 'manual_race_date_change',
      policy: { id: 'manual-race-date-impact', version: 1, digest: hash },
      app: { state: 'present', granted: true, revision: 1 },
    },
    event: {
      id: id(2),
      revision: 1,
      title: 'Race',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'UTC',
      locationName: 'Private location',
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
    collections: [
      { kind: 'race-event', revision: 1, privacy_generation: '0' },
      { kind: 'race-result', revision: 1, privacy_generation: '0' },
      { kind: 'training-best', revision: 1, privacy_generation: '0' },
    ],
    linkedPlan: null,
    currentTraining: null,
    completions: [],
    course: null,
    rosters: { nutrition: [], recovery: [], routine: [] },
    nutrition: [],
    recovery: [],
    routines: [],
    coreDependencies: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: athlete,
      capturedAt: now,
      trainingPlan: { kind: 'absent' },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
    },
    dependencyInventory: integratedDependencyKinds.map((kind) => ({ kind, state: 'absent' })),
    supplementaryManifest: { sessions: [], copies: [], routines: [], exercises: [] },
    routineActualManifest: {
      uniqueSourceCount: 0,
      occurrences: [],
      runs: [],
      blueprints: [],
      schedules: [],
      actualRosters: { activities: [], intake: [], recovery: [] },
    },
    sourcePermissionManifest: {
      complete: false,
      planned: [],
      resources: [],
      catalog: [],
      nestedNutritionSources: [],
      activityMediaPermissions: {
        activities: [],
        garminLineage: [],
        healthkit: [],
        media: [],
        healthkitRegistry: absent,
        garmin: absent,
        garminUnofficial: absent,
        consents: ['provider', 'healthkit', 'media'].map((kind) => ({ kind, ...absent })),
      },
      aiConsent: absent,
      missing: [
        'unsupported_domain_item_membership',
        'immutable_training_aggregate_history',
        'media_cleanup_status_port',
        'media_and_provider_source_permissions',
        'manual_purpose_app_and_policy_binding',
      ],
    },
    consumedSources: { plans: [], races: [] },
    readSetDigest: hash,
    affected: { nutrition: [], routine: [] },
  });
  c.consumedSources.races = [structuredClone(c.event)];
  c.calendarIntent = {
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
    resolutions: { nutrition: [], routines: [] },
  };
  return pin(c);
}
function pin(c: ReturnType<typeof raceImpactConsumedCaptureSchema.parse>) {
  const { status, coverage, readSetDigest, affected, ...set } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = impactDependencyDigest({
    ...set,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  return { context: c, intent: c.calendarIntent };
}
function fromCapture(f: ReturnType<typeof fixture>) {
  const c = f.context;
  let capture = normalizeRaceManualImpactProjectionCapture(c);
  let built = buildRacePlanImpactProjectionInput(capture, f.intent);
  if (built.status !== 'projected') throw Error('fixture');
  c.collectorSelection = built.collectorSelection;
  pin(c);
  capture = normalizeRaceManualImpactProjectionCapture(c);
  built = buildRacePlanImpactProjectionInput(capture, f.intent);
  if (built.status !== 'projected' || c.manualBasis.app.state !== 'present') throw Error('fixture');
  const sourceInput = {
    athleteId: c.athleteId,
    binding: {
      purpose: c.manualBasis.purpose,
      event: { id: c.event.id, revision: c.event.revision },
      appRevision: c.manualBasis.app.revision,
      policy: c.manualBasis.policy,
      restoreGeneration: c.restoreGeneration,
      readSetDigest: c.readSetDigest,
    },
    projectionInput: built.input,
    sourceFacts: built.sourceFacts,
  };
  const candidate = assembleRaceManualReviewCandidateCompatibleV4(
    sourceInput,
    createRacePlanImpactCapturedCalculationPorts(capture),
  );
  if (candidate.status !== 'assembled_readonly') throw Error('fixture assembled');
  const ids = { evidenceId: id(20), decisionId: id(21), proposalId: id(22) };
  return raceManualInternalPersonalExportSourceSchema.parse({
    schemaVersion: 1,
    chains: [
      {
        ...ids,
        createdAt: now,
        originalResult: {
          schemaVersion: 2,
          ...ids,
          candidateDigest: candidate.digest,
          createdAt: now,
          applicable: false,
          approvalAllowed: false,
        },
        bodyState: 'present',
        preparation: { context: c, sourceInput, candidate },
        purge: null,
      },
    ],
    candidates: [],
    approvalResults: [],
    approvalHistory: [],
  });
}
// Pure strict builder fixtures, not PG source authentication or original events.
function present() {
  const internal = fromCapture(fixture());
  const c = internal.chains[0];
  if (!c || c.bodyState !== 'present') throw Error('FIXTURE');
  const inventory = enumerateRaceManualReviewFullCopiedSourcesV2(c.preparation);
  if (inventory.inventoryState !== 'mapped') throw Error('FIXTURE_INVENTORY');
  const oldManual = {
    schemaVersion: 1,
    chains: [
      {
        evidenceId: c.evidenceId,
        decisionId: c.decisionId,
        proposalId: c.proposalId,
        savedRefCount: inventory.refs.length,
        savedParentCount: 1,
        savedSuppressionCount: 0,
        body: { state: 'present' },
        preparation: c.preparation,
      },
    ],
    refs: inventory.refs.map((r, index) => ({
      evidenceId: c.evidenceId,
      ordinal: index + 1,
      identity: r.identity,
      dtoDigest: r.dtoDigest,
      copiedLocations: r.copiedLocations,
      trainingAggregateId: null,
      sourceKind: null,
      parentCoverage: 'saved_parents',
      existence: { basis: 'export_snapshot', state: 'present' },
      location: { state: 'unavailable', reason: 'private_source_not_rendered' },
    })),
    parents: [
      {
        evidenceId: c.evidenceId,
        ordinal: 1,
        edge: {
          family: 'race-event',
          sourceId: id(2),
          versionKey: '1',
          role: 'source',
          membershipKey: null,
        },
      },
    ],
    suppressions: [],
  };
  const first = oldManual.chains[0];
  if (!first) throw Error('FIXTURE');
  const { preparation: _p, ...row } = first;
  return {
    source: {
      schemaVersion: 1,
      internal,
      sourceMetadata: {
        ...oldManual,
        chains: [
          {
            ...row,
            preparationBinding: {
              state: 'present',
              digestMethod: 'postgres-jsonb-v1',
              digest: 'b'.repeat(64),
            },
          },
        ],
      },
    },
    preparationBindings: [{ evidenceId: c.evidenceId, digest: 'b'.repeat(64) }],
  };
}
const nutrition = { schemaVersion: 1, origins: [], lineage: [] };
function fake(
  raw: unknown = present(),
  options: { reported?: number; installed?: boolean; nullBody?: boolean } = {},
) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let reads = 0;
  const measured = [
    options.reported ?? Buffer.byteLength(JSON.stringify(raw), 'utf8') + 64,
    Buffer.byteLength(JSON.stringify(nutrition), 'utf8') + 32,
  ];
  const tx: Transaction = {
    athleteId: athlete,
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('to_regprocedure'))
        return {
          rows: [{ installed: options.installed ?? true, executable: options.installed ?? true }],
          rowCount: 1,
        };
      const n = reads++;
      return {
        rows: [
          {
            bytes: String(measured[n]),
            source: n === 0 ? (options.nullBody ? null : raw) : nutrition,
          },
        ],
        rowCount: 1,
      };
    },
  };
  return { tx, calls, measured };
}
it('strict real-shaped preparation reuse preserves renderer and source output, with one measured batch and separate nutrition debit', async () => {
  const raw = present(),
    f = fake(raw),
    debits: number[] = [];
  const result = await readManualRetainedSourceExportBatchV1In(f.tx, 8388608, (n) =>
    debits.push(n),
  );
  expect(result.internal).toEqual(renderRaceManualInternalPersonalExport(raw.source.internal));
  const row = raw.source.sourceMetadata.chains[0];
  const chain = raw.source.internal.chains[0];
  if (!row || !chain) throw Error('FIXTURE');
  const { preparationBinding: _b, ...rest } = row;
  expect(result.sources).toEqual(
    mapManualSourcePersonalExportV1(
      { ...raw.source.sourceMetadata, chains: [{ ...rest, preparation: chain.preparation }] },
      nutrition,
    ),
  );
  expect(debits).toEqual(f.measured);
  const bodyCalls = f.calls.filter((c) => c.sql.includes('WITH observed'));
  expect(bodyCalls).toHaveLength(2);
  expect(bodyCalls[0]?.sql.match(/read_manual_race_retained_source_batch_v1\(/g)).toHaveLength(1);
  expect(bodyCalls[0]?.sql).toContain('ORDER BY ordinal');
  expect(bodyCalls[0]?.sql).toContain("convert_to((chain->'preparation')::text,'UTF8')");
  expect(bodyCalls[1]?.values).toEqual([8388608 - (f.measured[0] ?? 0)]);
  expect(JSON.stringify(result)).not.toContain('preparationBindings');
  expect(JSON.stringify(result)).not.toContain('copiedLocations');
  expect(result.sources.sourceAuthentication).toBe('not_authenticated');
});
it.each([
  'triplet',
  'missing',
  'extra',
  'duplicate',
  'binding',
  'body',
  'ordinal',
  'parent',
  'digest',
  'proof',
  'proofExtra',
] as const)('rejects %s batch correspondence without another body read', async (kind) => {
  const raw = present();
  const m = raw.source.sourceMetadata;
  const c = m.chains[0];
  const r = m.refs[0];
  const p = m.parents[0];
  const b = raw.preparationBindings[0];
  if (!c || !r || !p || !b) throw Error('FIXTURE');
  let input: unknown = raw;
  if (kind === 'triplet') c.decisionId = id(80);
  if (kind === 'missing') m.chains = [];
  if (kind === 'extra' || kind === 'duplicate')
    m.chains.push({ ...c, evidenceId: kind === 'extra' ? id(80) : c.evidenceId });
  if (kind === 'binding') c.preparationBinding.digest = 'c'.repeat(64);
  if (kind === 'body') c.body.state = 'purged';
  if (kind === 'ordinal') r.ordinal = 2;
  if (kind === 'parent') p.edge.sourceId = id(80);
  if (kind === 'digest') r.dtoDigest = 'c'.repeat(64);
  if (kind === 'proof') b.evidenceId = id(80);
  if (kind === 'proofExtra') input = { ...raw, proofAuthority: true };
  const f = fake(input);
  await expect(readManualRetainedSourceExportBatchV1In(f.tx)).rejects.toThrow('CORRUPT');
  // Source full mapper checks occur after nutrition transport, but invalid
  // batch/body bindings fail before nutrition; no extra/retried batch call.
  expect(
    f.calls.filter((c) => c.sql.includes('read_manual_race_retained_source_batch_v1($1')),
  ).toHaveLength(1);
});
it('rejects unsupported RPC before body query', async () => {
  const f = fake(undefined, { installed: false });
  await expect(readManualRetainedSourceExportBatchV1In(f.tx)).rejects.toThrow('UNSUPPORTED');
  expect(f.calls).toHaveLength(1);
});
it.each([
  { reported: 8388609, expected: 'TOO_LARGE' },
  { reported: 1, expected: 'CORRUPT' },
  { nullBody: true, expected: 'CORRUPT' },
])('rejects driver budget/null gate and underreported transfer before debit', async (options) => {
  const f = fake(present(), options),
    debits: number[] = [];
  await expect(
    readManualRetainedSourceExportBatchV1In(f.tx, 8388608, (n) => debits.push(n)),
  ).rejects.toThrow(options.expected);
  expect(debits).toEqual([]);
  expect(f.calls.filter((c) => c.sql.includes('WITH observed'))).toHaveLength(1);
});
it('rejects getter/cycle/sparse/private injected input without executing getter', async () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'source', {
    enumerable: true,
    get() {
      invoked++;
      throw Error('GETTER');
    },
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const raw of [
    getter,
    cyclic,
    { ...present(), preparationBindings: new Array(1) },
    { ...present(), rawCache: {} },
  ]) {
    await expect(
      readManualRetainedSourceExportBatchV1In(fake(raw, { reported: 80000 }).tx),
    ).rejects.toThrow('CORRUPT');
  }
  expect(invoked).toBe(0);
});
it.each([0, -1, 8388609, NaN])(
  'rejects invalid remaining budget %s before lookup',
  async (limit) => {
    const f = fake();
    await expect(readManualRetainedSourceExportBatchV1In(f.tx, limit)).rejects.toThrow('CORRUPT');
    expect(f.calls).toEqual([]);
  },
);
function purged() {
  const p = present();
  const c = p.source.internal.chains[0];
  const m = p.source.sourceMetadata.chains[0];
  const r = p.source.sourceMetadata.refs[0];
  if (!c || !m || !r) throw Error('FIXTURE');
  const purge = { purgedAt: now, purgeEventId: id(70) };
  return {
    source: {
      ...p.source,
      internal: {
        ...p.source.internal,
        chains: [{ ...c, bodyState: 'purged', preparation: null, purge }],
      },
      sourceMetadata: {
        ...p.source.sourceMetadata,
        chains: [
          {
            ...m,
            body: { state: 'purged', eventId: purge.purgeEventId, occurredAt: now },
            savedSuppressionCount: 1,
            preparationBinding: {
              state: 'purged',
              digestMethod: 'postgres-jsonb-v1',
              digest: null,
            },
          },
        ],
        refs: [
          {
            ...r,
            existence: { basis: 'export_snapshot', state: 'deleted' },
            location: { state: 'unavailable', reason: 'payload_purged' },
          },
        ],
        suppressions: [
          {
            evidenceId: c.evidenceId,
            eventId: purge.purgeEventId,
            occurredAt: now,
            recordVersion: 4,
            kind: 'race_event_deleted',
            matchedRefOrdinals: [1],
          },
        ],
      },
    },
    preparationBindings: [{ evidenceId: c.evidenceId, digest: null }],
  };
}
it('preserves genuinely shaped purged metadata/µs with null preparation and deleted fact, no restored body', async () => {
  const result = await readManualRetainedSourceExportBatchV1In(fake(purged()).tx);
  expect(result.internal.manualInternalChains[0]?.body).toEqual({
    state: 'purged',
    purgedAt: now,
    purgeEventId: id(70),
  });
  expect(result.sources.manualSavedSourceRefs[0]?.existence.state).toBe('deleted');
  expect(result.sources.manualSavedSourceSuppressions[0]?.occurredAt).toBe(now);
  expect(JSON.stringify(result)).not.toContain('Race');
});
it.each(['event', 'time', 'restore', 'digest', 'count'] as const)(
  'rejects purged %s contradiction',
  async (kind) => {
    const raw = purged();
    const c = raw.source.sourceMetadata.chains[0];
    if (!c) throw Error('FIXTURE');
    let input: unknown = raw;
    if (kind === 'event') c.body.eventId = id(71);
    if (kind === 'time') c.body.occurredAt = '2026-10-08T00:00:00.123457Z';
    if (kind === 'restore')
      input = {
        ...raw,
        source: {
          ...raw.source,
          sourceMetadata: {
            ...raw.source.sourceMetadata,
            chains: [{ ...c, preparation: present().source.internal.chains[0]?.preparation }],
          },
        },
      };
    if (kind === 'digest')
      input = {
        ...raw,
        preparationBindings: [{ evidenceId: c.evidenceId, digest: 'a'.repeat(64) }],
      };
    if (kind === 'count') c.savedSuppressionCount = 0;
    await expect(readManualRetainedSourceExportBatchV1In(fake(input).tx)).rejects.toThrow(
      'CORRUPT',
    );
  },
);
it('preserves empty independent actual census without inventing chains or preparation', async () => {
  const raw = {
    source: {
      schemaVersion: 1,
      internal: {
        schemaVersion: 1,
        chains: [],
        candidates: [],
        approvalResults: [],
        approvalHistory: [],
      },
      sourceMetadata: { schemaVersion: 1, chains: [], refs: [], parents: [], suppressions: [] },
    },
    preparationBindings: [],
  };
  const output = await readManualRetainedSourceExportBatchV1In(fake(raw).tx);
  expect(output.internal.manualInternalChains).toEqual([]);
  expect(output.sources.manualSourceChains).toEqual([]);
});
function pair() {
  const p = present();
  const c = p.source.internal.chains[0];
  const m = p.source.sourceMetadata.chains[0];
  const r = p.source.sourceMetadata.refs[0];
  const e = p.source.sourceMetadata.parents[0];
  const proof = p.preparationBindings[0];
  if (!c || !m || !r || !e || !proof) throw Error('FIXTURE');
  const ids = { evidenceId: id(80), decisionId: id(81), proposalId: id(82) };
  p.source.internal.chains.push({ ...c, ...ids, originalResult: { ...c.originalResult, ...ids } });
  p.source.sourceMetadata.chains.push({ ...m, ...ids });
  p.source.sourceMetadata.refs.push({ ...r, evidenceId: ids.evidenceId });
  p.source.sourceMetadata.parents.push({ ...e, evidenceId: ids.evidenceId });
  p.preparationBindings.push({ ...proof, evidenceId: ids.evidenceId });
  return p;
}
it('retains two independent stored chains sharing the same frozen source body', async () => {
  const result = await readManualRetainedSourceExportBatchV1In(fake(pair()).tx);
  expect(result.internal.manualInternalChains).toHaveLength(2);
  expect(result.sources.manualSourceChains).toHaveLength(2);
  expect(result.sources.manualSavedSourceRefs).toHaveLength(2);
});
it.each(['proofOrder', 'metadataOrder', 'duplicateInternal'] as const)(
  'rejects %s exact ordered chain correspondence',
  async (kind) => {
    const raw = pair();
    if (kind === 'proofOrder') raw.preparationBindings.reverse();
    if (kind === 'metadataOrder') raw.source.sourceMetadata.chains.reverse();
    if (kind === 'duplicateInternal') {
      const first = raw.source.internal.chains[0];
      if (!first) throw Error('FIXTURE');
      raw.source.internal.chains[1] = first;
    }
    await expect(readManualRetainedSourceExportBatchV1In(fake(raw).tx)).rejects.toThrow('CORRUPT');
  },
);
it('rejects accessor driver headers before invoking them or debiting', async () => {
  const f = fake();
  const query = f.tx.query;
  let invoked = 0;
  f.tx.query = async (sql, values) => {
    const r = await query(sql, values);
    if (sql.includes('WITH observed')) {
      const row = Object.defineProperty({ source: present() }, 'bytes', {
        enumerable: true,
        get() {
          invoked++;
          return '80000';
        },
      });
      return { rows: [row], rowCount: 1 };
    }
    return r;
  };
  await expect(readManualRetainedSourceExportBatchV1In(f.tx)).rejects.toThrow('CORRUPT');
  expect(invoked).toBe(0);
});
it.each([
  { code: '42501', target: 'batch' },
  { code: '42883', target: 'batch' },
  { code: '42501', target: 'nutrition' },
  { code: '42883', target: 'nutrition' },
])(
  'maps vanished/revoked $target RPC $code to unsupported after a positive probe, without fallback',
  async ({ code, target }) => {
    const f = fake(),
      query = f.tx.query;
    f.tx.query = async (sql, values) => {
      if (
        sql.includes('WITH observed') &&
        sql.includes(
          target === 'batch'
            ? 'read_manual_race_retained_source_batch_v1'
            : 'read_nutrition_disconnection_personal_export_v1',
        )
      ) {
        throw Object.assign(new Error('private relation detail must not escape'), { code });
      }
      return query(sql, values);
    };
    await expect(readManualRetainedSourceExportBatchV1In(f.tx)).rejects.toThrow('UNSUPPORTED');
    expect(f.calls.some((c) => c.sql.includes('read_manual_race_source_personal_export_v1'))).toBe(
      false,
    );
  },
);
