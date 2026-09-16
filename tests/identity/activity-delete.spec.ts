import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activitySchema,
  activityListSchema,
} from '../../packages/contracts/src/activity';

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

// Only this generated fixture is deleted; existing accounts, plans and other activities remain intact.
test('selected local deletion requires renewed confirmation after a real revision conflict and suppresses reimports', async ({
  page,
  browser,
}) => {
  const headers = await login(page, 'Alice');
  const marker = `Synthetic deletion ${randomUUID()}`;
  const sourceId = randomUUID();
  const body = {
    source: { kind: 'fixture', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: marker,
      kind: 'running',
      startedAt: '2016-03-01T08:00:00+09:00',
      timezone: 'Asia/Seoul',
      durationSeconds: null,
      durationKind: 'unknown',
      distanceMeters: 0,
    },
  };
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: body,
  });
  expect(imported.status()).toBe(200);
  const created = activityImportResultSchema.parse(await imported.json());
  const path = `/bff/v1/activities/${created.activityId}`;
  const read = async () => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return activitySchema.parse(await response.json());
  };
  try {
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const otherHeaders = await login(other, 'Bob');
      const denied = await other.request.delete(path, {
        headers: otherHeaders,
        data: { expectedRevision: created.revision },
      });
      expect(denied.status()).toBe(404);
      expect((await read()).revision).toBe(created.revision);
    } finally {
      await otherContext.close();
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(
      `/activities?${new URLSearchParams({ selected: created.activityId, search: marker })}`,
    );
    const detail = page.getByRole('region', { name: '선택한 활동 상세', exact: true });
    await expect(detail).toContainText(marker);
    const deletion = page.getByRole('region', { name: '활동 로컬 삭제', exact: true });
    const beginDelete = deletion.getByRole('button', { name: '이 활동 로컬 삭제', exact: true });
    await beginDelete.focus();
    await beginDelete.press('Enter');
    const confirmation = deletion.getByRole('group', { name: '로컬 삭제 확인', exact: true });
    await expect(confirmation).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(confirmation).toContainText('제공자 원본은 삭제하지 않습니다.');
    const cancel = confirmation.getByRole('button', { name: '로컬 삭제 취소', exact: true });
    await expect(cancel).toBeFocused();
    await cancel.press('Enter');
    await expect(confirmation).toHaveCount(0);
    await expect(beginDelete).toBeFocused();
    expect((await read()).revision).toBe(created.revision);
    await beginDelete.focus();
    await beginDelete.press('Enter');
    const updatedResponse = await page.request.patch(path, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: created.revision,
        reason: 'Synthetic competing correction',
        distanceMeters: 42,
      },
    });
    expect(updatedResponse.status()).toBe(200);
    const updated = activitySchema.parse(await updatedResponse.json());
    const confirm = confirmation.getByRole('button', { name: '이 활동 삭제 확인', exact: true });
    await confirm.focus();
    await expect(confirm).toBeFocused();
    const conflictResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname === path,
    );
    await confirm.press('Enter');
    expect((await conflictResponse).status()).toBe(409);
    await expect(confirmation).toHaveCount(0);
    await expect(deletion).toContainText(
      '활동이 변경되었습니다. 최신 기록을 확인한 뒤 삭제를 다시 확인하세요.',
    );
    expect((await read()).revision).toBe(updated.revision);
    await expect(detail).toContainText('42m');
    // A changed revision requires a fresh explicit review; the failed confirmation cannot delete it.
    await beginDelete.focus();
    await beginDelete.press('Enter');
    await expect(confirmation).toContainText(String(updated.revision));
    await confirm.focus();
    const deletedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname === path,
    );
    await confirm.press('Enter');
    expect((await deletedResponse).status()).toBe(204);
    await expect(page).not.toHaveURL(/selected=/);
    await expect(detail).toHaveCount(0);
    await expect(
      page.getByText('조회 조건에 맞는 활동 0개 · 현재 페이지 0개', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: marker, exact: true })).toHaveCount(0);
    const filtered = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ search: marker })}`,
      { headers },
    );
    expect(filtered.status()).toBe(200);
    expect(activityListSchema.parse(await filtered.json()).total).toBe(0);
    expect((await page.request.get(`${path}/context`, { headers })).status()).toBe(404);
    // Repeating a successful delete is harmless, and neither identical nor newer source data revives it.
    expect(
      (
        await page.request.delete(path, { headers, data: { expectedRevision: updated.revision } })
      ).status(),
    ).toBe(204);
    for (const revision of [1, 2]) {
      const replay = await page.request.post('/bff/v1/activity-imports', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          ...body,
          source: {
            ...body.source,
            revision,
            contentHash: (revision === 1 ? 'a' : 'b').repeat(64),
          },
        },
      });
      expect(replay.status()).toBe(200);
      expect(activityImportResultSchema.parse(await replay.json())).toMatchObject({
        outcome: 'suppressed',
        activityId: created.activityId,
      });
    }
    expect((await page.request.get(`${path}/context`, { headers })).status()).toBe(404);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    const remaining = await page.request.get(path, { headers });
    if (remaining.status() === 200) {
      const value = activitySchema.parse(await remaining.json());
      expect(
        (
          await page.request.delete(path, { headers, data: { expectedRevision: value.revision } })
        ).status(),
      ).toBe(204);
    } else expect(remaining.status()).toBe(404);
  }
});
