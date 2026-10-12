import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  parseAccountExportV38,
  parseAccountExportV40,
} from '../../packages/contracts/src/operations';
import { planReadSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
import { raceCommandResultSchema } from '../../packages/contracts/src/race-commands';
import { raceEventSchema } from '../../packages/contracts/src/races';
import { nutritionPlanVersionSchema } from '../../packages/contracts/src/nutrition-core';
import { nutritionPlanReadV4Schema } from '../../packages/contracts/src/nutrition-race-plan-v4';
import {
  createRecoveryStrategyRequestSchema,
  confirmRecoveryStrategyRequestSchema,
  recoveryStrategyVersionSchema,
} from '../../packages/contracts/src/recovery-core';
import {
  routineBlueprintReadSchema,
  routineSchedulePreviewSchema,
  routineScheduleReadSchema,
} from '../../packages/contracts/src/routine-commands';
import { raceManualPublicReviewResultSchema } from '../../packages/contracts/src/race-manual-public';
import { raceManualPublicPreviewSchema } from '../../packages/contracts/src/race-manual-public-preview';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';

// Test selection only, never a production support/admission claim. Baseline34,
// Old installed17 and unknown modes do not count as this named V38 HTTP acceptance.
// Profile27 injects the pooled V40 repository: the same retained V38 facts plus the
// gallery members (renditions are derived and never exported, U1).
const selectedProfile = process.env['IDENTITY_E2E_RACE_MANUAL_PUBLIC'] ?? '';
const exportsV40 = selectedProfile === 'installed-current-profile27';
test.skip(
  ![
    'installed-current-profile22',
    'installed-current-profile23',
    'installed-current-profile27',
  ].includes(selectedProfile),
  'Requires an explicit installed profile22, profile23 or profile27 harness with its actual V38/V40 repository; older/default modes are not this acceptance.',
);
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
  assert.ok('athleteId' in session && typeof session.athleteId === 'string');
  return {
    athleteId: session.athleteId,
    headers: {
      origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    },
  };
}
for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: installed named profile HTTP V38 retains exact unapproved public/internal/source facts after app withdrawal`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    page.setDefaultTimeout(10000);
    const { headers, athleteId } = await login(page, origin);
    const get = async (path: string) => {
      const reply = await page.request.get(`${origin}/bff/v1${path}`, { headers });
      expect(reply.status(), path).toBe(200);
      const body: unknown = await reply.json();
      return body;
    };
    const post = async (path: string, data: unknown, key = randomUUID()) => {
      const body =
        path === '/recovery/strategy-drafts'
          ? createRecoveryStrategyRequestSchema.omit({ idempotencyKey: true }).parse(data)
          : /^\/recovery\/strategies\/[^/]+\/confirm$/.test(path)
            ? confirmRecoveryStrategyRequestSchema
                .omit({ strategyId: true, idempotencyKey: true })
                .parse(data)
            : data;
      const reply = await page.request.post(`${origin}/bff/v1${path}`, {
        headers: { ...headers, 'idempotency-key': key },
        data: body,
      });
      expect(reply.ok(), `${path} HTTP ${reply.status()}`).toBe(true);
      if (path.endsWith('/date-change-reviews')) expect(reply.status()).toBe(201);
      const responseBody: unknown = await reply.json();
      return responseBody;
    };
    const exportAccount = async () => {
      // No body and no max-version caller flag: actual injected repository owns V38/V40.
      const reply = await page.request.post(`${origin}/bff/v1/operations/export`, { headers });
      expect(reply.status()).toBe(200);
      expect(reply.headers()['content-disposition']).toContain('workout-account.json');
      const raw: unknown = await reply.json();
      const result = exportsV40 ? parseAccountExportV40(raw) : parseAccountExportV38(raw);
      expect(result.schemaVersion).toBe(exportsV40 ? 40 : 38);
      expect(result.athleteId).toBe(athleteId);
      expect(result.data.sourceProvenanceCoverage).toBe('saved_safe_dependency_facts');
      expect(result.data.sourceAuthentication).toBe('not_authenticated');
      expect(result.data.originalEventAuthentication).toBe('not_authenticated');
      const encoded = JSON.stringify(raw);
      expect(encoded).not.toContain(headers['x-csrf-token']);
      expect(encoded).not.toContain(headers['x-workout-session-id']);
      expect(encoded).not.toContain('token_hash');
      expect(encoded).not.toContain('storage_ref');
      expect(encoded).not.toMatch(/rendition/i);
      return result;
    };
    try {
      const baseline = planReadSchema.parse(await get('/plans/current'));
      const saved = await page.request.put(`${origin}/bff/v1/plans/current`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          source: 'manual',
          confirmed: true,
          expectedVersionId: baseline.head?.id ?? null,
          draft: {
            title: `Synthetic export38 ${host}`,
            timezone: 'UTC',
            periods: ['season', 'wave', 'phase', 'block'].map((id, index, ids) => ({
              id,
              parentId: index === 0 ? null : ids[index - 1],
              level: id,
              title: id,
              startDate: '2026-01-01',
              endDateExclusive: '2026-02-01',
              timezone: 'UTC',
              intent: '',
              isPartial: false,
            })),
            sessions: [
              {
                id: 'session',
                blockId: 'block',
                date: '2026-01-06',
                localStartTime: '08:00',
                title: 'Synthetic planned session',
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
      expect(saved.status()).toBe(200);
      const plan = planSnapshotSchema.parse(await saved.json());
      const createdRace = raceCommandResultSchema.parse(
        await post('/races', {
          values: {
            title: `Synthetic export38 race ${host}`,
            localDate: '2026-01-06',
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
        }),
      );
      const race = raceEventSchema.parse(await get(`/races/${createdRace.id}`));
      const foods = [
        {
          foodVersionId: null,
          description: '합성 0 양',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'unknown',
        },
        {
          foodVersionId: null,
          description: '합성 미상 양',
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
            period: { from: '2026-01-01', toInclusive: '2026-01-31' },
            timezone: 'UTC',
            purpose: '합성 보존 계획',
            linkedTrainingPlanVersionId: plan.id,
            items: [
              {
                id: 'meal',
                category: 'meal',
                title: 'Synthetic planned meal',
                anchor: { kind: 'absolute', date: '2026-01-06', localTime: null, timezone: 'UTC' },
                foods,
                targets: [],
                instructions: '사용자 계획이며 실제 섭취가 아닙니다',
                evidenceIds: [],
                source: 'user_confirmed',
              },
            ],
          },
        }),
      );
      const optionId = randomUUID();
      const draftRecovery = recoveryStrategyVersionSchema.parse(
        await post('/recovery/strategy-drafts', {
          draft: {
            title: 'Synthetic retained rest',
            goal: 'User plan only',
            startDate: '2026-01-01',
            endDateExclusive: '2026-02-01',
            timezone: 'UTC',
            knownFacts: [],
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
                id: optionId,
                title: 'Rest',
                kind: 'full_rest',
                methodVersionId: null,
                explanation: 'Synthetic option',
              },
            ],
            reassessment: [
              {
                id: randomUUID(),
                trigger: 'plan_changed',
                description: '계획이 바뀌면 직접 재평가합니다',
                plannedAt: null,
                policyVersion: null,
              },
            ],
          },
        }),
      );
      const recovery = recoveryStrategyVersionSchema.parse(
        await post(`/recovery/strategies/${draftRecovery.strategyId}/confirm`, {
          expectedHeadVersionId: draftRecovery.versionId,
          selectedOptionId: optionId,
        }),
      );
      const blueprint = routineBlueprintReadSchema.parse(
        await post('/routines', {
          confirmed: true,
          expectedVersionId: null,
          blueprint: {
            schemaVersion: 4,
            routineId: randomUUID(),
            versionId: randomUUID(),
            title: 'Synthetic retained checklist',
            intent: 'Plan is not performance',
            status: 'published',
            tags: [],
            estimatedDurationSeconds: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            steps: [
              {
                id: 'step',
                title: 'Synthetic checklist',
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
            startDate: '2026-01-01',
            endDateExclusive: '2026-02-01',
            timezone: 'UTC',
            maxOccurrences: 10,
          },
          rule: { kind: 'dates', dates: ['2026-01-06'], localTime: '08:00' },
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
      const originalPlan = planReadSchema.parse(await get('/plans/current'));
      const originalNutrition = nutritionPlanReadV4Schema.parse(
        await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`),
      );
      const before = await exportAccount();
      expect(before.data.manualSourceChains).toEqual([]);
      expect(before.data.manualInternalChains).toEqual([]);
      expect(before.data.manualRaceReviews).toEqual([]);
      const reviewKey = randomUUID();
      const command = {
        schemaVersion: 1,
        intent: {
          expectedEvent: { id: race.id, revision: race.revision },
          newLocalDate: '2026-01-07',
          selection: { kind: 'keep_plan' },
          resolutions: { nutrition: [], routines: [] },
        },
      };
      const reviewed = raceManualPublicReviewResultSchema.parse(
        await post(`/races/${race.id}/date-change-reviews`, command, reviewKey),
      );
      assert.equal(reviewed.status, 'reviewed');
      if (reviewed.status !== 'reviewed') throw new Error('EXPECTED_REAL_REVIEW');
      expect(reviewed.bodyState).toBe('present');
      const publicPreview = raceManualPublicPreviewSchema.parse(
        await get(`/race-date-change-reviews/${reviewed.reference.candidateId}`),
      );
      assert.equal(publicPreview.status, 'present');
      const artifact = await exportAccount();
      expect(artifact.data.planSnapshots).toEqual(before.data.planSnapshots);
      expect(artifact.data.nutritionPlanVersions).toEqual(before.data.nutritionPlanVersions);
      expect(artifact.data.recoveryStrategyVersions).toEqual(before.data.recoveryStrategyVersions);
      expect(artifact.data.genericRoutineScheduleVersions).toEqual(
        before.data.genericRoutineScheduleVersions,
      );
      expect(artifact.data.manualInternalApprovalResults).toEqual([]);
      expect(artifact.data.manualInternalApprovalHistory).toEqual([]);
      expect(artifact.data.manualRaceApprovalHistory).toEqual([]);
      expect(artifact.data.manualInternalChains).toHaveLength(1);
      expect(artifact.data.manualInternalCandidates).toHaveLength(1);
      expect(artifact.data.manualSourceChains).toHaveLength(1);
      expect(artifact.data.manualRaceReviews).toEqual([
        {
          reference: reviewed.reference,
          createdAt: reviewed.reference.createdAt,
          bodyState: 'present',
          preview: publicPreview,
        },
      ]);
      expect(artifact.data.manualRaceCommandResults).toEqual([
        { operation: 'review', candidateId: reviewed.reference.candidateId, result: reviewed },
      ]);
      const chain = artifact.data.manualInternalChains[0],
        source = artifact.data.manualSourceChains[0],
        candidate = artifact.data.manualInternalCandidates[0];
      assert.ok(chain && source && candidate);
      expect(chain).toMatchObject({
        evidenceId: reviewed.reference.chain.evidenceId,
        decisionId: reviewed.reference.chain.decisionId,
        proposalId: reviewed.reference.chain.proposalId,
        proposalApplied: false,
        body: { state: 'present' },
      });
      expect(candidate).toMatchObject({
        candidateId: reviewed.reference.candidateId,
        chain: {
          evidenceId: reviewed.reference.chain.evidenceId,
          decisionId: reviewed.reference.chain.decisionId,
          proposalId: reviewed.reference.chain.proposalId,
        },
        body: { state: 'present', storedApplicationState: 'ready_for_explicit_approval' },
      });
      const refs = artifact.data.manualSavedSourceRefs.filter(
        (ref) => ref.evidenceId === source.evidenceId,
      );
      expect(refs.map((ref) => ref.ordinal)).toEqual(
        Array.from({ length: source.savedRefCount }, (_, index) => index + 1),
      );
      expect(
        artifact.data.manualSavedSourceParents.filter(
          (parent) => parent.evidenceId === source.evidenceId,
        ),
      ).toHaveLength(source.savedParentCount);
      expect(source.savedSuppressionCount).toBe(0);
      expect(
        refs.some(
          (ref) => ref.identity.kind === 'nutrition-plan-version' && ref.location.state === 'known',
        ),
      ).toBe(true);
      expect(refs.some((ref) => ref.identity.kind === 'routine-blueprint-version')).toBe(true);
      expect(await get('/plans/current')).toEqual(originalPlan);
      expect(await get(`/nutrition/plans/${nutrition.planId}?maxSchemaVersion=4`)).toEqual(
        originalNutrition,
      );
      expect(await get(`/recovery/strategies/${recovery.strategyId}`)).toEqual(recovery);
      expect(await get(`/routine-schedules/${routine.schedule.id}`)).toEqual(routine);
      expect(await get(`/races/${race.id}`)).toEqual(race);
      const consent: unknown = await get('/consents/app');
      assert.ok(
        typeof consent === 'object' &&
          consent !== null &&
          'revision' in consent &&
          typeof consent.revision === 'number',
      );
      const withdrawn = await page.request.put(`${origin}/bff/v1/consents/app`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { granted: false, expectedRevision: consent.revision },
      });
      expect(withdrawn.status()).toBe(200);
      const retained = await exportAccount();
      expect(retained.data.manualInternalChains).toEqual(artifact.data.manualInternalChains);
      expect(retained.data.manualInternalCandidates).toEqual(
        artifact.data.manualInternalCandidates,
      );
      expect(retained.data.manualSourceChains).toEqual(artifact.data.manualSourceChains);
      expect(retained.data.manualSavedSourceRefs).toEqual(artifact.data.manualSavedSourceRefs);
      expect(retained.data.manualRaceCommandResults).toEqual(
        artifact.data.manualRaceCommandResults,
      );
      expect(await post(`/races/${race.id}/date-change-reviews`, command, reviewKey)).toEqual(
        reviewed,
      );
      const denied = await page.request.post(
        `${origin}/bff/v1/races/${race.id}/date-change-reviews`,
        { headers: { ...headers, 'idempotency-key': randomUUID() }, data: command },
      );
      expect(denied.status()).toBe(409);
      const deniedBody: unknown = await denied.json();
      expect(deniedBody).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
      const final = await exportAccount();
      expect(final.data.manualInternalChains).toEqual(retained.data.manualInternalChains);
      expect(final.data.planSnapshots).toEqual(before.data.planSnapshots);
      expect(final.data.nutritionPlanVersions).toEqual(before.data.nutritionPlanVersions);
    } finally {
      const erased = await page.request.delete(`${origin}/bff/v1/operations/account`, {
        headers,
        data: { confirmation: 'DELETE MY ACCOUNT' },
        timeout: 10000,
      });
      expect(erased.status()).toBe(200);
    }
  });
}
