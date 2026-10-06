import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from './database.js';
import { lockAppAdmission, requireAppAdmission } from './app-admission.js';

// Server-owned manual editing rules. This basis does not authorize an approval
// or replace the complete domain read set and authenticated stored proposal.
const policy = Object.freeze({
  id: 'manual-race-date-impact',
  version: 1,
  existingUnresolved: 'preserve_with_notice',
  affectedUnresolved: 'resolve_before_approval',
  actualRecords: 'preserve',
  application: 'explicit_user_approval',
  calendarMovement: 'civil_date',
  unknownRaceEnd: 'remain_unresolved',
});
const policyDigest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
const consentSchema = z.strictObject({
  granted: z.boolean(),
  revision: z.number().int().positive().max(2_147_483_647),
});
const basisSchema = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  app: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    consentSchema.extend({ state: z.literal('present') }),
  ]),
  policy: z.strictObject({
    id: z.literal(policy.id),
    version: z.literal(policy.version),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export type RaceManualBasis = z.infer<typeof basisSchema>;

/** Capture retained-read facts, including missing/withdrawn consent. No automatic grant. */
export async function captureRaceManualBasis(tx: Transaction): Promise<RaceManualBasis> {
  await lockAppAdmission(tx);
  const result = await tx.query(
    "SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'",
    [tx.athleteId],
  );
  if (result.rows.length > 1) throw new Error('INVALID_RACE_MANUAL_BASIS');
  const row = result.rows[0];
  return {
    purpose: 'manual_race_date_change',
    app: row ? { state: 'present', ...consentSchema.parse(row) } : { state: 'absent' },
    policy: { id: policy.id, version: policy.version, digest: policyDigest },
  };
}

/**
 * Freshness check only, after original success-receipt lookup. The caller must
 * supply the basis from its owned immutable review record and independently
 * validate all domain dependencies and unresolved impacts before writing.
 */
export async function requireFreshRaceManualBasis(tx: Transaction, input: unknown): Promise<void> {
  const basis = basisSchema.safeParse(input);
  if (!basis.success) throw new Error('INVALID_RACE_MANUAL_BASIS');
  if (basis.data.policy.digest !== policyDigest) throw new Error('STALE_RACE_MANUAL_POLICY');
  const app = await requireAppAdmission(tx);
  if (
    basis.data.app.state !== 'present' ||
    !basis.data.app.granted ||
    basis.data.app.revision !== app.revision
  )
    throw new Error('STALE_RACE_MANUAL_BASIS');
}
