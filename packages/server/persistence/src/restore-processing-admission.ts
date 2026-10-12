import { z } from 'zod';
import type { Transaction } from './database.js';
import {
  RESTORE_ADMISSION_ROSTER_SHA256,
  RESTORE_ADMISSION_ROSTER_TALLIES,
  restoreAdmissionCensusSha256,
} from './full-restore-relation-classification-v2.js';

// SQL101 control + SQL147 atomic admission. CLOSED is the default and fail-safe state; ADMITTED
// exists only through the owner window/admit protocol in one transaction (SQL147) and is still
// not an external authority by itself. Callers must obtain the global shared lock before
// lifecycle77206/tenant0. Existing Database.tenant does not yet provide that order; no reader
// factory or runtime writer enforcement is installed by this module.
const revisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const targetFields = { targetNonce: z.uuid().nullable(), targetIncarnation: z.uuid().nullable() };
const pairedTarget = (value: { targetNonce: string | null; targetIncarnation: string | null }) =>
  (value.targetNonce === null) === (value.targetIncarnation === null);
/** CLOSED control (SQL101 shape): close, assertClosed, close receipt replay, loaders. */
const closedSchema = z
  .strictObject({
    state: z.literal('CLOSED'),
    localRevision: revisionSchema,
    generationId: z.uuid(),
    ...targetFields,
    admissionAllowed: z.literal(false),
    targetAttested: z.literal(false),
  })
  .refine(pairedTarget);
/** ADMITTED control (SQL147): always bound to a target; stale generation reads as not allowed. */
const admittedSchema = z.strictObject({
  state: z.literal('ADMITTED'),
  localRevision: revisionSchema,
  generationId: z.uuid(),
  targetNonce: z.uuid(),
  targetIncarnation: z.uuid(),
  admissionAllowed: z.boolean(),
  targetAttested: z.literal(true),
});
const controlSchema = z.union([closedSchema, admittedSchema]);
export type RestoreProcessingClosedControl = z.infer<typeof closedSchema>;
export type RestoreProcessingAdmittedControl = z.infer<typeof admittedSchema>;
export type RestoreProcessingAdmission =
  RestoreProcessingClosedControl | RestoreProcessingAdmittedControl;
