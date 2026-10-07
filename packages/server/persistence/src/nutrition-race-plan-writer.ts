import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  saveNutritionPlanV2IntentSchema,
  nutritionPlanVersionV2Schema,
  type SaveNutritionPlanV2Intent,
} from '@workout/contracts/nutrition-race-plan-v2';
import {
  nutritionPlanVersionCompatibleV3Schema,
  type NutritionPlanVersionCompatibleV3,
} from '@workout/contracts/nutrition-race-plan-v3';
import {
  nutritionPlanDraftSchema,
  type NutritionPlanDraft,
} from '@workout/contracts/nutrition-core';
import type { Database, Transaction } from './database.js';
import { requireAppAdmission, lockAppAdmission } from './app-admission.js';
import {
  replayNutritionPlan,
  validateFoodPortions,
  finish,
  NutritionReferenceError,
} from './nutrition-core.js';
import {
  prepareNutritionRaceTimingIn,
  type NutritionTimingPreparation,
} from './nutrition-race-timing-preparation.js';
import { PersistenceConflict } from './outbox.js';

export class NutritionRacePlanWriterError extends Error {
  constructor(
    readonly code:
      | 'NUTRITION_TIMING_APPROVAL_BLOCKED'
      | 'NUTRITION_V3_LINEAGE_REQUIRED'
      | 'NUTRITION_VERSION_LIMIT'
      | 'NUTRITION_SOURCE_LIMIT'
      | 'NUTRITION_INVALID_SOURCE',
    readonly blocks: readonly Extract<
      NutritionTimingPreparation,
      { status: 'blocked' }
    >['blocks'][number]['code'][] = [],
  ) {
    super(code);
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
/** Server-owned difference only; no browser-provided changed/affected IDs.
 * Removed items do not become synthetic actuals or retained timing refs. */
export function deriveNutritionAffectedItemIds(
  prior: NutritionPlanVersionCompatibleV3 | null,
  unknownDraft: unknown,
): readonly string[] {
  const draft = nutritionPlanDraftSchema.parse(unknownDraft);
  const previous = new Map(prior?.items.map((item) => [item.id, item]) ?? []);
  const contextChanged =
    !prior ||
    prior.timezone !== draft.timezone ||
    prior.linkedTrainingPlanVersionId !== draft.linkedTrainingPlanVersionId ||
    canonical(prior.period) !== canonical(draft.period);
  return Object.freeze(
    draft.items
      .filter((item) => {
        const old = previous.get(item.id);
        if (contextChanged || !old) return true;
        const { planVersionId, ...content } = old;
        void planVersionId;
        return canonical(content) !== canonical(item);
      })
      .map((item) => item.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
const priorRow = z.strictObject({
  version: z.number().int().min(1).max(2147483646),
  version_id: z.uuid(),
  bytes: z.string().regex(/^\d+$/),
  record_json: z.unknown(),
});
async function readPrior(
  tx: Transaction,
  command: Extract<SaveNutritionPlanV2Intent['command'], { kind: 'update' }>,
) {
  const found = await tx.query(
    `SELECT h.version,h.version_id,octet_length(v.record_json::text)::text AS bytes,
    CASE WHEN octet_length(v.record_json::text)<=524288 THEN v.record_json ELSE NULL END AS record_json
    FROM nutrition_plan_head h JOIN nutrition_plan_version v ON v.athlete_id=h.athlete_id AND v.plan_id=h.plan_id
      AND v.version_id=h.version_id AND v.version=h.version
    WHERE h.athlete_id=$1 AND h.plan_id=$2 FOR UPDATE OF h`,
    [tx.athleteId, command.planId],
  );
  if (found.rows.length === 0) throw new NutritionReferenceError('PLAN_NOT_FOUND');
  if (found.rows.length !== 1) throw new NutritionRacePlanWriterError('NUTRITION_INVALID_SOURCE');
  const row = priorRow.parse(found.rows[0]);
  if (row.version_id.toLowerCase() !== command.expectedHeadVersionId.toLowerCase())
    throw new PersistenceConflict('REVISION_CONFLICT');
  if (BigInt(row.bytes) > 524288n) throw new NutritionRacePlanWriterError('NUTRITION_SOURCE_LIMIT');
  const prior = nutritionPlanVersionCompatibleV3Schema.parse(row.record_json);
  if (
    prior.planId.toLowerCase() !== command.planId.toLowerCase() ||
    prior.versionId.toLowerCase() !== row.version_id.toLowerCase() ||
    prior.version !== row.version
  )
    throw new NutritionRacePlanWriterError('NUTRITION_INVALID_SOURCE');
  if ('schemaVersion' in prior && prior.schemaVersion === 3)
    throw new NutritionRacePlanWriterError('NUTRITION_V3_LINEAGE_REQUIRED');
  return { prior, decodedBytes: Number(row.bytes) };
}
export interface NutritionRacePlanWriter {
  /** Explicit user-approved standalone nutrition write, not full integrated approval.
   * Replaying a committed version after privacy redaction can return exact V3.
   * V3 retained-disconnected/reconnect writes await authenticated SQL lineage. */
  savePlanV2(athleteId: string, unknownIntent: unknown): Promise<NutritionPlanVersionCompatibleV3>;
}
export function createNutritionRacePlanWriter(
  database: Database,
  { now = () => new Date(), id = randomUUID }: { now?: () => Date; id?: () => string } = {},
): NutritionRacePlanWriter {
  return {
    savePlanV2(athleteId, unknownIntent) {
      const encoded = JSON.stringify(unknownIntent);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 512 * 1024)
        throw new NutritionRacePlanWriterError('NUTRITION_SOURCE_LIMIT');
      const intent = saveNutritionPlanV2IntentSchema.parse(unknownIntent);
      const command = intent.command;
      // Preserve the SQL108 registered root draft family; nested client intent is
      // not a receipt codec. Version and exact head expectations remain compared.
      const request = {
        operation: 'nutrition_plan_save',
        ...command,
        intentSchemaVersion: 2,
        expectedRaceHeads: intent.expectedRaceHeads,
      };
      const key = `nutrition-plan:${command.idempotencyKey}`;
      return database.tenant(athleteId, async (tx) => {
        await lockAppAdmission(tx);
        const replay = await replayNutritionPlan(tx, key, request);
        if (replay) return replay;
        await requireAppAdmission(tx);
        const priorRead = command.kind === 'update' ? await readPrior(tx, command) : null;
        const prior = priorRead?.prior ?? null;
        const version = prior ? prior.version + 1 : 1;
        if (version > 2147483646) throw new NutritionRacePlanWriterError('NUTRITION_VERSION_LIMIT');
        const affected = deriveNutritionAffectedItemIds(prior, command.draft);
        const foodBytes = await foodPreflight(tx, command.draft);
        await validateFoodPortions(
          tx,
          command.draft.items.flatMap((item) => item.foods),
        );
        const preparation: NutritionTimingPreparation = await prepareNutritionRaceTimingIn(
          tx,
          intent,
          affected,
          (priorRead?.decodedBytes ?? 0) + foodBytes,
        );
        if (preparation.status !== 'prepared')
          throw new NutritionRacePlanWriterError(
            'NUTRITION_TIMING_APPROVAL_BLOCKED',
            preparation.blocks.map((block) => block.code),
          );
        // A read-only prepared result does not authorize approval. Permission, exact
        // own prior, confirmed command, foods and source freshness were validated
        // in THIS transaction; SQL source/suppression guards remain authoritative.
        const planId = prior?.planId ?? id(),
          versionId = id(),
          approvalId = id();
        const saved = nutritionPlanVersionV2Schema.parse({
          ...command.draft,
          schemaVersion: 2,
          planId,
          versionId,
          version,
          previousVersionId: prior?.versionId ?? null,
          approvalId,
          approvedAt: now().toISOString(),
          raceTimingPins: preparation.timingRoster.raceTimingPins,
          itemRaceTimingBindings: preparation.timingRoster.itemRaceTimingBindings,
          items: command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
        });
        await persist(tx, saved, prior?.version ?? null);
        return finish(tx, key, request, saved, 'nutrition.plan_changed', {
          planId,
          versionId,
          version,
        });
      });
    },
  };
}
async function persist(
  tx: Transaction,
  saved: z.infer<typeof nutritionPlanVersionV2Schema>,
  previousVersion: number | null,
) {
  await tx.query(
    `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,
    period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      tx.athleteId,
      saved.planId,
      saved.versionId,
      saved.version,
      saved.previousVersionId,
      previousVersion,
      saved.period.from,
      saved.period.toInclusive,
      saved.linkedTrainingPlanVersionId,
      saved.approvalId,
      saved.approvedAt,
      JSON.stringify(saved),
    ],
  );
  if (previousVersion === null)
    await tx.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,$3,$4)',
      [tx.athleteId, saved.planId, saved.version, saved.versionId],
    );
  else {
    const updated = await tx.query(
      'UPDATE nutrition_plan_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND plan_id=$2 AND version=$5 AND version_id=$6',
      [
        tx.athleteId,
        saved.planId,
        saved.version,
        saved.versionId,
        previousVersion,
        saved.previousVersionId,
      ],
    );
    if (updated.rowCount !== 1) throw new PersistenceConflict('REVISION_CONFLICT');
  }
  await tx.query(
    "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'user_approved')",
    [tx.athleteId, saved.planId, saved.versionId, saved.approvalId],
  );
}

async function foodPreflight(tx: Transaction, draft: NutritionPlanDraft): Promise<number> {
  const ids = [
    ...new Set(
      draft.items.flatMap((item) =>
        item.foods.flatMap((food) =>
          food.foodVersionId === null ? [] : [z.uuid().parse(food.foodVersionId).toLowerCase()],
        ),
      ),
    ),
  ];
  if (ids.length > 5000) throw new NutritionRacePlanWriterError('NUTRITION_SOURCE_LIMIT');
  if (ids.length === 0) return 0;
  const result = await tx.query(
    `SELECT count(*)::text AS count,coalesce(sum(octet_length(record_json::text)+1024),0)::text AS bytes FROM food_definition_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])`,
    [tx.athleteId, ids],
  );
  if (result.rows.length !== 1) throw new NutritionRacePlanWriterError('NUTRITION_INVALID_SOURCE');
  const row = z
    .strictObject({ count: z.string().regex(/^\d+$/), bytes: z.string().regex(/^\d+$/) })
    .parse(result.rows[0]);
  if (BigInt(row.count) !== BigInt(ids.length))
    throw new NutritionReferenceError('FOOD_LINK_INVALID');
  if (BigInt(row.bytes) > 4194304n)
    throw new NutritionRacePlanWriterError('NUTRITION_SOURCE_LIMIT');
  return Number(row.bytes);
}
