import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { planReadSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
import { raceEventSchema } from '../../packages/contracts/src/races';
import { raceCommandResultSchema } from '../../packages/contracts/src/race-commands';
import {
  foodDefinitionVersionSchema,
  intakeEntryRecordSchema,
  nutritionPlanVersionSchema,
} from '../../packages/contracts/src/nutrition-core';
import { nutritionPlanReadV4Schema } from '../../packages/contracts/src/nutrition-race-plan-v4';
import { recoveryStrategyVersionSchema } from '../../packages/contracts/src/recovery-core';
import {
  routineBlueprintReadSchema,
  routineRunReadSchema,
  routineSchedulePreviewSchema,
  routineScheduleReadSchema,
} from '../../packages/contracts/src/routine-commands';
import { restoreGenerationResponseSchema } from '../../packages/contracts/src/restore-generation';
import { raceManualPublicReviewResultSchema } from '../../packages/contracts/src/race-manual-public';
import { raceManualPublicPreviewSchema } from '../../packages/contracts/src/race-manual-public-preview';
import { raceManualPublicImpactSchema } from '../../packages/contracts/src/race-manual-public-impact';
import { raceManualApprovalResultSchema } from '../../packages/contracts/src/race-manual-approval';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';

// Explicit disposable installed-runtime profile. Public HTTP producers, genuine local synthetic
// OIDC and UI; no SQL health seeds, interception, remote/device evidence.
// Public legacy V1 nutrition is the input; atomic approval creates a V4
// successor. This does not prove a public standalone V4/multipin writer.
async function login(page: Page, origin: string) {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await grantAppProcessingForScenario(page);
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(typeof session === 'object' && session !== null);
  assert.ok('sessionId' in session && typeof session.sessionId === 'string');
  assert.ok('csrfToken' in session && typeof session.csrfToken === 'string');
  return { origin, 'x-workout-session-id': session.sessionId, 'x-csrf-token': session.csrfToken };
}

for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: linked absolute nutrition requires genuine recovery confirmation then explicit four-domain approval`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    page.setDefaultTimeout(10000);
    const headers = await login(page, origin);
    const get = async (path: string) => {
      const reply = await page.request.get(`${origin}/bff/v1${path}`, { headers });
      expect(reply.status(), path).toBe(200);
      const body: unknown = await reply.json();
      return body;
    };
    const post = async (path: string, data: unknown, key = randomUUID()) => {
      const reply = await page.request.post(`${origin}/bff/v1${path}`, {
        headers: { ...headers, 'idempotency-key': key },
        data,
      });
      expect(reply.ok(), `${path} HTTP ${reply.status()}`).toBe(true);
      const body: unknown = await reply.json();
      return body;
    };
    try {
      const current = planReadSchema.parse(await get('/plans/current'));
      const planReply = await page.request.put(`${origin}/bff/v1/plans/current`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          source: 'manual',
          confirmed: true,
          expectedVersionId: current.head?.id ?? null,
          draft: {
            title: `Synthetic linked-nutrition ${host}`,
            timezone: 'UTC',
            periods: ['season', 'wave', 'phase', 'block'].map((id, index, ids) => ({
              id,
              parentId: index === 0 ? null : ids[index - 1],
              level: id,
              title: `Synthetic ${id}`,
              startDate: '2080-01-01',
              endDateExclusive: '2080-02-01',
              timezone: 'UTC',
              intent: '',
              isPartial: false,
            })),
            sessions: [
              {
                id: 'session',
                blockId: 'block',
                date: '2080-01-06',
                localStartTime: '08:00',
                title: 'Synthetic planned run',
                sport: 'running',
                durationSeconds: 1800,
                distanceMeters: 0,
                targetRpe: null,
                purpose: '',
                notes: '',
                priority: 'normal',
                locks: { date: false, time: false, intensity: false },
                steps: [],
              },
            ],
          },
        },
      });
      expect(planReply.status()).toBe(200);
      const plan = planSnapshotSchema.parse(await planReply.json());
      const raceResult = raceCommandResultSchema.parse(
        await post('/races', {
          values: {
            title: `Synthetic linked-nutrition race ${host}`,
            localDate: '2080-01-06',
            localStartTime: '09:00',
            timezone: 'UTC',
            locationName: null,
            distance: { kind: 'standard', class: '10k' },
            priority: 'A',
            participation: 'registered',
            officialUrl: null,
            course: null,
            targetSeconds: null,
            planVersionId: plan.id,
          },
        }),
      );
      const race = raceEventSchema.parse(await get(`/races/${raceResult.id}`));
      const unknownNutrient = (unit: string) => ({
        value: null,
        unit,
        status: 'unknown',
        evidenceIds: [],
      });
      const nutrientTotal = {
        energy: unknownNutrient('kcal'),
        carbohydrate: unknownNutrient('g'),
        protein: unknownNutrient('g'),
        fat: unknownNutrient('g'),
        fluid: unknownNutrient('mL'),
        sodium: unknownNutrient('mg'),
      };
      const food = foodDefinitionVersionSchema.parse(
        await post('/nutrition/foods', {
          expectedVersionId: null,
          confirmed: true,
          definition: {
            foodId: randomUUID(),
            name: 'Synthetic frozen source',
            basis: { kind: 'per_100g' },
            nutrients: nutrientTotal,
            provenance: {
              kind: 'user_entered',
              reference: null,
              capturedAt: '2026-10-07T00:00:00Z',
              reviewState: 'unreviewed',
            },
          },
        }),
      );
      const foods = [
        {
          foodVersionId: food.versionId,
          description: 'Synthetic retained food',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'per_100g',
        },
        {
          foodVersionId: null,
          description: 'Synthetic unknown portion',
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ];
      const nutrition = nutritionPlanVersionSchema.parse(
        await post('/nutrition/plans', {
          kind: 'create',
          confirmed: true,
          draft: {
            period: { from: '2080-01-01', toInclusive: '2080-02-04' },
            timezone: 'UTC',
            purpose: 'Retain food and explicit instructions',
            linkedTrainingPlanVersionId: plan.id,
            items: [
              {
                id: 'meal',
                category: 'before',
                title: 'Synthetic frozen meal',
                anchor: {
                  kind: 'absolute',
                  date: '2080-01-06',
                  localTime: '07:30',
                  timezone: 'UTC',
                },
                foods,
                targets: [],
                instructions: '합성 섭취를 기록한다',
                evidenceIds: [],
                source: 'user_confirmed',
              },
            ],
          },
        }),
      );
      // Public planning read does not expose aggregateId. Use the genuine
      // nutrition aggregate reference; never substitute the training snapshot ID.
      const selectedOptionId = randomUUID();
      const strategy = recoveryStrategyVersionSchema.parse(
        await post('/recovery/strategy-drafts', {
          draft: {
            title: 'Synthetic selected rest',
            goal: 'Preserve user facts',
            startDate: '2080-01-01',
            endDateExclusive: '2080-02-05',
            timezone: 'UTC',
            knownFacts: ['User reported synthetic fact'],
            missingInformation: [],
            priority: 'normal',
            observations: [],
            planRefs: [
              {
                kind: 'nutrition',
                aggregateId: nutrition.planId,
                headVersionId: nutrition.versionId,
              },
            ],
            options: [
              {
                id: selectedOptionId,
                title: 'Rest',
                kind: 'full_rest',
                methodVersionId: null,
                explanation: 'Existing explicit user option',
              },
            ],
            reassessment: [
              {
                id: randomUUID(),
                trigger: 'plan_changed',
                description: 'Reassess changed plan',
                plannedAt: null,
                policyVersion: null,
              },
            ],
          },
        }),
      );
      let recovery = strategy;
      expect(recovery.status).toBe('draft');
      expect(recovery.selectedOptionId).toBeNull();
      const blueprint = routineBlueprintReadSchema.parse(
        await post('/routines', {
          confirmed: true,
          expectedVersionId: null,
          blueprint: {
            schemaVersion: 4,
            routineId: randomUUID(),
            versionId: randomUUID(),
            title: 'Synthetic frozen checklist',
            intent: 'Preserve actual versus planned',
            status: 'published',
            tags: [],
            estimatedDurationSeconds: null,
            createdAt: '2026-10-08T00:00:00.000Z',
            steps: [
              {
                id: 'step',
                title: 'Explicit checklist',
                content: { kind: 'checklist', prompt: 'Synthetic question' },
                timing: { kind: 'ordered', afterStepId: null },
                required: true,
                choiceGroupId: null,
              },
            ],
            choiceGroups: [],
          },
        }),
      );
      const scheduleInput = {
        schedule: {
          schemaVersion: 4,
          id: randomUUID(),
          versionId: randomUUID(),
          blueprint: {
            id: blueprint.blueprint.routineId,
            versionId: blueprint.blueprint.versionId,
          },
          window: {
            startDate: '2080-01-01',
            endDateExclusive: '2080-02-05',
            timezone: 'UTC',
            maxOccurrences: 10,
          },
          rule: {
            kind: 'period_days',
            periodId: 'season',
            offsetsDays: [5, 6],
            localTime: '08:00',
          },
          state: 'draft',
        },
        sourcePlanVersionId: plan.id,
      };
      const schedulePreview = routineSchedulePreviewSchema.parse(
        await post('/routine-schedule-previews', scheduleInput),
      );
      const routine = routineScheduleReadSchema.parse(
        await post('/routine-schedules', {
          ...scheduleInput,
          previewDigest: schedulePreview.previewDigest,
          confirmed: true,
        }),
      );
      const occurrence = routine.occurrences[0];
      assert.ok(occurrence);
      const started = routineRunReadSchema.parse(
        await post('/routine-runs', {
          runId: randomUUID(),
          blueprintVersionId: blueprint.blueprint.versionId,
          occurrenceId: occurrence.id,
          confirmed: true,
        }),
      );
      const actualRun = routineRunReadSchema.parse(
        await post(`/routine-runs/${started.run.id}/steps`, {
          stepId: 'step',
          state: 'performed',
          actualRefs: [],
          occurredAt: '2026-10-07T00:00:00Z',
          reason: null,
          expectedRevision: started.run.revision,
          confirmed: true,
        }),
      );
      const { generationId } = restoreGenerationResponseSchema.parse(
        await get('/restore-generation'),
      );
      const intake = intakeEntryRecordSchema.parse(
        await post('/nutrition/intakes', {
          intakeId: `intake-${randomUUID()}`,
          restoreGeneration: generationId,
          confirmed: true,
          occurredAt: '2026-10-07T00:00:00Z',
          timezone: 'UTC',
          foods,
          nutrientTotal: {
            energy: unknownNutrient('kcal'),
            carbohydrate: unknownNutrient('g'),
            protein: unknownNutrient('g'),
            fat: unknownNutrient('g'),
            fluid: unknownNutrient('mL'),
            sodium: unknownNutrient('mg'),
          },
          plannedItemId: null,
          relatedSessionIds: [],
          relatedActivityIds: [],
          source: 'user',
          sourceRecordId: null,
          notes: null,
        }),
      );
      assert.equal(intake.status, 'active');
      const originalPlanRead = planReadSchema.parse(await get('/plans/current'));
      const originalNutritionRead = nutritionPlanReadV4Schema.parse(
        await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
      );
      let reviewRequests = 0,
        approvalRequests = 0;
      page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const path = new URL(request.url()).pathname;
        if (path === `/bff/v1/races/${race.id}/date-change-reviews`) reviewRequests++;
        if (path.startsWith('/bff/v1/race-date-change-reviews/') && path.endsWith('/approve'))
          approvalRequests++;
      });
      await page.goto(`${origin}/races/${race.id}`);
      await page.getByRole('button', { name: '대회 날짜 변경 검토', exact: true }).click();
      await page.getByLabel('새 대회 날짜').fill('2080-01-08');
      await page.getByLabel('계획 비교 방식').selectOption('move_period');
      await page.getByLabel('현재 계획의 기간').selectOption('season');
      await page.getByLabel('기간의 새 시작 날짜').fill('2080-01-03');
      await page.getByLabel('이동 범위').selectOption('descendants_and_sessions');
      const impactReply = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/bff/v1/races/${race.id}/date-change-impact` &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: '미저장 영향 보기', exact: true }).click();
      const diagnosticReply = await impactReply;
      expect(diagnosticReply.status()).toBe(200);
      const diagnostic = raceManualPublicImpactSchema.parse(await diagnosticReply.json());
      assert.equal(diagnostic.status, 'projected');
      expect(diagnostic.approvalAllowed).toBe(false);
      expect(diagnostic.persistence).toBe('not_stored');
      expect(diagnostic.affected.map((row) => row.domain).sort()).toEqual([
        'nutrition',
        'recovery',
        'routine_schedule',
        'training',
      ]);
      assert.equal(diagnostic.nutrition.state, 'present');
      assert.equal(diagnostic.recovery.state, 'present');
      expect(diagnostic.nutrition.members[0]?.after.linkedTraining.kind).toBe(
        'follows_training_approval',
      );
      for (const timing of diagnostic.nutrition.members.flatMap((member) => member.timings)) {
        expect(timing.state).toBe('unchanged');
        expect(timing.after).toEqual(timing.before);
      }
      expect(diagnostic.recovery.members[0]?.state).toBe('affected');
      expect(diagnostic.resolutionRequirements).toEqual([
        {
          domain: 'recovery',
          aggregateId: strategy.strategyId,
          strategyVersionId: strategy.versionId,
          reason: 'recovery_confirmation_required',
          editor: 'confirm_recovery_and_review',
        },
      ]);
      const impactRegion = page.getByRole('region', { name: '미저장 전체 영향 진단' });
      await expect(impactRegion).toBeVisible();
      await expect(impactRegion).toContainText('follows_training_approval');
      await expect(impactRegion).toContainText('affected');
      await expect(impactRegion).toContainText('follows_approval');
      await expect(impactRegion).toContainText('2080-01-06');
      await expect(impactRegion).toContainText('07:30');
      await expect(
        page.getByText(/회복 화면에서 실제 선택·확인을 완료한 뒤 새 영향 진단을 요청하세요/),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: '전체 영향 검토', exact: true }),
      ).toBeDisabled();
      expect(reviewRequests).toBe(0);
      expect(approvalRequests).toBe(0);
      expect(await get(`/races/${race.id}`)).toEqual(race);
      expect(await get('/plans/current')).toEqual(originalPlanRead);
      expect(
        nutritionPlanReadV4Schema.parse(
          await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
        ),
      ).toEqual(originalNutritionRead);
      expect(await get(`/recovery/strategies/${recovery.strategyId}`)).toEqual(strategy);
      expect(await get(`/routine-schedules/${routine.schedule.id}`)).toEqual(routine);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      // This real public command is the explicit recovery choice. The date-impact
      // editor must never synthesize confirmation from a projected dependency.
      recovery = recoveryStrategyVersionSchema.parse(
        await post(`/recovery/strategies/${strategy.strategyId}/confirm`, {
          expectedHeadVersionId: strategy.versionId,
          selectedOptionId,
        }),
      );
      expect(recovery.status).toBe('user_confirmed');
      expect(recovery.selectedOptionId).toBe(selectedOptionId);
      const refreshedImpactReply = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/bff/v1/races/${race.id}/date-change-impact` &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: '미저장 영향 보기', exact: true }).click();
      const refreshedReply = await refreshedImpactReply;
      expect(refreshedReply.status()).toBe(200);
      const refreshed = raceManualPublicImpactSchema.parse(await refreshedReply.json());
      assert.equal(refreshed.status, 'projected');
      expect(refreshed.resolutionRequirements).toEqual([]);
      expect(refreshed.affected.map((row) => row.domain).sort()).toEqual(
        diagnostic.affected.map((row) => row.domain).sort(),
      );
      await expect(page.getByRole('button', { name: '전체 영향 검토', exact: true })).toBeEnabled();
      expect(reviewRequests).toBe(0);
      expect(approvalRequests).toBe(0);
      expect(await get(`/races/${race.id}`)).toEqual(race);
      expect(await get('/plans/current')).toEqual(originalPlanRead);
      expect(
        nutritionPlanReadV4Schema.parse(
          await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
        ),
      ).toEqual(originalNutritionRead);
      expect(await get(`/recovery/strategies/${recovery.strategyId}`)).toEqual(recovery);
      expect(await get(`/routine-schedules/${routine.schedule.id}`)).toEqual(routine);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      const reviewedReply = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/bff/v1/races/${race.id}/date-change-reviews` &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: '전체 영향 검토', exact: true }).click();
      const reply = await reviewedReply;
      expect(reply.status()).toBe(201);
      const reviewed = raceManualPublicReviewResultSchema.parse(await reply.json());
      assert.equal(reviewed.status, 'reviewed');
      const preview = raceManualPublicPreviewSchema.parse(
        await get(`/race-date-change-reviews/${reviewed.reference.candidateId}`),
      );
      assert.equal(preview.status, 'present');
      for (const domain of ['training', 'nutrition', 'recovery', 'routines'] as const) {
        expect(preview[domain].state, domain).toBe('present');
      }
      assert.equal(preview.nutrition.state, 'present');
      expect(preview.nutrition.members[0]?.after.plan.items[0]?.foods).toEqual(foods);
      for (const timing of preview.nutrition.members.flatMap((member) => member.timings)) {
        expect(timing.state).toBe('unchanged');
        expect(timing.after).toEqual(timing.before);
      }
      const storedRegion = page.getByRole('region', { name: '전체 계획 영향 미리보기' });
      await expect(storedRegion).toBeVisible();
      const nutritionSection = storedRegion
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '영양', exact: true }) });
      const recoverySection = storedRegion
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '회복', exact: true }) });
      await expect(nutritionSection).toContainText('승인 시 새 버전');
      await expect(nutritionSection).toContainText('영향 밖 보존');
      await expect(recoverySection).toContainText('승인 시 새 버전');
      expect(
        nutritionPlanReadV4Schema.parse(
          await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
        ),
      ).toEqual(originalNutritionRead);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      expect(await get(`/races/${race.id}`)).toEqual(race);
      expect(await get('/plans/current')).toEqual(originalPlanRead);
      expect(await get(`/recovery/strategies/${recovery.strategyId}`)).toEqual(recovery);
      expect(await get(`/routine-schedules/${routine.schedule.id}`)).toEqual(routine);
      const approveButton = page.getByRole('button', { name: '계획 변경 승인', exact: true });
      await expect(approveButton).toBeDisabled();
      for (const width of [320, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
          .toBe(true);
      }
      await page
        .getByLabel('전체 변경과 보존 항목을 확인했으며 이 계획 변경을 명시적으로 승인합니다')
        .check();
      const committedReply = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            `/bff/v1/race-date-change-reviews/${reviewed.reference.candidateId}/approve` &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      );
      await approveButton.click();
      const approvalReply = await committedReply;
      expect(approvalReply.status()).toBe(200);
      const result = raceManualApprovalResultSchema.parse(await approvalReply.json());
      assert.equal(result.status, 'committed');
      expect(result.versions.map((v) => v.domain).sort()).toEqual([
        'nutrition',
        'recovery',
        'routine_schedule',
        'training',
      ]);
      const afterPlan = planReadSchema.parse(await get('/plans/current'));
      assert.ok(afterPlan.head);
      expect(afterPlan.head.id).not.toBe(plan.id);
      expect(afterPlan.head.draft.sessions[0]?.date).toBe('2080-01-08');
      expect(afterPlan.history.length).toBe(originalPlanRead.history.length + 1);
      // Explicit max4 route is required: old max3 cannot decode V4. No fallback
      // to preview metadata as evidence of a committed head/body.
      const afterNutrition = nutritionPlanReadV4Schema.parse(
        await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
      );
      assert.ok(afterNutrition.head);
      assert.ok('schemaVersion' in afterNutrition.head);
      expect(afterNutrition.head.schemaVersion).toBe(4);
      expect(afterNutrition.head.version).toBe(nutrition.version + 1);
      expect(afterNutrition.head.linkedTrainingPlanVersionId).toBe(afterPlan.head.id);
      expect(afterNutrition.head.items[0]?.foods).toEqual(nutrition.items[0]?.foods);
      expect(afterNutrition.head.items[0]?.anchor).toEqual(nutrition.items[0]?.anchor);
      expect(afterNutrition.head.items[0]?.instructions).toEqual(nutrition.items[0]?.instructions);
      expect(afterNutrition.head.items[0]?.foods.map((portion) => portion.quantity)).toEqual([
        0,
        null,
      ]);
      expect(afterNutrition.head.items[0]?.targets).toEqual(nutrition.items[0]?.targets);
      const afterRecovery = recoveryStrategyVersionSchema.parse(
        await get(`/recovery/strategies/${recovery.strategyId}`),
      );
      expect(afterRecovery.version).toBe(recovery.version + 1);
      expect(afterRecovery.selectedOptionId).toBe(selectedOptionId);
      expect(afterRecovery.draft.planRefs).toEqual([
        {
          kind: 'nutrition',
          aggregateId: nutrition.planId,
          headVersionId: afterNutrition.head.versionId,
        },
      ]);
      expect(afterRecovery.draft.knownFacts).toEqual(recovery.draft.knownFacts);
      expect(afterRecovery.draft.options).toEqual(recovery.draft.options);
      const afterRoutine = routineScheduleReadSchema.parse(
        await get(`/routine-schedules/${routine.schedule.id}`),
      );
      expect(afterRoutine.schedule.versionId).not.toBe(routine.schedule.versionId);
      expect(afterRoutine.sourcePlanVersionId).toBe(afterPlan.head.id);
      expect(afterRoutine.occurrences.some((o) => o.anchorKey === occurrence.anchorKey)).toBe(
        false,
      );
      expect(await get(`/routine-runs/${actualRun.run.id}`)).toEqual(actualRun);
      expect(await get(`/routine-versions/${blueprint.blueprint.versionId}`)).toEqual(
        blueprint.blueprint,
      );
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      expect(await get(`/nutrition/foods/${food.foodId}`)).toEqual(food);
      expect(await get(`/races/${race.id}`)).toMatchObject({
        revision: race.revision + 1,
        localDate: '2080-01-08',
      });
      for (const version of result.versions) {
        const actualVersion =
          version.domain === 'training'
            ? afterPlan.head.id
            : version.domain === 'nutrition'
              ? afterNutrition.head.versionId
              : version.domain === 'recovery'
                ? afterRecovery.versionId
                : afterRoutine.schedule.versionId;
        expect(version.versionId).toBe(actualVersion);
      }
      const request = approvalReply.request();
      const requestHeaders = await request.allHeaders();
      const originalKey = requestHeaders['idempotency-key'];
      assert.ok(originalKey);
      const replay = await page.request.post(request.url(), {
        headers: { ...headers, 'idempotency-key': originalKey },
        data: request.postDataJSON(),
      });
      expect(replay.status()).toBe(200);
      expect(raceManualApprovalResultSchema.parse(await replay.json())).toEqual(result);
      expect(await get('/plans/current')).toEqual(afterPlan);
      expect(await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`)).toEqual(
        afterNutrition,
      );
      expect(await get(`/recovery/strategies/${recovery.strategyId}`)).toEqual(afterRecovery);
      expect(await get(`/routine-schedules/${routine.schedule.id}`)).toEqual(afterRoutine);
      expect(await get(`/routine-runs/${actualRun.run.id}`)).toEqual(actualRun);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      expect(await get(`/nutrition/foods/${food.foodId}`)).toEqual(food);
      await page.goto(`${origin}/nutrition/plans/${nutrition.planId}`);
      const approvedNutrition = page.getByRole('region', { name: '승인된 영양 계획 읽기 전용' });
      await expect(approvedNutrition).toBeVisible();
      await expect(approvedNutrition.getByRole('heading', { level: 2 })).toContainText(
        `승인 버전 ${afterNutrition.head.version}`,
      );
      await expect(approvedNutrition).toContainText('계획과 음식·수량은 실제 섭취 기록이 아닙니다');
      await expect(page.getByRole('button', { name: '계획 저장', exact: true })).toHaveCount(0);
    } finally {
      const erased = await page.request.delete(`${origin}/bff/v1/operations/account`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { confirmation: 'DELETE MY ACCOUNT' },
      });
      expect(erased.status()).toBe(200);
    }
  });
}