export type RestoreProcessingAdmissionErrorCode =
  | 'RESTORE_PROCESSING_CLOSED'
  | 'RESTORE_PROCESSING_CONTROL_MISSING'
  | 'INVALID_RESTORE_PROCESSING_CONTROL'
  | 'RESTORE_PROCESSING_OWNER_REQUIRED'
  | 'RESTORE_PROCESSING_CONTROL_CONFLICT'
  | 'RESTORE_PROCESSING_CLOSE_CONFLICT'
  | 'RESTORE_PROCESSING_REVISION_EXHAUSTED'
  | 'INVALID_RESTORE_PROCESSING_CLOSE'
  | 'INVALID_RESTORE_PROCESSING_ADMIT'
  | 'RESTORE_PROCESSING_ADMIT_CONFLICT'
  | 'RESTORE_PROCESSING_ADMIT_SUPERSEDED'
  | 'RESTORE_PROCESSING_ADMIT_CONTEXT'
  | 'RESTORE_PROCESSING_WINDOW_NOT_OPEN'
  | 'RESTORE_PROCESSING_WINDOW_OPEN_AT_COMMIT'
  | 'RESTORE_PROCESSING_ROSTER_MISMATCH'
  | 'RESTORE_PROCESSING_POSTCONDITION_FAILED'
  | 'RESTORE_PROCESSING_COMMAND_ID_REUSED'
  | 'IMMUTABLE_RESTORE_PROCESSING_ADMIT_RECEIPT';
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
    'INVALID_RESTORE_PROCESSING_ADMIT',
    'RESTORE_PROCESSING_ADMIT_CONFLICT',
    'RESTORE_PROCESSING_ADMIT_SUPERSEDED',
    'RESTORE_PROCESSING_ADMIT_CONTEXT',
    'RESTORE_PROCESSING_WINDOW_NOT_OPEN',
    'RESTORE_PROCESSING_WINDOW_OPEN_AT_COMMIT',
    'RESTORE_PROCESSING_ROSTER_MISMATCH',
    'RESTORE_PROCESSING_POSTCONDITION_FAILED',
    'RESTORE_PROCESSING_COMMAND_ID_REUSED',
    'IMMUTABLE_RESTORE_PROCESSING_ADMIT_RECEIPT',
  ]),
});
function translate(error: unknown): never {
  const failure = sqlFailureSchema.safeParse(error);
  if (error instanceof Error && failure.success)
    throw new RestoreProcessingAdmissionError(failure.data.message);
  throw error;
}
/** CLOSED-only decoder (SQL101 shape). ADMITTED or any other value is rejected. */
export function decodeRestoreProcessingAdmission(input: unknown): RestoreProcessingClosedControl {
  const decoded = closedSchema.safeParse(input);
  if (!decoded.success)
    throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
  return decoded.data;
}
/** CLOSED or ADMITTED status decoder (read_ only). */
export function decodeRestoreProcessingControl(input: unknown): RestoreProcessingAdmission {
  const decoded = controlSchema.safeParse(input);
  if (!decoded.success)
    throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
  return decoded.data;
}
async function controlResult<T>(
  query: Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  decode: (input: unknown) => T,
): Promise<T> {
  try {
    const result = await query;
    if (result.rows.length !== 1)
      throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
    return decode(result.rows[0]?.['control']);
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
  return controlResult(
    tx.query('SELECT public.read_restore_processing_admission() AS control'),
    decodeRestoreProcessingControl,
  );
}
/**
 * Caller looks up original successful receipt first. Resolves only when the SQL gate passes AND a
 * read in the SAME transaction decodes as ADMITTED with admissionAllowed:true. `tx` must be an
 * explicit transaction; a malformed or replaced SQL function returning success never authorizes.
 */
export async function requireRestoreProcessingAdmission(tx: Transaction): Promise<void> {
  let control: unknown;
  try {
    await tx.query('SELECT public.require_restore_processing_admission()');
    const result = await tx.query('SELECT public.read_restore_processing_admission() AS control');
    if (result.rows.length !== 1)
      throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
    control = result.rows[0]?.['control'];
  } catch (error) {
    return translate(error);
  }
  const decoded = admittedSchema.safeParse(control);
  if (!decoded.success || decoded.data.admissionAllowed !== true)
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
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const xidSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const windowSchema = z.strictObject({
  expectedRevision: revisionSchema,
  targetNonce: z.uuid(),
  targetIncarnation: z.uuid(),
});
const censusEntrySchema = z.strictObject({
  schema: identifier,
  relation: identifier,
  rowCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const admitSchema = z.strictObject({
  expectedRevision: revisionSchema,
  commandId: z.uuid(),
  targetNonce: z.uuid(),
  targetIncarnation: z.uuid(),
  artifactSha256: hash,
  headSha256: hash,
  postconditionsSha256: hash,
  census: z.array(censusEntrySchema).min(1).max(1000),
  censusSha256: hash,
  observedXid: xidSchema,
});
export type RestoreProcessingAdmissionWindowInput = z.infer<typeof windowSchema>;
export type RestoreProcessingAdmitCommand = z.infer<typeof admitSchema>;
export type RestoreProcessingAdmissionWindow = Readonly<{
  xid: string;
  censusRelations: number;
  rosterSha256: string;
}>;
export type RestoreProcessingAdmitResult = Readonly<{
  replayed: boolean;
  resultRevision: string;
  rosterSha256: string;
  censusSha256: string;
  control: RestoreProcessingAdmittedControl;
}>;
export interface RestoreProcessingOwnerPort {
  close(input: unknown): Promise<RestoreProcessingClosedControl>;
  assertClosed(input: unknown): Promise<RestoreProcessingClosedControl>;
  /** (A) SQL147 window. Must be the first admission call inside the caller's RC transaction. */
  openAdmissionWindow(input: unknown): Promise<RestoreProcessingAdmissionWindow>;
  /** (C) SQL147 atomic admission in the same transaction as the window. */
  admit(command: unknown): Promise<RestoreProcessingAdmitResult>;
}
const codePointOrder = (
  a: { schema: string; relation: string },
  b: { schema: string; relation: string },
) =>
  a.schema !== b.schema
    ? a.schema < b.schema
      ? -1
      : 1
    : a.relation < b.relation
      ? -1
      : a.relation > b.relation
        ? 1
        : 0;
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
        decodeRestoreProcessingAdmission,
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
        decodeRestoreProcessingAdmission,
      );
    },
    async openAdmissionWindow(input) {
      const command = windowSchema.safeParse(input);
      if (!command.success)
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_ADMIT');
      await requirePlainLiveOwner(owner);
      const window = await controlResult(
        owner.query('SELECT public.open_restore_processing_admission_window($1,$2,$3) AS control', [
          command.data.expectedRevision,
          command.data.targetNonce,
          command.data.targetIncarnation,
        ]),
        (value) =>
          z
            .strictObject({
              xid: xidSchema,
              censusRelations: z.literal(RESTORE_ADMISSION_ROSTER_TALLIES.census),
              rosterSha256: z.literal(RESTORE_ADMISSION_ROSTER_SHA256),
            })
            .safeParse(value),
      );
      if (!window.success)
        throw new RestoreProcessingAdmissionError('RESTORE_PROCESSING_ROSTER_MISMATCH');
      return Object.freeze(window.data);
    },
    async admit(input) {
      const parsed = admitSchema.safeParse(input);
      if (!parsed.success)
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_ADMIT');
      const command = parsed.data;
      if (
        command.census.some((entry, i) => {
          const previous = command.census[i - 1];
          return previous !== undefined && codePointOrder(previous, entry) >= 0;
        }) ||
        restoreAdmissionCensusSha256(command.census) !== command.censusSha256
      )
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_ADMIT');
      await requirePlainLiveOwner(owner);
      const resultRevision = (BigInt(command.expectedRevision) + 1n).toString();
      const outcome = await controlResult(
        owner.query(
          'SELECT public.admit_restore_processing_exact($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) AS control',
          [
            command.expectedRevision,
            command.commandId,
            command.targetNonce,
            command.targetIncarnation,
            command.artifactSha256,
            command.headSha256,
            command.postconditionsSha256,
            JSON.stringify(command.census),
            command.censusSha256,
            command.observedXid,
          ],
        ),
        (value) =>
          z
            .strictObject({
              replayed: z.boolean(),
              resultRevision: z.literal(resultRevision),
              rosterSha256: z.literal(RESTORE_ADMISSION_ROSTER_SHA256),
              censusSha256: z.literal(command.censusSha256),
              control: admittedSchema.extend({
                localRevision: z.literal(resultRevision),
                targetNonce: z.literal(command.targetNonce),
                targetIncarnation: z.literal(command.targetIncarnation),
                admissionAllowed: z.literal(true),
              }),
            })
            .safeParse(value),
      );
      // A success-shaped but different result never counts as admission.
      if (!outcome.success)
        throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_CONTROL');
      return Object.freeze(outcome.data);
    },
  };
}

