import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';

import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
import {
  exerciseVersionReadSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
} from '../../packages/contracts/src/supplementary-core';
import { OFFLINE_SET_STORAGE_PREFIX } from '../../packages/modules/supplementary/src/offline-set-queue';

type Identity = 'Alice' | 'Bob';
type Headers = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const visited = new WeakMap<Page, Set<Identity>>();
const setRoute = '**/bff/v1/supplementary/executions/*/sets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionValue(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.athleteId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.csrfToken !== 'string'
  )
    throw new Error('INVALID_TEST_SESSION');
  return {
    athleteId: value.athleteId,
    sessionId: value.sessionId,
    csrfToken: value.csrfToken,
  };
}

function queueValue(value: unknown) {
  if (!isRecord(value) || typeof value.userId !== 'string' || !Array.isArray(value.entries))
    throw new Error('INVALID_OFFLINE_QUEUE');
  const entries = value.entries.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.kind !== 'string' ||
      typeof entry.status !== 'string' ||
      typeof entry.idempotencyKey !== 'string' ||
      typeof entry.logId !== 'string'
    )
      throw new Error('INVALID_OFFLINE_ENTRY');
    return {
      kind: entry.kind,
      status: entry.status,
      idempotencyKey: entry.idempotencyKey,
      logId: entry.logId,
      ...(Object.hasOwn(entry, 'payload') ? { payload: entry.payload } : {}),
    };
  });
  return { userId: value.userId, entries };
}

function setItems(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('INVALID_SET_COLLECTION');
  return value.items.map((item: unknown) => setLogReadSchema.parse(item));
}

async function login(page: Page, identity: Identity, direct = false) {
  const logout = page.getByRole('button', { name: '로그아웃', exact: true });
  if (direct) await page.goto('/bff/v1/auth/login');
  else {
    await page.goto('/account');
    const current = await page.request.get('/bff/v1/session');
    if (current.status() === 200) {
      await expect(logout).toBeVisible();
      await logout.click();
    } else expect(current.status()).toBe(401);
    const oidc = page.getByRole('link', { name: 'OIDC로 로그인' });
    await expect(oidc).toBeVisible();
    await oidc.click();
  }
  await page.getByRole('link', { name: `Sign in as ${identity}` }).click();
  await expect(logout).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session = sessionValue(await response.json());
  let users = visited.get(page);
  if (!users) {
    users = new Set();
    visited.set(page, users);
  }
  users.add(identity);
  return {
    athleteId: session.athleteId,
    headers: {
      origin: new URL(page.url()).origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    } satisfies Headers,
  };
}

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  const users = visited.get(page);
  visited.delete(page);
  if (!users) return;
  // All accounts are synthetic and live only in this test's isolated OIDC/PostgreSQL fixture.
  for (const user of users) {
    const { headers } = await login(page, user);
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
      timeout: 5000,
    });
    expect(erased.status()).toBe(200);
  }
});

async function queue(page: Page) {
  const records = await page.evaluate((prefix) => {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, value: localStorage.getItem(key) }));
  }, OFFLINE_SET_STORAGE_PREFIX);
  expect(records).toHaveLength(1);
  const [record] = records;
  if (!record || record.value === null) throw new Error('OFFLINE_QUEUE_MISSING');
  return { key: record.key, value: queueValue(JSON.parse(record.value)) };
}

