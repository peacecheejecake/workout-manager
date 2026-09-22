import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activeIntakeEntrySchema,
  deletedIntakeEntrySchema,
  nutritionPlanDraftSchema,
  nutritionPlanVersionSchema,
} from '../../packages/contracts/src/nutrition-core';
import { parseCurrentAccountExport } from './account-export';
import { manualActivityResultSchema } from '../../packages/contracts/src/activity';

type Headers = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const cleanup = new WeakMap<Page, Headers>();
const unknown = <U extends string>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
const nutrients = () => ({
  energy: unknown('kcal'),
  carbohydrate: unknown('g'),
  protein: unknown('g'),
  fat: unknown('g'),
  fluid: unknown('mL'),
  sodium: unknown('mg'),
});

async function login(page: Page): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const session = await page.request.get('/bff/v1/session');
  expect(session.status()).toBe(200);
  const body = (await session.json()) as {
    sessionId: string;
    csrfToken: string;
  };
  const headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': body.sessionId,
    'x-csrf-token': body.csrfToken,
  };
  cleanup.set(page, headers);
  return headers;
}

test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (!headers) return;
  cleanup.delete(page);
  const erased = await page.request.delete('http://127.0.0.1:3100/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

test('a confirmed nutrition plan stays separate from one revisable intake across both shells', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const headers = await login(page);
  const occurredAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const { day, timezone } = await page.evaluate((instant) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return {
      timezone,
      day: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(new Date(instant)),
    };
  }, occurredAt);
  const post = async (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  const draft = nutritionPlanDraftSchema.parse({
    period: { from: day, toInclusive: day },
    timezone,
    purpose: 'Synthetic nutrition acceptance',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'breakfast',
        category: 'meal',
        title: 'Synthetic breakfast plan',
        anchor: { kind: 'absolute', date: day, localTime: null, timezone },
        foods: [],
        targets: [],
        instructions: 'User confirmed meal note',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  const planResponse = await post('/bff/v1/nutrition/plans', {
    kind: 'create',
    confirmed: true,
    draft,
  });
  expect(planResponse.status()).toBe(200);
  const plan = nutritionPlanVersionSchema.parse(await planResponse.json());
  expect(plan.version).toBe(1);
  const linkedActivities = [];
  for (const index of [1, 2]) {
    const response = await post('/bff/v1/activities', {
      confirmed: true,
      activity: {
        title: `Synthetic nutrition link ${index}`,
        kind: 'running',
        startedAt: occurredAt,
        timezone,
        distanceMeters: 1000,
        durationSeconds: 300,
        durationKind: 'timer',
      },
      report: { sessionRpe: null, note: null, planLink: null },
    });
    expect(response.status()).toBe(200);
    linkedActivities.push(manualActivityResultSchema.parse(await response.json()).activityId);
  }
  const id = randomUUID();
  const body = {
    intakeId: id,
    confirmed: true,
    occurredAt,
    timezone,
    foods: [
      {
        foodVersionId: null,
        description: 'Synthetic snack with unknown nutrients',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    nutrientTotal: nutrients(),
    plannedItemId: 'breakfast',
    relatedSessionIds: [],
    relatedActivityIds: linkedActivities,
    source: 'user',
    sourceRecordId: null,
    notes: null,
  };
  const key = randomUUID();
  const created = await post('/bff/v1/nutrition/intakes', body, key);
  expect(created.status()).toBe(200);
  expect(activeIntakeEntrySchema.parse(await created.json()).nutrientValueCoverage).toBe('unknown');
  const replay = await post('/bff/v1/nutrition/intakes', body, key);
  expect(replay.status()).toBe(200);
  expect((await replay.json()).revisionId).toBe((await created.json()).revisionId);
  const list = await page.request.get(
    `/bff/v1/nutrition/intakes?${new URLSearchParams({
      from: new Date(Date.parse(occurredAt) - 86_400_000).toISOString(),
      toExclusive: new Date(Date.parse(occurredAt) + 86_400_000).toISOString(),
    })}`,
    { headers },
  );
  expect(list.status()).toBe(200);
  const listed = (await list.json()) as { entries: { intakeId: string }[] };
  expect(listed.entries.filter((entry) => entry.intakeId === id)).toHaveLength(1);

  await page.goto(`/nutrition?date=${day}`);
  await expect(page.getByRole('region', { name: '영양 작업 공간' })).toContainText(
    'Synthetic breakfast plan',
  );
  await expect(page.getByRole('region', { name: '영양 작업 공간' })).toContainText(
    'Synthetic snack with unknown nutrients',
  );
  await expect(page.getByRole('region', { name: '영양 작업 공간' })).toContainText('영양값 미상');

  const corrected = await page.request.patch(`/bff/v1/nutrition/intakes/${id}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      expectedRevision: 1,
      ...Object.fromEntries(Object.entries(body).filter(([field]) => field !== 'intakeId')),
      nutrientTotal: {
        ...nutrients(),
        energy: { value: 0, unit: 'kcal', status: 'reported', evidenceIds: [] },
      },
    },
  });
  expect(corrected.status()).toBe(200);
  expect(activeIntakeEntrySchema.parse(await corrected.json()).nutrientValueCoverage).toBe(
    'partial',
  );
  await page.reload();
  await expect(page.getByRole('region', { name: '영양 작업 공간' })).toContainText('0 kcal');

  await page.goto(`http://127.0.0.1:4200/nutrition?date=${day}`);
  await expect(page.getByRole('region', { name: '영양 작업 공간' })).toContainText(
    'Synthetic snack with unknown nutrients',
  );
  await page.goto(`http://127.0.0.1:3100/nutrition?date=${day}`);
  const deleted = await page.request.delete(`/bff/v1/nutrition/intakes/${id}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { confirmed: true, expectedRevision: 2, reason: 'user_requested' },
  });
  expect(deleted.status()).toBe(200);
  expect(deletedIntakeEntrySchema.parse(await deleted.json()).status).toBe('deleted');
  const exported = await page.request.post('/bff/v1/operations/export', { headers });
  expect(exported.status()).toBe(200);
  const artifact = parseCurrentAccountExport(await exported.json());
  expect(artifact.data.intakeEntries).toContainEqual(
    expect.objectContaining({ id, status: 'deleted' }),
  );
  expect(artifact.data.intakeEntryRevisions).toContainEqual(
    expect.objectContaining({ intake_id: id, revision: 3, record_json: null }),
  );
});
