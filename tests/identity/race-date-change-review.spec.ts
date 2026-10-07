import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { raceEventSchema } from '../../packages/contracts/src/races';
import { raceCommandResultSchema } from '../../packages/contracts/src/race-commands';
import { planReadSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
import { raceManualPublicReviewResultSchema } from '../../packages/contracts/src/race-manual-public';
import { raceManualApprovalResultSchema } from '../../packages/contracts/src/race-manual-approval';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';

// Explicit staged-manual profile only. Genuine local OIDC, API/UI and PostgreSQL;
// no interception, owner health seeds, provider/native/public deployment claims.
async function login(page: Page, origin: string) {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await grantAppProcessingForScenario(page);
  const sessionResponse = await page.request.get(`${origin}/bff/v1/session`);
  expect(sessionResponse.status()).toBe(200);
  const session: unknown = await sessionResponse.json();
  assert.ok(typeof session === 'object' && session !== null);
  assert.ok('sessionId' in session && typeof session.sessionId === 'string');
  assert.ok('csrfToken' in session && typeof session.csrfToken === 'string');
  return { origin, 'x-workout-session-id': session.sessionId, 'x-csrf-token': session.csrfToken };
}

for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: race date changes require explicit review and approval`, async ({ page }) => {
    test.setTimeout(120000);
    const headers = await login(page, origin);
    const currentResponse = await page.request.get(`${origin}/bff/v1/plans/current`, { headers });
    expect(currentResponse.status()).toBe(200);
    const current = planReadSchema.parse(await currentResponse.json());
    const planResponse = await page.request.put(`${origin}/bff/v1/plans/current`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft: {
          title: `Synthetic date review ${host}`,
          timezone: 'UTC',
          periods: [
            {
              id: 'season',
              parentId: null,
              level: 'season',
              title: 'Synthetic season',
              startDate: '2080-01-01',
              endDateExclusive: '2080-02-01',
              timezone: 'UTC',
              intent: '',
              isPartial: false,
            },
          ],
          sessions: [],
        },
      },
    });
    expect(planResponse.status()).toBe(200);
    const plan = planSnapshotSchema.parse(await planResponse.json());
    await page.goto(`${origin}/races`);
    const title = `Synthetic race date ${host} ${randomUUID()}`;
    await page.getByRole('button', { name: '새 목표 대회 등록', exact: true }).first().click();
    await page.getByLabel('대회 이름', { exact: true }).fill(title);
    const revalidated = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/bff/v1/session' && r.request().method() === 'GET',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await revalidated).status()).toBe(200);
    await expect(page.getByLabel('대회 이름', { exact: true })).toHaveValue(title);
    await page.getByLabel('현지 날짜', { exact: true }).fill('2080-01-03');
    const createdPromise = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/bff/v1/races' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '저장', exact: true }).click();
    const createdResponse = await createdPromise;
    expect(createdResponse.status()).toBe(201);
    const created = raceCommandResultSchema.parse(await createdResponse.json());
    const readRace = async () => {
      const response = await page.request.get(`${origin}/bff/v1/races/${created.id}`, { headers });
      expect(response.status()).toBe(200);
      return raceEventSchema.parse(await response.json());
    };
    const original = await readRace();
    const { id: _id, revision: _revision, ...values } = original;
    const blocked = await page.request.patch(`${origin}/bff/v1/races/${created.id}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedRevision: original.revision, values: { ...values, localDate: '2080-01-04' } },
    });
    expect(blocked.status()).toBe(409);
    expect(await readRace()).toEqual(original);
    const raceCard = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await raceCard.getByRole('button', { name: '편집', exact: true }).click();
    await expect(page.getByLabel('현지 날짜', { exact: true })).toHaveAttribute('readonly', '');
    await expect(
      raceCard.getByRole('button', { name: '대회 상세 · 날짜 변경 검토', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .getByRole('button', { name: '대회 상세 · 날짜 변경 검토', exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/races/${created.id}`);
    await page.getByRole('button', { name: '대회 날짜 변경 검토', exact: true }).click();
    await page.getByLabel('새 대회 날짜').fill('2080-01-04');
    await page.getByLabel('계획 비교 방식').selectOption('keep_plan');
    const reviewPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/races/${created.id}/date-change-reviews`) &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '전체 영향 검토', exact: true }).click();
    const reviewResponse = await reviewPromise;
    expect(reviewResponse.status()).toBe(201);
    const review = raceManualPublicReviewResultSchema.parse(await reviewResponse.json());
    expect(review.status).toBe('reviewed');
    await expect(page.getByRole('region', { name: '미리보기 본문' })).toBeVisible();
    expect(await readRace()).toEqual(original);
    const beforePlan = await page.request.get(`${origin}/bff/v1/plans/current`, { headers });
    expect(planReadSchema.parse(await beforePlan.json()).head?.id).toBe(plan.id);
    const approveButton = page.getByRole('button', { name: '계획 변경 승인', exact: true });
    await expect(approveButton).toBeDisabled();
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        )
        .toBe(true);
    }
    await page
      .getByLabel('전체 변경과 보존 항목을 확인했으며 이 계획 변경을 명시적으로 승인합니다')
      .check();
    const approvePromise = page.waitForResponse(
      (r) =>
        r.url().includes('/race-date-change-reviews/') &&
        r.url().endsWith('/approve') &&
        r.request().method() === 'POST',
    );
    await approveButton.click();
    const approveResponse = await approvePromise;
    expect(approveResponse.status()).toBe(200);
    const approved = raceManualApprovalResultSchema.parse(await approveResponse.json());
    expect(approved.status).toBe('committed');
    await expect(
      page.getByText('날짜와 영향받는 계획의 승인이 서버에 반영되었습니다.', { exact: true }),
    ).toBeVisible();
    expect(await readRace()).toMatchObject({
      localDate: '2080-01-04',
      revision: original.revision + 1,
    });
    const afterPlan = await page.request.get(`${origin}/bff/v1/plans/current`, { headers });
    expect(planReadSchema.parse(await afterPlan.json()).head?.id).toBe(plan.id);
  });
}
