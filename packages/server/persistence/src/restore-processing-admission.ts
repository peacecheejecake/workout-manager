import { z } from 'zod';
import type { Transaction } from './database.js';

// CLOSED-only primitive. This is not a full restore proof or external authority.
// Callers must obtain the global shared lock before lifecycle77206/tenant0.
// Existing Database.tenant does not yet provide that order; no reader factory or
// writer enforcement is installed by this module.
const revisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const targetFields = { targetNonce: z.uuid().nullable(), targetIncarnation: z.uuid().nullable() };
const pairedTarget = (value: { targetNonce: string | null; targetIncarnation: string | null }) =>
  (value.targetNonce === null) === (value.targetIncarnation === null);
const controlSchema = z
  .strictObject({
    state: z.literal('CLOSED'),
    localRevision: revisionSchema,
    generationId: z.uuid(),
    ...targetFields,
    admissionAllowed: z.literal(false),
    targetAttested: z.literal(false),
  })
  .refine(pairedTarget);
export type RestoreProcessingAdmission = z.infer<typeof controlSchema>;
export type RestoreProcessingAdmissionErrorCode =
  | 'RESTORE_PROCESSING_CLOSED'
  | 'RESTORE_PROCESSING_CONTROL_MISSING'
  | 'INVALID_RESTORE_PROCESSING_CONTROL'
  | 'RESTORE_PROCESSING_OWNER_REQUIRED'
  | 'RESTORE_PROCESSING_CONTROL_CONFLICT'
  | 'RESTORE_PROCESSING_CLOSE_CONFLICT'
  | 'RESTORE_PROCESSING_REVISION_EXHAUSTED'
  | 'INVALID_RESTORE_PROCESSING_CLOSE';
export class RestoreProcessingAdmissionError extends Error {
  constructor(readonly code: RestoreProcessingAdmissionErrorCode) {
    super(code);
  }
}
const sqlFailureSchema = z.object({
  code: z.enum(['P0001', '42501']),
  message: z.enum([
    'RESTORE_PROCESSING_CLOSED',
    'RESTORE_PROCESSING_CONTROL_MISSING',
    'RESTORE_PROCESSING_OWNER_REQUIRED',
    'RESTORE_PROCESSING_CONTROL_CONFLICT',
    'RESTORE_PROCESSING_CLOSE_CONFLICT',
    'RESTORE_PROCESSING_REVISION_EXHAUSTED',
    'INVALID_RESTORE_PROCESSING_CLOSE',
  ]),
});
function translate(error: unknown): never {
  const failure = sqlFailureSchema.safeParse(error);
  if (error instanceof Error && failure.success)
    throw new RestoreProcessingAdmissionError(failure.data.message);
  throw error;
}
export function decodeRestoreProcessingAdmission(input: unknown): RestoreProcessingAdmission {
  const decoded = controlSchema.safeParse(input);
  if (!decoded.success)
    throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
  return decoded.data;
}
async function controlResult(
  query: Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
): Promise<RestoreProcessingAdmission> {
  try {
    const result = await query;
    if (result.rows.length !== 1)
      throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
    return decodeRestoreProcessingAdmission(result.rows[0]?.['control']);
  } catch (error) {
    return translate(error);
  }
}
/** Must be acquired before lifecycle77206/tenant0, including retained-read transactions. */
export async function lockRestoreProcessingShared(tx: Transaction): Promise<void> {
  await tx.query('SELECT public.lock_restore_processing_shared()');
}
/** Retained status read; CLOSED is a valid result and never implies processing authority. */
export function readRestoreProcessingAdmission(
  tx: Transaction,
): Promise<RestoreProcessingAdmission> {
  return controlResult(tx.query('SELECT public.read_restore_processing_admission() AS control'));
}
/** Caller looks up original successful receipt first. No ADMITTED state exists here. */
export async function requireRestoreProcessingAdmission(tx: Transaction): Promise<never> {
  try {
    await tx.query('SELECT public.require_restore_processing_admission()');
  } catch (error) {
    return translate(error);
  }
  // A malformed/replaced SQL function returning success must never authorize processing.
  throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
}

/** Server owner connection only. This port never grants privileges or begins/commits a transaction. */
export interface RestoreProcessingOwnerQueryPort {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
const closeSchema = z
  .strictObject({ expectedRevision: revisionSchema, commandId: z.uuid(), ...targetFields })
  .refine(pairedTarget);
const assertSchema = z
  .strictObject({ expectedRevision: revisionSchema, ...targetFields })
  .refine(pairedTarget);
export interface RestoreProcessingOwnerPort {
  close(input: unknown): Promise<RestoreProcessingAdmission>;
  assertClosed(input: unknown): Promise<RestoreProcessingAdmission>;
}
async function requirePlainLiveOwner(client: RestoreProcessingOwnerQueryPort): Promise<void> {
  const result = await client.query(`SELECT current_user AS role,session_user AS session_role,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner,r.rolsuper,r.rolbypassrls
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.rolname=session_user
    WHERE c.oid='public.restore_processing_admission'::pg_catalog.regclass`);
  const shape = z.strictObject({
    role: z.string(),
    session_role: z.string(),
    owner: z.string(),
    rolsuper: z.literal(false),
    rolbypassrls: z.literal(false),
  });
  const value = shape.safeParse(result.rows[0]);
  if (
    result.rows.length !== 1 ||
    !value.success ||
    value.data.role !== value.data.session_role ||
    value.data.session_role !== value.data.owner
  )
    throw new RestoreProcessingAdmissionError('RESTORE_PROCESSING_OWNER_REQUIRED');
}
export function createRestoreProcessingOwnerPort(
  owner: RestoreProcessingOwnerQueryPort,
): RestoreProcessingOwnerPort {
  return {
    async close(input) {
      const command = closeSchema.safeParse(input);
      if (!command.success)
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CLOSE');
      await requirePlainLiveOwner(owner);
      return controlResult(
        owner.query('SELECT public.close_restore_processing_exact($1,$2,$3,$4) AS control', [
          command.data.expectedRevision,
          command.data.commandId,
          command.data.targetNonce,
          command.data.targetIncarnation,
        ]),
      );
    },
    async assertClosed(input) {
      const command = assertSchema.safeParse(input);
      if (!command.success)
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
      await requirePlainLiveOwner(owner);
      return controlResult(
        owner.query('SELECT public.assert_restore_processing_closed($1,$2,$3) AS control', [
          command.data.expectedRevision,
          command.data.targetNonce,
          command.data.targetIncarnation,
        ]),
      );
    },
  };
}
