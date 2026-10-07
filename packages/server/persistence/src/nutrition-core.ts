import { requireAppAdmission } from './app-admission.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  activeIntakeEntrySchema,
  createIntakeEntryRequestSchema,
  correctIntakeEntryRequestSchema,
  deleteIntakeEntryRequestSchema,
  deletedIntakeEntrySchema,
  foodDefinitionVersionSchema,
  intakeEntriesQuerySchema,
  intakeEntriesResponseSchema,
  nutrientValueCoverage,
  nutritionPlanReadSchema,
  nutritionPlanVersionSchema,
  nutritionPlansQuerySchema,
  nutritionPlansResponseSchema,
  saveFoodDefinitionVersionRequestSchema,
  saveNutritionPlanVersionRequestSchema,
  type ActiveIntakeEntry,
  type CorrectIntakeEntryRequest,
  type CreateIntakeEntryRequest,
  type DeletedIntakeEntry,
  type DeleteIntakeEntryRequest,
  type FoodDefinitionVersion,
  type IntakeEntriesQuery,
  type IntakeEntriesResponse,
  type IntakeEntryRecord,
  type NutritionPlanRead,
  type NutritionPlansQuery,
  type NutritionPlansResponse,
  type NutritionPlanVersion,
  type SaveFoodDefinitionVersionRequest,
  type SaveNutritionPlanVersionRequest,
} from '@workout/contracts/nutrition-core';
import {
  nutritionPlanReadV2Schema,
  type NutritionPlanReadV2,
} from '@workout/contracts/nutrition-race-plan-v2';
import {
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanVersionV3Schema,
  type NutritionPlanVersionCompatibleV3,
  nutritionPlanReadV3Schema,
  nutritionPlansResponseV3Schema,
  type NutritionPlanReadV3,
  type NutritionPlansResponseV3,
} from '@workout/contracts/nutrition-race-plan-v3';
import { planSnapshotSchema } from '@workout/contracts/planning';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { requireCurrentRestoreGeneration } from './restore-generation.js';

const boundedId = z.string().min(1).max(128);
const foodQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().max(512).nullable(),
});
type FoodQuery = z.infer<typeof foodQuerySchema>;
type FoodPage = { foods: FoodDefinitionVersion[]; nextCursor: string | null };

export class NutritionReferenceError extends Error {
  constructor(
    readonly code:
      | 'PLAN_NOT_FOUND'
      | 'FOOD_NOT_FOUND'
      | 'INTAKE_NOT_FOUND'
      | 'PLAN_LINK_INVALID'
      | 'FOOD_LINK_INVALID'
      | 'SESSION_LINK_INVALID'
      | 'ACTIVITY_LINK_INVALID',
  ) {
    super(code);
  }
}

export class NutritionValidationError extends Error {
  readonly code = 'OCCURRED_AT_IN_FUTURE';
  constructor() {
    super('OCCURRED_AT_IN_FUTURE');
  }
}

export class NutritionReadLimitError extends Error {
  readonly code = 'NUTRITION_READ_LIMIT';
  constructor() {
    super('NUTRITION_READ_LIMIT');
  }
}
export class NutritionReadVersionError extends Error {
  readonly code = 'NUTRITION_READ_VERSION_UNSUPPORTED';
  constructor() {
    super('NUTRITION_READ_VERSION_UNSUPPORTED');
  }
}
export interface NutritionRepository {
  savePlan(
    athleteId: string,
    input: SaveNutritionPlanVersionRequest,
  ): Promise<NutritionPlanVersion>;
  /** Receipt replay only; absent receipt returns null and never creates an approval. */
  replayPlanV3(
    athleteId: string,
    input: SaveNutritionPlanVersionRequest,
  ): Promise<NutritionPlanVersionCompatibleV3 | null>;
  readPlan(athleteId: string, planId: string): Promise<NutritionPlanRead | null>;
  readPlanV2(athleteId: string, planId: string): Promise<NutritionPlanReadV2 | null>;
  readPlanV3(athleteId: string, planId: string): Promise<NutritionPlanReadV3 | null>;
  listPlansV3(athleteId: string, query: NutritionPlansQuery): Promise<NutritionPlansResponseV3>;
  listPlans(athleteId: string, query: NutritionPlansQuery): Promise<NutritionPlansResponse>;
  saveFood(
    athleteId: string,
    input: SaveFoodDefinitionVersionRequest,
  ): Promise<FoodDefinitionVersion>;
  readFood(athleteId: string, foodId: string): Promise<FoodDefinitionVersion | null>;
  listFoods(athleteId: string, query: FoodQuery): Promise<FoodPage>;
  createIntake(athleteId: string, input: CreateIntakeEntryRequest): Promise<ActiveIntakeEntry>;
  correctIntake(athleteId: string, input: CorrectIntakeEntryRequest): Promise<ActiveIntakeEntry>;
  deleteIntake(athleteId: string, input: DeleteIntakeEntryRequest): Promise<DeletedIntakeEntry>;
  readIntake(athleteId: string, intakeId: string): Promise<IntakeEntryRecord | null>;
  listIntakes(athleteId: string, query: IntakeEntriesQuery): Promise<IntakeEntriesResponse>;
}

