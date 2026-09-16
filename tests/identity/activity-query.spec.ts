import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  activitySchema,
  type ActivityImport,
} from '../../packages/contracts/src/activity';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

// M1-04e: actual OIDC/API/PostgreSQL. Synthetic source labels do not represent live provider sync.
test('activity query uses effective values, literal search and requested local dates with stable paging', async ({
  page,
}) => {
  const headers = await login(page);
  const marker = `activity-query-${randomUUID()}`;
  const created = new Map<string, number>();
  const importActivity = async (
    suffix: string,
    startedAt: string | null,
    distanceMeters: number | null,
    kind: ActivityImport['activity']['kind'] = 'running',
    source: ActivityImport['source']['kind'] = 'fixture',
  ) => {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: { kind: source, sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
        activity: {
          title: `${marker} ${suffix}`,
          kind,
          startedAt,
          timezone: 'UTC',
          distanceMeters,
          durationSeconds: null,
          durationKind: 'unknown',
        },
      },
    });
    expect(response.status()).toBe(200);
    const record = activityImportResultSchema.parse(await response.json());
    created.set(record.activityId, record.revision);
    return record;
  };
  const read = async (filters: Record<string, string> = {}) => {
    const query = new URLSearchParams({ search: marker, ...filters });
    const response = await page.request.get(`/bff/v1/activities?${query}`, { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const ids = (result: ReturnType<typeof activityListSchema.parse>) =>
    result.items.map((item) => item.id);
  try {
    const prior = await importActivity('prior', '2024-03-10T04:30:00Z', 100);
    const corrected = await importActivity('original title', '2024-03-10T07:30:00Z', 0);
    const cycling = await importActivity('cycling', '2024-03-11T03:30:00Z', 10, 'cycling', 'fit');
    const unknown = await importActivity('unplaced', null, null);
    const tied = await importActivity('literalZZXAlpha', '2024-03-10T12:00:00Z', 25);
    const boundary = await importActivity('literal%_\\Zulu', '2024-03-11T04:00:00Z', null);
    const patch = await page.request.patch(`/bff/v1/activities/${corrected.activityId}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: corrected.revision,
        title: `${marker} literal%_\\Alpha`,
        distanceMeters: 25,
        reason: 'Synthetic title and observed distance correction',
      },
    });
    expect(patch.status()).toBe(200);
    const overlay = activitySchema.parse(await patch.json());
    created.set(overlay.id, overlay.revision);

    expect((await read()).total).toBe(6);
    expect(ids(await read({ sort: 'id_asc' }))).toEqual([...created.keys()].sort());
    expect((await read({ search: `${marker} original title` })).total).toBe(0);
    expect(ids(await read({ search: `  ${marker} literal%_\\  `, sort: 'started_asc' }))).toEqual([
      corrected.activityId,
      boundary.activityId,
    ]);
    const localRange = {
      from: '2024-03-10',
      toExclusive: '2024-03-11',
      timezone: 'America/New_York',
    };
    const local = await read({ ...localRange, sort: 'started_asc' });
    expect(local.total).toBe(3);
    expect(ids(local)).toEqual([corrected.activityId, tied.activityId, cycling.activityId]);
    expect(local.items.find((item) => item.id === corrected.activityId)?.effective).toMatchObject({
      title: `${marker} literal%_\\Alpha`,
      distanceMeters: 25,
    });
    expect(ids(await read({ ...localRange, timezone: 'UTC', sort: 'started_asc' }))).toEqual([
      prior.activityId,
      corrected.activityId,
      tied.activityId,
    ]);
    expect(ids(await read({ ...localRange, source: 'fit', kind: 'cycling' }))).toEqual([
      cycling.activityId,
    ]);
    expect((await read({ ...localRange, source: 'fixture', kind: 'cycling' })).total).toBe(0);
    const tiedIds = [corrected.activityId, tied.activityId].sort();
    const pageFilters = {
      ...localRange,
      source: 'fixture',
      kind: 'running',
      sort: 'distance_desc',
      limit: '1',
    };
    const firstPage = await read({ ...pageFilters, offset: '0' });
    const secondPage = await read({ ...pageFilters, offset: '1' });
    expect(firstPage.total).toBe(2);
    expect(secondPage.total).toBe(2);
    expect([...ids(firstPage), ...ids(secondPage)]).toEqual(tiedIds);
    expect(ids(await read({ ...pageFilters, offset: '2' }))).toEqual([]);
    expect((await read({ ...pageFilters, offset: '2' })).total).toBe(2);
    expect(ids(await read({ sort: 'started_asc' }))).toEqual([
      prior.activityId,
      corrected.activityId,
      tied.activityId,
      cycling.activityId,
      boundary.activityId,
      unknown.activityId,
    ]);
    expect(ids(await read({ sort: 'started_desc' }))).toEqual([
      boundary.activityId,
      cycling.activityId,
      tied.activityId,
      corrected.activityId,
      prior.activityId,
      unknown.activityId,
    ]);
    const missingDistanceIds = [unknown.activityId, boundary.activityId].sort();
    expect(ids(await read({ sort: 'distance_asc' }))).toEqual([
      cycling.activityId,
      ...tiedIds,
      prior.activityId,
      ...missingDistanceIds,
    ]);
    expect(ids(await read({ sort: 'distance_desc' }))).toEqual([
      prior.activityId,
      ...tiedIds,
      cycling.activityId,
      ...missingDistanceIds,
    ]);
    expect(ids(await read({ sort: 'title_asc' }))).toEqual([
      cycling.activityId,
      corrected.activityId,
      boundary.activityId,
      tied.activityId,
      prior.activityId,
      unknown.activityId,
    ]);
  } finally {
    for (const [id, revision] of created) {
      const response = await page.request.delete(`/bff/v1/activities/${id}`, {
        headers,
        data: { expectedRevision: revision },
      });
      expect(response.status()).toBe(204);
    }
  }
});
