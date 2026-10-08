import { describe, expect, it } from 'vitest';
import {
  manualSourcePersonalExportSchema,
  manualSourcePersonalIdentitySchema,
  manualSourcePersonalParentIdentitySchema,
} from '../src/manual-source-personal-export.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function first<T>(values: readonly T[]): T {
  const v = values[0];
  if (v === undefined) throw Error('fixture');
  return v;
}
const source = id(10),
  version = id(11);
const pairs = [
  [
    { kind: 'race-event', sourceId: source, revision: 1 },
    { family: 'race-event', sourceId: source, revision: 1 },
  ],
  [
    { kind: 'plan-snapshot', sourceId: 'legacy-plan', version: 1 },
    { family: 'plan-snapshot', sourceId: 'legacy-plan', version: 1 },
  ],
  [
    { kind: 'nutrition-plan-version', sourceId: source, versionId: version },
    { family: 'nutrition-plan', sourceId: source, versionId: version },
  ],
  [
    { kind: 'routine-schedule-version', sourceId: 'schedule', versionId: 'schedule-v1' },
    { family: 'routine-schedule', sourceId: 'schedule', versionId: 'schedule-v1' },
  ],
  [
    { kind: 'routine-blueprint-version', sourceId: 'blueprint', versionId: 'blueprint-v1' },
    { family: 'routine-blueprint', sourceId: 'blueprint', versionId: 'blueprint-v1' },
  ],
  [
    { kind: 'routine-occurrence', sourceId: 'occurrence' },
    { family: 'routine-occurrence', sourceId: 'occurrence' },
  ],
  [
    { kind: 'routine-run', sourceId: 'run', revision: 0 },
    { family: 'routine-run', sourceId: 'run', version: { kind: 'revision', revision: 0 } },
  ],
  [
    { kind: 'session-completion', sourceId: 'session', planVersionId: version, revision: 0 },
    {
      family: 'session-completion',
      sourceId: 'session',
      version: { planVersionId: version, revision: 0 },
    },
  ],
  [
    { kind: 'food-definition-version', sourceId: 'food', versionId: version },
    { family: 'food-definition', sourceId: 'food', versionId: version },
  ],
  ...(
    ['recovery-method', 'recovery-strategy', 'supplementary-exercise', 'workout-template'] as const
  ).map((f) => [
    { kind: `${f}-version`, sourceId: source, versionId: version },
    { family: f, sourceId: source, versionId: version },
  ]),
  [
    { kind: 'supplementary-session-copy', sourceId: source, sessionId: 'session' },
    { family: 'plan-snapshot', sourceId: source, version: null },
  ],
  [
    { kind: 'activity-canonical-values', sourceId: source, revision: 1 },
    { family: 'activity', sourceId: source, version: { kind: 'revision', revision: 1 } },
  ],
  [
    {
      kind: 'manual-activity-source',
      sourceId: source,
      source: { kind: 'manual', sourceRecordId: version, sourceRevision: 0 },
    },
    {
      family: 'activity',
      sourceId: source,
      version: {
        kind: 'source_revision',
        source: { kind: 'manual', sourceRecordId: version, sourceRevision: 0 },
      },
    },
  ],
  [
    { kind: 'activity-overlay', sourceId: source, revision: 0 },
    { family: 'activity', sourceId: source, version: { kind: 'revision', revision: 0 } },
  ],
  [
    { kind: 'intake-revision', sourceId: '섭취-' + '가'.repeat(1001), revisionId: version },
    { family: 'intake', sourceId: '섭취-' + '가'.repeat(1001), revisionId: version },
  ],
  [
    { kind: 'checkin-revision', sourceId: source, revision: 1 },
    { family: 'checkin', sourceId: source, revision: 1 },
  ],
  [
    {
      kind: 'checklist-confirmation',
      sourceId: 'confirmation',
      revisionId: version,
      runId: 'run',
      stepId: 'step',
    },
    { family: 'checklist-confirmation', sourceId: 'confirmation', revisionId: version },
  ],
  [
    { kind: 'routine-timer', sourceId: 'run', stepId: 'step', revision: 0 },
    {
      family: 'routine-run',
      sourceId: 'run',
      version: { kind: 'timer', stepId: 'step', revision: 0 },
    },
  ],
  [
    { kind: 'course-revision', sourceId: source, revisionId: version, revision: 0 },
    {
      family: 'course',
      sourceId: source,
      version: { kind: 'revision', revisionId: version, revision: 0 },
    },
  ],
  [
    { kind: 'course-head-descriptor', sourceId: source, revision: 1 },
    { family: 'course', sourceId: source, version: { kind: 'head', revision: 1 } },
  ],
  [
    { kind: 'activity-track-descriptor', sourceId: source, trackId: version, revision: 0 },
    { family: 'activity-track', sourceId: source, version: { trackId: version, revision: 0 } },
  ],
  [
    { kind: 'resource-text-version', sourceId: source, versionId: version },
    { family: 'resource', sourceId: source, versionId: version },
  ],
  [
    { kind: 'race-timing-pin-fragment', sourceId: source, revision: 1 },
    { family: 'race-event', sourceId: source, revision: 1 },
  ],
  [
    { kind: 'gallery-descriptor', sourceId: source, accessRevision: 0 },
    { family: 'gallery-media', sourceId: source, accessRevision: 0 },
  ],
];
function fixture(
  identity: unknown = first(pairs)?.[0],
  parentIdentity: unknown = first(pairs)?.[1],
) {
  return manualSourcePersonalExportSchema.parse({
    schemaVersion: 1,
    sourceProvenanceCoverage: 'saved_safe_dependency_facts',
    sourceAuthentication: 'not_authenticated',
    originalEventAuthentication: 'not_authenticated',
    manualSourceChains: [
      {
        evidenceId: id(1),
        decisionId: id(2),
        proposalId: id(3),
        savedRefCount: 1,
        savedParentCount: 1,
        savedSuppressionCount: 0,
        body: { state: 'present' },
      },
    ],
    manualSavedSourceRefs: [
      {
        evidenceId: id(1),
        ordinal: 1,
        identity,
        parentCoverage: 'saved_parents',
        existence: { basis: 'export_snapshot', state: 'present' },
        location: { state: 'unavailable', reason: 'private_source_not_rendered' },
      },
    ],
    manualSavedSourceParents: [
      { evidenceId: id(1), ordinal: 1, identity: parentIdentity, role: 'source', membership: null },
    ],
    manualSavedSourceSuppressions: [],
    nutritionDisconnectionOrigins: [],
    nutritionDisconnectionLineage: [],
  });
}
describe('safe saved personal source facts', () => {
  it('covers exact27 namespaces and preserves original product tuples', () => {
    expect(pairs).toHaveLength(27);
    for (const [identity, parent] of pairs) {
      expect(manualSourcePersonalIdentitySchema.safeParse(identity).success).toBe(true);
      expect(manualSourcePersonalParentIdentitySchema.safeParse(parent).success).toBe(true);
      expect(fixture(identity, parent).manualSavedSourceRefs).toHaveLength(1);
    }
  });
  it('rejects every tag with extra private source fields', () => {
    for (const [identity] of pairs)
      expect(
        manualSourcePersonalIdentitySchema.safeParse({ ...identity, sql_relations: [] }).success,
      ).toBe(false);
  });
  it('keeps manual UUID and redacted nonmanual source kinds distinct', () => {
    const base = { kind: 'manual-activity-source', sourceId: source };
    for (const kind of ['fit', 'fixture', 'healthkit', 'garmin'])
      expect(
        manualSourcePersonalIdentitySchema.safeParse({
          ...base,
          source: { kind, sourceRevision: 0, identifier: 'sensitive_identifier_not_exported' },
        }).success,
      ).toBe(true);
    expect(
      manualSourcePersonalIdentitySchema.safeParse({
        ...base,
        source: { kind: 'manual', sourceRecordId: 'external/provider', sourceRevision: 0 },
      }).success,
    ).toBe(false);
    expect(
      manualSourcePersonalIdentitySchema.safeParse({
        ...base,
        source: {
          kind: 'garmin',
          sourceRecordId: 'external/provider',
          sourceRevision: 0,
          identifier: 'sensitive_identifier_not_exported',
        },
      }).success,
    ).toBe(false);
  });
  it('does not infer UUID revisions or zero/null equivalence', () => {
    expect(
      manualSourcePersonalIdentitySchema.safeParse({
        kind: 'checkin-revision',
        sourceId: source,
        revision: version,
      }).success,
    ).toBe(false);
    expect(
      manualSourcePersonalIdentitySchema.safeParse({
        kind: 'checkin-revision',
        sourceId: source,
        revision: 0,
      }).success,
    ).toBe(false);
    expect(
      manualSourcePersonalIdentitySchema.safeParse({
        kind: 'routine-run',
        sourceId: 'run',
        revision: null,
      }).success,
    ).toBe(false);
  });
  it('requires actual census and rejects duplicate or foreign ordinals/chain roles', () => {
    const count = fixture();
    first(count.manualSourceChains).savedRefCount = 2;
    expect(manualSourcePersonalExportSchema.safeParse(count).success).toBe(false);
    const duplicate = fixture();
    duplicate.manualSavedSourceRefs.push(first(duplicate.manualSavedSourceRefs));
    expect(manualSourcePersonalExportSchema.safeParse(duplicate).success).toBe(false);
    const foreign = fixture();
    first(foreign.manualSavedSourceParents).evidenceId = id(99);
    expect(manualSourcePersonalExportSchema.safeParse(foreign).success).toBe(false);
    const role = fixture();
    first(role.manualSourceChains).proposalId = id(1);
    expect(manualSourcePersonalExportSchema.safeParse(role).success).toBe(false);
  });
  it('rejects a same-count replacement of the exact principal parent', () => {
    const v = fixture();
    first(v.manualSavedSourceParents).identity = {
      family: 'race-event',
      sourceId: id(99),
      revision: 1,
    };
    expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('keeps counted legacy parent association unknown without inventing parents', () => {
    const v = fixture();
    first(v.manualSavedSourceRefs).parentCoverage = 'legacy_association_unavailable';
    v.manualSavedSourceParents = [];
    first(v.manualSourceChains).savedParentCount = 0;
    expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  });
  it('preserves exact original suppression US6 and purged unavailable location', () => {
    const v = fixture();
    first(v.manualSourceChains).body = { state: 'purged', eventId: id(88), occurredAt: at };
    first(v.manualSourceChains).savedSuppressionCount = 1;
    first(v.manualSavedSourceRefs).location = { state: 'unavailable', reason: 'payload_purged' };
    v.manualSavedSourceSuppressions = [
      {
        evidenceId: id(1),
        eventId: id(88),
        occurredAt: at,
        recordVersion: 4,
        kind: 'race_event_deleted',
        matchedRefOrdinals: [1],
      },
    ];
    expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
    first(v.manualSavedSourceSuppressions).occurredAt = '2026-10-08T00:00:00.123457Z';
    expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects unknown fields, locator/authority and callbacks before parsing', () => {
    expect(
      manualSourcePersonalExportSchema.safeParse({ ...fixture(), authority: 'owner' }).success,
    ).toBe(false);
    const v = fixture();
    let reads = 0;
    Object.defineProperty(v, 'manualSavedSourceRefs', {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
    expect(reads).toBe(0);
    expect(
      manualSourcePersonalIdentitySchema.safeParse({ kind: 'unknown', sourceId: source }).success,
    ).toBe(false);
  });
  it('rejects whole encoded UTF8 over8MiB without truncation', () => {
    const v = fixture();
    first(v.manualSavedSourceRefs).location = {
      state: 'unavailable',
      reason: 'private_source_not_rendered',
    };
    expect(
      manualSourcePersonalExportSchema.safeParse({ ...v, private: '가'.repeat(3000000) }).success,
    ).toBe(false);
  });
});
it('keeps only real typed target membership and rejects foreign template/source association', () => {
  const v = fixture(
    { kind: 'workout-template-version', sourceId: source, versionId: version },
    { family: 'workout-template', sourceId: source, versionId: version },
  );
  first(v.manualSourceChains).savedParentCount = 2;
  v.manualSavedSourceParents.push({
    evidenceId: id(1),
    ordinal: 1,
    identity: { family: 'supplementary-exercise', sourceId: id(20), versionId: id(21) },
    role: 'target',
    membership: { kind: 'workout_target', routineVersionId: version, targetSetId: 'set' },
  });
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  const target = first(v.manualSavedSourceParents.filter((p) => p.role === 'target'));
  target.membership = { kind: 'workout_target', routineVersionId: id(99), targetSetId: 'set' };
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});
it('requires all supplied pin parents to match an exact saved nutrition tuple', () => {
  const v = fixture(
    { kind: 'race-timing-pin-fragment', sourceId: source, revision: 1 },
    { family: 'race-event', sourceId: source, revision: 1 },
  );
  first(v.manualSourceChains).savedRefCount = 2;
  first(v.manualSourceChains).savedParentCount = 3;
  v.manualSavedSourceRefs.push({
    evidenceId: id(1),
    ordinal: 2,
    identity: { kind: 'nutrition-plan-version', sourceId: id(20), versionId: id(21) },
    parentCoverage: 'saved_parents',
    existence: { basis: 'export_snapshot', state: 'present' },
    location: { state: 'unavailable', reason: 'private_source_not_rendered' },
  });
  v.manualSavedSourceParents.push(
    {
      evidenceId: id(1),
      ordinal: 2,
      identity: { family: 'nutrition-plan', sourceId: id(20), versionId: id(21) },
      role: 'source',
      membership: null,
    },
    {
      evidenceId: id(1),
      ordinal: 1,
      identity: { family: 'nutrition-plan', sourceId: id(20), versionId: id(21) },
      role: 'pin_parent',
      membership: null,
    },
  );
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  const pin = first(v.manualSavedSourceParents.filter((p) => p.role === 'pin_parent'));
  pin.identity = { family: 'nutrition-plan', sourceId: id(20), versionId: id(99) };
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});
it('requires an exact known parent for safe planned location and does not manufacture a purged location', () => {
  const v = fixture();
  first(v.manualSavedSourceRefs).location = {
    state: 'known',
    members: [
      {
        domain: 'race',
        aggregateId: source,
        side: 'before',
        component: 'race_timing',
        memberId: null,
        parent: { family: 'race-event', sourceId: source, revision: 1 },
      },
    ],
  };
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  const loc = first(v.manualSavedSourceRefs).location;
  if (loc.state !== 'known') throw Error('fixture');
  first(loc.members).component = 'nutrition_item';
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
  first(loc.members).component = 'race_timing';
  loc.members.push({ ...first(loc.members) });
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
  loc.members.pop();
  first(loc.members).parent = { family: 'race-event', sourceId: id(99), revision: 1 };
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});
it('exports exact SQL110 retained/reconnected/carried ancestry without SQL row hashes', () => {
  const v = fixture();
  v.nutritionDisconnectionOrigins = [
    {
      planId: source,
      versionId: version,
      itemId: '식-' + '가'.repeat(1001),
      originVersionId: version,
      eventId: id(88),
      occurredAt: at,
      eventKind: 'race_event_deleted',
    },
  ];
  const item = first(v.nutritionDisconnectionOrigins).itemId;
  v.nutritionDisconnectionLineage = [
    {
      planId: source,
      versionId: id(12),
      version: 2,
      priorVersionId: version,
      priorVersion: 1,
      itemId: item,
      originVersionId: version,
      eventId: id(88),
      disposition: 'retained',
    },
    {
      planId: source,
      versionId: id(13),
      version: 3,
      priorVersionId: id(12),
      priorVersion: 2,
      itemId: item,
      originVersionId: version,
      eventId: id(88),
      disposition: 'reconnected',
    },
    {
      planId: source,
      versionId: id(14),
      version: 4,
      priorVersionId: id(13),
      priorVersion: 3,
      itemId: item,
      originVersionId: version,
      eventId: id(88),
      disposition: 'carried',
    },
  ];
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  const foreign = structuredClone(v);
  first(foreign.nutritionDisconnectionLineage).eventId = id(99);
  expect(manualSourcePersonalExportSchema.safeParse(foreign).success).toBe(false);
  const lost = structuredClone(v);
  lost.nutritionDisconnectionLineage.splice(1, 1);
  expect(manualSourcePersonalExportSchema.safeParse(lost).success).toBe(false);
  const duplicate = structuredClone(v);
  duplicate.nutritionDisconnectionOrigins.push(first(duplicate.nutritionDisconnectionOrigins));
  expect(manualSourcePersonalExportSchema.safeParse(duplicate).success).toBe(false);
});
it('prebounds unknown input symbols, sparse arrays, cycles, descriptors and excessive depth', () => {
  const sparse = fixture();
  delete sparse.manualSavedSourceRefs[0];
  expect(manualSourcePersonalExportSchema.safeParse(sparse).success).toBe(false);
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol('secret'), { value: 'private' });
  expect(manualSourcePersonalExportSchema.safeParse(symbol).success).toBe(false);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  expect(manualSourcePersonalExportSchema.safeParse(cyclic).success).toBe(false);
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = [deep];
  expect(manualSourcePersonalExportSchema.safeParse(deep).success).toBe(false);
});
it('rejects suppression absent/duplicate ordinal and event-version substitutions', () => {
  const v = fixture();
  first(v.manualSourceChains).body = { state: 'purged', eventId: id(88), occurredAt: at };
  first(v.manualSourceChains).savedSuppressionCount = 1;
  first(v.manualSavedSourceRefs).location = { state: 'unavailable', reason: 'payload_purged' };
  v.manualSavedSourceSuppressions = [
    {
      evidenceId: id(1),
      eventId: id(88),
      occurredAt: at,
      recordVersion: 7,
      kind: 'manual_review_source_suppressed_v2',
      matchedRefOrdinals: [1],
    },
  ];
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  const foreign = structuredClone(v);
  first(foreign.manualSavedSourceSuppressions).matchedRefOrdinals = [2];
  expect(manualSourcePersonalExportSchema.safeParse(foreign).success).toBe(false);
  const mismatch = structuredClone(v);
  first(mismatch.manualSavedSourceSuppressions).recordVersion = 6;
  expect(manualSourcePersonalExportSchema.safeParse(mismatch).success).toBe(false);
});

it('retains two original external refs with the same lossy safe identity and distinct saved ordinals', () => {
  const identity = {
    kind: 'manual-activity-source',
    sourceId: source,
    source: { kind: 'garmin', sourceRevision: 0, identifier: 'sensitive_identifier_not_exported' },
  };
  const v = fixture(identity, {
    family: 'activity',
    sourceId: source,
    version: { kind: 'source_revision', source: identity.source },
  });
  first(v.manualSourceChains).savedRefCount = 2;
  first(v.manualSourceChains).savedParentCount = 2;
  v.manualSavedSourceRefs.push({ ...structuredClone(first(v.manualSavedSourceRefs)), ordinal: 2 });
  v.manualSavedSourceParents.push({
    ...structuredClone(first(v.manualSavedSourceParents)),
    ordinal: 2,
  });
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  first(v.manualSavedSourceRefs.filter((r) => r.ordinal === 2)).ordinal = 1;
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});

it('retains exact ordered membership for 5000 saved refs and rejects equal-count parent substitution', () => {
  const v = fixture();
  first(v.manualSourceChains).savedRefCount = 5000;
  first(v.manualSourceChains).savedParentCount = 5000;
  v.manualSavedSourceRefs = Array.from({ length: 5000 }, (_, i) => ({
    ...structuredClone(first(v.manualSavedSourceRefs)),
    ordinal: i + 1,
    identity: { kind: 'race-event', sourceId: id(i + 10), revision: 1 },
  }));
  v.manualSavedSourceParents = Array.from({ length: 5000 }, (_, i) => ({
    ...structuredClone(first(v.manualSavedSourceParents)),
    ordinal: i + 1,
    identity: { family: 'race-event', sourceId: id(i + 10), revision: 1 },
  }));
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  first(v.manualSavedSourceParents).identity = {
    family: 'race-event',
    sourceId: id(99999),
    revision: 1,
  };
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});

it('indexes 6000 exact prior lineage tuples without accepting an equal-count wrong predecessor', () => {
  const v = fixture();
  v.nutritionDisconnectionOrigins = [
    {
      planId: id(9),
      versionId: id(10),
      itemId: 'item',
      originVersionId: id(10),
      eventId: id(8),
      occurredAt: at,
      eventKind: 'race_event_deleted',
    },
  ];
  v.nutritionDisconnectionLineage = Array.from({ length: 6000 }, (_, i) => ({
    planId: id(9),
    versionId: id(i + 11),
    version: i + 2,
    priorVersionId: id(i + 10),
    priorVersion: i + 1,
    itemId: 'item',
    originVersionId: id(10),
    eventId: id(8),
    disposition: i === 0 ? 'retained' : 'carried',
  }));
  expect(manualSourcePersonalExportSchema.parse(v)).toEqual(v);
  first(v.nutritionDisconnectionLineage).version = 999;
  expect(manualSourcePersonalExportSchema.safeParse(v).success).toBe(false);
});