/** One owner connection that this helper may BEGIN/COMMIT/ROLLBACK on (not a pool). */
export type RestoreProcessingOwnerSession = RestoreProcessingOwnerQueryPort;
export type RestoreProcessingAdmissionObserver = (input: {
  readonly window: RestoreProcessingAdmissionWindow;
  /** Same connection and transaction; the window's locks and owner visibility apply. */
  readonly query: RestoreProcessingOwnerQueryPort['query'];
}) => Promise<RestoreProcessingAdmitCommand>;
/**
 * Owner transaction helper: BEGIN READ COMMITTED, SET LOCAL lock_timeout, open the window, hand
 * the same transaction to the observer/evaluator, admit, COMMIT. Any failure rolls back (the
 * catalog NO FORCE change and the control row revert); nothing commits unless admit succeeded.
 */
export async function runRestoreProcessingAdmissionTransaction(
  session: RestoreProcessingOwnerSession,
  input: Readonly<{
    window: RestoreProcessingAdmissionWindowInput;
    lockTimeoutMs: number;
    observe: RestoreProcessingAdmissionObserver;
  }>,
): Promise<RestoreProcessingAdmitResult> {
  if (
    !Number.isInteger(input.lockTimeoutMs) ||
    input.lockTimeoutMs < 1 ||
    input.lockTimeoutMs > 600000
  )
    throw new RestoreProcessingAdmissionError('INVALID_RESTORE_PROCESSING_ADMIT');
  const port = createRestoreProcessingOwnerPort(session);
  await session.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await session.query(`SET LOCAL lock_timeout = '${input.lockTimeoutMs}ms'`);
    const window = await port.openAdmissionWindow(input.window);
    const command = await input.observe({
      window,
      query: (sql, values) => session.query(sql, values),
    });
    if (
      command === null ||
      typeof command !== 'object' ||
      command.observedXid !== window.xid ||
      command.expectedRevision !== input.window.expectedRevision ||
      command.targetNonce !== input.window.targetNonce ||
      command.targetIncarnation !== input.window.targetIncarnation
    )
      throw new RestoreProcessingAdmissionError('RESTORE_PROCESSING_ADMIT_CONTEXT');
    const result = await port.admit(command);
    await session.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await session.query('ROLLBACK');
    } catch {
      // The caller must discard the connection; the transaction cannot commit.
    }
    if (error instanceof RestoreProcessingAdmissionError) throw error;
    return translate(error);
  }
}
