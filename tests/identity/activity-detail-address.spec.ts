import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';

/**
 * S09's spec address `/activities/:id?tab=<tab>` (01 §S09, M2-01k-k), against the real OIDC
 * session, API and PostgreSQL, in both shells.
 *
 * The alias forwards to the activity screen's own address, `/activities?selected=<id>&detailTab=
 * <tab>`. Each of the six tabs is entered through the alias and must arrive selected; an unknown
 * tab, a malformed id and another user's activity must reach the screen's existing error states,
 * and another user's activity must read exactly like one that does not exist.
 */
async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
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

const cleanup = new WeakMap<
  Page,
  { headers: Awaited<ReturnType<typeof login>>; id: string; revision: number }
>();
test.afterEach(async ({ page }) => {
  const entry = cleanup.get(page);
  if (!entry) return;
  cleanup.delete(page);
  const response = await page.request.delete(`/bff/v1/activities/${entry.id}`, {
    headers: entry.headers,
    data: { expectedRevision: entry.revision },
    timeout: 5000,
  });
  expect(response.status()).toBe(204);
});

/** A synthetic activity with observation records, so the intervals and source panels have content. */
async function importActivity(page: Page, title: string) {
  const headers = await login(page, 'Alice');
  const start = Date.parse('2023-06-15T12:00:00Z');
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'e'.repeat(64) },
    activity: {
      title,
      kind: 'running',
      startedAt: new Date(start).toISOString(),
      timezone: 'UTC',
      durationSeconds: 20,
      durationKind: 'elapsed',
      distanceMeters: 40,
    },
    details: {
      schemaVersion: 1,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: new Date(start).toISOString(),
      recordedAt: '2023-06-16T12:00:00Z',
      elapsedSeconds: 20,
      records: Array.from({ length: 20 }, (_, index) => ({
        index,
        timestamp: new Date(start + index * 1000).toISOString(),
        distanceMeters: index * 2,
        heartRateBpm: 120,
      })),
      laps: [],
    },
  });
  const { idempotencyKey, ...body } = command;
  const response = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(response.status()).toBe(200);
  const imported = activityImportResultSchema.parse(await response.json());
  cleanup.set(page, { headers, id: imported.activityId, revision: imported.revision });
  return imported.activityId;
}

const shells = [
  ['Next', 'http://127.0.0.1:3100'],
  ['Vite', 'http://127.0.0.1:4200'],
] as const;

/** Each spec tab value, the tab label it must select, and a region only that tab shows. */
const tabs = [
  ['overview', '개요', '활동 로컬 태그'],
  ['intervals', '구간', '원본 관측 워크벤치'],
  ['route', '경로', '저장된 경로'],
  ['impact', '영향', '관측·계산'],
  // The media panel (M2-01k-l) is the gallery's activity media region.
  ['media', '미디어', '활동 미디어'],
  ['source', '출처', '상세 출처'],
] as const;

for (const [shell, origin] of shells) {
  test(`${shell} shell: each /activities/:id?tab= address opens the activity with that tab selected`, async ({
    page,
  }) => {
    const title = `S09 주소 별칭 ${randomUUID()}`;
    const activityId = await importActivity(page, title);
    const tablist = page.getByRole('tablist', { name: '활동 상세 보기', exact: true });

    for (const [tab, label, region] of tabs) {
      await page.goto(`${origin}/activities/${activityId}?tab=${tab}`);
      // The alias became the screen's own address; nothing else is left of it.
      await expect(page).toHaveURL(
        `${origin}/activities?${new URLSearchParams({ selected: activityId, detailTab: tab })}`,
      );
      await expect(tablist.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      for (const [, other] of tabs)
        if (other !== label)
          await expect(tablist.getByRole('tab', { name: other, exact: true })).toHaveAttribute(
            'aria-selected',
            'false',
          );
      await expect(
        page
          .getByRole('region', { name: '선택한 활동 상세', exact: true })
          .getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
    }

    // Without `tab` the alias opens the screen's default tab.
    await page.goto(`${origin}/activities/${activityId}`);
    await expect(page).toHaveURL(`${origin}/activities?selected=${activityId}`);
    await expect(tablist.getByRole('tab', { name: '개요', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test(`${shell} shell: an unknown tab, a malformed id and another user's activity reach the existing error states`, async ({
    page,
    browser,
  }) => {
    const title = `S09 주소 별칭 오류 ${randomUUID()}`;
    const activityId = await importActivity(page, title);
    const tablist = page.getByRole('tablist', { name: '활동 상세 보기', exact: true });

    // An unknown tab: the screen's unsupported-view state, no tab selected, a way back to overview.
    await page.goto(`${origin}/activities/${activityId}?tab=map`);
    await expect(page).toHaveURL(`${origin}/activities?selected=${activityId}&detailTab=map`);
    await expect(page.getByText('알 수 없는 활동 상세 보기입니다.', { exact: true })).toBeVisible();
    for (const [, label] of tabs)
      await expect(tablist.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    await page.getByRole('button', { name: '개요로 이동', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '개요', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // A malformed id: the screen's invalid-address state, and no detail request is made.
    const detailRequests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/bff/') && request.url().includes('not-an-activity'))
        detailRequests.push(request.url());
    });
    await page.goto(`${origin}/activities/not-an-activity?tab=overview`);
    await expect(page).toHaveURL(
      `${origin}/activities?selected=not-an-activity&detailTab=overview`,
    );
    await expect(
      page.getByRole('alert').filter({ hasText: '조회 주소를 확인하세요.' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '선택한 활동 상세', exact: true })).toHaveCount(
      0,
    );
    expect(detailRequests).toEqual([]);

    // Bob: Alice's activity through the alias reads exactly like an activity that does not exist.
    const bobContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    try {
      const bob = await bobContext.newPage();
      await login(bob, 'Bob');
      const answer = async (id: string) => {
        // The screen reads the activity through its context and its source details.
        const reads = ['context', 'details'].map((part) =>
          bob.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === `/bff/v1/activities/${id}/${part}` &&
              response.request().method() === 'GET',
          ),
        );
        await bob.goto(`${origin}/activities/${id}?tab=impact`);
        await expect(bob).toHaveURL(`${origin}/activities?selected=${id}&detailTab=impact`);
        const statuses = await Promise.all(reads.map(async (read) => (await read).status()));
        const region = bob.getByRole('region', { name: '선택한 활동 상세', exact: true });
        await expect(
          region.getByRole('alert').filter({ hasText: '기록이 삭제되었거나 접근할 수 없습니다.' }),
        ).toBeVisible();
        await expect(bob.getByText(title)).toHaveCount(0);
        return { statuses, text: (await region.innerText()).replaceAll(id, '<id>') };
      };
      const alices = await answer(activityId);
      const missing = await answer(randomUUID());
      expect(alices.statuses).toEqual([404, 404]);
      expect(alices).toEqual(missing);
    } finally {
      await bobContext.close();
    }
  });
}
