import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { manualActivityCreateSchema } from '@workout/contracts/activity';
const sourceHash = (original: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(manualActivityCreateSchema.shape.activity.parse(original)))
    .digest('hex');
import {
  projectManualActivityReadFacts,
  validateManualActivityReadFacts,
  manualActivityReadProjectionInputSchema,
} from '../src/race-plan-impact-manual-activity-read-facts.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
const id = 'abcdefab-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
  const requested = { kind: 'activity', id, revisionId: '1', detailId: null, allocationId: null };
  const original = {
    title: 'Synthetic manual',
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
          kind: 'manual',
          sourceId: 'manual-source',
          sourceRevision: 1,
          contentHash: sourceHash(original),
        },
      },
    ],
    activityMetadata: [
      {
        ...current,
        overlay: { state: 'present', revision: 1 },
        source: {
          state: 'present',
          kind: 'manual',
          sourceId: 'manual-source',
          revision: 1,
          contentHash: sourceHash(original),
          suppressed: false,
          revisionRecord: { state: 'present' },
        },
      },
    ],
  });
}
function parts(c: ReturnType<typeof fixture>) {
  const a = c.actualFacts[0],
    s = c.activityRosters[0],
    m = c.activityMetadata[0];
  if (
    !a ||
    !s ||
    !m ||
    !a.current ||
    !a.content ||
    s.source.state !== 'present' ||
    m.source.state !== 'present'
  )
    throw Error('fixture');
  return { a, s, m };
}
function projected(c: unknown) {
  const result = projectManualActivityReadFacts(c);
  if (result.status !== 'projected_retained_read_facts') throw Error(result.reason);
  return result.facts;
}
it('matches actual manual current source/head/original/overlay without processing authority', () => {
  const c = fixture(),
    before = JSON.stringify(c),
    p = projected(c);
  expect(validateManualActivityReadFacts(p, c)).toEqual({
    status: 'validated_retained_read_facts',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(p.facts[0]?.content?.original).toMatchObject({ durationSeconds: 0, distanceMeters: null });
  expect(JSON.stringify(c)).toBe(before);
});
it('preserves deleted body null, old requested revision and older overlay history', () => {
  const c = fixture(),
    { a, s, m } = parts(c);
  a.state = 'deleted';
  a.content = null;
  a.current = { id, revision: 2, deleted: true };
  s.revision = 2;
  s.deleted = true;
  m.revision = 2;
  m.deleted = true;
  if (m.source.state !== 'present') throw Error('fixture');
  m.source.suppressed = true;
  const p = projected(c);
  expect(p.facts[0]).toMatchObject({
    state: 'deleted',
    content: null,
    requested: { revisionId: '1' },
  });
  expect(validateManualActivityReadFacts(p, c).status).toBe('validated_retained_read_facts');
});
it('retains missing historical body as unavailable instead of substituting current', () => {
  const c = fixture(),
    { a, s, m } = parts(c);
  s.revision = 2;
  m.revision = 2;
  m.overlay.revision = 2;
  a.current = { id, revision: 2, deleted: false };
  a.state = 'unavailable';
  a.reason = 'requested_revision_unavailable';
  a.content = null;
  const p = projected(c);
  expect(p.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'requested_revision_unavailable',
    content: null,
    sourceEvidence: null,
  });
  expect(validateManualActivityReadFacts(p, c)).toEqual({
    status: 'blocked',
    reason: 'source_unavailable',
  });
});
it.each(['fit', 'fixture', 'healthkit'] as const)('never falls back from %s to manual', (kind) => {
  const c = fixture(),
    { s, m } = parts(c);
  if (s.source.state !== 'present' || m.source.state !== 'present') throw Error('fixture');
  s.source.kind = kind;
  m.source.kind = kind;
  expect(projected(c).facts[0]?.reason).toBe('manual_source_required');
});
it('does not infer manual from absent source', () => {
  const c = fixture(),
    { s, m } = parts(c);
  s.source = { state: 'absent' };
  m.source = { state: 'absent' };
  expect(projected(c).facts[0]?.reason).toBe('manual_source_required');
});
it.each(['sourceId', 'revision', 'hash', 'record'] as const)(
  'requires source %s correspondence',
  (field) => {
    const c = fixture(),
      { m } = parts(c);
    if (m.source.state !== 'present') throw Error('fixture');
    if (field === 'sourceId') m.source.sourceId = 'other-source';
    if (field === 'revision') m.source.revision = 2;
    if (field === 'hash') m.source.contentHash = '0'.repeat(64);
    if (field === 'record') m.source.revisionRecord.state = 'absent';
    expect(projected(c).facts[0]?.reason).toBe('source_correspondence_unavailable');
  },
);
it.each(['head', 'original', 'overlay', 'overlayRevision', 'suppression', 'futureRef'] as const)(
  'rejects mismatched %s',
  (field) => {
    const c = fixture(),
      { a, m } = parts(c);
    if (!a.current || !a.content || m.source.state !== 'present') throw Error('fixture');
    if (field === 'head') a.current.revision = 2;
    if (field === 'original') a.content.original.durationSeconds = 9;
    if (field === 'overlay') a.content.overlay = { title: 'changed' };
    if (field === 'overlayRevision') m.overlay.revision = 2;
    if (field === 'suppression') m.source.suppressed = true;
    if (field === 'futureRef') {
      const requested = c.refs[0];
      if (!requested) throw Error('fixture');
      requested.revisionId = '2';
      a.requested.revisionId = '2';
    }
    expect(projectManualActivityReadFacts(c)).toEqual({
      status: 'blocked',
      reason: 'source_mismatch',
    });
  },
);
it('does not equate matching copied body hashes with source normalized raw hash', () => {
  const c = fixture(),
    { s, m } = parts(c);
  if (s.source.state !== 'present' || m.source.state !== 'present') throw Error('fixture');
  s.source.contentHash = '0'.repeat(64);
  m.source.contentHash = '0'.repeat(64);
  expect(projectManualActivityReadFacts(c)).toEqual({
    status: 'blocked',
    reason: 'source_mismatch',
  });
});
it.each(['detailId', 'allocationId'] as const)('leaves %s unsupported', (field) => {
  const c = fixture();
  const requested = c.refs[0],
    actual = c.actualFacts[0];
  if (!requested || !actual) throw Error('fixture');
  requested[field] = id;
  actual.requested[field] = id;
  expect(projected(c).facts[0]?.reason).toBe('unsupported_detail_or_allocation');
});
it('foreign/absent owned metadata cannot create a manual fact', () => {
  const c = fixture();
  c.activityMetadata = [];
  expect(projected(c).facts[0]?.reason).toBe('owned_reference_unavailable');
});
it.each(['refs', 'actualFacts', 'activityRosters', 'activityMetadata'] as const)(
  'rejects duplicate %s before mapping',
  (field) => {
    const c = fixture();
    const row = c[field][0];
    if (!row) throw Error('fixture');
    const input = { ...c, [field]: [row, structuredClone(row)] };
    expect(projectManualActivityReadFacts(input)).toEqual({
      status: 'blocked',
      reason: 'reference_mismatch',
    });
  },
);
it('rejects extra actual facts not requested', () => {
  const c = fixture();
  c.refs = [];
  expect(projectManualActivityReadFacts(c)).toEqual({
    status: 'blocked',
    reason: 'reference_mismatch',
  });
});
it('normalizes actual UUID aliases and rejects alias duplicates', () => {
  const c = fixture();
  const input = JSON.parse(JSON.stringify(c).replaceAll(id, id.toUpperCase())) as unknown;
  expect(projected(input)).toEqual(projected(c));
  const requested = c.refs[0];
  if (!requested) throw Error('fixture');
  c.refs.push({ ...requested, id: id.toUpperCase() });
  expect(projectManualActivityReadFacts(c).status).toBe('blocked');
});
it('does not accept forged output athlete/body/provenance', () => {
  const c = fixture(),
    p = projected(c);
  p.athleteId = 'foreign';
  expect(validateManualActivityReadFacts(p, c)).toEqual({
    status: 'blocked',
    reason: 'correspondence_mismatch',
  });
});
it('keeps output deterministic across roster/input order', () => {
  const c = fixture();
  const metadata = c.activityMetadata[0];
  if (!metadata) throw Error('fixture');
  c.activityMetadata.push({
    ...metadata,
    id: 'abcdefab-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  expect(projected(c)).toEqual(
    projected({ ...c, activityMetadata: [...c.activityMetadata].reverse() }),
  );
});
it.each([
  null,
  { ...fixture(), authorized: true },
  { ...fixture(), activityMetadata: [{ ...fixture().activityMetadata[0], authorized: true }] },
])('rejects unknown boundary %#', (value) => {
  expect(projectManualActivityReadFacts(value).status).toBe('blocked');
});
it('bounds whole UTF8 input before decoding', () => {
  expect(projectManualActivityReadFacts({ ...fixture(), noise: '한'.repeat(1400000) })).toEqual({
    status: 'blocked',
    reason: 'bounds_exceeded',
  });
});
it('rejects cyclic input and output without throwing', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(projectManualActivityReadFacts(cyclic).status).toBe('blocked');
  expect(validateManualActivityReadFacts(cyclic, fixture()).status).toBe('blocked');
});

it('separates ordered public manual source hash from canonical roster body digest', () => {
  const c = fixture(),
    { a, s } = parts(c);
  if (!a.content || s.source.state !== 'present') throw Error('fixture');
  expect(s.source.contentHash).toBe(sourceHash(a.content.original));
  expect(s.source.contentHash).not.toBe(s.originalDigest);
  expect(validateManualActivityReadFacts(projected(c), c).status).toBe(
    'validated_retained_read_facts',
  );
});
it('reconstructs producer key order from a differently ordered captured body', () => {
  const c = fixture(),
    { a } = parts(c);
  if (!a.content) throw Error('fixture');
  const o = a.content.original;
  a.content.original = {
    distanceMeters: o.distanceMeters,
    timezone: o.timezone,
    durationKind: o.durationKind,
    durationSeconds: o.durationSeconds,
    startedAt: o.startedAt,
    kind: o.kind,
    title: o.title,
  };
  expect(validateManualActivityReadFacts(projected(c), c).status).toBe(
    'validated_retained_read_facts',
  );
});
it('keeps unsupported manual source body correspondence explicitly unavailable', () => {
  const c = fixture(),
    { a, s } = parts(c);
  if (!a.content) throw Error('fixture');
  a.content.original.title = null;
  s.originalDigest = digest(a.content.original);
  expect(projected(c).facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'source_body_correspondence_port_missing',
    content: null,
  });
});
it('charges repeated visited refs before deduplication', () => {
  const c = fixture();
  const r = c.refs[0],
    a = c.actualFacts[0];
  if (!r || !a) throw Error('fixture');
  expect(
    projectManualActivityReadFacts({
      ...c,
      refs: Array.from({ length: 2501 }, () => r),
      actualFacts: Array.from({ length: 2501 }, () => a),
    }),
  ).toEqual({ status: 'blocked', reason: 'bounds_exceeded' });
});
it.each(['body', 'suppression'] as const)('rejects deleted %s contradiction', (field) => {
  const c = fixture(),
    { a, s, m } = parts(c);
  a.state = 'deleted';
  a.current = { id, revision: 2, deleted: true };
  s.revision = 2;
  s.deleted = true;
  m.revision = 2;
  m.deleted = true;
  if (m.source.state !== 'present') throw Error('fixture');
  m.source.suppressed = field === 'body';
  if (field === 'suppression') a.content = null;
  expect(projectManualActivityReadFacts(c)).toEqual({
    status: 'blocked',
    reason: 'source_mismatch',
  });
});
