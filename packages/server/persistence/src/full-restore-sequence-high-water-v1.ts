import { z } from 'zod';

/**
 * Budget journal identity sequence high-water (EXT-RESTOREa).
 *
 * The roster has exactly one sequence: public.openai_budget_journal_sequence_id_seq,
 * owned (identity, GENERATED ALWAYS) by public.openai_budget_journal.sequence_id.
 * Sequence state is NOT transactional: inside the capture snapshot it reads the
 * latest allocated value, which is >= every id visible to the snapshot. That
 * makes it a safe floor for the target, never an exact snapshot value. The
 * owner-column max is read in the same snapshot as a cross-check; the journal
 * policy only exposes all rows to the table owner, so capture requires the
 * plain owner session.
 */
export class FullRestoreSequenceHighWaterErrorV1 extends Error {
  constructor(
    readonly code:
      | 'SEQUENCE_TRANSACTION_INVALID'
      | 'SEQUENCE_OWNER_REQUIRED'
      | 'SEQUENCE_REPLY_INVALID'
      | 'SEQUENCE_DEFINITION_MISMATCH'
      | 'SEQUENCE_STATE_INCONSISTENT'
      | 'SEQUENCE_TARGET_AHEAD'
      | 'SEQUENCE_APPLY_FAILED',
  ) {
    super(code);
    this.name = 'FullRestoreSequenceHighWaterErrorV1';
  }
}
const fail = (code: FullRestoreSequenceHighWaterErrorV1['code']): never => {
  throw new FullRestoreSequenceHighWaterErrorV1(code);
};
export interface FullRestoreSequenceQueryPortV1 {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const SEQUENCE = Object.freeze({
  schema: 'public',
  relation: 'openai_budget_journal_sequence_id_seq',
});
const OWNER = Object.freeze({
  schema: 'public',
  relation: 'openai_budget_journal',
  column: 'sequence_id',
});
const INT8_MAX = '9223372036854775807';
const STATE_SQL = `SELECT pg_catalog.format_type(s.seqtypid,NULL) AS type,s.seqstart::text AS start,
 s.seqincrement::text AS increment,s.seqmin::text AS minimum,s.seqmax::text AS maximum,s.seqcache::text AS cache,
 s.seqcycle AS cycle,q.last_value::text AS last_value,q.is_called,
 (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('deptype',d.deptype,'schema',cn.nspname,
   'relation',c.relname,'column',a.attname,'identity',a.attidentity) ORDER BY d.refobjid,d.refobjsubid)
  FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class c ON c.oid=d.refobjid
  JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
  WHERE d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=sc.oid
   AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass) AS ownership,
 (SELECT max(j.sequence_id)::text FROM public.openai_budget_journal j) AS owner_max,
 current_user=pg_catalog.pg_get_userbyid(oc.relowner) AND session_user=pg_catalog.pg_get_userbyid(oc.relowner) AS is_owner
FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class sc ON sc.oid=s.seqrelid
JOIN pg_catalog.pg_namespace sn ON sn.oid=sc.relnamespace
CROSS JOIN public.openai_budget_journal_sequence_id_seq q
JOIN pg_catalog.pg_class oc ON oc.oid='public.openai_budget_journal'::pg_catalog.regclass
WHERE sn.nspname='public' AND sc.relname='openai_budget_journal_sequence_id_seq'`;

const int64 = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const stateSchema = z.strictObject({
  type: z.string(),
  start: int64,
  increment: int64,
  minimum: int64,
  maximum: int64,
  cache: int64,
  cycle: z.boolean(),
  last_value: int64,
  is_called: z.boolean(),
  ownership: z
    .array(
      z.strictObject({
        deptype: z.string(),
        schema: z.string(),
        relation: z.string(),
        column: z.string().nullable(),
        identity: z.string().nullable(),
      }),
    )
    .nullable(),
  owner_max: int64.nullable(),
  is_owner: z.boolean(),
});

export type FullRestoreSequenceHighWaterV1 = Readonly<{
  kind: 'full_restore_sequence_high_water_v1';
  schema: 'public';
  relation: 'openai_budget_journal_sequence_id_seq';
  lastValue: string;
  isCalled: boolean;
  ownerColumnMax: string | null;
  snapshotSemantics: 'non_transactional_floor';
  authority: 'none';
}>;

async function readState(tx: FullRestoreSequenceQueryPortV1) {
  const reply = await tx.query(STATE_SQL);
  const parsed = stateSchema.safeParse(reply.rows[0]);
  if (reply.rows.length !== 1 || !parsed.success) return fail('SEQUENCE_REPLY_INVALID');
  const s = parsed.data;
  if (!s.is_owner) fail('SEQUENCE_OWNER_REQUIRED');
  const ownership = s.ownership ?? [];
  if (
    s.type !== 'bigint' ||
    s.start !== '1' ||
    s.increment !== '1' ||
    s.minimum !== '1' ||
    s.maximum !== INT8_MAX ||
    s.cache !== '1' ||
    s.cycle ||
    ownership.length !== 1 ||
    ownership[0]?.deptype !== 'i' ||
    ownership[0].schema !== OWNER.schema ||
    ownership[0].relation !== OWNER.relation ||
    ownership[0].column !== OWNER.column ||
    ownership[0].identity !== 'a'
  )
    fail('SEQUENCE_DEFINITION_MISMATCH');
  const last = BigInt(s.last_value);
  if (
    last < 1n ||
    (s.owner_max !== null && (!s.is_called || last < BigInt(s.owner_max))) ||
    (!s.is_called && last !== 1n)
  )
    fail('SEQUENCE_STATE_INCONSISTENT');
  return s;
}

/** Source side: inside the capture REPEATABLE READ READ ONLY transaction, as plain owner. */
export async function captureFullRestoreSequenceHighWaterV1(
  tx: FullRestoreSequenceQueryPortV1,
): Promise<FullRestoreSequenceHighWaterV1> {
  const mode = await tx.query(
    "SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only",
  );
  if (mode.rows[0]?.['isolation'] !== 'repeatable read' || mode.rows[0]?.['read_only'] !== 'on')
    fail('SEQUENCE_TRANSACTION_INVALID');
  const s = await readState(tx);
  return Object.freeze({
    kind: 'full_restore_sequence_high_water_v1',
    ...SEQUENCE,
    lastValue: s.last_value,
    isCalled: s.is_called,
    ownerColumnMax: s.owner_max,
    snapshotSemantics: 'non_transactional_floor',
    authority: 'none',
  });
}

export type FullRestoreSequenceTargetObservationV1 = Readonly<{
  schema: 'public';
  relation: 'openai_budget_journal_sequence_id_seq';
  lastValue: string;
  isCalled: boolean;
  ownerColumnMax: string | null;
}>;

/**
 * Target side, inside the CLOSED restore write transaction after the journal rows
 * are loaded. Raises the sequence to the authenticated source floor; never lowers
 * it and refuses a target that is already ahead of the source (foreign target).
 * The returned observation is the postcondition `sequences` entry.
 */
export async function applyFullRestoreSequenceHighWaterV1(
  tx: FullRestoreSequenceQueryPortV1,
  source: Pick<FullRestoreSequenceHighWaterV1, 'lastValue' | 'isCalled' | 'ownerColumnMax'>,
): Promise<FullRestoreSequenceTargetObservationV1> {
  const wanted = int64.safeParse(source.lastValue);
  if (!wanted.success || typeof source.isCalled !== 'boolean') return fail('SEQUENCE_APPLY_FAILED');
  const mode = await tx.query("SELECT current_setting('transaction_read_only') AS read_only");
  if (mode.rows[0]?.['read_only'] !== 'off') fail('SEQUENCE_TRANSACTION_INVALID');
  const before = await readState(tx);
  const floor = BigInt(wanted.data);
  if (
    (before.is_called && BigInt(before.last_value) > floor) ||
    (before.owner_max !== null && BigInt(before.owner_max) > floor) ||
    (before.owner_max !== null && !source.isCalled)
  )
    fail('SEQUENCE_TARGET_AHEAD');
  await tx.query(
    "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq'::pg_catalog.regclass,$1::bigint,$2::boolean)",
    [wanted.data, source.isCalled],
  );
  const after = await readState(tx);
  if (after.last_value !== wanted.data || after.is_called !== source.isCalled)
    fail('SEQUENCE_APPLY_FAILED');
  return Object.freeze({
    ...SEQUENCE,
    lastValue: after.last_value,
    isCalled: after.is_called,
    ownerColumnMax: after.owner_max,
  });
}
