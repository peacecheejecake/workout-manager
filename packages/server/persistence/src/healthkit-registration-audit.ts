import type { Pool } from 'pg';
import { z } from 'zod';

const optionsSchema = z.strictObject({
  countCeiling: z.number().int().min(1).max(1_000_000).default(1_000_000),
});
const countSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const metrics = {
  rawRows: 'SELECT count(*) FROM public.healthkit_workout_sample',
  rawActiveRows: "SELECT count(*) FROM public.healthkit_workout_sample WHERE state='active'",
  rawTombstoneRows: "SELECT count(*) FROM public.healthkit_workout_sample WHERE state='deleted'",
  rawDuplicateAccountUuids:
    'SELECT count(*) FROM (SELECT sample_id FROM public.healthkit_workout_sample GROUP BY sample_id HAVING count(DISTINCT athlete_id)>1) duplicates',
  rawWithoutOwnClaimRows:
    'SELECT count(*) FROM public.healthkit_workout_sample s WHERE NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim c WHERE c.sample_id=s.sample_id AND c.athlete_id=s.athlete_id)',
  rawOtherClaimOwnerRows:
    'SELECT count(*) FROM public.healthkit_workout_sample s JOIN public.healthkit_workout_claim c ON c.sample_id=s.sample_id WHERE c.athlete_id<>s.athlete_id',
  rawWithoutGrantedConsentRows:
    "SELECT count(*) FROM public.healthkit_workout_sample s WHERE NOT EXISTS(SELECT 1 FROM public.consent c WHERE c.athlete_id=s.athlete_id AND c.kind='healthkit' AND c.granted)",
  receiptRows: 'SELECT count(*) FROM public.healthkit_workout_batch_receipt',
  receiptLegacyV1Rows:
    'SELECT count(*) FROM public.healthkit_workout_batch_receipt WHERE protocol_version=1',
  receiptHistoricalRows:
    'SELECT count(*) FROM public.healthkit_workout_batch_receipt WHERE pre_registration_historical',
  receiptPurgedRows:
    'SELECT count(*) FROM public.healthkit_workout_batch_receipt WHERE purged_at IS NOT NULL',
  receiptActiveUnknownMembershipRows:
    'SELECT count(*) FROM public.healthkit_workout_batch_receipt WHERE purged_at IS NULL AND sample_ids IS NULL',
  receiptActiveKnownMembershipRows:
    'SELECT count(*) FROM public.healthkit_workout_batch_receipt WHERE purged_at IS NULL AND sample_ids IS NOT NULL',
  receiptActiveWithoutGrantedConsentRows:
    "SELECT count(*) FROM public.healthkit_workout_batch_receipt r WHERE r.purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.consent c WHERE c.athlete_id=r.athlete_id AND c.kind='healthkit' AND c.granted)",
  receiptKnownDuplicateAccountUuids:
    'SELECT count(*) FROM (SELECT sample_id FROM public.healthkit_workout_batch_receipt r CROSS JOIN LATERAL unnest(r.sample_ids) sample_id WHERE r.purged_at IS NULL GROUP BY sample_id HAVING count(DISTINCT r.athlete_id)>1) duplicates',
  rawAndKnownReceiptDuplicateAccountUuids:
    'SELECT count(*) FROM (SELECT sample_id FROM (SELECT athlete_id,sample_id FROM public.healthkit_workout_sample UNION SELECT r.athlete_id,sample_id FROM public.healthkit_workout_batch_receipt r CROSS JOIN LATERAL unnest(r.sample_ids) sample_id WHERE r.purged_at IS NULL) membership GROUP BY sample_id HAVING count(DISTINCT athlete_id)>1) duplicates',
  claimRows: 'SELECT count(*) FROM public.healthkit_workout_claim',
  claimWithoutCurrentConsentRows:
    "SELECT count(*) FROM public.healthkit_workout_claim h WHERE NOT EXISTS(SELECT 1 FROM public.consent c WHERE c.athlete_id=h.athlete_id AND c.kind='healthkit' AND c.granted AND c.revision=h.consent_revision)",
  pendingDeregistrationRows:
    "SELECT count(*) FROM public.healthkit_workout_deregistration WHERE state='pending_cleanup'",
} as const;
type Metric = keyof typeof metrics;
export interface HealthKitRegistrationAudit {
  readonly schemaVersion: 1;
  readonly countCeiling: number;
  readonly counts: Readonly<
    Record<Metric, { readonly count: number; readonly saturated: boolean }>
  >;
  /** Unknown receipt membership cannot establish historical UUID ownership. */
  readonly historicalOwnershipProven: false;
}

/** Owner-only operational audit. No mutation, identifier output, or automatic claim backfill. */
export async function auditHealthKitRegistration(
  pool: Pool,
  options: z.input<typeof optionsSchema> = {},
): Promise<HealthKitRegistrationAudit> {
  const { countCeiling } = optionsSchema.parse(options);
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(
      "SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','3000',true),set_config('row_security','off',true),set_config('search_path','pg_catalog,public',true)",
    );
    const owner =
      await client.query(`SELECT count(*)::text AS count FROM pg_catalog.pg_class WHERE oid IN (
      'public.healthkit_workout_sample'::regclass,'public.healthkit_workout_batch_receipt'::regclass,
      'public.healthkit_workout_claim'::regclass,'public.healthkit_workout_deregistration'::regclass,
      'public.consent'::regclass) AND pg_get_userbyid(relowner)=session_user`);
    if (owner.rows[0]?.['count'] !== '5') throw new Error('HEALTHKIT_AUDIT_OWNER_REQUIRED');
    const projections = Object.entries(metrics).map(([name, sql]) => `(${sql})::text AS "${name}"`);
    const result = await client.query(`SELECT ${projections.join(',')}`);
    // Strict scalar decoding and clipping prevent raw rows or unbounded counts escaping this boundary.
    const row = z.record(z.string(), countSchema).parse(result.rows[0]);
    const counts = {} as Record<Metric, { count: number; saturated: boolean }>;
    for (const name of Object.keys(metrics) as Metric[]) {
      const value = row[name];
      if (value === undefined) throw new Error('HEALTHKIT_AUDIT_INVALID_RESULT');
      counts[name] = { count: Math.min(value, countCeiling), saturated: value > countCeiling };
    }
    await client.query('COMMIT');
    return { schemaVersion: 1, countCeiling, counts, historicalOwnershipProven: false };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    if (error instanceof Error && error.message === 'HEALTHKIT_AUDIT_OWNER_REQUIRED') throw error;
    throw new Error('HEALTHKIT_AUDIT_UNAVAILABLE');
  } finally {
    client.release(discard);
  }
}
