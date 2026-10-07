import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  aiSettingsV1Schema,
  aiExecutionCatalogV1Schema,
  type AiSettingsWriteV1,
  aiSettingsWriteV1Schema,
} from '../../packages/contracts/src/ai-settings';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import {
  closeAiSettingsFixtureRestoreTarget,
  readAiSettingsLifecycleFacts,
} from '../../scripts/fixtures/ai-settings-lifecycle';

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'LIFECYCLE_INVALID_RESPONSE',
  );
  return Object.fromEntries(Object.entries(value));
}
type Session = { athleteId: string; sessionId: string; csrfToken: string };
function parseSession(input: unknown): Session {
  const value = record(input);
  assert.ok(
    typeof value['athleteId'] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value['athleteId'],
      ),
  );
  assert.ok(
    typeof value['sessionId'] === 'string' &&
      value['sessionId'].length > 0 &&
      value['sessionId'].length <= 4096,
  );
  assert.ok(
    typeof value['csrfToken'] === 'string' &&
      value['csrfToken'].length > 0 &&
      value['csrfToken'].length <= 4096,
  );
  return {
    athleteId: value['athleteId'],
    sessionId: value['sessionId'],
    csrfToken: value['csrfToken'],
  };
}
function errorCode(input: unknown): string {
  const value = record(input);
  assert.ok(Object.keys(value).every((key) => key === 'error' || key === 'requestId'));
  const error = record(value['error']);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.ok(typeof error['code'] === 'string' && error['code'].length <= 100);
  assert.ok(
    value['requestId'] === undefined ||
      (typeof value['requestId'] === 'string' && value['requestId'].length <= 200),
  );
  return error['code'];
}
async function login(page: Page, origin: string, account: 'Alice' | 'Bob') {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${account}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  return parseSession(await response.json());
}
function headers(origin: string, session: Session) {
  return { origin, 'x-workout-session-id': session.sessionId, 'x-csrf-token': session.csrfToken };
}
async function get(page: Page, origin: string, session: Session) {
  const response = await page.request.get(`${origin}/bff/v1/ai-settings`, {
    headers: headers(origin, session),
  });
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  return aiSettingsV1Schema.parse(await response.json());
}
async function put(
  page: Page,
  origin: string,
  session: Session,
  command: AiSettingsWriteV1,
  status: number,
) {
  const { idempotencyKey, ...body } = command;
  const response = await page.request.put(`${origin}/bff/v1/ai-settings`, {
    headers: { ...headers(origin, session), 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toBe('no-store');
  return response;
}
test('isolated Next+Vite: restore-target503 retains drafts, reads and exact receipts without reopening', async ({
  browser,
}) => {
  test.skip(
    process.env['IDENTITY_E2E_AI_SETTINGS_LIFECYCLE'] !== 'on',
    'Requires fresh disposable spec-only lifecycle harness',
  );
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [nextContext, viteContext, bobContext] = contexts;
  if (!nextContext || !viteContext || !bobContext) throw new Error('LIFECYCLE_CONTEXT_REQUIRED');
  try {
    const next = await nextContext.newPage(),
      vite = await viteContext.newPage(),
      bob = await bobContext.newPage();
    const alice = await login(next, identityWebOrigin, 'Alice'),
      viteAlice = await login(vite, identityMobileOrigin, 'Alice'),
      bobSession = await login(bob, identityWebOrigin, 'Bob');
    expect(viteAlice.athleteId).toBe(alice.athleteId);
    expect(bobSession.athleteId).not.toBe(alice.athleteId);
    const initialAlice = await readAiSettingsLifecycleFacts(alice.athleteId),
      initialBob = await readAiSettingsLifecycleFacts(bobSession.athleteId);
    expect(initialAlice.settingsReceiptCount).toBe(0);
    expect(initialBob.settingsReceiptCount).toBe(0);
    await next.goto(`${identityWebOrigin}/settings`);
    await next.getByRole('combobox', { name: '기본 제공자', exact: true }).selectOption('openai');
    await next
      .getByRole('combobox', { name: '기본 모델', exact: true })
      .selectOption('gpt-6.1-sol');
    const pending = next.waitForResponse(
      (response) =>
        response.url().endsWith('/bff/v1/ai-settings') && response.request().method() === 'PUT',
    );
    await next.getByRole('button', { name: '설정 저장', exact: true }).click();
    const savedResponse = await pending;
    expect(savedResponse.status()).toBe(200);
    const original = aiSettingsV1Schema.parse(await savedResponse.json());
    expect(original.revision).toBe(1);
    await expect(
      next.getByText('선택은 저장할 수 있지만 AI 연결이 준비되지 않아 실행할 수 없습니다.', {
        exact: true,
      }),
    ).toBeVisible();
    const command = aiSettingsWriteV1Schema.parse({
      ...record(savedResponse.request().postDataJSON()),
      idempotencyKey: savedResponse.request().headers()['idempotency-key'],
    });
    await expect(next.getByRole('status')).toHaveText('AI 설정을 저장했습니다.');
    await vite.goto(`${identityMobileOrigin}/settings`);
    await expect(vite.getByRole('combobox', { name: '기본 모델', exact: true })).toHaveValue(
      'gpt-6.1-sol',
    );
    expect(await get(vite, identityMobileOrigin, viteAlice)).toEqual(original);
    expect(await get(bob, identityWebOrigin, bobSession)).toMatchObject({
      revision: 0,
      defaultSelection: null,
    });
    for (const page of [next, vite]) {
      await page
        .getByRole('combobox', { name: '합성 비교 사용', exact: true })
        .selectOption('selected');
      await page
        .getByRole('combobox', { name: '합성 비교 제공자', exact: true })
        .selectOption('openai');
      await page
        .getByRole('combobox', { name: '합성 비교 모델', exact: true })
        .selectOption('gpt-6-luna');
    }
    const beforeAlice = await readAiSettingsLifecycleFacts(alice.athleteId),
      beforeBob = await readAiSettingsLifecycleFacts(bobSession.athleteId);
    expect(beforeAlice).toEqual({
      ...initialAlice,
      settingsRevision: 1,
      settingsHistoryCount: 1,
      settingsReceiptCount: 1,
    });
    expect(beforeBob).toEqual(initialBob);
    expect(await closeAiSettingsFixtureRestoreTarget()).toMatchObject({
      closed: true,
      admissionAllowed: false,
      closeReceiptCount: 1,
    });
    for (const page of [next, vite]) {
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/bff/v1/ai-settings') && request.method() === 'PUT')
          requests.push(request.method());
      });
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith('/bff/v1/ai-settings') && response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: '설정 저장', exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(503);
      expect(response.headers()['cache-control']).toBe('no-store');
      expect(errorCode(await response.json())).toBe('UNAVAILABLE');
      await expect(page.getByRole('status')).toHaveText(
        '설정을 저장하지 못했습니다. 선택한 초안은 유지됩니다.',
      );
      await expect(page.getByRole('combobox', { name: '기본 모델', exact: true })).toHaveValue(
        'gpt-6.1-sol',
      );
      await expect(page.getByRole('combobox', { name: '합성 비교 모델', exact: true })).toHaveValue(
        'gpt-6-luna',
      );
      await expect(page.getByText('AI 설정을 저장했습니다.', { exact: true })).toHaveCount(0);
      expect(requests).toHaveLength(1);
    }
    expect(await get(next, identityWebOrigin, alice)).toEqual(original);
    expect(await get(vite, identityMobileOrigin, viteAlice)).toEqual(original);
    for (const [page, origin, session] of [
      [next, identityWebOrigin, alice],
      [vite, identityMobileOrigin, viteAlice],
    ] as const) {
      const catalog = await page.request.get(`${origin}/bff/v1/ai-settings/catalog`, {
        headers: headers(origin, session),
      });
      expect(catalog.status()).toBe(200);
      expect(catalog.headers()['cache-control']).toBe('no-store');
      aiExecutionCatalogV1Schema.parse(await catalog.json());
      expect(
        aiSettingsV1Schema.parse(await (await put(page, origin, session, command, 200)).json()),
      ).toEqual(original);
      await put(page, origin, session, { ...command, idempotencyKey: randomUUID() }, 503);
      const collision = await put(
        page,
        origin,
        session,
        { ...command, defaultSelection: null },
        409,
      );
      expect(errorCode(await collision.json())).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(await get(bob, identityWebOrigin, bobSession)).toMatchObject({
      revision: 0,
      defaultSelection: null,
      syntheticComparison: { kind: 'off' },
    });
    await put(
      bob,
      identityWebOrigin,
      bobSession,
      { ...command, idempotencyKey: randomUUID() },
      503,
    );
    const { idempotencyKey: ignoredKey, ...foreignBody } = command;
    void ignoredKey;
    const foreign = await bob.request.put(`${identityWebOrigin}/bff/v1/ai-settings`, {
      headers: { ...headers(identityWebOrigin, bobSession), 'idempotency-key': randomUUID() },
      data: { ...foreignBody, athleteId: alice.athleteId },
    });
    expect(foreign.status()).toBe(400);
    expect(foreign.headers()['cache-control']).toBe('no-store');
    expect(errorCode(await foreign.json())).toBe('INVALID_REQUEST');
    expect(await readAiSettingsLifecycleFacts(alice.athleteId)).toEqual(beforeAlice);
    expect(await readAiSettingsLifecycleFacts(bobSession.athleteId)).toEqual(beforeBob);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