function cursor<T>(value: T): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor<T>(value: string | null, schema: z.ZodType<T>): T | null {
  if (value === null) return null;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
function requireUuid(value: string): string {
  return z.uuid().parse(value).toLowerCase();
}
function record<T>(value: unknown, schema: z.ZodType<T>): T {
  return schema.parse(value);
}
async function commandLock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tx.athleteId]);
}
async function replay<T>(
  tx: Transaction,
  key: string,
  request: unknown,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const prior = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!prior.rows[0]) return null;
  if (prior.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return schema.parse(prior.rows[0]['result']);
}
const scrubbedNutritionReceiptRequestSchema = z.strictObject({
  receiptVersion: z.literal(2),
  digestVersion: z.literal('postgres-jsonb-sha256-v1'),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const committedNutritionReceiptSchema = z.strictObject({
  receiptVersion: z.literal(2),
  outcome: z.literal('committed'),
  kind: z.literal('nutrition_plan'),
  planId: z.uuid().transform((id) => id.toLowerCase()),
  versionId: z.uuid().transform((id) => id.toLowerCase()),
  version: z.number().int().positive(),
  approvalId: z.uuid().transform((id) => id.toLowerCase()),
});
/** Original receipt tuple only: never select the latest head or create another approval. */
async function replayNutritionPlan(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<NutritionPlanVersionCompatibleV3 | null> {
  const prior = await tx.query(
    `SELECT request,result,CASE WHEN request->>'receiptVersion'='2'
       THEN request->>'requestDigest'=encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex')
       ELSE request=$3::jsonb END AS matches
     FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2`,
    [tx.athleteId, key, JSON.stringify(request)],
  );
  const row = prior.rows[0];
  if (!row) return null;
  const stored = z.record(z.string(), z.unknown()).parse(row['request']);
  if (stored['receiptVersion'] !== 2) {
    if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
    return nutritionPlanVersionCompatibleV3Schema.parse(row['result']);
  }
  scrubbedNutritionReceiptRequestSchema.parse(stored);
  const committed = committedNutritionReceiptSchema.parse(row['result']);
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  const versions = await tx.query(
    `SELECT octet_length(record_json::text)::text AS bytes,
       CASE WHEN octet_length(record_json::text)<=524288 THEN record_json ELSE NULL END AS record_json
     FROM nutrition_plan_version
     WHERE athlete_id=$1 AND plan_id=$2 AND version_id=$3 AND version=$4 AND approval_id=$5`,
    [tx.athleteId, committed.planId, committed.versionId, committed.version, committed.approvalId],
  );
  if (versions.rows.length !== 1) throw new Error('INVALID_NUTRITION_SAVE_RECEIPT');
  const versionRow = versions.rows[0];
  if (!versionRow) throw new Error('INVALID_NUTRITION_SAVE_RECEIPT');
  if (BigInt(z.string().regex(/^\d+$/).parse(versionRow['bytes'])) > 524288n)
    throw new NutritionReadLimitError();
  const record = nutritionPlanVersionV3Schema.parse(versionRow['record_json']);
  if (
    record.planId !== committed.planId ||
    record.versionId !== committed.versionId ||
    record.version !== committed.version ||
    record.approvalId !== committed.approvalId
  )
    throw new Error('INVALID_NUTRITION_SAVE_RECEIPT');
  return record;
}
async function finish<T>(
  tx: Transaction,
  key: string,
  request: unknown,
  result: T,
  topic: string,
  payload: Record<string, string | number>,
): Promise<T> {
  await enqueue(tx, { id: randomUUID(), idempotencyKey: key, topic, payload });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
  return result;
}
async function ownedTrainingPlan(tx: Transaction, id: string) {
  const rows = await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    requireUuid(id),
  ]);
  if (!rows.rows[0]) throw new NutritionReferenceError('PLAN_LINK_INVALID');
  return planSnapshotSchema.shape.draft.parse(rows.rows[0]['draft']);
}
async function validateFoodPortions(
  tx: Transaction,
  portions: { foodVersionId: string | null; sourceBasis: string }[],
) {
  const ids = [
    ...new Set(
      portions.flatMap((portion) =>
        portion.foodVersionId === null ? [] : [requireUuid(portion.foodVersionId)],
      ),
    ),
  ];
  if (ids.length === 0) return;
  const rows = await tx.query(
    'SELECT version_id,record_json FROM food_definition_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])',
    [tx.athleteId, ids],
  );
  const found = new Map(
    rows.rows.map((row) => {
      const food = foodDefinitionVersionSchema.parse(row['record_json']);
      return [food.versionId, food] as const;
    }),
  );
  if (found.size !== ids.length) throw new NutritionReferenceError('FOOD_LINK_INVALID');
  for (const portion of portions) {
    if (portion.foodVersionId === null) continue;
    const food = found.get(requireUuid(portion.foodVersionId));
    if (!food) throw new NutritionReferenceError('FOOD_LINK_INVALID');
    if (
      portion.sourceBasis !== 'manual_total' &&
      portion.sourceBasis !== 'unknown' &&
      portion.sourceBasis !== food.basis.kind
    )
      throw new NutritionReferenceError('FOOD_LINK_INVALID');
  }
}
async function validatePlanDraft(tx: Transaction, draft: SaveNutritionPlanVersionRequest['draft']) {
  const training =
    draft.linkedTrainingPlanVersionId === null
      ? null
      : await ownedTrainingPlan(tx, draft.linkedTrainingPlanVersionId);
  const sessions = new Set(training?.sessions.map((session) => session.id) ?? []);
  for (const item of draft.items) {
    // Legacy writes have no owned immutable race capture; session IDs cannot authorize races.
    if (
      item.anchor.kind === 'relative' &&
      (item.anchor.entity !== 'session' || !sessions.has(item.anchor.entityId))
    )
      throw new NutritionReferenceError('SESSION_LINK_INVALID');
  }
  await validateFoodPortions(
    tx,
    draft.items.flatMap((item) => item.foods),
  );
}
type IntakeFields = Pick<
  CreateIntakeEntryRequest,
  | 'occurredAt'
  | 'timezone'
  | 'foods'
  | 'nutrientTotal'
  | 'plannedItemId'
  | 'relatedSessionIds'
  | 'relatedActivityIds'
  | 'source'
  | 'sourceRecordId'
  | 'notes'
>;
async function validateIntakeLinks(tx: Transaction, input: IntakeFields) {
  await validateFoodPortions(tx, input.foods);
  if (input.plannedItemId !== null) {
    const item = await tx.query(
      `SELECT 1 FROM nutrition_plan_version WHERE athlete_id=$1 AND EXISTS
       (SELECT 1 FROM jsonb_array_elements(record_json->'items') item WHERE item->>'id'=$2) LIMIT 1`,
      [tx.athleteId, input.plannedItemId],
    );
    if (!item.rowCount) throw new NutritionReferenceError('PLAN_LINK_INVALID');
  }
  for (const sessionId of input.relatedSessionIds) {
    const session = await tx.query(
      `SELECT 1 FROM plan_snapshot WHERE athlete_id=$1 AND EXISTS
       (SELECT 1 FROM jsonb_array_elements(draft->'sessions') session WHERE session->>'id'=$2) LIMIT 1`,
      [tx.athleteId, sessionId],
    );
    if (!session.rowCount) throw new NutritionReferenceError('SESSION_LINK_INVALID');
  }
  if (input.relatedActivityIds.length > 0) {
    const ids = input.relatedActivityIds.map(requireUuid);
    const activities = await tx.query(
      'SELECT id FROM activity_canonical WHERE athlete_id=$1 AND id=ANY($2::uuid[]) AND deleted=false',
      [tx.athleteId, ids],
    );
    if (activities.rowCount !== ids.length)
      throw new NutritionReferenceError('ACTIVITY_LINK_INVALID');
  }
}
function intakeRecord(row: Record<string, unknown>): IntakeEntryRecord {
  if (row['status'] === 'active') return activeIntakeEntrySchema.parse(row['record_json']);
  return deletedIntakeEntrySchema.parse({
    status: 'deleted',
    intakeId: row['intake_id'],
    revisionId: row['revision_id'],
    revision: row['revision'],
    deletedAt:
      row['deleted_at'] instanceof Date ? row['deleted_at'].toISOString() : row['deleted_at'],
    reason: row['deletion_reason'],
  });
}
async function currentIntake(tx: Transaction, id: string): Promise<IntakeEntryRecord | null> {
  const result = await tx.query(
    `SELECT r.* FROM intake_entry e JOIN intake_entry_revision r
     ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision=e.current_revision
     WHERE e.athlete_id=$1 AND e.id=$2`,
    [tx.athleteId, id],
  );
  return result.rows[0] ? intakeRecord(result.rows[0]) : null;
}
const planCursorSchema = z.strictObject({ planId: z.uuid() });
const foodCursorSchema = z.strictObject({ foodId: boundedId });
const intakeCursorSchema = z.strictObject({
  occurredAt: z.iso.datetime({ offset: true }),
  intakeId: boundedId,
});

/** Retained structural read only: no live re-pin, admission or marker authority. */
async function readNutritionPlanIn(tx: Transaction, planId: string) {
  const rows = await tx.query(
    `SELECT v.version_id,v.version,v.approved_at,h.version_id AS head_id,
       CASE WHEN v.version_id=h.version_id THEN octet_length(v.record_json::text)::text ELSE '0' END AS bytes,
       CASE WHEN v.version_id=h.version_id AND octet_length(v.record_json::text)<=524288
         THEN v.record_json ELSE NULL END AS record_json
     FROM nutrition_plan_version v JOIN nutrition_plan_head h
     ON h.athlete_id=v.athlete_id AND h.plan_id=v.plan_id
     WHERE v.athlete_id=$1 AND v.plan_id=$2 ORDER BY v.version DESC LIMIT 100`,
    [tx.athleteId, planId],
  );
  if (!rows.rows[0]) return null;
  const row = rows.rows.find((row) => row['version_id'] === row['head_id']);
  if (row && BigInt(z.string().regex(/^\d+$/).parse(row['bytes'])) > 524288n)
    throw new NutritionReadLimitError();
  const head = row ? nutritionPlanVersionCompatibleV3Schema.parse(row['record_json']) : null;
  if (
    head &&
    row &&
    (head.planId.toLowerCase() !== planId ||
      head.versionId.toLowerCase() !== row['version_id'] ||
      head.version !== row['version'])
  )
    throw new Error('INVALID_NUTRITION_PLAN_RECORD');
  return {
    planId,
    head,
    history: rows.rows.map((row) => ({
      versionId: row['version_id'],
      version: row['version'],
      approvedAt:
        row['approved_at'] instanceof Date ? row['approved_at'].toISOString() : row['approved_at'],
    })),
  };
}
async function listNutritionPlansIn(tx: Transaction, input: NutritionPlansQuery) {
  const after = decodeCursor(input.cursor, planCursorSchema);
  // One statement/MVCC snapshot: bounded scalar inventory gates body materialization.
  const result = await tx.query(
    `WITH bounded AS MATERIALIZED (
       SELECT v.version_id,h.plan_id,octet_length(v.record_json::text)::bigint AS bytes
       FROM nutrition_plan_head h JOIN nutrition_plan_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
       WHERE h.athlete_id=$1 AND v.period_from<=$3 AND v.period_to>=$2
       AND ($4::uuid IS NULL OR h.plan_id>$4::uuid)
       ORDER BY h.plan_id LIMIT $5
     ), bounds AS (
       SELECT count(*)::text AS count,coalesce(sum(bytes+1024),0)::text AS bytes,coalesce(max(bytes),0)::text AS largest FROM bounded
     )
     SELECT count,bytes,largest,CASE WHEN bytes::bigint<=4194304 AND largest::bigint<=524288 THEN
       coalesce((SELECT jsonb_agg(jsonb_build_object('plan_id',b.plan_id,'record_json',v.record_json) ORDER BY b.plan_id)
       FROM bounded b JOIN nutrition_plan_version v ON v.athlete_id=$1 AND v.version_id=b.version_id),'[]'::jsonb)
       ELSE '[]'::jsonb END AS records FROM bounds`,
    [tx.athleteId, input.from, input.toInclusive, after?.planId ?? null, input.limit + 1],
  );
  const row = z
    .strictObject({
      count: z.string().regex(/^\d+$/),
      bytes: z.string().regex(/^\d+$/),
      largest: z.string().regex(/^\d+$/),
      records: z.array(z.strictObject({ plan_id: z.uuid(), record_json: z.unknown() })).max(101),
    })
    .parse(result.rows[0]);
  if (BigInt(row.bytes) > 4194304n || BigInt(row.largest) > 524288n)
    throw new NutritionReadLimitError();
  if (
    BigInt(row.count) > BigInt(input.limit + 1) ||
    BigInt(row.count) !== BigInt(row.records.length)
  )
    throw new Error('INVALID_NUTRITION_PLAN_RECORD');
  const rows = { rows: row.records };
  const page = rows.rows.slice(0, input.limit);
  return {
    plans: page.map((row) => {
      const plan = nutritionPlanVersionCompatibleV3Schema.parse(row['record_json']);
      if (plan.planId.toLowerCase() !== row['plan_id'])
        throw new Error('INVALID_NUTRITION_PLAN_RECORD');
      return plan;
    }),
    nextCursor:
      rows.rows.length > input.limit ? cursor({ planId: page.at(-1)?.['plan_id'] }) : null,
  };
}

export function createNutritionRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): NutritionRepository {
  return {
    savePlan(athleteId, input) {
      const command = saveNutritionPlanVersionRequestSchema.parse(input);
      const key = `nutrition-plan:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_plan_save', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        const prior = await replayNutritionPlan(tx, key, request);
        if (prior) {
          if ('schemaVersion' in prior) throw new NutritionReadVersionError();
          return nutritionPlanVersionSchema.parse(prior);
        }
        await requireAppAdmission(tx);
        let planId: string;
        let version: number;
        let previousVersionId: string | null;
        if (command.kind === 'create') {
          planId = randomUUID();
          version = 1;
          previousVersionId = null;
        } else {
          planId = requireUuid(command.planId);
          const current = await tx.query(
            'SELECT version,version_id FROM nutrition_plan_head WHERE athlete_id=$1 AND plan_id=$2',
            [athleteId, planId],
          );
          if (!current.rows[0]) throw new NutritionReferenceError('PLAN_NOT_FOUND');
          previousVersionId = requireUuid(String(current.rows[0]['version_id']));
          if (previousVersionId !== requireUuid(command.expectedHeadVersionId))
            throw new PersistenceConflict('REVISION_CONFLICT');
          version = z.number().int().positive().parse(current.rows[0]['version']) + 1;
        }
        await validatePlanDraft(tx, command.draft);
        const versionId = randomUUID();
        const approvalId = randomUUID();
        const saved = nutritionPlanVersionSchema.parse({
          ...command.draft,
          linkedTrainingPlanVersionId:
            command.draft.linkedTrainingPlanVersionId === null
              ? null
              : requireUuid(command.draft.linkedTrainingPlanVersionId),
          planId,
          versionId,
          version,
          previousVersionId,
          approvedAt: now().toISOString(),
          approvalId,
          items: command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
        });
        await tx.query(
          `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,
           period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [
            athleteId,
            planId,
            versionId,
            version,
            previousVersionId,
            previousVersionId === null ? null : version - 1,
            saved.period.from,
            saved.period.toInclusive,
            saved.linkedTrainingPlanVersionId,
            approvalId,
            saved.approvedAt,
            JSON.stringify(saved),
          ],
        );
        if (version === 1) {
          await tx.query(
            'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,$3,$4)',
            [athleteId, planId, version, versionId],
          );
        } else {
          await tx.query(
            'UPDATE nutrition_plan_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND plan_id=$2',
            [athleteId, planId, version, versionId],
          );
        }
        await tx.query(
          "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'user_approved')",
          [athleteId, planId, versionId, approvalId],
        );
        return finish(tx, key, request, saved, 'nutrition.plan_changed', {
          planId,
          versionId,
          version,
        });
      });
    },
    replayPlanV3(athleteId, input) {
      const command = saveNutritionPlanVersionRequestSchema.parse(input);
      const key = `nutrition-plan:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_plan_save', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        return replayNutritionPlan(tx, key, request);
      });
    },
    readPlan(athleteId, planId) {
      const id = requireUuid(planId);
      return database.tenant(athleteId, async (tx) => {
        const read = await readNutritionPlanIn(tx, id);
        if (read === null) return null;
        if (read.head !== null && 'schemaVersion' in read.head)
          throw new NutritionReadVersionError();
        return nutritionPlanReadSchema.parse(read);
      });
    },
    readPlanV2(athleteId, planId) {
      const id = requireUuid(planId);
      return database.tenant(athleteId, async (tx) => {
        const read = await readNutritionPlanIn(tx, id);
        if (read === null) return null;
        if (read.head !== null && 'schemaVersion' in read.head && read.head.schemaVersion === 3)
          throw new NutritionReadVersionError();
        return nutritionPlanReadV2Schema.parse({ schemaVersion: 2, ...read });
      });
    },
    readPlanV3(athleteId, planId) {
      const id = requireUuid(planId);
      return database.tenant(athleteId, async (tx) => {
        const read = await readNutritionPlanIn(tx, id);
        if (read === null) return null;
        const response = { schemaVersion: 3, ...read };
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 524288)
          throw new NutritionReadLimitError();
        return nutritionPlanReadV3Schema.parse(response);
      });
    },
    listPlansV3(athleteId, query) {
      const input = nutritionPlansQuerySchema.parse(query);
      return database.tenant(athleteId, async (tx) =>
        nutritionPlansResponseV3Schema.parse({
          schemaVersion: 3,
          ...(await listNutritionPlansIn(tx, input)),
        }),
      );
    },
    listPlans(athleteId, query) {
      const input = nutritionPlansQuerySchema.parse(query);
      const after = decodeCursor(input.cursor, planCursorSchema);
      return database.tenant(athleteId, async (tx) => {
        const rows = await tx.query(
          `SELECT v.record_json,h.plan_id FROM nutrition_plan_head h JOIN nutrition_plan_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND v.period_from<=$3 AND v.period_to>=$2
           AND ($4::uuid IS NULL OR h.plan_id>$4::uuid)
           ORDER BY h.plan_id LIMIT $5`,
          [athleteId, input.from, input.toInclusive, after?.planId ?? null, input.limit + 1],
        );
        const page = rows.rows.slice(0, input.limit);
        for (const row of page) {
          const body = z.record(z.string(), z.unknown()).parse(row['record_json']);
          if (body['schemaVersion'] === 2 || body['schemaVersion'] === 3)
            throw new NutritionReadVersionError();
        }
        return nutritionPlansResponseSchema.parse({
          plans: page.map((row) => row['record_json']),
          nextCursor:
            rows.rows.length > input.limit ? cursor({ planId: page.at(-1)?.['plan_id'] }) : null,
        });
      });
    },
    saveFood(athleteId, input) {
      const command = saveFoodDefinitionVersionRequestSchema.parse(input);
      const key = `nutrition-food:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_food_save', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        const prior = await replay(tx, key, request, foodDefinitionVersionSchema);
        if (prior) return prior;
        const foodId = command.definition.foodId;
        const current = await tx.query(
          'SELECT version,version_id FROM food_definition_head WHERE athlete_id=$1 AND food_id=$2',
          [athleteId, foodId],
        );
        const previousVersionId = current.rows[0] ? String(current.rows[0]['version_id']) : null;
        if (
          previousVersionId !==
          (command.expectedVersionId === null ? null : requireUuid(command.expectedVersionId))
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        const version = current.rows[0]
          ? z.number().int().positive().parse(current.rows[0]['version']) + 1
          : 1;
        const versionId = randomUUID();
        const saved = foodDefinitionVersionSchema.parse({
          ...command.definition,
          versionId,
          version,
          previousVersionId,
          createdAt: now().toISOString(),
        });
        await tx.query(
          `INSERT INTO food_definition_version(athlete_id,food_id,version_id,version,
           previous_version_id,previous_version,created_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            athleteId,
            foodId,
            versionId,
            version,
            previousVersionId,
            previousVersionId === null ? null : version - 1,
            saved.createdAt,
            JSON.stringify(saved),
          ],
        );
        if (version === 1) {
          await tx.query(
            'INSERT INTO food_definition_head(athlete_id,food_id,version,version_id) VALUES($1,$2,$3,$4)',
            [athleteId, foodId, version, versionId],
          );
        } else {
          await tx.query(
            'UPDATE food_definition_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND food_id=$2',
            [athleteId, foodId, version, versionId],
          );
        }
        return finish(tx, key, request, saved, 'nutrition.food_changed', {
          foodId,
          versionId,
          version,
        });
      });
    },
    readFood(athleteId, foodId) {
      const id = boundedId.parse(foodId);
      return database.tenant(athleteId, async (tx) => {
        const rows = await tx.query(
          `SELECT v.record_json FROM food_definition_head h JOIN food_definition_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND h.food_id=$2`,
          [athleteId, id],
        );
        return rows.rows[0]
          ? record(rows.rows[0]['record_json'], foodDefinitionVersionSchema)
          : null;
      });
    },
    listFoods(athleteId, query) {
      const input = foodQuerySchema.parse(query);
      const after = decodeCursor(input.cursor, foodCursorSchema);
      return database.tenant(athleteId, async (tx) => {
        const rows = await tx.query(
          `SELECT v.record_json,h.food_id FROM food_definition_head h JOIN food_definition_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND ($2::text IS NULL OR h.food_id>$2)
           ORDER BY h.food_id LIMIT $3`,
          [athleteId, after?.foodId ?? null, input.limit + 1],
        );
        const page = rows.rows.slice(0, input.limit);
        return {
          foods: page.map((row) => foodDefinitionVersionSchema.parse(row['record_json'])),
          nextCursor:
            rows.rows.length > input.limit ? cursor({ foodId: page.at(-1)?.['food_id'] }) : null,
        };
      });
    },
    createIntake(athleteId, input) {
      const command = createIntakeEntryRequestSchema.parse(input);
      const key = `nutrition-intake:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_intake_create', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        await requireCurrentRestoreGeneration(tx, command.restoreGeneration);
        const prior = await replay(tx, key, request, activeIntakeEntrySchema);
        if (prior) return prior;
        await requireAppAdmission(tx);
        if (await currentIntake(tx, command.intakeId))
          throw new PersistenceConflict('REVISION_CONFLICT');
        const recordedAt = now().toISOString();
        if (Date.parse(command.occurredAt) > Date.parse(recordedAt))
          throw new NutritionValidationError();
        await validateIntakeLinks(tx, command);
        const revisionId = randomUUID();
        const saved = activeIntakeEntrySchema.parse({
          status: 'active',
          intakeId: command.intakeId,
          revisionId,
          revision: 1,
          occurredAt: command.occurredAt,
          recordedAt,
          timezone: command.timezone,
          foods: command.foods,
          nutrientTotal: command.nutrientTotal,
          plannedItemId: command.plannedItemId,
          relatedSessionIds: command.relatedSessionIds,
          relatedActivityIds: command.relatedActivityIds,
          source: command.source,
          sourceRecordId: command.sourceRecordId,
          notes: command.notes,
          nutrientValueCoverage: nutrientValueCoverage(command.nutrientTotal),
        });
        await tx.query(
          "INSERT INTO intake_entry(athlete_id,id,current_revision,current_revision_id,status) VALUES($1,$2,1,$3,'active')",
          [athleteId, command.intakeId, revisionId],
        );
        await tx.query(
          `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
           occurred_at,recorded_at,record_json) VALUES($1,$2,1,$3,'active',$4,$5,$6::jsonb)`,
          [
            athleteId,
            command.intakeId,
            revisionId,
            saved.occurredAt,
            saved.recordedAt,
            JSON.stringify(saved),
          ],
        );
        return finish(tx, key, request, saved, 'nutrition.intake_changed', {
          intakeId: command.intakeId,
          revision: 1,
          action: 'created',
        });
      });
    },
    correctIntake(athleteId, input) {
      const command = correctIntakeEntryRequestSchema.parse(input);
      const key = `nutrition-intake:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_intake_correct', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        const prior = await replay(tx, key, request, activeIntakeEntrySchema);
        if (prior) return prior;
        await requireAppAdmission(tx);
        const current = await currentIntake(tx, command.intakeId);
        if (!current) throw new NutritionReferenceError('INTAKE_NOT_FOUND');
        if (current.status !== 'active' || current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const recordedAt = now().toISOString();
        if (Date.parse(command.occurredAt) > Date.parse(recordedAt))
          throw new NutritionValidationError();
        await validateIntakeLinks(tx, command);
        const revisionId = randomUUID();
        const revision = current.revision + 1;
        const saved = activeIntakeEntrySchema.parse({
          status: 'active',
          intakeId: command.intakeId,
          revisionId,
          revision,
          occurredAt: command.occurredAt,
          recordedAt,
          timezone: command.timezone,
          foods: command.foods,
          nutrientTotal: command.nutrientTotal,
          plannedItemId: command.plannedItemId,
          relatedSessionIds: command.relatedSessionIds,
          relatedActivityIds: command.relatedActivityIds,
          source: command.source,
          sourceRecordId: command.sourceRecordId,
          notes: command.notes,
          nutrientValueCoverage: nutrientValueCoverage(command.nutrientTotal),
        });
        await tx.query(
          `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
           occurred_at,recorded_at,record_json) VALUES($1,$2,$3,$4,'active',$5,$6,$7::jsonb)`,
          [
            athleteId,
            command.intakeId,
            revision,
            revisionId,
            saved.occurredAt,
            saved.recordedAt,
            JSON.stringify(saved),
          ],
        );
        await tx.query(
          'UPDATE intake_entry SET current_revision=$3,current_revision_id=$4 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.intakeId, revision, revisionId],
        );
        return finish(tx, key, request, saved, 'nutrition.intake_changed', {
          intakeId: command.intakeId,
          revision,
          action: 'corrected',
        });
      });
    },
    deleteIntake(athleteId, input) {
      const command = deleteIntakeEntryRequestSchema.parse(input);
      const key = `nutrition-intake:${command.idempotencyKey}`;
      const request = { operation: 'nutrition_intake_delete', ...command };
      return database.tenant(athleteId, async (tx) => {
        await commandLock(tx);
        const prior = await replay(tx, key, request, deletedIntakeEntrySchema);
        if (prior) return prior;
        const current = await currentIntake(tx, command.intakeId);
        if (!current) throw new NutritionReferenceError('INTAKE_NOT_FOUND');
        if (current.status !== 'active' || current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const revisionId = randomUUID();
        const revision = current.revision + 1;
        const saved = deletedIntakeEntrySchema.parse({
          status: 'deleted',
          intakeId: command.intakeId,
          revisionId,
          revision,
          deletedAt: now().toISOString(),
          reason: 'user_requested',
        });
        await tx.query(
          `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
           recorded_at,deleted_at,deletion_reason) VALUES($1,$2,$3,$4,'deleted',$5,$5,'user_requested')`,
          [athleteId, command.intakeId, revision, revisionId, saved.deletedAt],
        );
        await tx.query(
          "UPDATE intake_entry SET current_revision=$3,current_revision_id=$4,status='deleted' WHERE athlete_id=$1 AND id=$2",
          [athleteId, command.intakeId, revision, revisionId],
        );
        return finish(tx, key, request, saved, 'nutrition.intake_changed', {
          intakeId: command.intakeId,
          revision,
          action: 'deleted',
        });
      });
    },
    readIntake(athleteId, intakeId) {
      const id = boundedId.parse(intakeId);
      return database.tenant(athleteId, (tx) => currentIntake(tx, id));
    },
    listIntakes(athleteId, query) {
      const input = intakeEntriesQuerySchema.parse(query);
      const after = decodeCursor(input.cursor, intakeCursorSchema);
      return database.tenant(athleteId, async (tx) => {
        // The page and coverage use separate statements; hold the command lock so
        // corrections cannot change the head between those snapshots.
        await commandLock(tx);
        const rows = await tx.query(
          `SELECT r.record_json,
                  to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_occurred_at,
                  e.id FROM intake_entry e JOIN intake_entry_revision r
           ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision=e.current_revision
           WHERE e.athlete_id=$1 AND e.status='active' AND r.occurred_at >= $2 AND r.occurred_at < $3
           AND ($4::timestamptz IS NULL OR (r.occurred_at,e.id) < ($4::timestamptz,$5::text))
           ORDER BY r.occurred_at DESC,e.id DESC LIMIT $6`,
          [
            athleteId,
            input.from,
            input.toExclusive,
            after?.occurredAt ?? null,
            after?.intakeId ?? null,
            input.limit + 1,
          ],
        );
        const count = await tx.query(
          `SELECT count(*)::integer AS known,
           count(*) FILTER (WHERE (r.record_json->>'nutrientValueCoverage') <> 'all_values_present')::integer AS unknown
           FROM intake_entry e JOIN intake_entry_revision r
           ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision=e.current_revision
           WHERE e.athlete_id=$1 AND e.status='active' AND r.occurred_at >= $2 AND r.occurred_at < $3`,
          [athleteId, input.from, input.toExclusive],
        );
        const page = rows.rows.slice(0, input.limit);
        const known = z.number().int().nonnegative().parse(count.rows[0]?.['known']);
        const unknown = z.number().int().nonnegative().parse(count.rows[0]?.['unknown']);
        const last = page.at(-1);
        return intakeEntriesResponseSchema.parse({
          entries: page.map((row) => activeIntakeEntrySchema.parse(row['record_json'])),
          coverage: {
            from: input.from,
            toExclusive: input.toExclusive,
            status: known === 0 ? 'unknown' : 'partial',
            knownEntries: known,
            entriesWithUnknownNutrients: unknown,
          },
          nextCursor:
            rows.rows.length > input.limit && last
              ? cursor({
                  occurredAt: last['cursor_occurred_at'],
                  intakeId: last['id'],
                })
              : null,
        });
      });
    },
  };
}

// Shared internal command seams; callers retain their own receipt/admission order.
export { replayNutritionPlan, validateFoodPortions, ownedTrainingPlan, finish };
