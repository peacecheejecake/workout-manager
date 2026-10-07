import { z } from 'zod';
import { activeIntakeEntrySchema } from '@workout/contracts/nutrition-core';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest as digest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
export const manualIntakeReadReferenceSchema = z.strictObject({
  kind: z.literal('intake'),
  id: activeIntakeEntrySchema.shape.intakeId,
  revisionId: uuid,
});
const head = z.strictObject({
  id: activeIntakeEntrySchema.shape.intakeId,
  revision,
  revisionId: uuid,
  status: z.enum(['active', 'deleted']),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const fact = z.strictObject({
  requested: manualIntakeReadReferenceSchema,
  state: z.enum(['current', 'historical', 'deleted', 'unavailable']),
  reason: z
    .enum([
      'owned_reference_unavailable',
      'requested_revision_unavailable',
      'manual_source_required',
    ])
    .nullable(),
  current: head.nullable(),
  content: activeIntakeEntrySchema.nullable(),
  contentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export const manualIntakeReadFactsSchema = z.strictObject({
  purpose: z.literal('retained_manual_intake_read'),
  athleteId: z.string().min(1).max(200),
  facts: z.array(fact).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type ManualIntakeReadFacts = z.infer<typeof manualIntakeReadFactsSchema>;
const refs = z.array(manualIntakeReadReferenceSchema).max(5000);
const key = (ref: z.infer<typeof manualIntakeReadReferenceSchema>) =>
  JSON.stringify([ref.id, ref.revisionId]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function bytes(value: unknown, maximum = 4194304) {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  }
  if (text === undefined) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maximum) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return size;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
export type ManualIntakeReadValidation =
  | { status: 'validated_retained_read_facts'; approvalAuthority: 'none'; freshness: 'not_checked' }
  | {
      status: 'blocked';
      reason:
        | 'invalid_facts'
        | 'scope_mismatch'
        | 'reference_mismatch'
        | 'source_unavailable'
        | 'body_mismatch';
    };
/** Pure correspondence only. A caller-supplied fact is not proof of database ownership. */
export function validateManualIntakeReadFacts(
  unknownFacts: unknown,
  unknownExpected: unknown,
): ManualIntakeReadValidation {
  try {
    bytes(unknownFacts);
    bytes(unknownExpected);
  } catch {
    return { status: 'blocked', reason: 'invalid_facts' };
  }
  const parsed = manualIntakeReadFactsSchema.safeParse(unknownFacts),
    expected = z
      .strictObject({ athleteId: z.string().min(1).max(200), refs })
      .safeParse(unknownExpected);
  if (!parsed.success || !expected.success) return { status: 'blocked', reason: 'invalid_facts' };
  const data = parsed.data;
  if (data.athleteId !== expected.data.athleteId)
    return { status: 'blocked', reason: 'scope_mismatch' };
  const requested = new Set(expected.data.refs.map(key)),
    actual = new Set(data.facts.map((f) => key(f.requested)));
  if (
    actual.size !== data.facts.length ||
    requested.size !== actual.size ||
    [...actual].some((k) => !requested.has(k))
  )
    return { status: 'blocked', reason: 'reference_mismatch' };
  for (const f of data.facts) {
    if (f.state === 'unavailable') return { status: 'blocked', reason: 'source_unavailable' };
    const current = f.current;
    if (f.reason !== null || !current || current.id !== f.requested.id)
      return { status: 'blocked', reason: 'body_mismatch' };
    if (f.state === 'deleted') {
      // This proves the owned current tombstone only, never existence of an old
      // requested revision. No deleted historical food body is fetched or copied.
      if (
        current.status !== 'deleted' ||
        current.contentDigest !== digest(null) ||
        f.content !== null ||
        f.contentDigest !== null
      )
        return { status: 'blocked', reason: 'body_mismatch' };
      continue;
    }
    const body = f.content;
    if (
      !body ||
      current.status !== 'active' ||
      body.intakeId !== f.requested.id ||
      body.revisionId.toLowerCase() !== f.requested.revisionId ||
      body.revision > current.revision ||
      body.source !== 'user' ||
      body.sourceRecordId !== null ||
      bytes(body) > 65536 ||
      f.contentDigest !== digest(body) ||
      (f.state === 'current') !== (current.revisionId === f.requested.revisionId) ||
      (f.state === 'current' &&
        (body.revision !== current.revision || current.contentDigest !== f.contentDigest)) ||
      (f.state === 'historical' && body.revision >= current.revision)
    )
      return { status: 'blocked', reason: 'body_mismatch' };
  }
  return {
    status: 'validated_retained_read_facts',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  };
}
/** Retained manual user records, not new processing admission. No app/AI/provider
 * consent lookup, approval boolean, external I/O, mutation, or implicit repinning.
 * Caller supplies fenced authenticated tx; whole-snapshot freshness is separate.
 */
export async function captureManualIntakeReadFacts(
  tx: Transaction,
  unknownRefs: readonly unknown[],
  budget: SourceBudget,
): Promise<ManualIntakeReadFacts> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  const size = bytes(unknownRefs),
    requested = parse(refs, unknownRefs);
  reserveSourceBudget(budget, BigInt(size), requested.length);
  const unique = [...new Map(requested.map((ref) => [key(ref), ref])).values()].sort((a, b) =>
    order(key(a), key(b)),
  );
  const facts: z.infer<typeof fact>[] = [];
  for (const ref of unique) {
    const parameters = [tx.athleteId, ref.id, ref.revisionId];
    const measured = parse(
      z.strictObject({ bytes: z.string().regex(/^\d+$/) }),
      (
        await tx.query(
          `SELECT (coalesce(sum(coalesce(octet_length(c.record_json::text),0)+CASE WHEN e.status='active' THEN coalesce(octet_length(r.record_json::text),0) ELSE 0 END),0)+4096)::text AS bytes
     FROM intake_entry e JOIN intake_entry_revision c ON c.athlete_id=e.athlete_id AND c.intake_id=e.id AND c.revision_id=e.current_revision_id
     LEFT JOIN intake_entry_revision r ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision_id=$3::uuid WHERE e.athlete_id=$1 AND e.id=$2`,
          parameters,
        )
      ).rows[0],
    );
    reserveSourceBudget(budget, BigInt(measured.bytes), 1);
    const rows = (
      await tx.query(
        `SELECT e.id,e.current_revision,e.current_revision_id,e.status,c.record_json AS current_record,
     CASE WHEN e.status='active' THEN r.revision ELSE NULL END AS requested_revision,
     CASE WHEN e.status='active' THEN r.record_json ELSE NULL END AS requested_record
     FROM intake_entry e JOIN intake_entry_revision c ON c.athlete_id=e.athlete_id AND c.intake_id=e.id AND c.revision_id=e.current_revision_id
     LEFT JOIN intake_entry_revision r ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision_id=$3::uuid WHERE e.athlete_id=$1 AND e.id=$2 LIMIT 2`,
        parameters,
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) {
      facts.push({
        requested: ref,
        state: 'unavailable',
        reason: 'owned_reference_unavailable',
        current: null,
        content: null,
        contentDigest: null,
      });
      continue;
    }
    const row = parse(
      z.strictObject({
        id: activeIntakeEntrySchema.shape.intakeId,
        current_revision: revision,
        current_revision_id: uuid,
        status: z.enum(['active', 'deleted']),
        current_record: z.unknown(),
        requested_revision: revision.nullable(),
        requested_record: z.unknown(),
      }),
      rows[0],
    );
    if (row.id !== ref.id) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    let currentDigest = digest(null);
    if (row.status === 'active') {
      bytes(row.current_record, 65536);
      const current = parse(activeIntakeEntrySchema, row.current_record);
      if (
        current.intakeId !== row.id ||
        current.revision !== row.current_revision ||
        current.revisionId.toLowerCase() !== row.current_revision_id
      )
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      currentDigest = digest(current);
    } else if (
      row.current_record !== null ||
      row.requested_record !== null ||
      row.requested_revision !== null
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const current = {
      id: row.id,
      revision: row.current_revision,
      revisionId: row.current_revision_id,
      status: row.status,
      contentDigest: currentDigest,
    };
    if (row.status === 'deleted') {
      facts.push({
        requested: ref,
        state: 'deleted',
        reason: null,
        current,
        content: null,
        contentDigest: null,
      });
      continue;
    }
    if (row.requested_record === null || row.requested_revision === null) {
      facts.push({
        requested: ref,
        state: 'unavailable',
        reason: 'requested_revision_unavailable',
        current,
        content: null,
        contentDigest: null,
      });
      continue;
    }
    bytes(row.requested_record, 65536);
    const body = parse(activeIntakeEntrySchema, row.requested_record);
    if (
      body.intakeId !== ref.id ||
      body.revisionId.toLowerCase() !== ref.revisionId ||
      body.revision !== row.requested_revision ||
      body.revision > current.revision
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (body.source !== 'user' || body.sourceRecordId !== null) {
      facts.push({
        requested: ref,
        state: 'unavailable',
        reason: 'manual_source_required',
        current,
        content: null,
        contentDigest: null,
      });
      continue;
    }
    const bodyDigest = digest(body);
    if (
      current.revisionId === ref.revisionId
        ? body.revision !== current.revision || bodyDigest !== current.contentDigest
        : body.revision >= current.revision
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    facts.push({
      requested: ref,
      state: current.revisionId === ref.revisionId ? 'current' : 'historical',
      reason: null,
      current,
      content: body,
      contentDigest: bodyDigest,
    });
  }
  const result = parse(manualIntakeReadFactsSchema, {
    purpose: 'retained_manual_intake_read',
    athleteId: tx.athleteId,
    facts,
    authority: 'none',
    freshness: 'not_checked',
  });
  bytes(result);
  return result;
}
