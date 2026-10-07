import { expect, it } from 'vitest';
import {
  manualActivityReadProjectionInputSchema,
  projectManualActivityReadFacts,
} from '../src/race-plan-impact-manual-activity-read-facts.js';
import {
  projectLocalImportedActivityReadFacts,
  validateLocalImportedActivityReadFacts,
  localImportedActivityReadFactsSchema,
} from '../src/race-plan-impact-local-imported-activity-read-facts.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
const id = 'abcdefab-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
  const requested = { kind: 'activity', id, revisionId: '1', detailId: null, allocationId: null };
  const original = {
    title: 'Synthetic local import',
    kind: 'unknown',
    startedAt: '2026-10-07T00:00:00Z',
    durationSeconds: 0,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: null,
  };
  const overlay = {};
  const current = { id, revision: 1, deleted: false };
  return manualActivityReadProjectionInputSchema.parse({
    athleteId: 'synthetic-own',
    refs: [requested],
    actualFacts: [
      {
        requested,
        state: 'current',
        reason: null,
        current,
        content: { original, overlay, detail: null },
      },
    ],
    activityRosters: [
      {
        ...current,
        originalDigest: digest(original),
        overlayDigest: digest(overlay),
        source: {
          state: 'present',
          kind: 'fit',
          sourceId: 'Local-식-Case',
          sourceRevision: 1,
          contentHash: 'c'.repeat(64),
        },
      },
    ],
    activityMetadata: [
      {
        ...current,
        overlay: { state: 'present', revision: 1 },
        source: {
          state: 'present',
          kind: 'fit',
          sourceId: 'Local-식-Case',
          revision: 1,
          contentHash: 'c'.repeat(64),
          suppressed: false,
          revisionRecord: { state: 'present' },
        },
      },
    ],
  });
}
function parts(c: ReturnType<typeof fixture>) {
  const shape = manualActivityReadProjectionInputSchema.shape;
  const actual = shape.actualFacts.element;
  const roster = shape.activityRosters.element;
  const metadata = shape.activityMetadata.element;
  const a = actual
    .extend({ content: actual.shape.content.unwrap(), current: actual.shape.current.unwrap() })
    .parse(c.actualFacts[0]);
  const s = roster.extend({ source: roster.shape.source.options[1] }).parse(c.activityRosters[0]);
  const m = metadata
    .extend({ source: metadata.shape.source.options[1] })
    .parse(c.activityMetadata[0]);
  c.actualFacts[0] = a;
  c.activityRosters[0] = s;
  c.activityMetadata[0] = m;
  return { a, s, m };
}
function projected(c: unknown) {
  const r = projectLocalImportedActivityReadFacts(c);
  if (r.status !== 'projected_retained_local_import_read_facts') throw Error(r.reason);
  return r.facts;
}
for (const kind of ['fit', 'fixture'] as const)
  it(`current ${kind} original/overlay tuple is metadata-only and unverified`, () => {
    const c = fixture(),
      { s, m } = parts(c);
    s.source.kind = kind;
    m.source.kind = kind;
    const before = JSON.stringify(c),
      p = projected(c);
    expect(validateLocalImportedActivityReadFacts(p, c)).toEqual({
      status: 'validated_retained_local_import_read_facts',
      approvalAuthority: 'none',
      sourceAuthentication: 'unverified',
      freshness: 'not_checked',
    });
    expect(p.facts[0]).toMatchObject({
      state: 'current',
      sourceTuple: { kind, sourceId: 'Local-식-Case', contentHash: 'c'.repeat(64) },
      originalDigest: s.originalDigest,
      overlayDigest: s.overlayDigest,
    });
    expect(p.facts[0]).not.toHaveProperty('content');
    expect(p.facts[0]).not.toHaveProperty('original');
    expect(JSON.stringify(c)).toBe(before);
    // File/source hash is not the canonical normalized-body digest.
    expect(p.facts[0]?.sourceTuple?.contentHash).not.toBe(p.facts[0]?.originalDigest);
  });
