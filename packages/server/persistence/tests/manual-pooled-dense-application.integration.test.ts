import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseAccountExportV38, type AccountExportV38 } from '@workout/contracts/operations';
import type { raceManualInternalPlannedContentSchema } from '@workout/contracts/race-manual-internal-personal-export';
import { raceManualPublicImpactNutritionItemSchema } from '@workout/contracts/race-manual-public-impact';
import { planDraftSchema } from '@workout/contracts/planning';
import { nutritionPlanDraftSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntimeV7 } from '../src/current-runtime-installation-v7.js';
import { grantCurrentRuntimeV7Profile } from '../src/current-runtime-grants-v7.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPooledPublicRepositoryV2 } from '../src/race-manual-pooled-bundle-v2.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { expandRoutineSchedule } from '../src/routine-expansion.js';
import {
  createOperationsRepository,
  createOperationsV38PooledRepository,
} from '../src/operations.js';
import { readRaceManualPooledChainTransportV1In } from '../src/race-manual-pooled-chain-transport-v1.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import {
  toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase,
  decodeRaceManualReviewPooledDatabaseEnvelopeV1 as decode,
  raceManualReviewPooledDatabaseEnvelopeV1Schema,
} from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root executes actual DB. Public source producers only; owner bootstrap is an
// identity-FK row, never health/candidate/source data. Export uses the actual pooled consumer.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_dense_${suffix}`,
  ownerRole = `pooled_dense_owner_${suffix}`,
  runtimeRole = `pooled_dense_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let db: Database,
  created = false,
  pending: Promise<void> = Promise.resolve();
type DiagnosticStage =
  | 'fixture'
  | 'producer.identity_app'
  | 'producer.training'
  | 'producer.race'
  | 'producer.nutrition'
  | 'producer.recovery'
  | 'producer.routine'
  | 'public.review'
  | 'public.approve'
  | 'workflow.prepare_and_review'
  | 'retained.preview'
  | 'retained.readlossless'
  | 'retained.encode'
  | 'retained.decode_and_compare';
let stage: DiagnosticStage = 'fixture';
function emit(phase: 'dispatch' | 'terminal', operation: string, elapsedMs = 0, count?: number) {
  console.log(
    JSON.stringify({
      diagnostic: 'pooled_dense',
      stage,
      phase,
      operation,
      elapsedMs: Math.round(elapsedMs),
      ...(count === undefined ? {} : { count }),
    }),
  );
}
async function timedStage<T>(next: DiagnosticStage, operation: () => Promise<T>): Promise<T> {
  const previous = stage;
  stage = next;
  const started = performance.now();
  emit('dispatch', next);
  try {
    return await operation();
  } finally {
    stage = next;
    emit('terminal', next, performance.now() - started);
    stage = previous;
  }
}
function timedSync<T>(next: DiagnosticStage, operation: () => T): T {
  const previous = stage;
  stage = next;
  const started = performance.now();
  emit('dispatch', next);
  try {
    return operation();
  } finally {
    emit('terminal', next, performance.now() - started);
    stage = previous;
  }
}
// Only own data descriptors are inspected. No body/value field is visited.
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw Error('METRICS_UNAVAILABLE');
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !('value' in property)) throw Error('METRICS_UNAVAILABLE');
  return property.value;
}
const diagnosticInteger = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
function numericResponseMetrics(
  sql: string,
  values: unknown[] | undefined,
  response: unknown,
  operation: 'query.sql.parentreader' | 'query.sql.ownedscalar',
  sequence: number,
) {
  try {
    const rows = ownData(response, 'rows');
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('METRICS_UNAVAILABLE');
    const row = ownData(rows, '0');
    const measuredBytes = diagnosticInteger.parse(ownData(row, 'bytes'));
    if (operation === 'query.sql.parentreader') {
      // This is the actual measured-wrapper bound parameter, not a guessed
      // last argument or a replacement SourceBudget reservation/debit.
      const match = /CASE WHEN bytes <= \$(\d+)::bigint THEN value ELSE NULL END/.exec(sql);
      if (!match || !values) throw Error('METRICS_UNAVAILABLE');
      const parameter = z.coerce.number().int().positive().max(values.length).parse(match[1]);
      const remainingBytes = diagnosticInteger.parse(ownData(values, String(parameter - 1)));
      console.log(
        JSON.stringify({
          diagnostic: 'pooled_dense_response_numbers',
          stage,
          operation,
          sequence,
          measuredBytes,
          remainingBytes,
        }),
      );
    } else {
      const metrics = z
        .strictObject({
          count: z.number().int().min(0).max(2),
          bodyMaximum: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          currentMaximum: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          metadataMaximum: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .parse({
          count: diagnosticInteger.parse(ownData(row, 'count')),
          bodyMaximum: diagnosticInteger.parse(ownData(row, 'bodyMaximum')),
          currentMaximum: diagnosticInteger.parse(ownData(row, 'currentMaximum')),
          metadataMaximum: diagnosticInteger.parse(ownData(row, 'metadataMaximum')),
        });
      // Existing source reservation is scalar.bytes + 512 at the consumer.
      // No remaining budget is present in this query, so none is invented.
      console.log(
        JSON.stringify({
          diagnostic: 'pooled_dense_response_numbers',
          stage,
          operation,
          sequence,
          measuredBytes,
          ...metrics,
          existingReservationOverheadBytes: 512,
        }),
      );
    }
  } catch {
    console.log(
      JSON.stringify({
        diagnostic: 'pooled_dense_response_numbers',
        stage,
        operation,
        sequence,
        metrics: 'skipmetrics',
      }),
    );
  }
}
// Fixture-only client query timing. No SQL text, parameters, identifiers or
// health/body fields are logged. Inner PostgreSQL frames are not measured here.
const queryLabels = [
  ['store_manual_race_pooled_chain_v1', 'query.sql.publicstore'],
  ['observe_manual_review_multi_owned_source_bindings_v3', 'query.sql.checkcapture'],
  ['observe_manual_review_full_owned_source_bindings_v2', 'query.sql.checkcapture'],
  ['ack_manual_race_pooled_same_tx_parent_v1', 'query.sql.ack'],
  ['prepare_race_manual_pooled_application_v1', 'query.sql.applicationprepare'],
  ['begin_race_manual_pooled_application_v1', 'query.sql.applicationbegin'],
  ['finish_race_manual_pooled_public_review_v1', 'query.sql.finish'],
  ['finish_race_manual_public_approval_v1', 'query.sql.finish'],
  ['read_race_manual_pooled_public_preview_source_v1', 'query.sql.preview'],
] as const;
let querySequence = 0;
function encodedStoreMetrics(values: unknown[] | undefined) {
  const started = performance.now();
  try {
    const text = values?.[5];
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4194304)
      throw Error('METRICS_UNAVAILABLE');
    // The transport already validated this exact argument. Validate the finite
    // private codec again only for diagnostic counts; never authorize a store.
    const parsed = raceManualReviewPooledDatabaseEnvelopeV1Schema.parse(JSON.parse(text));
    const metrics = z
      .strictObject({
        refsCount: z.number().int().min(1).max(5000),
        copiedLocationCountL: z.number().int().min(1).max(5000),
        sourcePoolCountP: z.number().int().min(0).max(5000),
        substitutionCountS: z.number().int().min(0).max(5000),
        compactEncodedBytes: z.number().int().positive().max(4194304),
      })
      .parse({
        refsCount: parsed.payload.inventory.refs.length,
        copiedLocationCountL: parsed.payload.inventory.refs.reduce(
          (sum, ref) => sum + ref.copiedLocations.length,
          0,
        ),
        sourcePoolCountP: parsed.payload.preparation.sourcePool.length,
        substitutionCountS: parsed.payload.preparation.substitutions.length,
        compactEncodedBytes: Buffer.byteLength(text, 'utf8'),
      });
    console.log(
      JSON.stringify({
        diagnostic: 'pooled_dense_encoded_counts',
        ...metrics,
        predictionBasis: 'static_code_analysis_only',
        predictedCheckEncodedCalls: 3 + metrics.copiedLocationCountL,
        predictedSlotDepthPasses: (3 + metrics.copiedLocationCountL) * metrics.substitutionCountS,
        diagnosticValidationMs: Math.round(performance.now() - started),
      }),
    );
  } catch {
    // Diagnostics must not replace original validation, exceptions or SQL calls.
    console.log(
      JSON.stringify({
        diagnostic: 'pooled_dense_encoded_counts',
        metrics: 'skipmetrics',
        diagnosticValidationMs: Math.round(performance.now() - started),
      }),
    );
  }
}
function measuredDatabase(source: Database): Database {
  function wrap(tx: Transaction): Transaction {
    return {
      athleteId: tx.athleteId,
      async query(sql, values) {
        const label =
          sql.includes('public.read_manual_race_pooled_chain_v1(') ||
          sql.includes('public.read_manual_race_pooled_parent_delta_v1(')
            ? 'query.sql.parentreader'
            : /^\/\* manual_review_owned_v2 scalar (?:race-event|plan-snapshot|nutrition-plan-version|routine-schedule-version|routine-blueprint-version|routine-occurrence|routine-run|session-completion) \*\/ SELECT count\(\*\)::text AS count,/.test(
                  sql,
                )
              ? 'query.sql.ownedscalar'
              : (queryLabels.find(([name]) => sql.includes(name))?.[1] ?? 'query.sql.other');
        const sequence = ++querySequence;
        if (label === 'query.sql.publicstore') encodedStoreMetrics(values);
        // Timing starts after diagnostic codec parsing; original SQL unchanged.
        const started = performance.now();
        emit('dispatch', label, 0, sequence);
        try {
          const response = await tx.query(sql, values);
          if (label === 'query.sql.parentreader' || label === 'query.sql.ownedscalar')
            numericResponseMetrics(sql, values, response, label, sequence);
          return response;
        } catch (error) {
          const descriptor =
            error !== null && typeof error === 'object'
              ? Object.getOwnPropertyDescriptor(error, 'code')
              : undefined;
          const code = z
            .string()
            .regex(/^[0-9A-Z]{5}$/)
            .safeParse(descriptor?.value);
          console.log(
            JSON.stringify({
              diagnostic: 'pooled_dense_query_error',
              operation: label,
              sqlState: code.success ? code.data : 'unknown',
              sequence,
            }),
          );
          throw error;
        } finally {
          emit('terminal', label, performance.now() - started, sequence);
        }
      },
    };
  }
  return {
    close: () => source.close(),
    tenant: (athlete, operation) => source.tenant(athlete, (tx) => operation(wrap(tx))),
    exclusiveTenant: (athlete, operation) =>
      source.exclusiveTenant(athlete, (tx) => operation(wrap(tx))),
    ...(source.snapshotTenant
      ? {
          snapshotTenant<T>(athlete: string, operation: (tx: Transaction) => Promise<T>) {
            const snapshot = source.snapshotTenant;
            if (!snapshot) throw Error('SNAPSHOT_REQUIRED');
            return snapshot(athlete, (tx) => operation(wrap(tx)));
          },
        }
      : {}),
  };
}
function fixtureIt(label: string, apply: () => Promise<void> | void) {
  it(
    label,
    async () => {
      const work = pending.then(apply);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    60000,
  );
}
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owner<T>(apply: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(ownerRole) });
  try {
    return await apply(pool);
  } finally {
    await pool.end();
  }
}
// Explicit raw140..142 acceptance preparation only; collection/static checks are not
// actual SQL142 or dense approval evidence. Existing pre140 predicted metrics below
// are retained historical code estimates, not post140 executed check counts.
const sameInvocationLookupSql = await readFile(
  new URL('../migrations/140_manual_pooled_same_invocation_lookup.sql', import.meta.url),
  'utf8',
);
const sameInvocationLookupSha256 =
  '748596663ad63c868cdcf22bbc149d7328d3438230826cd7d61a8dd6270dd3ac';
const applicationLocalValidationSql = await readFile(
  new URL('../migrations/141_manual_pooled_application_local_validation.sql', import.meta.url),
  'utf8',
);
const applicationLocalValidationSha256 =
  'cab05bdb0aa3b081d886efd3c0b4eabcbd0cbb5a38baf5c1ffadde30df10008d';
const parentDeltaSql = await readFile(
  new URL('../migrations/142_manual_pooled_parent_delta.sql', import.meta.url),
  'utf8',
);
const parentDeltaSha256 = '7653de06a0b5017195729a20d2a21ea706c45c1e0db6b21f4b9c3a7094851cca';
beforeAll(async () => {
  expect(createHash('sha256').update(parentDeltaSql).digest('hex')).toBe(parentDeltaSha256);
  expect(createHash('sha256').update(applicationLocalValidationSql).digest('hex')).toBe(
    applicationLocalValidationSha256,
  );
  expect(createHash('sha256').update(sameInvocationLookupSql).digest('hex')).toBe(
    sameInvocationLookupSha256,
  );
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  const installed = await installCurrentRuntimeV7(url(ownerRole));
  expect(installed).toMatchObject({
    profileVersion: 7,
    runtimeStep: 23,
    sourceDdlTip: 133,
    supported: false,
    processingAuthority: 'none',
  });
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), runtimeRole, 'core');
  await grantCurrentRuntimeV7Profile(url(ownerRole), runtimeRole);
  await owner(async (p) => {
    for (const filename of [
      '134_manual_pooled_preparation_resolver.sql',
      '135_manual_pooled_store_and_basis.sql',
      '136_manual_pooled_chain_reader_and_ack.sql',
      '137_manual_pooled_application.sql',
      '138_manual_pooled_public_finish_and_preview.sql',
      '139_manual_pooled_personal_export_batch.sql',
      '140_manual_pooled_same_invocation_lookup.sql',
      '141_manual_pooled_application_local_validation.sql',
      '142_manual_pooled_parent_delta.sql',
    ])
      await p.query(
        filename === '140_manual_pooled_same_invocation_lookup.sql'
          ? sameInvocationLookupSql
          : filename === '141_manual_pooled_application_local_validation.sql'
            ? applicationLocalValidationSql
            : filename === '142_manual_pooled_parent_delta.sql'
              ? parentDeltaSql
              : await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'),
      );
    for (const signature of [
      'public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_pooled_chain_v1(uuid)',
      'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
      'public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)',
      'public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid)',
      'public.read_race_manual_pooled_public_preview_source_v1(uuid)',
      'public.read_manual_race_pooled_personal_export_batch_v1(integer)',
    ])
      await p.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    expect(
      (
        await p.query(
          "SELECT has_function_privilege($1,'public.read_manual_race_pooled_personal_export_batch_v1(integer)','EXECUTE') AS batch_execute,has_schema_privilege($1,'wm_manual_pooled','USAGE') AS private_usage,has_function_privilege($1,'wm_manual_pooled.read_internal_export_v2(integer)','EXECUTE') AS private_execute,has_function_privilege($1,'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)','EXECUTE') AS delta_execute,has_function_privilege($1,'wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)','EXECUTE') AS delta_private_execute",
          [runtimeRole],
        )
      ).rows[0],
    ).toEqual({
      batch_execute: true,
      private_usage: false,
      private_execute: false,
      delta_execute: true,
      delta_private_execute: false,
    });
    expect(
      (await p.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]?.['v'],
    ).toBe(107);
  });
  db = measuredDatabase(createDatabase({ connectionString: url(runtimeRole), max: 4 }));
}, 60000);
afterAll(async () => {
  await pending;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);
async function tenant() {
  const athlete = randomUUID(),
    owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  return athlete;
}
function snapshot<T>(athlete: string, callback: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, callback);
}

async function reviewFixture(denseOtherPlans = true) {
  let producerStarted = performance.now();
  stage = 'producer.identity_app';
  emit('dispatch', 'producer.identity_app');
  const athlete = await tenant();
  emit('terminal', 'producer.identity_app', performance.now() - producerStarted);
  stage = 'producer.training';
  producerStarted = performance.now();
  emit('dispatch', 'producer.training');
  const draft = planDraftSchema.parse({
    title: 'Export planned',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
      id: level,
      parentId: index ? ids[index - 1] : null,
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: denseOtherPlans
      ? Array.from({ length: 400 }, (_, index) => ({
          id: `session-${String(index).padStart(3, '0')}`,
          blockId: 'block',
          date: '2026-10-06',
          localStartTime: null,
          title: `Planned ${index}`,
          sport: 'running',
          durationSeconds: index % 2 ? null : 0,
          distanceMeters: index % 2 ? null : 0,
          targetRpe: null,
          purpose: 'User plan',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        }))
      : [],
  });
  const plan = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  emit('terminal', 'producer.training', performance.now() - producerStarted, draft.sessions.length);
  stage = 'producer.race';
  producerStarted = performance.now();
  emit('dispatch', 'producer.race');
  const races = createRaceRepository(db);
  const event = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Export race',
      localDate: '2026-10-06',
      localStartTime: '09:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: plan.id,
    },
  });
  emit('terminal', 'producer.race', performance.now() - producerStarted);
  stage = 'producer.nutrition';
  producerStarted = performance.now();
  emit('dispatch', 'producer.nutrition');
  const nutrition = await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
    schemaVersion: 2,
    command: {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: {
        period: { from: '2026-10-01', toInclusive: '2026-11-04' },
        timezone: 'UTC',
        purpose: 'Retained meal',
        linkedTrainingPlanVersionId: plan.id,
        items: denseItems(event.id),
      },
    },
    expectedRaceHeads: [{ namespace: 'race-event', eventId: event.id, revision: event.revision }],
  });
  expect(Buffer.byteLength(JSON.stringify(nutrition), 'utf8')).toBeLessThan(524288);
  expect(nutrition.items).toHaveLength(400);
  emit(
    'terminal',
    'producer.nutrition',
    performance.now() - producerStarted,
    nutrition.items.length,
  );
  stage = 'producer.recovery';
  producerStarted = performance.now();
  emit('dispatch', 'producer.recovery');
  const aggregateId = await db.tenant(athlete, async (tx) =>
    z
      .uuid()
      .parse(
        (
          await tx.query(
            'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
            [athlete, plan.id],
          )
        ).rows[0]?.['aggregate_id'],
      ),
  );
  const recovery = createRecoveryRepository(db),
    optionId = randomUUID();
  const strategy = await recovery.createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Selected rest',
      goal: 'Retain user facts',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-05',
      timezone: 'UTC',
      knownFacts: ['User report'],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [
        { kind: 'training', aggregateId, headVersionId: plan.id },
        {
          kind: 'nutrition',
          aggregateId: nutrition.planId,
          headVersionId: nutrition.versionId,
        },
      ],
      options: [
        {
          id: optionId,
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'User option',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'plan_changed',
          description: 'Review facts',
          plannedAt: null,
          policyVersion: null,
        },
      ],
    },
  });
  const confirmed = await recovery.confirmStrategy(athlete, {
    strategyId: strategy.strategyId,
    expectedHeadVersionId: strategy.versionId,
    selectedOptionId: optionId,
    idempotencyKey: randomUUID(),
  });
  emit('terminal', 'producer.recovery', performance.now() - producerStarted);
  stage = 'producer.routine';
  producerStarted = performance.now();
  emit('dispatch', 'producer.routine');
  const routine = createRoutineRepository(db);
  const blueprint = (
    await routine.saveBlueprint(athlete, {
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      blueprint: {
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Checklist',
        intent: 'Planned only',
        status: 'published',
        tags: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-10-08T00:00:00Z',
        steps: Array.from({ length: denseOtherPlans ? 30 : 1 }, (_, index) => ({
          id: `step-${String(index).padStart(3, '0')}`,
          title: 'Check',
          content: { kind: 'checklist', prompt: 'User question' },
          timing: { kind: 'ordered', afterStepId: null },
          required: true,
          choiceGroupId: null,
        })),
        choiceGroups: [],
      },
    })
  ).blueprint;
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-05',
        timezone: 'UTC',
        maxOccurrences: 10,
      },
      rule: {
        kind: 'period_days' as const,
        periodId: 'season',
        offsetsDays: [5],
        localTime: '08:00',
      },
      state: 'draft' as const,
    },
    sourcePlanVersionId: plan.id,
  };
  const preview = await routine.previewSchedule(athlete, scheduleInput);
  const approved = await routine.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const repo = createRaceManualPooledPublicRepositoryV2(db);
  emit('terminal', 'producer.routine', performance.now() - producerStarted);
  stage = 'public.review';
  const reviewKey = randomUUID();
  const reviewed = await timedStage('public.review', () =>
    repo.review(athlete, {
      schemaVersion: 1,
      idempotencyKey: reviewKey,
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: '2026-10-08',
        selection: {
          kind: 'move_period',
          expectedCurrentPlanVersionId: plan.id,
          periodId: 'season',
          newStartDate: '2026-10-03',
          scope: 'descendants_and_sessions',
        },
      },
    }),
  );
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  return {
    athlete,
    races,
    event,
    repo,
    reviewed,
    reviewKey,
    plan,
    nutrition,
    recovery,
    confirmed,
    routine,
    blueprint,
    approved,
    intent: {
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: plan.id,
        periodId: 'season',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
    },
  };
}

// Canonical public items; zero is measured quantity while null is unknown.
// This is a genuine saved 400-item producer, not an oversized codec mock.
function denseItems(eventId: string) {
  return Array.from({ length: 400 }, (_, index) => ({
    id: `meal-${String(index).padStart(3, '0')}-한글`,
    category: 'before' as const,
    title: `Retained meal ${index}`,
    anchor: {
      kind: 'relative' as const,
      entity: 'race' as const,
      entityId: eventId,
      point: 'start' as const,
      offsetMinutes: -30,
    },
    foods: [
      {
        foodVersionId: null,
        description: 'User portion',
        quantity: index % 2 ? null : 0,
        unit: 'g',
        sourceBasis: 'unknown' as const,
      },
    ],
    targets: [],
    instructions: 'User planned meal',
    evidenceIds: [],
    source: 'user_confirmed' as const,
  }));
}
function assertItems(
  items: readonly {
    id: string;
    foods: readonly { quantity: number | null; foodVersionId: string | null }[];
  }[],
  eventId: string,
) {
  expect(items.map((i) => i.id)).toEqual(denseItems(eventId).map((i) => i.id));
  expect(items).toHaveLength(400);
  for (const [index, item] of items.entries()) {
    expect(item.foods).toHaveLength(1);
    expect(item.foods[0]?.quantity).toBe(index % 2 ? null : 0);
    expect(item.foods[0]?.foodVersionId).toBeNull();
  }
}

type DenseFixture = Awaited<ReturnType<typeof reviewFixture>>;
let saved: DenseFixture | undefined;
let originalCommit: Awaited<ReturnType<DenseFixture['repo']['approve']>> | undefined;
let approvalCommand:
  | {
      schemaVersion: 1;
      candidateId: string;
      applicationDigest: string;
      confirmed: true;
      idempotencyKey: string;
    }
  | undefined;
function actualFixture() {
  if (!saved) throw Error('DENSE_FIXTURE_UNAVAILABLE');
  return saved;
}
fixtureIt(
  'public training400/nutrition400/routine30 review stores one lossless pooled body and frozen preview without plan writes',
  async () => {
    const f = await timedStage('workflow.prepare_and_review', () => reviewFixture(true));
    saved = f;
    const preview = await timedStage('retained.preview', () =>
      f.repo.readPreview(f.athlete, f.reviewed.reference.candidateId),
    );
    if (
      preview?.status !== 'present' ||
      preview.training.state !== 'present' ||
      preview.nutrition.state !== 'present' ||
      preview.routines.state !== 'present' ||
      preview.recovery.state !== 'present'
    )
      throw Error('DENSE_FULL_PREVIEW_REQUIRED');
    expect(new Set(preview.affected.map((w) => w.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    const training = preview.training.members[0],
      nutrition = preview.nutrition.members[0],
      routine = preview.routines.members[0];
    if (!training || !nutrition || !routine) throw Error('DENSE_FULL_PREVIEW_REQUIRED');
    expect(training.before.plan.sessions).toHaveLength(400);
    expect(training.after.plan.sessions.map((s) => s.id)).toEqual(
      training.before.plan.sessions.map((s) => s.id),
    );
    for (const [index, session] of training.after.plan.sessions.entries()) {
      expect(session.durationSeconds).toBe(index % 2 ? null : 0);
      expect(session.distanceMeters).toBe(index % 2 ? null : 0);
      expect(session.localStartTime).toBeNull();
    }
    assertItems(nutrition.before.plan.items, f.event.id);
    assertItems(nutrition.after.plan.items, f.event.id);
    expect(nutrition.timings).toHaveLength(400);
    expect(routine.blueprint.steps).toHaveLength(30);
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThanOrEqual(4194304);
    // Separate actual retained-read command, with its own unchanged source budget.
    // The expanded logical body is never submitted to the historical store.
    await timedStage('retained.readlossless', () =>
      snapshot(f.athlete, async (tx) => {
        const read = await readRaceManualPooledChainTransportV1In(
          tx,
          f.reviewed.reference.chain.evidenceId,
          { bytes: 0n, sources: 0 },
        );
        if (read.status !== 'read' || read.payload?.state !== 'present')
          throw Error('DENSE_STORED_BODY_REQUIRED');
        expect(read.payloadEncoding).toBe('pooled-database-envelope-v1');
        const logical = read.payload,
          wire = timedSync('retained.encode', () => toDatabase(encode(logical)));
        timedSync('retained.decode_and_compare', () => expect(decode(wire)).toEqual(logical));
        const sizes = z
          .strictObject({
            logical_bytes: z.number().int().positive(),
            encoded_bytes: z.number().int().positive(),
            refs: z.number().int().positive(),
          })
          .parse(
            (
              await tx.query(
                "SELECT octet_length($1::jsonb::text) AS logical_bytes,octet_length($2::jsonb::text) AS encoded_bytes,jsonb_array_length($2::jsonb->'payload'->'inventory'->'refs') AS refs",
                [JSON.stringify(logical), JSON.stringify(wire)],
              )
            ).rows[0],
          );
        expect(Buffer.byteLength(JSON.stringify(logical), 'utf8')).toBeLessThanOrEqual(4194304);
        expect(sizes.logical_bytes).toBeGreaterThan(4194304);
        expect(sizes.encoded_bytes).toBeLessThanOrEqual(4194304);
        expect(sizes.encoded_bytes).toBeLessThan(sizes.logical_bytes);
        expect(sizes.refs).toBe(logical.payload.inventory.refs.length);
        console.log(
          JSON.stringify({
            diagnostic: 'pooled_dense_lossless',
            logicalPgJsonbBytes: sizes.logical_bytes,
            encodedPgJsonbBytes: sizes.encoded_bytes,
            refs: sizes.refs,
            poolEntries: wire.payload.preparation.sourcePool.length,
            substitutions: wire.payload.preparation.substitutions.length,
          }),
        );
      }),
    );
    expect((await createPlanningRepository(db).read(f.athlete)).head?.id).toBe(f.plan.id);
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(f.event.revision);
    expect(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head
        ?.versionId,
    ).toBe(f.nutrition.versionId);
    expect(await f.routine.readSchedule(f.athlete, f.approved.schedule.id)).toEqual(f.approved);
    expect(await f.recovery.readStrategy(f.athlete, f.confirmed.strategyId)).toEqual(f.confirmed);
  },
);
let reviewedExport: AccountExportV38 | undefined;
async function assertExportCensus(value: AccountExportV38, f: DenseFixture) {
  expect(value.athleteId).toBe(f.athlete);
  expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThanOrEqual(8388608);
  expect(value.data.manualInternalChains).toHaveLength(1);
  expect(value.data.manualInternalCandidates).toHaveLength(1);
  expect(value.data.manualRaceReviews).toHaveLength(1);
  expect(value.data.manualSourceChains).toHaveLength(1);
  const internal = value.data.manualInternalChains[0],
    source = value.data.manualSourceChains[0];
  if (!internal || !source) throw Error('DENSE_EXPORT_CHAIN_REQUIRED');
  const expectedChainIds = {
    evidenceId: f.reviewed.reference.chain.evidenceId,
    decisionId: f.reviewed.reference.chain.decisionId,
    proposalId: f.reviewed.reference.chain.proposalId,
  };
  expect({
    evidenceId: internal.evidenceId,
    decisionId: internal.decisionId,
    proposalId: internal.proposalId,
  }).toEqual(expectedChainIds);
  expect({
    evidenceId: source.evidenceId,
    decisionId: source.decisionId,
    proposalId: source.proposalId,
  }).toEqual(expectedChainIds);
  expect(internal.proposalApplied).toBe(false);
  expect(internal.body.state).toBe('present');
  expect(value.data.manualInternalCandidates[0]?.candidateId).toBe(
    f.reviewed.reference.candidateId,
  );
  expect(value.data.manualRaceReviews[0]?.reference).toEqual(f.reviewed.reference);
  // These public original references carry the readonly candidate digest.
  // Internal/source chain DTOs expose only IDs; source-ref DTO hashes are a
  // different namespace and must not stand in for this original receipt fact.
  expect(value.data.manualRaceReviews[0]?.reference.chain.readonlyCandidateDigest).toBe(
    f.reviewed.reference.chain.readonlyCandidateDigest,
  );
  const originalReview = value.data.manualRaceCommandResults.find(
    (result) =>
      result.operation === 'review' && result.candidateId === f.reviewed.reference.candidateId,
  );
  if (
    !originalReview ||
    originalReview.operation !== 'review' ||
    originalReview.result.status !== 'reviewed'
  )
    throw Error('DENSE_EXPORT_ORIGINAL_REVIEW_REQUIRED');
  expect(originalReview.result.reference.chain.readonlyCandidateDigest).toBe(
    f.reviewed.reference.chain.readonlyCandidateDigest,
  );
  const refs = value.data.manualSavedSourceRefs.filter((r) => r.evidenceId === source.evidenceId);
  const stored = await owner(async (pool) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN READ ONLY');
      await tx.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
      return z
        .strictObject({
          refs: z.number().int(),
          parents: z.number().int(),
          suppressions: z.number().int(),
        })
        .parse(
          (
            await tx.query(
              'SELECT (SELECT count(*)::int FROM public.manual_race_chain_source_ref_v2 WHERE athlete_id=$1 AND evidence_id=$2) AS refs,(SELECT count(*)::int FROM public.manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=$1 AND evidence_id=$2) AS parents,(SELECT count(*)::int FROM public.manual_race_chain_suppression_v2 WHERE athlete_id=$1 AND evidence_id=$2) AS suppressions',
              [f.athlete, source.evidenceId],
            )
          ).rows[0],
        );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
  expect({
    refs: source.savedRefCount,
    parents: source.savedParentCount,
    suppressions: source.savedSuppressionCount,
  }).toEqual(stored);
  expect(refs).toHaveLength(source.savedRefCount);
  expect(refs.map((r) => r.ordinal)).toEqual(
    Array.from({ length: source.savedRefCount }, (_, i) => i + 1),
  );
  expect(
    value.data.manualSavedSourceParents.filter((r) => r.evidenceId === source.evidenceId),
  ).toHaveLength(source.savedParentCount);
  expect(
    value.data.manualSavedSourceSuppressions.filter((r) => r.evidenceId === source.evidenceId),
  ).toHaveLength(source.savedSuppressionCount);
}
fixtureIt(
  'genuine reviewed dense chain exports full frozen planned/source census before approval without domain writes',
  async () => {
    const f = actualFixture();
    const preview = await timedStage('retained.preview', () =>
      f.repo.readPreview(f.athlete, f.reviewed.reference.candidateId),
    );
    const value = parseAccountExportV38(
      await createOperationsV38PooledRepository(db).exportAccount(f.athlete),
    );
    await assertExportCensus(value, f);
    reviewedExport = value;
    const chain = value.data.manualInternalChains.find(
      (row) => row.evidenceId === f.reviewed.reference.chain.evidenceId,
    );
    expect(chain?.decisionId).toBe(f.reviewed.reference.chain.decisionId);
    expect(chain?.proposalId).toBe(f.reviewed.reference.chain.proposalId);
    const body = chain?.body;
    const candidate = value.data.manualInternalCandidates.find(
      (row) => row.candidateId === f.reviewed.reference.candidateId,
    );
    expect(candidate?.chain).toEqual({
      evidenceId: f.reviewed.reference.chain.evidenceId,
      decisionId: f.reviewed.reference.chain.decisionId,
      proposalId: f.reviewed.reference.chain.proposalId,
    });
    const candidateBody = candidate?.body;
    if (
      candidateBody?.state !== 'present' ||
      candidateBody.storedApplicationState !== 'ready_for_explicit_approval'
    )
      throw Error('DENSE_EXPORT_READY_CANDIDATE_REQUIRED');
    if (body?.state !== 'present' || preview?.status !== 'present')
      throw Error('DENSE_EXPORT_PLANNED_REQUIRED');
    // Both strict codecs retain the full planned content. Public ready preview
    // additionally labels hypothetical writes with after.kind; internal stored
    // facts instead carry explicit state/resolution requirements and source refs.
    // Compare a typed full projection, never drop a domain/member/item by count.
    type Planned = z.infer<typeof raceManualInternalPlannedContentSchema>;
    const trainingExpected: Planned['training'] = preview.training;
    expect(body.planned.training).toEqual(trainingExpected);
    if (
      preview.nutrition.state !== 'present' ||
      preview.recovery.state !== 'present' ||
      preview.routines.state !== 'present' ||
      preview.training.state !== 'present'
    )
      throw Error('DENSE_FOUR_DOMAIN_PRESENT_REQUIRED');
    for (const section of [preview.training, preview.nutrition, preview.recovery, preview.routines])
      for (const member of section.members)
        expect(member.after.kind).toBe('new_version_on_approval');
    type NutritionMember = Extract<Planned['nutrition'], { state: 'present' }>['members'][number];
    const plannedNutrition = (
      plan: (typeof preview.nutrition.members)[number]['before']['plan'],
    ): NutritionMember['before']['plan'] => ({
      ...plan,
      items: plan.items.map((item) =>
        raceManualPublicImpactNutritionItemSchema.parse({
          ...item,
          // This established internal planned codec excludes private evidence IDs;
          // preserve all metric/amount definitions, item identities and ordering.
          targets: item.targets.map((target) => ({
            metric: target.metric,
            amount: {
              min: target.amount.min,
              max: target.amount.max,
              unit: target.amount.unit,
              basis: target.amount.basis,
            },
          })),
        }),
      ),
    });
    const nutritionExpected: Planned['nutrition'] = {
      state: 'present',
      members: preview.nutrition.members.map((member) => ({
        aggregateId: member.aggregateId,
        before: { ...member.before, plan: plannedNutrition(member.before.plan) },
        after: {
          plan: plannedNutrition(member.after.plan),
          linkedTraining: member.after.linkedTraining,
        },
        timings: member.timings.map((t) => ({ ...t, resolution: 'absent', requirement: 'none' })),
      })),
    };
    expect(body.planned.nutrition).toEqual(nutritionExpected);
    const recoveryExpected: Planned['recovery'] = {
      state: 'present',
      members: preview.recovery.members.map((member) => {
        const { kind, ...after } = member.after;
        expect(kind).toBe('new_version_on_approval');
        return {
          aggregateId: member.aggregateId,
          state: 'affected',
          before: member.before,
          after,
          requirement: 'none',
        };
      }),
    };
    expect(body.planned.recovery).toEqual(recoveryExpected);
    const routinesExpected: Planned['routines'] = {
      state: 'present',
      members: preview.routines.members.map((member) => {
        const { kind, ...after } = member.after;
        expect(kind).toBe('new_version_on_approval');
        expect(member.aggregateId).toBe(f.approved.schedule.id);
        return {
          aggregateId: member.aggregateId,
          state: 'affected',
          blueprint: member.blueprint,
          before: { ...member.before, sourcePlanVersionId: f.approved.sourcePlanVersionId },
          after: { ...after, sourcePlanVersionId: f.approved.sourcePlanVersionId },
          retainedStarted: member.retainedStarted,
          storedOccurrences: f.approved.occurrences.map((o) => ({
            occurrenceId: o.id,
            schedule: o.schedule,
            blueprint: o.blueprint,
            sourcePlanVersionId: f.approved.sourcePlanVersionId,
            anchorKey: o.anchorKey,
            scheduledAt: o.scheduledAt,
            timingStatus: o.timingStatus,
            unresolvedReason: null,
          })),
          resolution: 'absent',
          requirement: 'none',
        };
      }),
    };
    // SQL116 readonly projection keeps the original schedule version. SQL118
    // separately freezes a new application version and its deterministic IDs.
    const training = preview.training.members.find(
      (member) => member.before.ref.versionId === f.plan.id,
    );
    if (!training) throw Error('DENSE_EXACT_TRAINING_REQUIRED');
    const readonlyRoutinesExpected: Planned['routines'] = {
      state: 'present',
      members: routinesExpected.members.map((member) => {
        expect(member.before.schedule.versionId).toBe(f.approved.schedule.versionId);
        expect(member.after.schedule.versionId).not.toBe(member.before.schedule.versionId);
        const originalSchedule = {
          ...member.after.schedule,
          versionId: member.before.schedule.versionId,
        };
        const started = new Set(member.retainedStarted.map((run) => run.anchorKey));
        const originalOccurrences = expandRoutineSchedule(
          originalSchedule,
          training.after.plan,
        ).filter((occurrence) => !started.has(occurrence.anchorKey));
        const proposedOccurrences = expandRoutineSchedule(
          member.after.schedule,
          training.after.plan,
        ).filter((occurrence) => !started.has(occurrence.anchorKey));
        expect(member.after.expansion).toEqual({
          state: 'expanded',
          occurrences: proposedOccurrences,
        });
        expect(originalOccurrences).toHaveLength(proposedOccurrences.length);
        for (const [index, original] of originalOccurrences.entries()) {
          const proposed = proposedOccurrences[index];
          if (!proposed) throw Error('DENSE_EXACT_OCCURRENCE_REQUIRED');
          expect(original.schedule).toEqual({
            id: originalSchedule.id,
            versionId: originalSchedule.versionId,
          });
          expect(proposed.schedule).toEqual({
            id: member.after.schedule.id,
            versionId: member.after.schedule.versionId,
          });
          expect(original.id).not.toBe(proposed.id);
          // Every content field and ordered occurrence is compared; only these
          // explicitly verified namespace fields differ between stored families.
          expect({ ...original, id: proposed.id, schedule: proposed.schedule }).toEqual(proposed);
        }
        return {
          ...member,
          after: {
            ...member.after,
            schedule: originalSchedule,
            expansion: { state: 'expanded', occurrences: originalOccurrences },
          },
        };
      }),
    };
    expect(body.planned.routines).toEqual(readonlyRoutinesExpected);
    // The stored ready application must match the preview's full proposed
    // identities/content across all affected domains, independently of chain.
    expect(candidateBody.planned.training).toEqual(trainingExpected);
    expect(candidateBody.planned.nutrition).toEqual(nutritionExpected);
    expect(candidateBody.planned.recovery).toEqual(recoveryExpected);
    expect(candidateBody.planned.routines).toEqual(routinesExpected);
    expect(candidateBody.planned.race).toEqual(preview.race);
    expect(candidateBody.planned.retainedUnplanned).toEqual(preview.retainedUnplanned);
    expect(candidateBody.planned.affected).toEqual(body.planned.affected);
    expect(candidateBody.planned.resolutionRequirements).toEqual(
      body.planned.resolutionRequirements,
    );
    expect(candidateBody.planned.notices).toEqual(body.planned.notices);
    expect(body.planned.race).toEqual(preview.race);
    expect(body.planned.retainedUnplanned).toEqual(preview.retainedUnplanned);
    expect(value.data.manualInternalApprovalResults).toEqual([]);
    expect(value.data.manualInternalApprovalHistory).toEqual([]);
    expect(value.data.manualRaceApprovalHistory).toEqual([]);
    expect(
      value.data.manualRaceCommandResults
        .filter((r) => r.operation === 'review')
        .map((r) => r.result),
    ).toContainEqual(f.reviewed);
    expect((await createPlanningRepository(db).read(f.athlete)).head).toEqual(f.plan);
    expect(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    ).toEqual(f.nutrition);
    expect(await f.recovery.readStrategy(f.athlete, f.confirmed.strategyId)).toEqual(f.confirmed);
    expect(await f.routine.readSchedule(f.athlete, f.approved.schedule.id)).toEqual(f.approved);
  },
);
fixtureIt(
  'explicit approval commits all four dense heads atomically and original receipt replay creates no extra versions',
  async () => {
    const f = actualFixture();
    approvalCommand = {
      schemaVersion: 1,
      candidateId: f.reviewed.reference.candidateId,
      applicationDigest: f.reviewed.reference.applicationDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    };
    const committed = await timedStage('public.approve', () =>
      f.repo.approve(f.athlete, approvalCommand),
    );
    if (committed.status !== 'committed') throw new Error('DENSE_APPROVAL_REQUIRED');
    originalCommit = committed;
    expect(new Set(committed.versions.map((v) => v.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    expect(committed.versions).toHaveLength(4);
    const head = (await createPlanningRepository(db).read(f.athlete)).head;
    expect(head?.draft.sessions).toHaveLength(400);
    expect(head?.draft.sessions.map((s) => s.id)).toEqual(f.plan.draft.sessions.map((s) => s.id));
    expect(head?.draft.sessions.every((s) => s.date === '2026-10-08')).toBe(true);
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.planVersionId).toBe(head?.id);
    const next = nutritionPlanVersionV4Schema.parse(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    );
    assertItems(next.items, f.event.id);
    expect(next.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
    expect(next.itemRaceTimingBindings).toHaveLength(400);
    const nextRecovery = await f.recovery.readStrategy(f.athlete, f.confirmed.strategyId);
    expect(nextRecovery?.versionId).not.toBe(f.confirmed.versionId);
    expect(nextRecovery?.selectedOptionId).toEqual(f.confirmed.selectedOptionId);
    expect(nextRecovery?.draft.options).toEqual(f.confirmed.draft.options);
    expect(nextRecovery?.draft.knownFacts).toEqual(f.confirmed.draft.knownFacts);
    expect(await f.routine.readBlueprintVersion(f.athlete, f.blueprint.versionId)).toEqual(
      f.blueprint,
    );
    const versions = await owner(
      async (p) =>
        (
          await p.query(
            'SELECT (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) AS training,(SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS nutrition,(SELECT count(*)::int FROM recovery_strategy_version WHERE athlete_id=$1) AS recovery,(SELECT count(*)::int FROM routine_schedule_version WHERE athlete_id=$1) AS routine',
            [f.athlete],
          )
        ).rows[0],
    );
    expect(
      await timedStage('public.approve', () => f.repo.approve(f.athlete, approvalCommand)),
    ).toEqual(committed);
    expect(
      await timedStage('public.approve', () =>
        f.repo.approve(f.athlete, { ...approvalCommand, idempotencyKey: randomUUID() }),
      ),
    ).toEqual(committed);
    expect(
      await owner(
        async (p) =>
          (
            await p.query(
              'SELECT (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) AS training,(SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS nutrition,(SELECT count(*)::int FROM recovery_strategy_version WHERE athlete_id=$1) AS recovery,(SELECT count(*)::int FROM routine_schedule_version WHERE athlete_id=$1) AS routine',
              [f.athlete],
            )
          ).rows[0],
      ),
    ).toEqual(versions);
  },
);
fixtureIt(
  'withdrawal permits original review/approval replay and frozen retained preview while refusing new processing',
  async () => {
    const f = actualFixture();
    if (!originalCommit || !approvalCommand) throw Error('DENSE_COMMIT_UNAVAILABLE');
    const before = await timedStage('retained.preview', () =>
      f.repo.readPreview(f.athlete, f.reviewed.reference.candidateId),
    );
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      await timedStage('retained.preview', () =>
        f.repo.readPreview(f.athlete, f.reviewed.reference.candidateId),
      ),
    ).toEqual(before);
    expect(
      await timedStage('public.review', () =>
        f.repo.review(f.athlete, {
          schemaVersion: 1,
          idempotencyKey: f.reviewKey,
          intent: f.intent,
        }),
      ),
    ).toEqual(f.reviewed);
    expect(
      await timedStage('public.approve', () => f.repo.approve(f.athlete, approvalCommand)),
    ).toEqual(originalCommit);
    expect(
      await timedStage('public.approve', () =>
        f.repo.approve(f.athlete, { ...approvalCommand, idempotencyKey: randomUUID() }),
      ),
    ).toEqual(originalCommit);
    await expect(
      timedStage('public.review', () =>
        f.repo.review(f.athlete, {
          schemaVersion: 1,
          idempotencyKey: randomUUID(),
          intent: f.intent,
        }),
      ),
    ).rejects.toThrow('APP_CONSENT_REQUIRED');
  },
);
fixtureIt(
  'approved dense chain exports original approval receipts and atomic heads after withdrawal with frozen source census',
  async () => {
    const f = actualFixture();
    if (originalCommit?.status !== 'committed' || !reviewedExport)
      throw Error('DENSE_COMMIT_EXPORT_UNAVAILABLE');
    const value = parseAccountExportV38(
      await createOperationsV38PooledRepository(db).exportAccount(f.athlete),
    );
    await assertExportCensus(value, f);
    expect(value.data.manualInternalChains).toEqual(reviewedExport.data.manualInternalChains);
    expect(value.data.manualInternalCandidates).toEqual(
      reviewedExport.data.manualInternalCandidates,
    );
    expect(
      value.data.manualSavedSourceRefs.map((r) => ({
        evidenceId: r.evidenceId,
        ordinal: r.ordinal,
        identity: r.identity,
        location: r.location,
      })),
    ).toEqual(
      reviewedExport.data.manualSavedSourceRefs.map((r) => ({
        evidenceId: r.evidenceId,
        ordinal: r.ordinal,
        identity: r.identity,
        location: r.location,
      })),
    );
    expect(value.data.manualSavedSourceParents).toEqual(
      reviewedExport.data.manualSavedSourceParents,
    );
    expect(value.data.manualInternalApprovalResults).toEqual([originalCommit]);
    expect(value.data.manualInternalApprovalHistory).toHaveLength(4);
    expect(value.data.manualRaceApprovalHistory).toHaveLength(4);
    expect(
      value.data.manualRaceCommandResults
        .filter((r) => r.operation === 'approve')
        .map((r) => r.result),
    ).toContainEqual(originalCommit);
    const training = (await createPlanningRepository(db).read(f.athlete)).head;
    const nutrition = (
      await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId)
    )?.head;
    const recovery = await f.recovery.readStrategy(f.athlete, f.confirmed.strategyId);
    const routine = await f.routine.readSchedule(f.athlete, f.approved.schedule.id);
    for (const v of originalCommit.versions) {
      if (v.domain === 'training') expect(training?.id).toBe(v.versionId);
      else if (v.domain === 'nutrition') expect(nutrition?.versionId).toBe(v.versionId);
      else if (v.domain === 'recovery') expect(recovery?.versionId).toBe(v.versionId);
      else expect(routine?.schedule.versionId).toBe(v.versionId);
    }
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(
      originalCommit.race.revision,
    );
    expect(training?.draft.sessions).toHaveLength(400);
    if (!nutrition) throw Error('DENSE_NUTRITION_HEAD_REQUIRED');
    assertItems(nutrition.items, f.event.id);
    expect(nutrition.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
  },
);
fixtureIt(
  'genuine account erasure removes whole pooled payloads/candidates/receipts and prevents retained resurrection',
  async () => {
    const f = actualFixture();
    expect(await createOperationsRepository(db).eraseAccount(f.athlete)).toEqual({ erased: true });
    await owner(async (p) => {
      for (const table of [
        'manual_race_evidence_v2',
        'manual_race_decision_v2',
        'manual_race_proposal_v2',
        'manual_race_chain_receipt_v2',
        'manual_race_chain_commit_v2',
        'manual_race_chain_source_ref_v2',
        'manual_race_chain_lifecycle_edge_v2',
        'manual_race_chain_suppression_v2',
        'race_manual_application_candidate_v1',
        'race_manual_application_receipt_v1',
        'race_manual_application_history_v1',
        'race_manual_application_context_v1',
        'race_manual_public_receipt_v1',
      ]) {
        // Fixed local table roster only. Count facts, never source/health bodies.
        expect(
          (
            await p.query(
              `SELECT count(*)::int AS count FROM public.${table} WHERE athlete_id=$1`,
              [f.athlete],
            )
          ).rows[0]?.['count'],
        ).toBe(0);
      }
    });
    await expect(createOperationsV38PooledRepository(db).exportAccount(f.athlete)).rejects.toThrow(
      'ACCOUNT_ERASED',
    );
    const foreign = await tenant();
    const empty = parseAccountExportV38(
      await createOperationsV38PooledRepository(db).exportAccount(foreign),
    );
    expect(empty.data.manualInternalChains).toEqual([]);
    expect(empty.data.manualInternalCandidates).toEqual([]);
    expect(empty.data.manualInternalApprovalResults).toEqual([]);
    expect(empty.data.manualRaceReviews).toEqual([]);
    expect(empty.data.manualRaceCommandResults).toEqual([]);
    expect(empty.data.manualSourceChains).toEqual([]);
    expect(empty.data.manualSavedSourceRefs).toEqual([]);
    expect(empty.data.manualSavedSourceParents).toEqual([]);
    expect(empty.data.manualSavedSourceSuppressions).toEqual([]);
    await expect(
      timedStage('retained.preview', () =>
        f.repo.readPreview(f.athlete, f.reviewed.reference.candidateId),
      ),
    ).rejects.toThrow('ACCOUNT_ERASED');
    await expect(
      timedStage('public.review', () =>
        f.repo.review(f.athlete, {
          schemaVersion: 1,
          idempotencyKey: f.reviewKey,
          intent: f.intent,
        }),
      ),
    ).rejects.toThrow('ACCOUNT_ERASED');
  },
);
fixtureIt(
  'routine31/400 are rejected separately from the actual accepted30 blueprint without adding versions',
  async () => {
    const athlete = await tenant(),
      routine = createRoutineRepository(db);
    const blueprint = {
      schemaVersion: 4 as const,
      routineId: randomUUID(),
      versionId: randomUUID(),
      title: 'Negative planned bound',
      intent: 'Planned only',
      status: 'published' as const,
      tags: [],
      estimatedDurationSeconds: null,
      createdAt: '2026-10-08T00:00:00Z',
      steps: Array.from({ length: 30 }, (_, index) => ({
        id: `step-${index}`,
        title: 'Check',
        content: { kind: 'checklist' as const, prompt: 'User question' },
        timing: { kind: 'ordered' as const, afterStepId: null },
        required: true,
        choiceGroupId: null,
      })),
      choiceGroups: [],
    };
    const saved = (
      await routine.saveBlueprint(athlete, {
        confirmed: true,
        expectedVersionId: null,
        idempotencyKey: randomUUID(),
        blueprint,
      })
    ).blueprint;
    const first = saved.steps[0];
    if (!first) throw Error('STEP_REQUIRED');
    for (const count of [31, 400])
      await expect(
        routine.saveBlueprint(athlete, {
          confirmed: true,
          expectedVersionId: null,
          idempotencyKey: randomUUID(),
          blueprint: {
            ...saved,
            routineId: randomUUID(),
            versionId: randomUUID(),
            steps: Array.from({ length: count }, (_, index) => ({
              ...first,
              id: `rejected-${index}`,
            })),
          },
        }),
      ).rejects.toThrow('INVALID_BLUEPRINT');
    expect((await routine.listBlueprints(athlete, {})).items).toHaveLength(1);
    expect(await routine.readBlueprintVersion(athlete, saved.versionId)).toEqual(saved);
  },
);
fixtureIt(
  'semantic5001 remains a codec negative and is never substituted for genuine accepted mixed400/400/30',
  () => {
    const template = denseItems(randomUUID())[0];
    if (!template) throw Error('ITEM_REQUIRED');
    expect(
      nutritionPlanDraftSchema.safeParse({
        period: { from: '2026-10-01', toInclusive: '2026-11-04' },
        timezone: 'UTC',
        purpose: 'Too many',
        linkedTrainingPlanVersionId: null,
        items: Array.from({ length: 5001 }, (_, index) => ({
          ...template,
          id: `negative-${index}`,
        })),
      }).success,
    ).toBe(false);
  },
);
