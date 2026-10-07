import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { checkInTemplateVersionSchema } from '../../packages/contracts/src/check-in-templates';
import {
  checkInCommandResultSchema,
  checkInSchema,
  checkInListSchema,
} from '../../packages/contracts/src/check-ins';
import {
  routineBlueprintReadSchema,
  routineRunReadSchema,
} from '../../packages/contracts/src/routine-commands';
import { identityWebOrigin, identityMobileOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';
// Requires explicit isolated IDENTITY_E2E_CHECK_IN_TEMPLATES=staged-123.
// Real HTTP/UI producers and local synthetic OIDC only. No mocked responses,
// owner health seeds, provider/device/authenticity or copied-purge/restore claim.
async function login(page: Page, origin: string) {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await grantAppProcessingForScenario(page);
  const reply = await page.request.get(`${origin}/bff/v1/session`);
  expect(reply.status()).toBe(200);
  const session: unknown = await reply.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      session.sessionId.length > 0 &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string' &&
      session.csrfToken.length > 0,
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
async function reflow(page: Page) {
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 900 });
}
for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: public CheckIn template frozen routine and explicit actual link with zero/null`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(`${origin}/account`);
    const headers = await login(page, origin),
      key = () => ({ ...headers, 'idempotency-key': randomUUID() });
    try {
      await page.setViewportSize({ width: 320, height: 900 });
      const beforeResponse = await page.request.get(
        `${origin}/bff/v1/check-ins?from=2026-10-06&toExclusive=2026-10-07`,
        { headers },
      );
      expect(beforeResponse.status()).toBe(200);
      const before = checkInListSchema.parse(await beforeResponse.json());
      await page.goto(`${origin}/routines`);
      const workspace = page.getByRole('region', { name: '범용 루틴 작업 공간' });
      await workspace.getByRole('button', { name: '새 루틴' }).click();
      const title = `합성 체크인 루틴 ${randomUUID()}`;
      const titleInput = workspace.getByRole('textbox', { name: '제목', exact: true });
      await titleInput.dispatchEvent('compositionstart');
      await titleInput.fill(title);
      await titleInput.dispatchEvent('compositionend');
      await workspace.getByRole('button', { name: '단계 추가' }).click();
      await workspace.getByRole('textbox', { name: '단계 제목' }).fill('피로 직접 보고');
      await workspace.getByRole('combobox', { name: '종류' }).selectOption('checkin_template');
      await workspace
        .getByRole('textbox', { name: '체크인 템플릿 제목' })
        .fill(`합성 직접 보고 ${host}`);
      await expect(workspace).toContainText(
        '저장해도 날짜가 있는 실제 체크인이 생성되지 않습니다.',
      );
      const templateResponse = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).origin === origin &&
          new URL(reply.url()).pathname === '/bff/v1/check-in-templates' &&
          reply.request().method() === 'POST',
      );
      const saveTemplate = workspace.getByRole('button', {
        name: '체크인 입력 항목 저장',
        exact: true,
      });
      await saveTemplate.focus();
      await expect(saveTemplate).toBeFocused();
      await saveTemplate.press('Enter');
      const templateReply = await templateResponse;
      expect(templateReply.status()).toBe(200);
      const template = checkInTemplateVersionSchema.parse(await templateReply.json());
      await expect(workspace).toContainText('입력 항목을 저장했습니다.');
      await expect(workspace).toContainText('사용자 직접 보고 (self_report)');
      const select = workspace.getByRole('button', { name: '이 고정 버전 선택' });
      await select.focus();
      await select.press('Enter');
      await reflow(page);
      const blueprintResponse = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).origin === origin &&
          new URL(reply.url()).pathname === '/bff/v1/routines' &&
          reply.request().method() === 'POST',
      );
      await workspace.getByRole('button', { name: '루틴 버전 저장' }).click();
      const blueprintReply = await blueprintResponse;
      expect(blueprintReply.status()).toBe(200);
      const saved = routineBlueprintReadSchema.parse(await blueprintReply.json());
      expect(saved.blueprint.steps[0]?.content).toEqual({
        kind: 'checkin_template',
        ref: { id: template.templateId, versionId: template.versionId },
      });
      const unchangedResponse = await page.request.get(
        `${origin}/bff/v1/check-ins?from=2026-10-06&toExclusive=2026-10-07`,
        { headers },
      );
      expect(unchangedResponse.status()).toBe(200);
      expect(checkInListSchema.parse(await unchangedResponse.json())).toEqual(before);
      const update = await page.request.post(`${origin}/bff/v1/check-in-templates`, {
        headers: key(),
        data: {
          templateId: template.templateId,
          expectedVersion: 1,
          content: { ...template.content, title: '새 합성 질문 머리', fields: ['note', 'fatigue'] },
        },
      });
      expect(update.status()).toBe(200);
      const newer = checkInTemplateVersionSchema.parse(await update.json());
      expect(newer.version).toBe(2);
      expect(newer.versionId).not.toBe(template.versionId);
      const historical = await page.request.get(
        `${origin}/bff/v1/check-in-templates/${template.templateId}/versions/${template.versionId}`,
        { headers },
      );
      expect(historical.status()).toBe(200);
      expect(checkInTemplateVersionSchema.parse(await historical.json())).toEqual(template);
      const exactBlueprint = await page.request.get(
        `${origin}/bff/v1/routine-versions/${saved.blueprint.versionId}`,
        { headers },
      );
      expect(exactBlueprint.status()).toBe(200);
      expect(await exactBlueprint.json()).toEqual(saved.blueprint);
      await workspace.getByRole('link', { name: title, exact: true }).click();
      const startResponse = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).origin === origin &&
          new URL(reply.url()).pathname === '/bff/v1/routine-runs' &&
          reply.request().method() === 'POST',
      );
      await workspace.getByRole('button', { name: '계획 없이 실행', exact: true }).click();
      const startReply = await startResponse;
      expect(startReply.status()).toBe(200);
      // Both Hosts navigate immediately after the committed start. The old
      // response body can be released by Chromium during navigation; verify the
      // authoritative stored run through its actual destination instead.
      await expect(page).toHaveURL(/\/routine-runs\/[0-9a-f-]+$/);
      const startedRunId = new URL(page.url()).pathname.split('/').at(-1);
      assert.ok(
        startedRunId &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(startedRunId),
      );
      const startedRunRead = await page.request.get(
        `${origin}/bff/v1/routine-runs/${startedRunId}`,
        { headers },
      );
      expect(startedRunRead.status()).toBe(200);
      const run = routineRunReadSchema.parse(await startedRunRead.json());
      expect(run.run.id).toBe(startedRunId);
      expect(run.run.blueprint.versionId).toBe(saved.blueprint.versionId);
      expect(run.run.origin).toEqual({ kind: 'unplanned' });
      const create = await page.request.post(`${origin}/bff/v1/check-ins`, {
        headers: key(),
        data: {
          values: {
            observedAt: '2026-10-06T00:00:00Z',
            timezone: 'UTC',
            fatigue: 0,
            discomfort: null,
            bodyLocation: null,
            note: null,
          },
        },
      });
      expect(create.status()).toBe(200);
      const actual = checkInCommandResultSchema.parse(await create.json());
      const actualInput = workspace.getByRole('textbox', { name: '실제 체크인 ID (UUID)' });
      await actualInput.fill('not-a-uuid');
      await workspace.getByRole('button', { name: '실제 체크인 확인', exact: true }).click();
      await expect(workspace).toContainText('실제 체크인 UUID를 입력하세요.');
      await expect(workspace.getByRole('button', { name: '수행 확인' })).toBeDisabled();
      await actualInput.fill(actual.id);
      await workspace.getByRole('button', { name: '실제 체크인 확인', exact: true }).click();
      await expect(workspace).toContainText('피로: 0 / 불편감: 미상');
      await expect(workspace.getByRole('button', { name: '수행 확인' })).toBeDisabled();
      await workspace.getByRole('button', { name: '이 실제 체크인 연결' }).click();
      const actualReadResponse = await page.request.get(`${origin}/bff/v1/check-ins/${actual.id}`, {
        headers,
      });
      const observation = checkInSchema.parse(await actualReadResponse.json());
      const correction = await page.request.put(`${origin}/bff/v1/check-ins/${actual.id}`, {
        headers: key(),
        data: {
          expectedRevision: actual.revision,
          reason: '합성 메모 정정',
          values: { ...observation.values, note: '합성 정정' },
        },
      });
      expect(correction.status()).toBe(200);
      const corrected = checkInCommandResultSchema.parse(await correction.json());
      const staleResponse = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).origin === origin &&
          new URL(reply.url()).pathname === `/bff/v1/routine-runs/${run.run.id}/steps` &&
          reply.request().method() === 'POST',
      );
      await workspace.getByRole('button', { name: '수행 확인' }).click();
      expect((await staleResponse).status()).toBe(404);
      await expect(workspace).toContainText('연결 대상이 없거나 현재 계정에서 볼 수 없습니다.');
      const unrecorded = await page.request.get(`${origin}/bff/v1/routine-runs/${run.run.id}`, {
        headers,
      });
      expect(routineRunReadSchema.parse(await unrecorded.json()).run.progress).toEqual([]);
      await workspace.getByRole('button', { name: '실제 체크인 확인', exact: true }).click();
      await expect(workspace).toContainText(`숫자 revision: ${corrected.revision}`);
      await workspace.getByRole('button', { name: '이 실제 체크인 연결' }).click();
      const recordResponse = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).origin === origin &&
          new URL(reply.url()).pathname === `/bff/v1/routine-runs/${run.run.id}/steps` &&
          reply.request().method() === 'POST',
      );
      const perform = workspace.getByRole('button', { name: '수행 확인' });
      await perform.focus();
      await perform.press('Enter');
      const recordReply = await recordResponse;
      expect(recordReply.status()).toBe(200);
      const recorded = routineRunReadSchema.parse(await recordReply.json());
      expect(recorded.run.progress[0]?.actualRefs).toEqual([
        { kind: 'checkin', id: actual.id, revisionId: String(corrected.revision) },
      ]);
      await expect(workspace).toContainText('수행 1개 · 미확인 0개');
      const afterResponse = await page.request.get(
        `${origin}/bff/v1/check-ins?from=2026-10-06&toExclusive=2026-10-07`,
        { headers },
      );
      const after = checkInListSchema.parse(await afterResponse.json());
      expect(after.total).toBe(before.total + 1);
      expect(after.items.find((item) => item.id === actual.id)?.values).toMatchObject({
        fatigue: 0,
        discomfort: null,
      });
      await reflow(page);
      await page.goto(`${origin}/account`);
      await page.getByRole('button', { name: '앱 처리 동의 철회', exact: true }).click();
      await expect(
        page.getByText('현재 앱 저장·처리: 허용하지 않음', { exact: true }),
      ).toBeVisible();
      const retained = await page.request.get(
        `${origin}/bff/v1/check-in-templates/${template.templateId}/versions/${template.versionId}`,
        { headers },
      );
      expect(retained.status()).toBe(200);
      expect(checkInTemplateVersionSchema.parse(await retained.json())).toEqual(template);
      await page.goto(`${origin}/routines/${saved.blueprint.routineId}/edit`);
      await workspace
        .getByRole('textbox', { name: '체크인 템플릿 제목' })
        .fill('철회 후 유지할 질문');
      await workspace.getByRole('button', { name: '체크인 입력 항목 저장', exact: true }).click();
      await expect(workspace).toContainText('앱 데이터 처리 동의가 필요합니다. 입력은 유지됩니다.');
      await expect(workspace.getByRole('textbox', { name: '체크인 템플릿 제목' })).toHaveValue(
        '철회 후 유지할 질문',
      );
      await expect(workspace).not.toContainText('입력 항목을 저장했습니다.');
    } finally {
      const erased = await page.request.delete(`${origin}/bff/v1/operations/account`, {
        headers,
        data: { confirmation: 'DELETE MY ACCOUNT' },
        timeout: 10000,
      });
      expect(erased.status()).toBe(200);
    }
  });
}
