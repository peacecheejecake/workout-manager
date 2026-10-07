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
import {
  routineBlueprintReadSchema,
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

// Actual public producer/OIDC/UI acceptance preparation. Root alone runs the
// staged-manual harness. No SQL owner body seeds, request interception or skips.
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
  for (const mode of ['nutrition', 'routine'] as const) {
    test(`${host}: resolves affected ${mode} timing through transient diagnosis before explicit approval`, async ({
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
        const mealId = '식사-' + 'x'.repeat(201);
        const current = planReadSchema.parse(await get('/plans/current'));
        const planReply = await page.request.put(`${origin}/bff/v1/plans/current`, {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: {
            source: 'manual',
            confirmed: true,
            expectedVersionId: current.head?.id ?? null,
            draft: {
              title: `Synthetic four-domain ${host}`,
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
                  localStartTime: mode === 'nutrition' ? null : '08:00',
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
              title: `Synthetic all-domain race ${host}`,
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
                  id: mealId,
                  category: 'before',
                  title: 'Synthetic frozen meal',
                  anchor: {
                    kind: 'relative',
                    entity: 'session',
                    entityId: 'session',
                    point: 'start',
                    offsetMinutes: -30,
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
        let routine: ReturnType<typeof routineScheduleReadSchema.parse> | null = null;
        if (mode === 'routine') {
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
                localTime: null,
              },
              state: 'draft',
            },
            sourcePlanVersionId: plan.id,
          };
          const schedulePreview = routineSchedulePreviewSchema.parse(
            await post('/routine-schedule-previews', scheduleInput),
          );
          routine = routineScheduleReadSchema.parse(
            await post('/routine-schedules', {
              ...scheduleInput,
              previewDigest: schedulePreview.previewDigest,
              confirmed: true,
            }),
          );

          expect(routine.occurrences.length).toBeGreaterThan(0);
          expect(
            routine.occurrences.every(
              (o) => o.timingStatus === 'unresolved' && o.scheduledAt === null,
            ),
          ).toBe(true);
        }
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

        // No started historical run is introduced: that separate unresolved
        // preservation policy is not covered by this unstarted dates-editor case.
        const originalPlan = planReadSchema.parse(await get('/plans/current'));
        const originalNutrition = nutritionPlanReadV4Schema.parse(
          await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
        );
        await page.goto(`${origin}/races/${race.id}`);
        await page.getByRole('button', { name: '대회 날짜 변경 검토', exact: true }).click();
        await page.getByLabel('새 대회 날짜').fill('2080-01-08');
        await page.getByLabel('계획 비교 방식').selectOption('move_period');
        await page.getByLabel('현재 계획의 기간').selectOption('season');
        await page.getByLabel('기간의 새 시작 날짜').fill('2080-01-03');
        await page.getByLabel('이동 범위').selectOption('descendants_and_sessions');
        const awaitImpact = () =>
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === `/bff/v1/races/${race.id}/date-change-impact` &&
              r.request().method() === 'POST',
          );
        const firstPromise = awaitImpact();
        await page.getByRole('button', { name: '미저장 영향 보기', exact: true }).click();
        const firstResponse = await firstPromise;
        expect(firstResponse.status()).toBe(200);
        const first = raceManualPublicImpactSchema.parse(await firstResponse.json());
        assert.equal(first.status, 'projected');
        expect(first.approvalAllowed).toBe(false);
        expect(first.persistence).toBe('not_stored');
        expect(first.freshness).toBe('not_checked');
        expect(first.resolutionRequirements).toHaveLength(1);
        if (mode === 'nutrition') {
          expect(first.resolutionRequirements).toEqual([
            {
              domain: 'nutrition',
              aggregateId: nutrition.planId,
              planVersionId: nutrition.versionId,
              itemId: mealId,
              reason: 'affected_timing_unresolved',
              editor: 'replace_anchor',
            },
          ]);
        } else {
          assert.ok(routine);
          expect(first.resolutionRequirements).toEqual([
            {
              domain: 'routine_schedule',
              aggregateId: routine.schedule.id,
              scheduleVersionId: routine.schedule.versionId,
              reason: 'affected_timing_unresolved',
              editor: 'replace_rule',
            },
          ]);
        }
        const review = page.getByRole('button', { name: '전체 영향 검토', exact: true });
        await expect(review).toBeDisabled();
        expect(await get('/plans/current')).toEqual(originalPlan);
        expect(await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`)).toEqual(
          originalNutrition,
        );
        expect(await get(`/races/${race.id}`)).toEqual(race);
        expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
        const title =
          mode === 'nutrition' ? `영양 ${mealId}` : `루틴 ${routine?.schedule.versionId}`;
        await page.getByLabel(`${title} 날짜`, { exact: true }).fill('2080-01-08');
        await page.getByLabel(`${title} 시각`, { exact: true }).fill('08:30');
        await page.getByLabel(`${title} 시간대`, { exact: true }).fill('UTC');
        if (mode === 'routine') {
          await page.getByLabel(`${title} 종료 날짜(미포함)`, { exact: true }).fill('2080-01-10');
          await page.getByLabel(`${title} 최대 발생 수`, { exact: true }).fill('2');
        }
        await expect(review).toBeDisabled();
        const secondPromise = awaitImpact();
        await page.getByRole('button', { name: '해결 입력으로 다시 진단', exact: true }).click();
        const secondResponse = await secondPromise;
        expect(secondResponse.status()).toBe(200);
        const second = raceManualPublicImpactSchema.parse(await secondResponse.json());
        assert.equal(second.status, 'projected');
        expect(second.resolutionRequirements).toEqual([]);
        expect(second.approvalAllowed).toBe(false);
        if (mode === 'nutrition') {
          assert.equal(second.nutrition.state, 'present');
          const m = second.nutrition.members.find((m) => m.aggregateId === nutrition.planId);
          assert.ok(m);
          expect(m.after.plan.items.find((i) => i.id === mealId)?.anchor).toEqual({
            kind: 'absolute',
            date: '2080-01-08',
            localTime: '08:30',
            timezone: 'UTC',
          });
          expect(m.after.plan.items.find((i) => i.id === mealId)?.foods).toEqual(foods);
          expect(m.timings.find((t) => t.itemId === mealId)).toMatchObject({
            resolution: 'explicit_replacement',
            requirement: 'none',
            after: { state: 'resolved', date: '2080-01-08', localTime: '08:30', timezone: 'UTC' },
          });
        } else {
          assert.equal(second.routines.state, 'present');
          assert.ok(routine);
          const m = second.routines.members.find((m) => m.aggregateId === routine.schedule.id);
          assert.ok(m);
          expect(m.after.schedule.rule).toEqual({
            kind: 'dates',
            dates: ['2080-01-08'],
            localTime: '08:30',
          });
          expect(m.after.schedule.window).toEqual({
            startDate: '2080-01-08',
            endDateExclusive: '2080-01-10',
            timezone: 'UTC',
            maxOccurrences: 2,
          });
          expect(m.requirement).toBe('none');
          expect(m.after.expansion.state).toBe('expanded');
        }
        expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
        await expect(review).toBeEnabled();
        const reviewedPromise = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/bff/v1/races/${race.id}/date-change-reviews` &&
            r.request().method() === 'POST',
        );
        await review.click();
        const reviewedResponse = await reviewedPromise;
        expect(reviewedResponse.status()).toBe(201);
        const reviewed = raceManualPublicReviewResultSchema.parse(await reviewedResponse.json());
        assert.equal(reviewed.status, 'reviewed');
        const preview = raceManualPublicPreviewSchema.parse(
          await get(`/race-date-change-reviews/${reviewed.reference.candidateId}`),
        );
        assert.equal(preview.status, 'present');
        const approve = page.getByRole('button', { name: '계획 변경 승인', exact: true });
        await expect(approve).toBeDisabled();
        await page
          .getByLabel('전체 변경과 보존 항목을 확인했으며 이 계획 변경을 명시적으로 승인합니다')
          .check();
        const commitPromise = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
              `/bff/v1/race-date-change-reviews/${reviewed.reference.candidateId}/approve` &&
            r.request().method() === 'POST',
        );
        await approve.click();
        const committedResponse = await commitPromise;
        expect(committedResponse.status()).toBe(200);
        const committed = raceManualApprovalResultSchema.parse(await committedResponse.json());
        assert.equal(committed.status, 'committed');
        const afterNutrition = nutritionPlanReadV4Schema.parse(
          await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
        );
        assert.ok(afterNutrition.head);
        expect(afterNutrition.head.version).toBe(nutrition.version + 1);
        expect(afterNutrition.history.length).toBe(originalNutrition.history.length + 1);
        for (const frozen of originalNutrition.history) {
          expect(afterNutrition.history.find((row) => row.versionId === frozen.versionId)).toEqual(
            frozen,
          );
        }
        expect(
          afterNutrition.history.find((row) => row.versionId === nutrition.versionId),
        ).toMatchObject({ versionId: nutrition.versionId, version: nutrition.version });
        const actualItem = afterNutrition.head.items.find((i) => i.id === mealId);
        assert.ok(actualItem);
        expect(actualItem.foods).toEqual(foods);
        expect(actualItem.targets).toEqual(nutrition.items[0]?.targets);
        if (mode === 'nutrition')
          expect(actualItem.anchor).toEqual({
            kind: 'absolute',
            date: '2080-01-08',
            localTime: '08:30',
            timezone: 'UTC',
          });
        else {
          assert.ok(routine);
          const afterRoutine = routineScheduleReadSchema.parse(
            await get(`/routine-schedules/${routine.schedule.id}`),
          );
          expect(afterRoutine.schedule.versionId).not.toBe(routine.schedule.versionId);
          expect(afterRoutine.schedule.rule).toEqual({
            kind: 'dates',
            dates: ['2080-01-08'],
            localTime: '08:30',
          });
          expect(afterRoutine.occurrences.length).toBe(1);
          expect(afterRoutine.occurrences[0]?.timingStatus).toBe('resolved');
        }
        expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
        expect(await get(`/nutrition/foods/${food.foodId}`)).toEqual(food);
        const request = committedResponse.request(),
          key = (await request.allHeaders())['idempotency-key'];
        assert.ok(key);
        const replay = await page.request.post(request.url(), {
          headers: { ...headers, 'idempotency-key': key },
          data: request.postDataJSON(),
        });
        expect(replay.status()).toBe(200);
        expect(raceManualApprovalResultSchema.parse(await replay.json())).toEqual(committed);
        expect(await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`)).toEqual(
          afterNutrition,
        );
        expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      } finally {
        const erased = await page.request.delete(`${origin}/bff/v1/operations/account`, {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { confirmation: 'DELETE MY ACCOUNT' },
        });
        expect(erased.status()).toBe(200);
      }
    });
  }
}
