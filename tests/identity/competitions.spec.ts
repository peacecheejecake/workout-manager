import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { consentSchema } from '../../apps/api/src/ports';
import { activitySchema, manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { courseReadResultSchema } from '../../packages/contracts/src/courses';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { raceCommandResultSchema } from '../../packages/contracts/src/race-commands';
import {
  raceEventSchema,
  raceResultSchema,
  trainingBestSchema,
} from '../../packages/contracts/src/races';
import { importCourse, shells, type Headers } from './course-editor-support';

/** Real private OIDC + PostgreSQL fixture. No network interception or synthetic transport.
 * Explicit PB comparison uses these same public result pages; date-change Plan impact approval
 * and V2 file attachments remain separate unfinished use cases.
 * Canonical /races, /races/:id and /records drive the shared authenticated shell.
 * /competitions remains a compatibility alias; no health draft values enter URLs.
 */
async function login(page: Page, name: 'Alice' | 'Bob'): Promise<Headers> {
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
const writeHeaders = (headers: Headers) => ({ ...headers, 'idempotency-key': randomUUID() });

async function readJson(page: Page, headers: Headers, path: string): Promise<unknown> {
  const response = await page.request.get(path, { headers });
  expect(response.status()).toBe(200);
  return response.json();
}
async function grantApp(page: Page, headers: Headers) {
  const currentResponse = await page.request.get('/bff/v1/consents/app', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = consentSchema.parse(await currentResponse.json());
  // Explicit authenticated athlete action for these new synthetic plan/actual records.
  // This is not a production default grant or a generic provider permission.
  const response = await page.request.put('/bff/v1/consents/app', {
    headers: writeHeaders(headers),
    data: { granted: true, expectedRevision: current.revision },
  });
  expect(response.status()).toBe(200);
  expect(consentSchema.parse(await response.json()).granted).toBe(true);
}
async function eraseSyntheticAccount(page: Page, headers: Headers) {
  const response = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 10000,
  });
  expect(response.status()).toBe(200);
}
async function seedRelations(page: Page, headers: Headers, prefix: string) {
  const currentResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = planReadSchema.parse(await currentResponse.json());
  const draft = planDraftSchema.parse({
    title: `${prefix} 계획`,
    timezone: 'UTC',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: '합성 Season',
        startDate: '2080-01-01',
        endDateExclusive: '2080-02-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [],
  });
  const saved = await page.request.put('/bff/v1/plans/current', {
    headers: writeHeaders(headers),
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(saved.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await saved.json());
  const created = await page.request.post('/bff/v1/activities', {
    headers: writeHeaders(headers),
    data: {
      confirmed: true,
      activity: {
        title: `${prefix} 활동`,
        kind: 'running',
        startedAt: '2019-06-02T00:00:00Z',
        timezone: 'UTC',
        durationSeconds: null,
        durationKind: 'elapsed',
        distanceMeters: 0,
      },
      report: {
        sessionRpe: 0,
        note: '합성 actual; race는 이 기록을 복제하지 않음',
        planLink: null,
      },
    },
  });
  expect(created.status()).toBe(200);
  const activity = manualActivityResultSchema.parse(await created.json());
  const courseId = await importCourse(page, headers, `${prefix} 코스`, [
    [0, 0],
    [0.002, 0.002],
  ]);
  const courseResponse = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(courseResponse.status()).toBe(200);
  const course = courseReadResultSchema.parse(await courseResponse.json());
  assert.ok(course.status === 'available');
  return { plan, activity, course: course.course };
}
async function saveForm(page: Page, panel: Locator, endpoint: string, method: 'POST' | 'PATCH') {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === endpoint && response.request().method() === method,
      { timeout: 10000 },
    ),
    panel.getByRole('button', { name: '저장', exact: true }).click(),
  ]);
  expect(response.status()).toBe(method === 'POST' ? 201 : 200);
  const receipt = raceCommandResultSchema.parse(await response.json());
  await expect(
    panel.getByText(`저장이 서버에 반영되었습니다 (revision ${receipt.revision}).`),
  ).toBeVisible();
  return receipt;
}
async function deleteCard(page: Page, panel: Locator, card: Locator, endpoint: string) {
  await card.getByRole('button', { name: '삭제', exact: true }).click();
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === endpoint && response.request().method() === 'DELETE',
      { timeout: 10000 },
    ),
    panel.getByRole('button', { name: '삭제 확인', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(card).toHaveCount(0);
}
async function readActivity(page: Page, headers: Headers, id: string) {
  const response = await page.request.get(`/bff/v1/activities/${id}`, { headers });
  expect(response.status()).toBe(200);
  return activitySchema.parse(await response.json());
}

for (const shell of shells) {
  test(`${shell.name}: authenticated competition CRUD, relations, CAS, URL and tenant isolation`, async ({
    browser,
  }) => {
    test.setTimeout(180000);
    const aliceContext = await browser.newContext({ baseURL: shell.origin });
    const bobContext = await browser.newContext({ baseURL: shell.origin });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    let aliceHeaders: Headers | undefined;
    let bobHeaders: Headers | undefined;
    try {
      alice.setDefaultTimeout(10000);
      bob.setDefaultTimeout(10000);
      aliceHeaders = await login(alice, 'Alice');
      await grantApp(alice, aliceHeaders);
      const prefix = `합성 대회 ${randomUUID().slice(0, 8)}`;
      const relations = await seedRelations(alice, aliceHeaders, prefix);
      const actualBefore = await readActivity(alice, aliceHeaders, relations.activity.activityId);
      const planBefore = planReadSchema.parse(
        await readJson(alice, aliceHeaders, '/bff/v1/plans/current'),
      );
      await alice.goto('/races');
      const events = alice.getByRole('region', { name: '목표 대회', exact: true });
      const results = alice.getByRole('region', { name: '실제 대회 결과', exact: true });
      const bests = alice.getByRole('region', { name: '훈련 기록', exact: true });
      const nav = alice.getByRole('navigation', { name: '대회 및 기록 화면' });
      await events.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await events.getByLabel('대회 이름', { exact: true }).fill(prefix);
      await events.getByLabel('현지 날짜').fill('2080-01-03');
      await events.getByLabel('IANA 시간대').fill('Pacific/Auckland');
      await events.getByLabel('목표 시간 (초)').fill('0');
      const planLabel = `${prefix} 계획 · 계획 v${relations.plan.version}`;
      const courseLabel = `${prefix} 코스 · 버전 ${relations.course.headRevision}`;
      await expect(
        events.getByLabel('연결 계획').getByRole('option', { name: planLabel, exact: true }),
      ).toHaveCount(1);
      await events.getByLabel('연결 계획').selectOption({ label: planLabel });
      await expect(
        events.getByLabel('고정 버전 코스').getByRole('option', { name: courseLabel, exact: true }),
      ).toHaveCount(1);
      await events.getByLabel('고정 버전 코스').selectOption({ label: courseLabel });
      const eventReceipt = await saveForm(alice, events, '/bff/v1/races', 'POST');
      const event = raceEventSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/races/${eventReceipt.id}`),
      );
      expect(event).toMatchObject({
        title: prefix,
        localDate: '2080-01-03',
        localStartTime: null,
        timezone: 'Pacific/Auckland',
        targetSeconds: 0,
        planVersionId: relations.plan.id,
        course: {
          courseId: relations.course.courseId,
          courseRevision: relations.course.headRevision,
          revisionId: relations.course.revisionId,
        },
      });
      const [detailRead] = await Promise.all([
        alice.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/bff/v1/races/${event.id}` &&
            response.request().method() === 'GET',
          { timeout: 10000 },
        ),
        events
          .getByRole('listitem')
          .filter({ hasText: prefix })
          .getByRole('button', { name: '대회 상세 · 날짜 변경 검토', exact: true })
          .click(),
      ]);
      expect(detailRead.status()).toBe(200);
      expect(raceEventSchema.parse(await detailRead.json())).toEqual(event);
      await expect(alice).toHaveURL(`${shell.origin}/races/${event.id}`);
      const detail = alice.getByRole('region', { name: '대회 상세', exact: true });
      await expect(detail.getByRole('heading', { name: prefix, exact: true })).toBeVisible();
      await expect(detail.getByText(`Plan ${planLabel}`, { exact: false })).toBeVisible();
      await expect(detail.getByText(`코스 ${courseLabel}`, { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: '대회 편집', exact: true }).click();
      await expect(detail.getByLabel('고정 버전 코스')).toHaveValue(relations.course.revisionId);
      await expect(
        detail.getByLabel('고정 버전 코스').getByRole('option', { name: courseLabel, exact: true }),
      ).toHaveCount(1);
      await expect(detail.getByLabel('연결 계획')).toHaveValue(relations.plan.id);
      await detail.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 상세 미저장`);
      await detail.getByRole('button', { name: '대회 목록으로', exact: true }).click();
      const moveGuard = detail.getByRole('region', { name: '미저장 변경 이동 확인' });
      await expect(moveGuard).toBeVisible();
      await moveGuard.getByRole('button', { name: '계속 편집', exact: true }).click();
      await expect(detail.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 상세 미저장`,
      );
      await expect(alice).toHaveURL(`${shell.origin}/races/${event.id}`);
      await detail.getByRole('button', { name: '대회 목록으로', exact: true }).click();
      await moveGuard.getByRole('button', { name: '변경을 버리고 이동', exact: true }).click();
      await expect(alice).toHaveURL(`${shell.origin}/races`);
      expect(
        raceEventSchema.parse(await readJson(alice, aliceHeaders, `/bff/v1/races/${event.id}`)),
      ).toEqual(event);
      const renamed = await alice.request.patch(`/bff/v1/courses/${relations.course.courseId}`, {
        headers: writeHeaders(aliceHeaders),
        data: {
          expectedRevision: relations.course.headRevision,
          change: { kind: 'rename', name: `${prefix} 새 코스 이름` },
        },
      });
      expect(renamed.status()).toBe(200);
      courseReadResultSchema.parse(await renamed.json());
      await alice.reload();
      const eventCard = events.getByRole('listitem').filter({ hasText: prefix });
      await eventCard.getByRole('button', { name: '편집', exact: true }).click();
      await expect(events.getByLabel('고정 버전 코스')).toHaveValue(relations.course.revisionId);
      await events.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 초안`);
      await nav.getByRole('button', { name: '실제 대회 결과', exact: true }).click();
      await expect(alice).toHaveURL(`${shell.origin}/records?section=results`);
      await nav.getByRole('button', { name: '훈련 기록', exact: true }).click();
      await expect(alice).toHaveURL(`${shell.origin}/records?section=training-bests`);
      await expect(bests).toBeVisible();
      await alice.goBack();
      await expect(alice).toHaveURL(`${shell.origin}/records?section=results`);
      await expect(results).toBeVisible();
      await alice.goBack();
      await expect(events.getByLabel('대회 이름', { exact: true })).toHaveValue(`${prefix} 초안`);
      await expect(alice).toHaveURL(`${shell.origin}/races`);
      expect(new URL(alice.url()).searchParams.toString()).toBe('');
      expect(alice.url()).not.toContain(prefix);
      expect(alice.url()).not.toContain(relations.activity.activityId);
      const { id: _eventId, revision: _eventRevision, ...eventValues } = event;
      const concurrent = await alice.request.patch(`/bff/v1/races/${event.id}`, {
        headers: writeHeaders(aliceHeaders),
        data: {
          expectedRevision: event.revision,
          values: { ...eventValues, title: `${prefix} 서버 변경` },
        },
      });
      expect(concurrent.status()).toBe(200);
      const concurrentReceipt = raceCommandResultSchema.parse(await concurrent.json());
      const [conflict] = await Promise.all([
        alice.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/bff/v1/races/${event.id}` &&
            response.request().method() === 'PATCH',
          { timeout: 10000 },
        ),
        events.getByRole('button', { name: '저장', exact: true }).click(),
      ]);
      expect(conflict.status()).toBe(409);
      await expect(events.getByRole('alert')).toContainText('다른 변경과 충돌');
      await expect(events.getByLabel('대회 이름', { exact: true })).toHaveValue(`${prefix} 초안`);
      await events.getByRole('button', { name: '최신 기록 확인', exact: true }).click();
      await expect(
        events.getByRole('heading', {
          name: `서버의 최신 기록 · revision ${concurrentReceipt.revision}`,
        }),
      ).toBeVisible();
      await events
        .getByRole('button', { name: '비교 완료 · 초안 유지하며 최신 revision 채택', exact: true })
        .click();
      await saveForm(alice, events, `/bff/v1/races/${event.id}`, 'PATCH');
      const finalEvent = raceEventSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/races/${event.id}`),
      );
      expect(finalEvent.title).toBe(`${prefix} 초안`);
      expect(finalEvent.course).toEqual(event.course);
      expect(finalEvent.planVersionId).toBe(event.planVersionId);

      await nav.getByRole('button', { name: '실제 대회 결과', exact: true }).click();
      await expect(alice).toHaveURL(`${shell.origin}/records?section=results`);
      await alice.reload();
      await expect(alice).toHaveURL(`${shell.origin}/records?section=results`);
      await expect(results).toBeVisible();
      await results.getByRole('button', { name: '새 실제 대회 결과 등록' }).click();
      await results.getByLabel('현지 날짜').fill('2080-01-03');
      await results.getByLabel('IANA 시간대').fill('Pacific/Auckland');
      await expect(
        results.getByLabel('연결 대회').getByRole('option', {
          name: `${prefix} 초안 · ${event.localDate}`,
          exact: true,
        }),
      ).toHaveCount(1);
      await results.getByLabel('연결 대회').selectOption(event.id);
      await results.getByLabel('기록 출처', { exact: true }).selectOption('official');
      await results.getByLabel('공식 기록 기관').fill('Synthetic race authority');
      await results
        .getByLabel('공식 기록 HTTPS URL')
        .fill('https://example.invalid/synthetic-result');
      await results.getByLabel('Chip 시간 (초)').fill('0');
      await results.getByLabel('공식 거리 (m)').fill('10000');
      await results.getByLabel('기기 거리 (m)').fill('10020');
      const activityOption = results
        .getByLabel('연결 실제 활동')
        .getByRole('option')
        .filter({ hasText: `${prefix} 활동` });
      await expect(activityOption).toHaveCount(1);
      const activityLabel = await activityOption.textContent();
      assert.ok(activityLabel);
      await results.getByLabel('연결 실제 활동').selectOption({ label: activityLabel });
      await results.getByLabel('날씨 메모').fill(`${prefix} 날씨`);
      const resultReceipt = await saveForm(alice, results, '/bff/v1/race-results', 'POST');
      const result = raceResultSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/race-results/${resultReceipt.id}`),
      );
      expect(result).toMatchObject({
        raceEventId: event.id,
        timezone: 'Pacific/Auckland',
        chipSeconds: 0,
        gunSeconds: null,
        officialDistanceMeters: 10000,
        deviceDistanceMeters: 10020,
        linkedActivityId: relations.activity.activityId,
        source: { kind: 'official', authority: 'Synthetic race authority', verifiedAt: null },
      });
      expect(result.source).toEqual({
        kind: 'official',
        authority: 'Synthetic race authority',
        resultUrl: 'https://example.invalid/synthetic-result',
        verifiedAt: null,
      });
      const resultCard = results.getByRole('listitem').filter({ hasText: `${prefix} 날씨` });
      await expect(
        alice.getByRole('heading', { name: 'PB 포함 기준 · 직접 입력한 대회 기록 포함' }),
      ).toBeVisible();
      await expect(alice.getByText(/직접 입력한 대회 기록도 PB 인정 대상입니다/)).toBeVisible();
      await expect(alice.getByText(/원기록은 유지합니다/)).toBeVisible();
      await expect(alice.getByText(/아래에서 비교 기준을 직접 선택해 PB를 계산/)).toBeVisible();
      const pb = results.getByRole('region', { name: '거리별 PB 비교', exact: true });
      await expect(pb.getByRole('list', { name: '거리별 PB 결과' })).toHaveCount(0);
      await expect(resultCard.getByText(/인증 자료 첨부 · 링크/)).toBeVisible();
      await expect(resultCard.getByText(/검토 시각 미상/)).toBeVisible();
      await expect(
        resultCard.getByText(/제출된 출처와 검토 시각만으로 기록의 진위가 확인되었다고/),
      ).toBeVisible();
      await expect(resultCard.getByRole('link', { name: '첨부 기록 링크' })).toHaveAttribute(
        'href',
        'https://example.invalid/synthetic-result',
      );
      await expect(resultCard.getByText(/서버 인증|서버 미인증/)).toHaveCount(0);
      await comparePersonalBests();
      await expect(
        pb.getByText('선택한 기준의 PB 후보가 없습니다.', { exact: true }),
      ).toBeVisible();
      await expect(pb.getByRole('list', { name: 'PB 제외 사유' }).getByText(/0초/)).toBeVisible();
      await resultCard.getByRole('button', { name: '편집', exact: true }).click();
      await results.getByLabel('날씨 메모').fill(`${prefix} 수정 날씨`);
      await results.getByLabel('Chip 시간 (초)').fill('10');
      await saveForm(alice, results, `/bff/v1/race-results/${result.id}`, 'PATCH');
      const editedResult = raceResultSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/race-results/${result.id}`),
      );
      expect(editedResult).toEqual({
        ...result,
        revision: result.revision + 1,
        weatherNote: `${prefix} 수정 날씨`,
        chipSeconds: 10,
      });

      // A second user-entered result participates without an official verification claim.
      await results.getByRole('button', { name: '새 실제 대회 결과 등록' }).click();
      await results.getByLabel('현지 날짜').fill('2080-01-04');
      await results.getByLabel('IANA 시간대').fill('Pacific/Auckland');
      await results.getByLabel('기록 출처', { exact: true }).selectOption('manual');
      await results.getByLabel('Chip 시간 (초)').fill('15');
      await results.getByLabel('Gun 시간 (초)').fill('9');
      await results.getByLabel('공식 거리 (m)').fill('10000');
      await results.getByLabel('날씨 메모').fill(`${prefix} 수동 PB`);
      const manualPbReceipt = await saveForm(alice, results, '/bff/v1/race-results', 'POST');
      const manualPb = raceResultSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/race-results/${manualPbReceipt.id}`),
      );
      expect(manualPb.source).toEqual({ kind: 'manual' });
      async function comparePersonalBests() {
        await pb.getByLabel('PB 거리 기준').selectOption('standard');
        await pb.getByLabel('PB 시간 기준').selectOption('both');
        await pb.getByLabel('PB 기간 시작 (선택)').fill('2080-01-01');
        await pb.getByLabel('PB 기간 끝 (선택)').fill('2080-01-31');
        await pb.getByLabel('PB 기준일').fill('2080-01-31');
        await pb.getByRole('button', { name: 'PB 비교 적용', exact: true }).click();
      }
      await comparePersonalBests();
      await expect(pb.getByText('10000 m · Chip · 10 초', { exact: true })).toBeVisible();
      await expect(pb.getByText('10000 m · Gun · 9 초', { exact: true })).toBeVisible();
      await expect(pb.getByText(/직접 입력/)).toBeVisible();
      await expect(
        pb.getByRole('list', { name: 'PB 제외 사유' }).getByText(/시간 미상/),
      ).toBeVisible();

      await nav.getByRole('button', { name: '훈련 기록', exact: true }).click();
      await bests.getByRole('button', { name: '새 훈련 기록 등록' }).click();
      await bests.getByLabel('관측 시각 (ISO 8601, offset 포함)').fill('2080-01-02T09:00:00+12:00');
      await bests.getByLabel('훈련 기록 출처').selectOption('activity');
      await bests.getByLabel('원본 실제 활동').selectOption({ label: activityLabel });
      await bests.getByLabel('측정 기준').selectOption('device-estimated-split');
      await bests.getByLabel('훈련 거리 (m)').fill('1000');
      await bests.getByLabel('경과 시간 (초)').fill('0');
      const bestReceipt = await saveForm(alice, bests, '/bff/v1/training-bests', 'POST');
      const best = trainingBestSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/training-bests/${bestReceipt.id}`),
      );
      expect(best).toMatchObject({
        source: { kind: 'activity', activityId: relations.activity.activityId },
        basis: 'device-estimated-split',
        distanceMeters: 1000,
        elapsedSeconds: 0,
      });
      expect(Date.parse(best.observedAt)).toBe(Date.parse('2080-01-02T09:00:00+12:00'));
      const bestCard = bests.getByRole('listitem').filter({ hasText: `${prefix} 활동` });
      await bestCard.getByRole('button', { name: '편집', exact: true }).click();
      await bests.getByLabel('경과 시간 (초)').fill('');
      await saveForm(alice, bests, `/bff/v1/training-bests/${best.id}`, 'PATCH');
      const editedBest = trainingBestSchema.parse(
        await readJson(alice, aliceHeaders, `/bff/v1/training-bests/${best.id}`),
      );
      expect(editedBest).toEqual({ ...best, revision: best.revision + 1, elapsedSeconds: null });

      bobHeaders = await login(bob, 'Bob');
      await grantApp(bob, bobHeaders);
      for (const endpoint of [
        `races/${event.id}`,
        `race-results/${result.id}`,
        `training-bests/${best.id}`,
      ]) {
        expect(
          (await bob.request.get(`/bff/v1/${endpoint}`, { headers: bobHeaders })).status(),
        ).toBe(404);
        expect(
          (
            await bob.request.delete(`/bff/v1/${endpoint}`, {
              headers: writeHeaders(bobHeaders),
              data: { expectedRevision: 1 },
            })
          ).status(),
        ).toBe(404);
      }
      expect(
        (
          await bob.request.patch(`/bff/v1/races/${event.id}`, {
            headers: writeHeaders(bobHeaders),
            data: {
              expectedRevision: finalEvent.revision,
              values: { ...eventValues, course: null, planVersionId: null },
            },
          })
        ).status(),
      ).toBe(404);
      const missingCsrf = await alice.request.patch(`/bff/v1/races/${event.id}`, {
        headers: {
          origin: shell.origin,
          'x-workout-session-id': aliceHeaders['x-workout-session-id'] ?? '',
          'idempotency-key': randomUUID(),
        },
        data: { expectedRevision: finalEvent.revision, values: eventValues },
      });
      expect(missingCsrf.status()).toBe(403);
      const anonymous = await browser.newContext({ baseURL: shell.origin });
      try {
        expect((await anonymous.request.get(`/bff/v1/races/${event.id}`)).status()).toBe(401);
      } finally {
        await anonymous.close();
      }
      await bob.goto('/races');
      await expect(bob.getByRole('region', { name: '목표 대회', exact: true })).toBeVisible();
      await expect(bob.getByText(`${prefix} 초안`, { exact: true })).toHaveCount(0);
      await bob.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await expect(
        bob.getByLabel('연결 계획').getByRole('option', { name: planLabel, exact: true }),
      ).toHaveCount(0);
      await expect(
        bob.getByLabel('고정 버전 코스').getByRole('option', {
          name: `${prefix} 새 코스 이름 · 버전 ${relations.course.headRevision + 1}`,
          exact: true,
        }),
      ).toHaveCount(0);

      await bob.goto('/records?section=results&section=training-bests');
      await expect(bob.getByRole('region', { name: '실제 대회 결과', exact: true })).toBeVisible();
      await bob.goto('/competitions?section=training-bests');
      await expect(bob.getByRole('region', { name: '훈련 기록', exact: true })).toBeVisible();
      await deleteCard(alice, bests, bestCard, `/bff/v1/training-bests/${best.id}`);
      await nav.getByRole('button', { name: '실제 대회 결과', exact: true }).click();
      await deleteCard(
        alice,
        results,
        results.getByRole('listitem').filter({ hasText: `${prefix} 수정 날씨` }),
        `/bff/v1/race-results/${result.id}`,
      );
      await comparePersonalBests();
      await expect(pb.getByText('10000 m · Chip · 15 초', { exact: true })).toBeVisible();
      await expect(pb.getByText('10000 m · Chip · 10 초', { exact: true })).toHaveCount(0);
      await expect(pb.getByText('10000 m · Gun · 9 초', { exact: true })).toBeVisible();
      await deleteCard(
        alice,
        results,
        results.getByRole('listitem').filter({ hasText: `${prefix} 수동 PB` }),
        `/bff/v1/race-results/${manualPb.id}`,
      );
      await expect(
        pb.getByText('선택한 기준의 PB 후보가 없습니다.', { exact: true }),
      ).toBeVisible();
      await nav.getByRole('button', { name: '목표 대회', exact: true }).click();
      await deleteCard(
        alice,
        events,
        events.getByRole('listitem').filter({ hasText: `${prefix} 초안` }),
        `/bff/v1/races/${event.id}`,
      );
      for (const endpoint of [
        `races/${event.id}`,
        `race-results/${result.id}`,
        `training-bests/${best.id}`,
      ])
        expect(
          (await alice.request.get(`/bff/v1/${endpoint}`, { headers: aliceHeaders })).status(),
        ).toBe(404);
      expect(await readActivity(alice, aliceHeaders, relations.activity.activityId)).toEqual(
        actualBefore,
      );
      expect(
        planReadSchema.parse(await readJson(alice, aliceHeaders, '/bff/v1/plans/current')),
      ).toEqual(planBefore);
      await events.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await events.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 비공개 초안`);
      await alice.goto('/account');
      await alice.getByRole('button', { name: '로그아웃', exact: true }).click();
      await login(alice, 'Bob');
      await alice.goto('/races');
      await alice.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await expect(alice.getByLabel('대회 이름', { exact: true })).toHaveValue('');
      await expect(alice.getByText(prefix, { exact: false })).toHaveCount(0);
      // Happy-path cleanup is part of the actual authenticated journey. On assertion or
      // timeout failure, never issue requests from an expired test context and mask it;
      // the runner's disposable PostgreSQL cluster teardown owns failure cleanup.
      await alice.goto('/account');
      await alice.getByRole('button', { name: '로그아웃', exact: true }).click();
      aliceHeaders = await login(alice, 'Alice');
      await eraseSyntheticAccount(alice, aliceHeaders);
      await eraseSyntheticAccount(bob, bobHeaders);
    } finally {
      await Promise.allSettled([aliceContext.close(), bobContext.close()]);
    }
  });
}
