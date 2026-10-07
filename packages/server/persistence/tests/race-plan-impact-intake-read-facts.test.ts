import { expect, it } from 'vitest';
import { activeIntakeEntrySchema } from '@workout/contracts/nutrition-core';
import type { Transaction } from '../src/database.js';
import {
  captureManualIntakeReadFacts,
  validateManualIntakeReadFacts,
} from '../src/race-plan-impact-intake-read-facts.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
const athlete = 'synthetic-own',
  id = 'synthetic-intake',
  uuid = 'abcdefab-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  newer = 'abcdefab-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ref = { kind: 'intake', id, revisionId: uuid };
const datum = (unit: string, value: number | null) => ({
  unit,
  value,
  status: value === null ? 'unknown' : 'reported',
  evidenceIds: [],
});
function body(revisionId = uuid, revision = 1) {
  return activeIntakeEntrySchema.parse({
    intakeId: id,
    revisionId,
    revision,
    status: 'active',
    occurredAt: '2026-10-07T00:00:00Z',
    recordedAt: '2026-10-07T01:00:00Z',
    timezone: 'Asia/Seoul',
    foods: [
      {
        foodVersionId: null,
        description: 'Zero user portion',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
      {
        foodVersionId: null,
        description: 'Unknown portion',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    nutrientTotal: {
      energy: datum('kcal', 0),
      carbohydrate: datum('g', null),
      protein: datum('g', null),
      fat: datum('g', null),
      fluid: datum('mL', null),
      sodium: datum('mg', null),
    },
    nutrientValueCoverage: 'partial',
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
}
function row(historical = false) {
  const current = body(historical ? newer : uuid, historical ? 2 : 1);
  return {
    id,
    current_revision: current.revision,
    current_revision_id: current.revisionId,
    status: 'active',
    current_record: current,
    requested_revision: 1,
    requested_record: body(),
  };
}
function fixture(rows: Record<string, unknown>[] = [row()], size = '8192') {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const tx: Transaction = {
    athleteId: athlete,
    async query(sql, values) {
      calls.push({ sql, ...(values ? { values } : {}) });
      return { rows: sql.includes(' AS bytes') ? [{ bytes: size }] : rows, rowCount: rows.length };
    },
  };
  return { tx, calls };
}
const budget = () => ({ bytes: 0n, sources: 0 });
const expected = { athleteId: athlete, refs: [ref] };
it.each([false, true])(
  'captures exact manual current/historical revision without changing actual zero/null or admitting processing history=%s',
  async (historical) => {
    const f = fixture([row(historical)]),
      before = body();
    const facts = await captureManualIntakeReadFacts(f.tx, [ref], budget());
    expect(facts.facts[0]).toMatchObject({
      requested: ref,
      state: historical ? 'historical' : 'current',
      reason: null,
      content: before,
      contentDigest: digest(before),
      current: { revision: historical ? 2 : 1, revisionId: historical ? newer : uuid },
    });
    expect(facts).toMatchObject({
      purpose: 'retained_manual_intake_read',
      athleteId: athlete,
      authority: 'none',
      freshness: 'not_checked',
    });
    expect(facts.facts[0]?.content?.foods.map((p) => p.quantity)).toEqual([0, null]);
    expect(validateManualIntakeReadFacts(facts, expected)).toEqual({
      status: 'validated_retained_read_facts',
      approvalAuthority: 'none',
      freshness: 'not_checked',
    });
    expect(f.calls.every((c) => c.sql.startsWith('SELECT'))).toBe(true);
    expect(f.calls.some((c) => /consent|provider|command_receipt|outbox/i.test(c.sql))).toBe(false);
    expect(f.calls[1]?.values).toEqual([athlete, id, uuid]);
    expect(f.calls[1]?.sql).toContain('e.athlete_id=$1 AND e.id=$2 LIMIT 2');
  },
);
it('dedups normalized UUID aliases deterministically and charges visits before cache', async () => {
  const f = fixture(),
    b = budget();
  const result = await captureManualIntakeReadFacts(
    f.tx,
    [ref, { ...ref, revisionId: uuid.toUpperCase() }, ref],
    b,
  );
  expect(result.facts).toHaveLength(1);
  expect(f.calls).toHaveLength(2);
  expect(b.sources).toBe(4);
  expect(uuid.toUpperCase()).not.toBe(uuid);
  expect(
    validateManualIntakeReadFacts(result, { athleteId: athlete, refs: [ref, ref] }).status,
  ).toBe('validated_retained_read_facts');
});
it('deleted owned head never selects or returns a historical food body, without certifying old revision existence', async () => {
  const f = fixture([
    {
      id,
      current_revision: 2,
      current_revision_id: newer,
      status: 'deleted',
      current_record: null,
      requested_revision: null,
      requested_record: null,
    },
  ]);
  const facts = await captureManualIntakeReadFacts(f.tx, [ref], budget());
  expect(facts.facts[0]).toMatchObject({
    state: 'deleted',
    content: null,
    contentDigest: null,
    current: { status: 'deleted', revision: 2, contentDigest: digest(null) },
  });
  expect(f.calls.every((c) => c.sql.includes("CASE WHEN e.status='active'"))).toBe(true);
  expect(validateManualIntakeReadFacts(facts, expected).status).toBe(
    'validated_retained_read_facts',
  );
});
it.each(['foreign_or_missing', 'missing_revision', 'extraction'])(
  'keeps unavailable %s contentless and explicitly blocked without inventing consent',
  async (kind) => {
    const r: Record<string, unknown> = row();
    if (kind === 'missing_revision') {
      r['requested_record'] = null;
      r['requested_revision'] = null;
    }
    if (kind === 'extraction') {
      const value = activeIntakeEntrySchema.parse({
        ...body(),
        source: 'user_confirmed_extraction',
        sourceRecordId: 'synthetic-resource-reference',
      });
      r['current_record'] = value;
      r['requested_record'] = value;
    }
    const f = fixture(kind === 'foreign_or_missing' ? [] : [r]);
    const result = await captureManualIntakeReadFacts(f.tx, [ref], budget());
    expect(result.facts[0]).toMatchObject({
      state: 'unavailable',
      content: null,
      contentDigest: null,
      reason:
        kind === 'foreign_or_missing'
          ? 'owned_reference_unavailable'
          : kind === 'missing_revision'
            ? 'requested_revision_unavailable'
            : 'manual_source_required',
    });
    expect(validateManualIntakeReadFacts(result, expected)).toEqual({
      status: 'blocked',
      reason: 'source_unavailable',
    });
  },
);
it.each([
  'different_owner',
  'different_ref',
  'digest',
  'head',
  'duplicate',
  'extra_authority',
  'oversized',
])('pure boundary rejects %s facts rather than accepting permission claims', async (kind) => {
  const result = await captureManualIntakeReadFacts(fixture().tx, [ref], budget()),
    f = result.facts[0];
  if (!f || !f.current) throw Error('fixture');
  let unknown: unknown = result;
  if (kind === 'different_owner') result.athleteId = 'synthetic-other';
  if (kind === 'different_ref') f.requested.revisionId = newer;
  if (kind === 'digest') f.contentDigest = '2'.repeat(64);
  if (kind === 'head') f.current.contentDigest = '2'.repeat(64);
  if (kind === 'duplicate') result.facts.push(structuredClone(f));
  if (kind === 'extra_authority') unknown = { ...result, approved: true };
  if (kind === 'oversized') unknown = { ...result, payload: 'x'.repeat(4194305) };
  expect(validateManualIntakeReadFacts(unknown, expected).status).toBe('blocked');
});
it.each([
  'duplicate_rows',
  'wrong_id',
  'head_body',
  'requested_body',
  'deleted_leak',
  'invalid_bytes',
])('strict SQL boundary rejects %s', async (kind) => {
  const r: Record<string, unknown> = row();
  if (kind === 'wrong_id') r['id'] = 'other';
  if (kind === 'head_body') r['current_record'] = { ...body(), revision: 2 };
  if (kind === 'requested_body')
    r['requested_record'] = { ...body(), notes: 'Contradicting same revision' };
  if (kind === 'deleted_leak') r['status'] = 'deleted';
  const f = fixture(
    kind === 'duplicate_rows' ? [r, r] : [r],
    kind === 'invalid_bytes' ? 'false' : '8192',
  );
  await expect(captureManualIntakeReadFacts(f.tx, [ref], budget())).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
});
it('bounds shared bytes/visited refs before body fetch and refuses malformed references before querying', async () => {
  const f = fixture();
  await expect(
    captureManualIntakeReadFacts(f.tx, [ref], { bytes: 4194300n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
  expect(f.calls).toHaveLength(0);
  await expect(
    captureManualIntakeReadFacts(
      f.tx,
      Array.from({ length: 5000 }, () => ref),
      { bytes: 0n, sources: 1 },
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'unique_sources' });
  expect(f.calls).toHaveLength(0);
  await expect(
    captureManualIntakeReadFacts(f.tx, [{ ...ref, revisionId: 'unknown' }], budget()),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(f.calls).toHaveLength(0);
  const tooLarge = fixture([row()], '4194304');
  await expect(captureManualIntakeReadFacts(tooLarge.tx, [ref], budget())).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(tooLarge.calls).toHaveLength(1);
});