it('legacy manual-only source meaning remains unavailable for an imported witness', () => {
  const legacy = projectManualActivityReadFacts(fixture());
  expect(legacy.status).toBe('projected_retained_read_facts');
  if (legacy.status !== 'projected_retained_read_facts') throw Error('LEGACY_FIXTURE');
  expect(legacy.facts.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'manual_source_required',
    content: null,
  });
});
it('null overlay is distinct from empty overlay and zero/null body values are unchanged', () => {
  const c = fixture(),
    { a, s, m } = parts(c);
  a.content.overlay = null;
  s.overlayDigest = digest(null);
  m.overlay = { state: 'absent', revision: null };
  expect(projected(c).facts[0]).toMatchObject({
    overlayDigest: digest(null),
    overlayRevision: null,
  });
  expect(a.content.original).toMatchObject({ durationSeconds: 0, distanceMeters: null });
});
for (const field of [
  'original',
  'overlay',
  'sourceID',
  'sourceRevision',
  'sourceHash',
  'revisionRecord',
  'suppression',
  'head',
  'overlayRevision',
  'overlayPresence',
] as const)
  it(`rejects mismatched ${field}`, () => {
    const c = fixture(),
      { a, m } = parts(c);
    if (field === 'original') a.content.original.title = 'Altered';
    if (field === 'overlay') a.content.overlay = { title: 'Altered' };
    if (field === 'sourceID') m.source.sourceId = 'local-식-case';
    if (field === 'sourceRevision') m.source.revision = 2;
    if (field === 'sourceHash') m.source.contentHash = 'd'.repeat(64);
    if (field === 'revisionRecord') m.source.revisionRecord.state = 'absent';
    if (field === 'suppression') m.source.suppressed = true;
    if (field === 'head') m.revision = 2;
    if (field === 'overlayRevision') m.overlay.revision = 2;
    if (field === 'overlayPresence') m.overlay.state = 'absent';
    expect(projectLocalImportedActivityReadFacts(c)).toMatchObject({
      status: 'blocked',
      reason: 'source_mismatch',
    });
  });
for (const kind of ['manual', 'healthkit'] as const)
  it(`${kind} is not relabeled as local imported`, () => {
    const c = fixture(),
      { s, m } = parts(c);
    s.source.kind = kind;
    m.source.kind = kind;
    const p = projected(c);
    expect(p.facts[0]).toMatchObject({
      state: 'unavailable',
      reason: 'local_import_source_required',
      sourceTuple: null,
    });
    expect(validateLocalImportedActivityReadFacts(p, c)).toMatchObject({
      status: 'blocked',
      reason: 'source_unavailable',
    });
  });
