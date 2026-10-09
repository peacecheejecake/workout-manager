import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
} from '../../packages/contracts/src/ai-settings';
import { publishAiSettingsFixtureCatalog } from '../../scripts/fixtures/ai-settings-catalog';
import {
  readAiSettingsFixtureContext,
  readAiSettingsFixtureFacts,
} from '../../scripts/fixtures/ai-settings-context';

function parseSession(value: unknown) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'athleteId' in value &&
      typeof value.athleteId === 'string' &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      'csrfToken' in value &&
      typeof value.csrfToken === 'string',
    'INVALID_SYNTHETIC_SESSION',
  );
  return { athleteId: value.athleteId, sessionId: value.sessionId, csrfToken: value.csrfToken };
}
const sessions = new WeakMap<Page, ReturnType<typeof parseSession>>();
async function login(page: Page, account: 'Alice' | 'Bob', origin: string) {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${account}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  const session = parseSession(await response.json());
  sessions.set(page, session);
  return session;
}
const headers = (page: Page, session: ReturnType<typeof parseSession>) => ({
  origin: new URL(page.url()).origin,
  'x-workout-session-id': session.sessionId,
  'x-csrf-token': session.csrfToken,
});
async function readSettings(page: Page) {
  const session = sessions.get(page);
  assert.ok(session, 'MISSING_SYNTHETIC_SESSION');
  const response = await page.request.get(`${new URL(page.url()).origin}/bff/v1/ai-settings`, {
    headers: { 'x-workout-session-id': session.sessionId },
  });
  expect(response.status()).toBe(200);
  return aiSettingsV1Schema.parse(await response.json());
}
async function saveFromUi(page: Page, expectedStatus = 200) {
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bff/v1/ai-settings') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  expect((await response).status()).toBe(expectedStatus);
}
async function erase(page: Page, session: ReturnType<typeof parseSession>) {
  const response = await page.request.delete(
    `${new URL(page.url()).origin}/bff/v1/operations/account`,
    {
      headers: headers(page, session),
      data: { confirmation: 'DELETE MY ACCOUNT' },
    },
  );
  expect(response.status()).toBe(200);
}

