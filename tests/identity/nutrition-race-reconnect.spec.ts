import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { raceCommandResultSchema } from '../../packages/contracts/src/race-commands';
import {
  nutritionPlanVersionSchema,
  intakeEntryRecordSchema,
} from '../../packages/contracts/src/nutrition-core';
import { restoreGenerationResponseSchema } from '../../packages/contracts/src/restore-generation';
import { nutritionPlanReadV4Schema } from '../../packages/contracts/src/nutrition-race-plan-v4';
import {
  nutritionPlanPublicApprovalV4ResultSchema,
  nutritionPlanPublicPreviewV4Schema,
} from '../../packages/contracts/src/nutrition-race-plan-public-v4';
import { shells } from './course-editor-support';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';

// V023 nutrition: actual public producers, OIDC, deletion and explicit approval.
// The Root runs the explicit raw staged-manual profile; no source SQL body seeds.
for (const shell of shells) {
  test(`${shell.name}: race deletion suspends nutrition until preview and separate reconnect approval`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const context = await browser.newContext({
      baseURL: shell.origin,
      viewport: { width: 320, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto('/account');
    await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
    await page.getByRole('link', { name: 'Sign in as Alice' }).click();
    await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    await grantAppProcessingForScenario(page);
    const session: unknown = await (await page.request.get('/bff/v1/session')).json();
    assert.ok(session && typeof session === 'object');
    assert.ok('sessionId' in session && typeof session.sessionId === 'string');
    assert.ok('csrfToken' in session && typeof session.csrfToken === 'string');
    const headers = {
      origin: shell.origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    };
    const post = async (path: string, data: unknown, key = randomUUID()) => {
      const reply = await page.request.post(`/bff/v1${path}`, {
        headers: { ...headers, 'idempotency-key': key },
        data,
      });
      expect(reply.ok(), `${path}: ${reply.status()}`).toBe(true);
      const body: unknown = await reply.json();
      return body;
    };
    const get = async (path: string) => {
      const reply = await page.request.get(`/bff/v1${path}`, { headers });
      expect(reply.status(), path).toBe(200);
      const body: unknown = await reply.json();
      return body;
    };
    try {
      const values = {
        title: `합성 재연결 대회 ${shell.name}`,
        localDate: '2080-01-06',
        localStartTime: '09:00',
        timezone: 'UTC',
        locationName: null,
        distance: { kind: 'standard', class: '10k' },
        priority: null,
        participation: 'registered',
        officialUrl: null,
        course: null,
        targetSeconds: null,
        planVersionId: null,
      };
      const oldRace = raceCommandResultSchema.parse(await post('/races', { values }));
      const foods = [
        {
          foodVersionId: null,
          description: '보존 음식',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'manual_total',
        },
        {
          foodVersionId: null,
          description: '미상 수량',
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ];
      const draft = {
        period: { from: '2080-01-01', toInclusive: '2080-01-31' },
        timezone: 'UTC',
        purpose: '합성 재연결 수용',
        linkedTrainingPlanVersionId: null,
        items: [
          {
            id: '식사-' + '한'.repeat(1001),
            category: 'before',
            title: '합성 식사',
            anchor: { kind: 'absolute', date: '2080-01-06', localTime: '08:30', timezone: 'UTC' },
            foods,
            targets: [],
            instructions: '입력한 양을 보존',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      };
      const original = nutritionPlanVersionSchema.parse(
        await post('/nutrition/plans', {
          kind: 'create',
          confirmed: true,
          draft,
        }),
      );
      const { generationId } = restoreGenerationResponseSchema.parse(
        await get('/restore-generation'),
      );
      const unknown = (unit: string) => ({ value: null, unit, status: 'unknown', evidenceIds: [] });
      const intake = intakeEntryRecordSchema.parse(
        await post('/nutrition/intakes', {
          intakeId: `intake-${randomUUID()}`,
          restoreGeneration: generationId,
          confirmed: true,
          occurredAt: '2026-10-07T00:00:00Z',
          timezone: 'UTC',
          foods,
          nutrientTotal: {
            energy: unknown('kcal'),
            carbohydrate: unknown('g'),
            protein: unknown('g'),
            fat: unknown('g'),
            fluid: unknown('mL'),
            sodium: unknown('mg'),
          },
          plannedItemId: null,
          relatedSessionIds: [],
          relatedActivityIds: [],
          source: 'user',
          sourceRecordId: null,
          notes: null,
        }),
      );
      const relativeDraft = {
        ...draft,
        items: draft.items.map((item) => ({
          ...item,
          anchor: {
            kind: 'relative',
            entity: 'race',
            entityId: oldRace.id,
            point: 'start',
            offsetMinutes: -30,
          },
        })),
      };
      const initial = nutritionPlanPublicApprovalV4ResultSchema.parse(
        await post(`/nutrition/plans/${original.planId}/approve-v4`, {
          schemaVersion: 4,
          intent: {
            schemaVersion: 3,
            command: {
              kind: 'update',
              expectedHeadVersionId: original.versionId,
              confirmed: true,
              draft: relativeDraft,
            },
            expectedRaceHeads: [
              { namespace: 'race-event', eventId: oldRace.id, revision: oldRace.revision },
            ],
            reconnectItemIds: [],
          },
        }),
      );
      const removed = await page.request.delete(`/bff/v1/races/${oldRace.id}`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { expectedRevision: oldRace.revision },
      });
      expect(removed.status()).toBe(200);
      const planPath = `/nutrition/plans/${original.planId}?maxSchemaVersion=4`;
      const disconnected = nutritionPlanReadV4Schema.parse(await get(planPath));
      assert.ok(disconnected.head);
      expect(disconnected.head.items[0]?.anchor.kind).toBe('disconnected');
      expect(disconnected.head.items[0]?.foods).toEqual(foods);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      const newRace = raceCommandResultSchema.parse(
        await post('/races', {
          values: { ...values, title: `새 합성 대회 ${shell.name}`, localDate: '2080-01-08' },
        }),
      );
      expect(await get(planPath)).toEqual(disconnected);
      await page.goto(`/nutrition/plans/${original.planId}`);
      const editor = page.getByRole('region', { name: '대회 연결 해제 항목 재연결' });
      await editor.getByRole('button', { name: '연결 해제 항목 재연결 열기' }).click();
      await editor.getByLabel('이 항목을 명시적으로 재연결').check();
      await editor.getByLabel('재연결할 본인 대회').selectOption(newRace.id);
      await editor.getByRole('button', { name: '선택 대회 현재 버전 확인' }).click();
      await expect(editor.getByText(/확인한 대회 새 합성 대회/)).toBeVisible();
      await editor.getByLabel('전후 분 (이전은 음수)').fill('-30');
      const previewResponse = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/preview-v4'),
      );
      await editor.getByRole('button', { name: '재연결 영향 미저장 검토' }).click();
      const response = await previewResponse;
      expect(response.status()).toBe(200);
      const preview = nutritionPlanPublicPreviewV4Schema.parse(await response.json());
      expect(preview.status).toBe('projected');
      expect(preview.persistence).toBe('not_stored');
      expect(preview.approvalAllowed).toBe(false);
      expect(await get(planPath)).toEqual(disconnected);
      await expect(
        editor.getByRole('button', { name: '재연결 영양 계획 명시 재승인' }),
      ).toBeDisabled();
      await editor.getByLabel(/미저장 비교와 재연결 항목을 확인했고/).check();
      const committedResponse = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/approve-v4'),
      );
      await editor.getByRole('button', { name: '재연결 영양 계획 명시 재승인' }).click();
      const committed = await committedResponse;
      expect(committed.status()).toBe(200);
      const saved = nutritionPlanPublicApprovalV4ResultSchema.parse(await committed.json());
      expect(saved.plan.version).toBe(disconnected.head.version + 1);
      expect(saved.plan.items[0]?.foods).toEqual(foods);
      expect(saved.plan.items[0]?.anchor).toMatchObject({
        kind: 'relative',
        entity: 'race',
        entityId: newRace.id,
      });
      expect(saved.plan.previousVersionId).toBe(disconnected.head.versionId);
      expect(saved.plan.versionId).not.toBe(initial.plan.versionId);
      const request = committed.request();
      const replay = await page.request.post(request.url(), {
        headers: { ...headers, 'idempotency-key': request.headers()['idempotency-key'] ?? '' },
        data: request.postDataJSON(),
      });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual(saved);
      expect(await get(`/nutrition/intakes/${intake.intakeId}`)).toEqual(intake);
      await page.reload();
      await expect(page.getByText('보존 음식', { exact: false }).first()).toBeVisible();
      expect(await get(planPath)).toMatchObject({ head: saved.plan });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    } finally {
      const erased = await page.request.delete('/bff/v1/operations/account', {
        headers,
        data: { confirmation: 'DELETE MY ACCOUNT' },
      });
      expect(erased.status()).toBe(200);
      await context.close();
    }
  });
}
