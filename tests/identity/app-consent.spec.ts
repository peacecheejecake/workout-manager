import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { activitySchema, manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { accountExportSchema } from '../../packages/contracts/src/operations';

function parseConsent(value: unknown) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      value.kind === 'app' &&
      'granted' in value &&
      typeof value.granted === 'boolean' &&
      'revision' in value &&
      typeof value.revision === 'number' &&
      Number.isInteger(value.revision) &&
      value.revision >= 0 &&
      value.revision <= 2147483647,
  );
  assert.deepEqual(Object.keys(value).sort(), ['granted', 'kind', 'revision']);
  return { kind: value.kind, granted: value.granted, revision: value.revision };
}
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
  );
  return { athleteId: value.athleteId, sessionId: value.sessionId, csrfToken: value.csrfToken };
}
const sessions = new WeakMap<Page, ReturnType<typeof parseSession>>();
async function login(page: Page, origin: string, account: 'Alice' | 'Bob') {
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
function headers(origin: string, session: ReturnType<typeof parseSession>) {
  return { origin, 'x-workout-session-id': session.sessionId, 'x-csrf-token': session.csrfToken };
}
async function changeFromUi(page: Page, label: string, granted: boolean, revision: number) {
  const received = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bff/v1/consents/app') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: label, exact: true }).click();
  const response = await received;
  expect(response.status()).toBe(200);
  expect(parseConsent(await response.json())).toEqual({ kind: 'app', granted, revision });
  const session = sessions.get(page);
  assert.ok(session);
  const current = await page.request.get(`${new URL(page.url()).origin}/bff/v1/consents/app`, {
    headers: headers(new URL(page.url()).origin, session),
  });
  expect(current.status()).toBe(200);
  expect(parseConsent(await current.json())).toEqual({ kind: 'app', granted, revision });
  await expect(
    page.getByText(`현재 앱 저장·처리: ${granted ? '허용' : '허용하지 않음'}`, { exact: true }),
  ).toBeVisible();
}

// Actual local OIDC/API/PostgreSQL/Next+Vite. No provider/device, route stubs,
// synthetic authority, implicit consent or change to CLOSED generation policy.
// Run only this spec with independent ports/runId and fresh normal105 fixture.
for (const [shell, origin, account, other] of [
  ['Next', identityWebOrigin, 'Alice', 'Bob'],
  ['Vite', identityMobileOrigin, 'Bob', 'Alice'],
] as const) {
  test(`${shell}: explicit refusal/grant/withdrawal preserves reads, export, deletion and rejected activity draft`, async ({
    page,
    browser,
  }) => {
    const session = await login(page, origin, account);
    const panel = page.getByRole('region', { name: '앱 저장·처리 동의', exact: true });
    await expect(panel).toContainText('계획·실제 기록·대화를 새로 저장하거나 처리');
    await expect(panel).toContainText('조회·내보내기·삭제는');
    await expect(panel).toContainText('HealthKit·Garmin');
    const initial = await page.request.get(`${origin}/bff/v1/consents/app`, {
      headers: headers(origin, session),
    });
    expect(parseConsent(await initial.json())).toEqual({
      kind: 'app',
      granted: false,
      revision: 0,
    });
    for (const width of [320, 767, 768, 1279, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(panel.getByRole('button', { name: '동의하지 않음', exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    const refusal = panel.getByRole('button', { name: '동의하지 않음', exact: true });
    await refusal.focus();
    await expect(refusal).toBeFocused();
    await changeFromUi(page, '동의하지 않음', false, 1);
    await changeFromUi(page, '앱 저장·처리에 동의', true, 2);
    const marker = `Synthetic app consent ${shell} ${randomUUID()}`;
    const key = randomUUID(),
      command = {
        confirmed: true,
        activity: {
          title: marker,
          kind: 'running',
          startedAt: '2021-11-07T05:30:00Z',
          timezone: 'America/New_York',
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: 0,
        },
        report: { sessionRpe: 0, note: null, planLink: null },
      };
    const created = await page.request.post(`${origin}/bff/v1/activities`, {
      headers: { ...headers(origin, session), 'idempotency-key': key },
      data: command,
    });
    expect(created.status()).toBe(200);
    const receipt = manualActivityResultSchema.parse(await created.json());
    await changeFromUi(page, '앱 처리 동의 철회', false, 3);
    const path = `${origin}/bff/v1/activities/${receipt.activityId}`;
    const retained = await page.request.get(path, { headers: headers(origin, session) });
    expect(retained.status()).toBe(200);
    expect(activitySchema.parse(await retained.json()).effective).toMatchObject({
      title: marker,
      distanceMeters: 0,
      durationSeconds: null,
    });
    const replay = await page.request.post(`${origin}/bff/v1/activities`, {
      headers: { ...headers(origin, session), 'idempotency-key': key },
      data: command,
    });
    expect(replay.status()).toBe(200);
    expect(manualActivityResultSchema.parse(await replay.json())).toEqual(receipt);
    const exported = await page.request.post(`${origin}/bff/v1/operations/export`, {
      headers: headers(origin, session),
    });
    expect(exported.status()).toBe(200);
    const download = accountExportSchema.parse(await exported.json());
    expect(download.schemaVersion).toBe(33);
    expect(download.athleteId).toBe(session.athleteId);
    expect(download.data.activities.filter((row) => row['id'] === receipt.activityId)).toHaveLength(
      1,
    );
    const foreignContext = await browser.newContext();
    try {
      const foreignPage = await foreignContext.newPage();
      const foreign = await login(foreignPage, origin, other);
      expect(
        (await foreignPage.request.get(path, { headers: headers(origin, foreign) })).status(),
      ).toBe(404);
      const foreignExport = await foreignPage.request.post(`${origin}/bff/v1/operations/export`, {
        headers: headers(origin, foreign),
      });
      expect(foreignExport.status()).toBe(200);
      expect(
        accountExportSchema
          .parse(await foreignExport.json())
          .data.activities.some((row) => row['id'] === receipt.activityId),
      ).toBe(false);
    } finally {
      await foreignContext.close();
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${origin}/activities/new`);
    const title = page.getByLabel('활동 제목', { exact: true });
    await expect(title).toBeEnabled();
    await title.fill(`${marker} retained draft`);
    await title.dispatchEvent('compositionstart', { data: '합성' });
    await title.press('Enter');
    await expect(
      page.getByRole('button', { name: '실제 활동 확인하고 저장', exact: true }),
    ).toHaveCount(0);
    await title.dispatchEvent('compositionend', { data: '합성' });
    await page.getByRole('button', { name: '활동 저장 미리보기', exact: true }).click();
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/bff/v1/activities') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '실제 활동 확인하고 저장', exact: true }).click();
    const rejected = await denied;
    expect(rejected.status()).toBe(409);
    const error: unknown = await rejected.json();
    assert.ok(
      typeof error === 'object' &&
        error !== null &&
        'error' in error &&
        typeof error.error === 'object' &&
        error.error !== null &&
        'code' in error.error &&
        error.error.code === 'APP_CONSENT_REQUIRED',
    );
    await expect(
      page.getByText(
        '앱 저장·처리 동의가 필요합니다. 계정에서 동의 상태를 확인하세요. 초안은 유지됩니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(title).toHaveValue(`${marker} retained draft`);
    await expect(title).toBeEnabled();
    for (const width of [320, 767, 768, 1279, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(title).toHaveValue(`${marker} retained draft`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await title.focus();
    await expect(title).toBeFocused();
    await expect(page.getByText('활동 저장이 확인되었습니다.', { exact: true })).toHaveCount(0);
    const after = await page.request.post(`${origin}/bff/v1/operations/export`, {
      headers: headers(origin, session),
    });
    expect(after.status()).toBe(200);
    expect(accountExportSchema.parse(await after.json()).data.activities).toEqual(
      download.data.activities,
    );
    const removed = await page.request.delete(path, {
      headers: { ...headers(origin, session), 'idempotency-key': randomUUID() },
      data: { expectedRevision: receipt.revision },
    });
    expect(removed.status()).toBe(204);
    expect((await page.request.get(path, { headers: headers(origin, session) })).status()).toBe(
      404,
    );
    const unchanged = await page.request.get(`${origin}/bff/v1/consents/app`, {
      headers: headers(origin, session),
    });
    expect(parseConsent(await unchanged.json())).toEqual({
      kind: 'app',
      granted: false,
      revision: 3,
    });
  });
}

// Buffer the actual server response (not an invented success) until the account
// lifetime changes. No shared fixture, API or backend delay hook is used.
for (const [shell, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${shell}: a late real Alice consent response cannot overwrite Bob's account lifetime`, async ({
    page,
  }) => {
    const alice = await login(page, origin, 'Alice');
    const before = await page.request.get(`${origin}/bff/v1/consents/app`, {
      headers: headers(origin, alice),
    });
    let current = parseConsent(await before.json());
    if (!current.granted) {
      await changeFromUi(page, '앱 저장·처리에 동의', true, current.revision + 1);
      current = { ...current, granted: true, revision: current.revision + 1 };
    }
    let captured: () => void = () => undefined;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let capturedCount = 0;
    let complete: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await page.route('**/bff/v1/consents/app', async (route) => {
      if (route.request().method() !== 'GET' || held) {
        await route.continue();
        return;
      }
      held = true;
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const bytes = await response.body();
        expect(bytes.length).toBeLessThan(4096);
        const body: unknown = JSON.parse(bytes.toString('utf8'));
        expect(parseConsent(body)).toEqual(current);
        capturedCount++;
        captured();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            hold,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('SYNTHETIC_RESPONSE_BARRIER_TIMEOUT')),
                15000,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        // Abort on account reset may have already cancelled this old request.
        await route.fulfill({ response }).catch(() => undefined);
      } finally {
        complete();
      }
    });
    const other = await page.context().newPage();
    try {
      await page.reload();
      await ready;
      await expect(
        page.getByRole('button', { name: /^AI (전달에 동의|동의 철회)$/ }),
      ).toBeVisible();
      const logout = await other.request.post(`${origin}/bff/v1/auth/logout`, {
        headers: headers(origin, alice),
      });
      expect([200, 204]).toContain(logout.status());
      const bob = await login(other, origin, 'Bob');
      const bobHeadResponse = await other.request.get(`${origin}/bff/v1/consents/app`, {
        headers: headers(origin, bob),
      });
      const bobHead = parseConsent(await bobHeadResponse.json());
      expect(bobHead.granted).toBe(false);
      // The old tab's explicit write reaches the actual session-changed boundary.
      // No AI/app permission can be granted with Alice's expired session headers.
      const changed = page.waitForResponse(
        (response) =>
          response.url().endsWith('/bff/v1/consents/ai') && response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: /^AI (전달에 동의|동의 철회)$/ }).click();
      expect((await changed).status()).toBe(409);
      await expect(
        page.getByText(`로그인된 계정: ${bob.athleteId}`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('현재 앱 저장·처리: 허용하지 않음', { exact: true }),
      ).toBeVisible();
      release();
      await finished;
      expect(capturedCount).toBe(1);
      await expect(
        page.getByText(`로그인된 계정: ${alice.athleteId}`, { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('현재 앱 저장·처리: 허용', { exact: true })).toHaveCount(0);
      await expect(
        page.getByText('현재 앱 저장·처리: 허용하지 않음', { exact: true }),
      ).toBeVisible();
      const fresh = await page.request.get(`${origin}/bff/v1/consents/app`, {
        headers: headers(origin, bob),
      });
      expect(parseConsent(await fresh.json())).toEqual(bobHead);
    } finally {
      release();
      await page.unroute('**/bff/v1/consents/app');
      await other.close();
    }
  });
}
