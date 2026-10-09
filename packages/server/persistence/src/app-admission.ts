import { z } from 'zod';
import type { Transaction } from './database.js';

const appAdmissionSchema = z.strictObject({
  kind: z.literal('app'),
  granted: z.literal(true),
  revision: z.number().int().positive().max(2_147_483_647),
});

export type AppAdmission = z.infer<typeof appAdmissionSchema>;

export class AppConsentRequiredError extends Error {
  readonly code = 'APP_CONSENT_REQUIRED';

  constructor() {
    super('APP_CONSENT_REQUIRED');
  }
}

/**
 * Serialize with consent changes, including an absent consent row. Acquire this
 * tenant command lock before any domain lock or receipt lookup. Consent changes
 * use the same key; locking just the consent row cannot protect an absent head.
 */
export async function lockAppAdmission(transaction: Transaction): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    transaction.athleteId,
  ]);
}

/**
 * Authorize new core processing in its own write transaction, after any successful
 * idempotent receipt has been returned. Call lockAppAdmission before other domain
 * locks; re-acquiring it here is safe and also protects standalone callers.
 *
 * This live head is not an upgrade of a stored evidence/approval basis. Callers
 * must independently validate any versioned basis and existing AI/provider gates.
 * Read, export, deletion and cancellation paths do not call this admission gate.
 */
export async function requireAppAdmission(transaction: Transaction): Promise<AppAdmission> {
  await lockAppAdmission(transaction);
  const result = await transaction.query(
    "SELECT kind,granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'",
    [transaction.athleteId],
  );
  const admission = appAdmissionSchema.safeParse(result.rows[0]);
  if (!admission.success) throw new AppConsentRequiredError();
  return admission.data;
}

const appBindingFailureSchema = z.object({
  code: z.literal('P0001'),
  message: z.enum(['APP_CONSENT_REQUIRED', 'STALE_APP_ADMISSION', 'APP_BINDING_UNAVAILABLE']),
});

export class AppAdmissionBindingError extends Error {
  constructor(
    readonly code: 'APP_CONSENT_REQUIRED' | 'STALE_APP_ADMISSION' | 'APP_BINDING_UNAVAILABLE',
  ) {
    super(code);
  }
}

/** Only these fixed SQL gate functions can produce public app admission conflicts. */
export async function requireAppBinding(
  transaction: Transaction,
  subject: 'evidence' | 'run' | 'candidate' | 'integrated_candidate',
  id: string,
): Promise<void> {
  const functions = {
    evidence: 'require_evidence_app_binding',
    run: 'require_run_app_binding',
    candidate: 'require_candidate_app_binding',
    integrated_candidate: 'require_integrated_candidate_app_binding',
  } as const;
  try {
    await transaction.query(`SELECT public.${functions[subject]}($1)`, [id]);
  } catch (error) {
    const failure = appBindingFailureSchema.safeParse(error);
    if (error instanceof Error && failure.success)
      throw new AppAdmissionBindingError(failure.data.message);
    throw error;
  }
}