it('old requested revision stays unavailable without borrowing the current body', () => {
  const c = fixture(),
    { a, s, m } = parts(c);
  s.revision = 2;
  m.revision = 2;
  m.overlay.revision = 2;
  a.current = { id, revision: 2, deleted: false };
  a.state = 'unavailable';
  a.reason = 'requested_revision_unavailable';
  const row = c.actualFacts[0];
  if (!row) throw Error('FIXTURE_ACTUAL');
  row.content = null;
  const p = projected(c);
  expect(p.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'requested_revision_unavailable',
    originalDigest: null,
    overlayDigest: null,
  });
  expect(validateLocalImportedActivityReadFacts(p, c)).toMatchObject({
    status: 'blocked',
    reason: 'source_unavailable',
  });
});
it('deletion retains only the exact tombstone and old reference; body resurrection fails', () => {
  const c = fixture(),
    { a, s, m } = parts(c);
  s.revision = 2;
  s.deleted = true;
  m.revision = 2;
  m.deleted = true;
  m.source.suppressed = true;
  a.current = { id, revision: 2, deleted: true };
  a.state = 'deleted';
  const row = c.actualFacts[0];
  if (!row) throw Error('FIXTURE_ACTUAL');
  row.content = null;
  const p = projected(c);
  expect(p.facts[0]).toMatchObject({
    state: 'deleted',
    requested: { revisionId: '1' },
    originalDigest: null,
    overlayDigest: null,
  });
  expect(validateLocalImportedActivityReadFacts(p, c).status).toBe(
    'validated_retained_local_import_read_facts',
  );
  a.content = parts(fixture()).a.content;
  expect(projectLocalImportedActivityReadFacts(c)).toMatchObject({
    status: 'blocked',
    reason: 'source_mismatch',
  });
});
it('exact repeated requests dedup after visit accounting; divergent observations and extra roster do not', () => {
  const c = fixture(),
    { a, s } = parts(c),
    r = c.refs[0];
  if (!r) throw Error('FIXTURE_REF');
  c.refs.push(r);
  c.actualFacts.push(a);
  expect(projected(c).facts).toHaveLength(1);
  const changed = structuredClone(a);
  if (!changed.content) throw Error('FIXTURE_BODY');
  changed.content.original.title = 'Changed';
  c.actualFacts.push(changed);
  expect(projectLocalImportedActivityReadFacts(c)).toMatchObject({
    status: 'blocked',
    reason: 'reference_mismatch',
  });
  const extra = fixture();
  extra.activityRosters.push({ ...s, id: '12345678-1234-4234-8234-123456789abc' });
  expect(projectLocalImportedActivityReadFacts(extra)).toMatchObject({
    status: 'blocked',
    reason: 'reference_mismatch',
  });
});
it('omitted actual, missing owned metadata, and supplied fact/body tampering are blocked', () => {
  const c = fixture(),
    p = projected(c);
  c.actualFacts = [];
  expect(projectLocalImportedActivityReadFacts(c)).toMatchObject({
    status: 'blocked',
    reason: 'reference_mismatch',
  });
  const absent = fixture();
  absent.activityMetadata = [];
  expect(projected(absent).facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'owned_reference_unavailable',
  });
  const changed = structuredClone(p);
  const f = changed.facts[0];
  if (!f) throw Error('FIXTURE_FACT');
  f.originalDigest = 'e'.repeat(64);
  expect(validateLocalImportedActivityReadFacts(changed, fixture())).toMatchObject({
    status: 'blocked',
    reason: 'correspondence_mismatch',
  });
  expect(
    validateLocalImportedActivityReadFacts({ ...p, athleteId: 'foreign' }, fixture()),
  ).toMatchObject({ status: 'blocked', reason: 'correspondence_mismatch' });
  expect(localImportedActivityReadFactsSchema.safeParse({ ...p, permission: true }).success).toBe(
    false,
  );
});
it('detail/allocation facts are explicitly unsupported, never invented source bytes', () => {
  const c = fixture(),
    { a } = parts(c),
    r = c.refs[0];
  if (!r) throw Error('FIXTURE_REF');
  r.detailId = id;
  a.requested.detailId = id;
  expect(projected(c).facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'unsupported_detail_or_allocation',
  });
});
it('UUID identities normalize but opaque source ID case/Unicode remains exact', () => {
  const c = fixture(),
    { a, s, m } = parts(c),
    r = c.refs[0];
  if (!r || !a.current) throw Error('FIXTURE_REF');
  r.id = r.id.toUpperCase();
  a.requested.id = a.requested.id.toUpperCase();
  a.current.id = id.toUpperCase();
  s.id = id.toUpperCase();
  m.id = id.toUpperCase();
  expect(projected(c).facts[0]).toMatchObject({
    current: { id },
    sourceTuple: { sourceId: 'Local-식-Case' },
  });
});
it('5000 visits are bounded before ref dedup and primitive/accessor boundaries run before schemas', () => {
  const c = fixture(),
    { a } = parts(c),
    r = c.refs[0];
  if (!r) throw Error('FIXTURE_REF');
  c.refs = Array.from({ length: 2500 }, () => r);
  c.actualFacts = Array.from({ length: 2500 }, () => a);
  expect(projectLocalImportedActivityReadFacts(c)).toMatchObject({
    status: 'blocked',
    reason: 'bounds_exceeded',
  });
  let calls = 0;
  const bad = {};
  Object.defineProperty(bad, 'athleteId', {
    enumerable: true,
    get() {
      calls++;
      return 'fake';
    },
  });
  expect(projectLocalImportedActivityReadFacts(bad)).toMatchObject({
    status: 'blocked',
    reason: 'invalid_input',
  });
  expect(calls).toBe(0);
  expect(projectLocalImportedActivityReadFacts('食'.repeat(1400000))).toMatchObject({
    status: 'blocked',
    reason: 'bounds_exceeded',
  });
});