test('confirmed sets survive offline reload, sync once, dedupe, and clear on sign-out/account switch', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(8_000);
  const alice = await login(page, 'Alice');
  const marker = randomUUID();
  const supplementary = '/bff/v1/supplementary';

  await page.goto('/supplementary/exercises');
  const exerciseForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 동작', exact: true }),
  });
  await page.getByRole('button', { name: '동작 추가' }).click();
  await exerciseForm
    .getByRole('textbox', { name: '이름', exact: true })
    .fill(`Offline set ${marker}`);
  await exerciseForm.getByRole('combobox', { name: '동작 계열' }).selectOption('plyometric');
  await exerciseForm.getByRole('combobox', { name: '횟수 정의' }).selectOption('foot_contacts');
  await exerciseForm.getByRole('combobox', { name: '횟수 기준' }).selectOption('per_side');
  await exerciseForm
    .getByRole('textbox', { name: '수행 설명' })
    .fill('Synthetic set for offline browser verification.');
  const exerciseResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${supplementary}/exercises` &&
      response.request().method() === 'POST',
  );
  await exerciseForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const exercise = exerciseVersionReadSchema.parse(await (await exerciseResponse).json());

  const activityResponse = await page.request.post('/bff/v1/activities', {
    headers: { ...alice.headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      activity: {
        title: `Offline Activity ${marker}`,
        kind: 'strength',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        timezone: 'UTC',
        distanceMeters: null,
        durationSeconds: null,
        durationKind: 'unknown',
      },
      report: { sessionRpe: null, note: null, planLink: null },
    },
  });
  expect(activityResponse.status()).toBe(200);
  const activityId = manualActivityResultSchema.parse(await activityResponse.json()).activityId;
  const executionResponse = await page.request.post(`${supplementary}/executions`, {
    headers: { ...alice.headers, 'idempotency-key': randomUUID() },
    data: {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: null,
      activity: { kind: 'match_existing', activityId },
      confirmed: true,
    },
  });
  expect(executionResponse.status()).toBe(200);
  const execution = supplementaryExecutionSchema.parse(await executionResponse.json());
  const setPath = `${supplementary}/executions/${execution.executionId}/sets`;

  await page.goto(`/supplementary/sessions/${execution.executionId}/perform`);
  const workspace = page.getByRole('region', { name: '보강 운동 작업 공간' });
  const offline = workspace.getByRole('region', { name: '오프라인 세트 기록' });
  const setForm = workspace.locator('form').filter({
    has: page.getByRole('heading', { name: '세트 추가', exact: true }),
  });
  await expect(setForm.getByRole('button', { name: '세트 초안 저장' })).toBeEnabled();
  expect(
    await page.evaluate(
      (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
      OFFLINE_SET_STORAGE_PREFIX,
    ),
  ).toEqual([]);
  await offline.getByRole('button', { name: '오프라인 세트 저장 동의' }).click();
  expect((await queue(page)).value).toMatchObject({ userId: alice.athleteId, entries: [] });

  const abortSetWrites = async (route: Route) => {
    if (route.request().method() === 'POST') await route.abort('internetdisconnected');
    else await route.continue();
  };
  await page.route(setRoute, abortSetWrites);
  await setForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exercise.definition.versionId);
  await setForm.getByRole('combobox', { name: '상태', exact: true }).selectOption('performed');
  await setForm.getByRole('spinbutton', { name: '실제 횟수 (모르면 비움)' }).fill('8');
  await context.setOffline(true);
  await setForm.getByRole('button', { name: '확인하고 실제 세트 저장' }).click();
  await expect(offline).toContainText('동기화 대기');
  const pending = (await queue(page)).value.entries.filter((entry) => entry.status === 'pending');
  expect(pending).toHaveLength(1);
  const [first] = pending;
  if (!first) throw new Error('OFFLINE_SET_NOT_QUEUED');
  expect(first).toMatchObject({
    kind: 'create',
    payload: { command: { confirmation: 'user_confirmed' } },
  });

  // Keep set writes disconnected while the shell reloads and recovers its server reads.
  await context.setOffline(false);
  await page.reload();
  await expect(offline).toContainText('동기화 대기');
  await expect(offline).toContainText('미전송 세트가 남아 있습니다');
  expect(
    (await queue(page)).value.entries.find(
      (entry) => entry.idempotencyKey === first.idempotencyKey,
    ),
  ).toMatchObject({ status: 'pending' });
  const before = await page.request.get(setPath, { headers: alice.headers });
  expect(before.status()).toBe(200);
  expect(setItems(await before.json())).toHaveLength(0);

  await context.setOffline(true);
  await page.unroute(setRoute, abortSetWrites);
  const browserPosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === setPath)
      browserPosts.push(request.headers()['idempotency-key'] ?? '');
  });
  const synced = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === setPath &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  await context.setOffline(false);
  const syncResponse = await synced;
  const saved = setLogReadSchema.parse(await syncResponse.json());
  if (saved.status !== 'active') throw new Error('OFFLINE_SET_NOT_ACTIVE');
  expect(saved.current).toMatchObject({ logId: first.logId, state: 'performed' });
  await expect(offline).toContainText('대기 중이던 세트 기록을 동기화했습니다');
  const receipt = (await queue(page)).value.entries.find(
    (entry) => entry.idempotencyKey === first.idempotencyKey,
  );
  expect(receipt).toMatchObject({ status: 'confirmed' });
  expect(receipt).not.toHaveProperty('payload');
  await offline.getByRole('button', { name: '대기 세트 다시 전송' }).click();
  expect(browserPosts).toEqual([first.idempotencyKey]);

  const originalBody: unknown = syncResponse.request().postDataJSON();
  if (!isRecord(originalBody)) throw new Error('INVALID_REPLAY_BODY');
  const replay = await page.request.post(setPath, {
    headers: { ...alice.headers, 'idempotency-key': first.idempotencyKey },
    data: originalBody,
  });
  expect(replay.status()).toBe(200);
  expect(setLogReadSchema.parse(await replay.json())).toEqual(saved);
  const after = await page.request.get(setPath, { headers: alice.headers });
  expect(setItems(await after.json())).toHaveLength(1);

  // A second, unsent actual proves logout clears sensitive pending payloads.
  await page.route(setRoute, abortSetWrites);
  await expect(setForm.getByRole('button', { name: '세트 초안 저장' })).toBeEnabled();
  await setForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exercise.definition.versionId);
  await setForm.getByRole('combobox', { name: '상태', exact: true }).selectOption('performed');
  await setForm.getByRole('spinbutton', { name: '실제 횟수 (모르면 비움)' }).fill('5');
  await context.setOffline(true);
  await setForm.getByRole('button', { name: '확인하고 실제 세트 저장' }).click();
  await expect(offline).toContainText('동기화 대기');
  const pendingAtLogout = await queue(page);
  expect(pendingAtLogout.value.entries.filter((entry) => entry.status === 'pending')).toHaveLength(
    1,
  );
  const rawPending = await page.evaluate((key) => localStorage.getItem(key), pendingAtLogout.key);
  if (rawPending === null) throw new Error('PENDING_QUEUE_MISSING');
  await context.setOffline(false);
  await page.goto('/account');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('workout:private:')),
    ),
  ).toEqual([]);
  // Simulate a stale queue restored by another tab after sign-out. The Bob account
  // binding must purge it before any supplementary workspace can read or send it.
  await page.evaluate(
    ({ key, payload, athleteId }) => {
      localStorage.setItem(key, payload);
      localStorage.setItem('workout:private:account-scope', athleteId);
    },
    { key: pendingAtLogout.key, payload: rawPending, athleteId: alice.athleteId },
  );
  const bob = await login(page, 'Bob', true);
  expect(bob.athleteId).not.toBe(alice.athleteId);
  expect(
    await page.evaluate(
      (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
      OFFLINE_SET_STORAGE_PREFIX,
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('workout:private:account-scope'))).toBe(
    bob.athleteId,
  );
});
