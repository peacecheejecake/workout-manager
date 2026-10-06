import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { consentSchema } from '../../apps/api/src/ports';
import {
  raceCommandResultSchema,
  raceEventCreateCommandSchema,
  type RaceEventValues,
} from '../../packages/contracts/src/race-commands';
import { raceEventSchema } from '../../packages/contracts/src/races';
import { raceEventListPageSchema } from '../../packages/contracts/src/race-queries';
import {
  accountExportSchema,
  eraseAccountResultSchema,
} from '../../packages/contracts/src/operations';
import { shells } from './course-editor-support';

/** Actual local OIDC/browser/API/PostgreSQL acceptance. No auth/network/business mocks.
 * The account tab changes permission while the race tab retains its in-memory draft.
 * No health draft, session credential or OIDC query is stored in URL/browser storage.
 * Real native IME/WKWebView/provider/production acceptance remains separate. */
type Headers = Record<string, string>;
async function login(page: Page, name: 'Alice' | 'Bob'): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await request(page, 'GET', '/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      session.sessionId.length > 0 &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string' &&
      session.csrfToken.length >= 32,
  );

  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
/** Avoid printing authentication headers if a context expires or transport fails. */
async function request(
  page: Page,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  headers?: Headers,
  data?: unknown,
) {
  try {
    return await page.request.fetch(url, {
      method,
      ...(headers === undefined ? {} : { headers }),
      ...(data === undefined ? {} : { data }),
      timeout: 10000,
    });
  } catch {
    throw new Error(`SYNTHETIC_${method}_REQUEST_FAILED`);
  }
}
const writeHeaders = (headers: Headers, key: string = randomUUID()) => ({
  ...headers,
  'idempotency-key': key,
});
async function changeConsent(account: Page, granted: boolean) {
  await expect(
    account.getByRole('heading', { name: '앱 저장·처리 동의', exact: true }),
  ).toBeVisible();
  const [response] = await Promise.all([
    account.waitForResponse(
      (r) => new URL(r.url()).pathname === '/bff/v1/consents/app' && r.request().method() === 'PUT',
      { timeout: 10000 },
    ),
    account
      .getByRole('button', {
        name: granted ? '앱 저장·처리에 동의' : '앱 처리 동의 철회',
        exact: true,
      })
      .click(),
  ]);
  expect(response.status()).toBe(200);
  expect(consentSchema.parse(await response.json()).granted).toBe(granted);
}
async function readConsent(page: Page, headers: Headers) {
  const response = await request(page, 'GET', '/bff/v1/consents/app', headers);
  expect(response.status()).toBe(200);
  return consentSchema.parse(await response.json());
}
async function save(
  page: Page,
  panel: Locator,
  method: 'POST' | 'PATCH',
  path: string,
  status: 201 | 200 | 409,
) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === path && r.request().method() === method,
      { timeout: 10000 },
    ),
    panel.getByRole('button', { name: '저장', exact: true }).click(),
  ]);
  expect(response.status()).toBe(status);
  if (status === 409) {
    expect(await response.json()).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
    await expect(panel.getByRole('alert')).toContainText('앱 저장·처리 동의가 필요');
    return null;
  }
  return raceCommandResultSchema.parse(await response.json());
}
async function snapshot(page: Page, headers: Headers) {
  const response = await request(page, 'POST', '/bff/v1/operations/export', writeHeaders(headers));
  expect(response.status()).toBe(200);
  const exported = accountExportSchema.parse(await response.json());
  assert.equal(exported.schemaVersion, 31);
  if (exported.schemaVersion !== 31) throw new Error('RACE_EXPORT_VERSION_REQUIRED');
  return {
    events: exported.data.raceEvents,
    revisions: exported.data.raceEventRevisions,
    heads: exported.data.raceCollectionHeads,
  };
}
async function erase(page: Page, headers: Headers) {
  const response = await request(page, 'DELETE', '/bff/v1/operations/account', headers, {
    confirmation: 'DELETE MY ACCOUNT',
  });
  expect(response.status()).toBe(200);
  expect(eraseAccountResultSchema.parse(await response.json()).erased).toBe(true);
}
for (const shell of shells)
  test(`${shell.name}: real app consent UI revocation, draft recovery and retained race operations`, async ({
    browser,
  }) => {
    test.setTimeout(120000);
    const aliceContext = await browser.newContext({ baseURL: shell.origin });
    const bobContext = await browser.newContext({ baseURL: shell.origin });
    const account = await aliceContext.newPage(),
      editor = await aliceContext.newPage(),
      newEditor = await aliceContext.newPage(),
      bob = await bobContext.newPage();
    try {
      const headers = await login(account, 'Alice');
      const initial = await readConsent(account, headers);
      if (initial.granted) await changeConsent(account, false);
      await changeConsent(account, true);
      expect((await readConsent(account, headers)).granted).toBe(true);
      const prefix = `Synthetic consent ${shell.name} ${randomUUID().slice(0, 8)}`;
      await editor.goto('/races');
      const panel = editor.getByRole('region', { name: '목표 대회', exact: true });
      await panel.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await panel.getByLabel('대회 이름', { exact: true }).fill(prefix);
      await panel.getByLabel('현지 날짜').fill('2080-01-03');
      await panel.getByLabel('IANA 시간대').fill('UTC');
      await panel.getByLabel('목표 시간 (초)').fill('0');
      const [createdResponse] = await Promise.all([
        editor.waitForResponse(
          (r) => new URL(r.url()).pathname === '/bff/v1/races' && r.request().method() === 'POST',
          { timeout: 10000 },
        ),
        panel.getByRole('button', { name: '저장', exact: true }).click(),
      ]);
      expect(createdResponse.status()).toBe(201);
      const created = raceCommandResultSchema.parse(await createdResponse.json());
      const rawBody: unknown = createdResponse.request().postDataJSON();
      assert.ok(typeof rawBody === 'object' && rawBody !== null);
      const command = raceEventCreateCommandSchema.parse({
        ...rawBody,
        idempotencyKey: await createdResponse.request().headerValue('idempotency-key'),
      });
      const createValues = command.values,
        key = command.idempotencyKey;
      const deletionValues: RaceEventValues = { ...createValues, title: `${prefix} 삭제용` };
      const deletionResponse = await request(
        editor,
        'POST',
        '/bff/v1/races',
        writeHeaders(headers),
        { values: deletionValues },
      );
      expect(deletionResponse.status()).toBe(201);
      const deletion = raceCommandResultSchema.parse(await deletionResponse.json());
      await panel.getByRole('button', { name: '목록 새로고침', exact: true }).click();
      const originalCard = panel
        .getByRole('listitem')
        .filter({ has: editor.getByRole('heading', { name: prefix, exact: true }) });
      await originalCard.getByRole('button', { name: '편집', exact: true }).click();
      await panel.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 수정 초안`);
      await changeConsent(account, false);
      expect((await readConsent(account, headers)).granted).toBe(false);
      await save(editor, panel, 'PATCH', `/bff/v1/races/${created.id}`, 409);
      await expect(panel.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 수정 초안`,
      );
      await newEditor.goto('/races');
      const freshPanel = newEditor.getByRole('region', { name: '목표 대회', exact: true });
      await freshPanel.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await freshPanel.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 새 초안`);
      await freshPanel.getByLabel('현지 날짜').fill('2080-01-04');
      await freshPanel.getByLabel('IANA 시간대').fill('UTC');
      await save(newEditor, freshPanel, 'POST', '/bff/v1/races', 409);
      await expect(freshPanel.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 새 초안`,
      );
      // Actual retained read/list/export plus receipt replay, while both browser drafts stay open.
      const read = await request(editor, 'GET', `/bff/v1/races/${created.id}`, headers);
      expect(read.status()).toBe(200);
      expect(raceEventSchema.parse(await read.json())).toMatchObject({
        title: prefix,
        revision: 1,
        targetSeconds: 0,
        localStartTime: null,
      });
      const list = await request(editor, 'GET', '/bff/v1/races', headers);
      expect(list.status()).toBe(200);
      expect(
        raceEventListPageSchema
          .parse(await list.json())
          .items.some((item) => item.id === created.id),
      ).toBe(true);
      const before = await snapshot(editor, headers);
      const replay = await request(editor, 'POST', '/bff/v1/races', writeHeaders(headers, key), {
        values: createValues,
      });
      expect(replay.status()).toBe(201);
      expect(raceCommandResultSchema.parse(await replay.json())).toEqual(created);
      expect(await snapshot(editor, headers)).toEqual(before);
      const deletionCard = panel
        .getByRole('listitem')
        .filter({ has: editor.getByRole('heading', { name: deletionValues.title, exact: true }) });
      await deletionCard.getByRole('button', { name: '삭제', exact: true }).click();
      const [removed] = await Promise.all([
        editor.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/bff/v1/races/${deletion.id}` &&
            r.request().method() === 'DELETE',
          { timeout: 10000 },
        ),
        panel.getByRole('button', { name: '삭제 확인', exact: true }).click(),
      ]);
      expect(removed.status()).toBe(200);
      await expect(deletionCard).toHaveCount(0);
      await expect(panel.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 수정 초안`,
      );
      await changeConsent(account, true);
      await expect(panel.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 수정 초안`,
      );
      const updated = await save(editor, panel, 'PATCH', `/bff/v1/races/${created.id}`, 200);
      expect(updated).toMatchObject({ id: created.id, revision: 2 });
      await expect(freshPanel.getByLabel('대회 이름', { exact: true })).toHaveValue(
        `${prefix} 새 초안`,
      );
      expect(await save(newEditor, freshPanel, 'POST', '/bff/v1/races', 201)).not.toBeNull();
      // Account switch actually remounts the authenticated lifetime; no browser storage or URL draft.
      await panel.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await panel.getByLabel('대회 이름', { exact: true }).fill(`${prefix} 비공개 미저장`);
      await editor.goto('/account');
      await editor.getByRole('button', { name: '로그아웃', exact: true }).click();
      const bobHeaders = await login(editor, 'Bob');
      await editor.goto('/races');
      await panel.getByRole('button', { name: '새 목표 대회 등록' }).click();
      await expect(panel.getByLabel('대회 이름', { exact: true })).toHaveValue('');
      await expect(editor.getByText(prefix, { exact: false })).toHaveCount(0);
      expect(editor.url()).toBe(`${shell.origin}/races`);
      expect((await readConsent(editor, bobHeaders)).granted).toBe(false);
      const foreign = await request(editor, 'GET', `/bff/v1/races/${created.id}`, bobHeaders);
      expect(foreign.status()).toBe(404);
      // Happy cleanup is authenticated. Failed assertions only close contexts: disposable runner
      // tears down PostgreSQL, avoiding an expired-context erase that could mask the first failure.
      await editor.goto('/account');
      await editor.getByRole('button', { name: '로그아웃', exact: true }).click();
      const aliceHeaders = await login(editor, 'Alice');
      await erase(editor, aliceHeaders);
      const separateBobHeaders = await login(bob, 'Bob');
      await erase(bob, separateBobHeaders);
    } finally {
      await Promise.allSettled([aliceContext.close(), bobContext.close()]);
    }
  });