// Real local OIDC, BFF, PostgreSQL and UI. No route interception/MSW, no provider
// request or API key. Synthetic catalog is unconfigured, not actual API availability.
// Root runs this only after composing the private fixture helpers into the harness.
for (const [shell, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${shell}: selectOption functional diagnostic: settings save/reload/isolation/CAS/revocation (keyboard not verified)`, async ({
    page,
    browser,
  }) => {
    const { ownerUrl } = await readAiSettingsFixtureContext();
    await publishAiSettingsFixtureCatalog(ownerUrl, { selectable: true });
    const alice = await login(page, 'Alice', origin);
    const baseline = await readAiSettingsFixtureFacts(alice.athleteId);
    let bobPage: Page | undefined;
    let bob: ReturnType<typeof parseSession> | undefined;
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      await page.goto(`${origin}/settings`);
      await expect(page.getByRole('heading', { name: 'AI 설정', exact: true })).toBeVisible();
      await expect(
        page.getByText('전체 사용자·모델 합산 월 50,000원 한도 · Asia/Seoul 기준'),
      ).toBeVisible();
      await expect(
        page.getByText(/저장만으로 정보를 전송하거나 전송에 동의하지 않으며/),
      ).toBeVisible();
      await expect(page.getByRole('combobox', { name: '기본 제공자', exact: true })).toHaveValue(
        '',
      );
      await expect(page.getByRole('combobox', { name: '합성 비교 사용', exact: true })).toHaveValue(
        'off',
      );
      expect(await readSettings(page)).toMatchObject({
        revision: 0,
        defaultSelection: null,
        syntheticComparison: { kind: 'off' },
      });
      await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();

      await page.setViewportSize({ width: 320, height: 740 });
      const provider = page.getByRole('combobox', { name: '기본 제공자', exact: true });
      await provider.focus();
      await expect(provider).toBeFocused();
      await provider.selectOption('openai');
      await expect(provider).toHaveValue('openai');
      const model = page.getByRole('combobox', { name: '기본 모델', exact: true });
      await model.focus();
      await expect(model).toBeFocused();
      await model.selectOption('gpt-6.1-sol');
      await expect(model).toHaveValue('gpt-6.1-sol');
      await page
        .getByRole('combobox', { name: '합성 비교 사용', exact: true })
        .selectOption('selected');
      await page
        .getByRole('combobox', { name: '합성 비교 제공자', exact: true })
        .selectOption('openai');
      await page
        .getByRole('combobox', { name: '합성 비교 모델', exact: true })
        .selectOption('gpt-6-luna');
      await expect(
        page.getByText('합성 비교용 선택만 저장합니다. 비교는 자동으로 실행되지 않습니다.'),
      ).toBeVisible();
      await expect(page.getByLabel('기본 정보 전송 안내')).toContainText('정보를 받는 곳: OpenAI');
      const scope = page.getByLabel('기본 정보 전송 안내');
      for (const label of ['계획 요약', '실제 기록 요약', '체크인', '참고 자료 발췌'])
        await expect(scope).toContainText(label);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await saveFromUi(page);
      await expect(page.getByRole('status')).toHaveText('AI 설정을 저장했습니다.');
      await page.reload();
      await expect(model).toHaveValue('gpt-6.1-sol');
      await expect(page.getByRole('combobox', { name: '합성 비교 모델', exact: true })).toHaveValue(
        'gpt-6-luna',
      );
      expect(await readSettings(page)).toMatchObject({
        revision: 1,
        defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
        syntheticComparison: {
          kind: 'selected',
          selection: { providerId: 'openai', modelId: 'gpt-6-luna' },
        },
      });

      const secondTab = await page.context().newPage();
      try {
        await secondTab.goto(`${origin}/settings`);
        await expect(
          secondTab.getByRole('combobox', { name: '기본 모델', exact: true }),
        ).toHaveValue('gpt-6.1-sol');
        await secondTab
          .getByRole('combobox', { name: '합성 비교 사용', exact: true })
          .selectOption('off');
        await saveFromUi(secondTab);
        await provider.selectOption('');
        await saveFromUi(page, 409);
        await expect(page.getByRole('status')).toHaveText(
          '설정이 변경되었습니다. 초안을 유지했으니 최신 설정을 다시 확인해 주세요.',
        );
        await expect(provider).toHaveValue('');
        const refreshed = page.waitForResponse(
          (response) =>
            response.url().endsWith('/bff/v1/ai-settings') && response.request().method() === 'GET',
        );
        await page.getByRole('button', { name: '최신 설정 다시 확인', exact: true }).click();
        expect((await refreshed).status()).toBe(200);
        await (await refreshed).finished();
        await expect(
          page.getByRole('button', { name: '최신 설정 다시 확인', exact: true }),
        ).toBeEnabled();
        await expect(provider).toHaveValue(''); // Explicit reload does not replace the user's draft.
        await page.getByRole('button', { name: '변경 취소', exact: true }).click();
        await expect(provider).toBeFocused();
        await expect(provider).toHaveValue('openai');
        await expect(
          page.getByRole('combobox', { name: '합성 비교 사용', exact: true }),
        ).toHaveValue('off');
        expect((await readSettings(page)).revision).toBe(2);
      } finally {
        await secondTab.close();
      }

      bobPage = await otherContext.newPage();
      bob = await login(bobPage, 'Bob', origin);
      expect(bob.athleteId).not.toBe(alice.athleteId);
      await bobPage.goto(`${origin}/settings`);
      await expect(bobPage.getByRole('combobox', { name: '기본 제공자', exact: true })).toHaveValue(
        '',
      );
      expect(await readSettings(bobPage)).toMatchObject({
        revision: 0,
        defaultSelection: null,
        syntheticComparison: { kind: 'off' },
      });

      const revoked = await publishAiSettingsFixtureCatalog(ownerUrl, { selectable: false });
      await page.reload();
      await expect(model).toHaveValue('gpt-6.1-sol');
      const revokedOption = model.getByRole('option', {
        name: 'Sol · 현재 선택 불가',
        exact: true,
      });
      await expect(revokedOption).toHaveAttribute('disabled', '');
      await expect(revokedOption).toHaveJSProperty('disabled', true);
      await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
      const stored = await readSettings(page);
      expect(stored.defaultSelection?.modelId).toBe('gpt-6.1-sol');
      const command = aiSettingsWriteV1Schema.parse({
        schemaVersion: 1,
        expectedRevision: stored.revision,
        catalogRevision: revoked.catalogRevision,
        policyVersion: revoked.policyVersion,
        disclosureVersion: revoked.disclosureVersion,
        defaultSelection: stored.defaultSelection,
        syntheticComparison: stored.syntheticComparison,
        idempotencyKey: randomUUID(),
      });
      const { idempotencyKey, ...body } = command;
      const denied = await page.request.put(`${origin}/bff/v1/ai-settings`, {
        headers: { ...headers(page, alice), 'idempotency-key': idempotencyKey },
        data: body,
      });
      expect(denied.status()).toBe(422);
      expect(await denied.json()).toMatchObject({ error: { code: 'DEFAULT_NOT_SELECTABLE' } });
      expect((await readSettings(page)).revision).toBe(2);
      const after = await readAiSettingsFixtureFacts(alice.athleteId);
      expect(after).toEqual({ ...baseline, settingsRevision: 2, settingsHistoryCount: 2 });
    } finally {
      await publishAiSettingsFixtureCatalog(ownerUrl, { selectable: true });
      if (bobPage && bob) await erase(bobPage, bob);
      await erase(page, alice);
      await otherContext.close();
    }
  });
}
