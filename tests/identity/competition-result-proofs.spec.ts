import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Response } from '@playwright/test';
import { galleryMediaListSchema } from '../../packages/contracts/src/gallery';
import { privateResourceListSchema } from '../../packages/contracts/src/resources';
import { raceResultCapabilitiesSchema } from '../../packages/contracts/src/race-result-capabilities';
import {
  raceResultCompatibleReadSchema,
  raceResultCreateV2CommandSchema,
  raceResultV2CommandResultSchema,
} from '../../packages/contracts/src/race-result-v2';
import {
  raceResultValuesSchema,
  raceCommandResultSchema,
} from '../../packages/contracts/src/race-commands';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';
import { shells } from './course-editor-support';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WF0X7sAAAAASUVORK5CYII=',
  'base64',
);
/** Complete synthetic single-page PDF with real byte offsets/xref, not staged metadata. */
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 20 80 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
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
  await grantAppProcessingForScenario(page);
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
function write(headers: Record<string, string>, key: string = randomUUID()) {
  return { ...headers, 'idempotency-key': key };
}
async function readResult(page: Page, headers: Record<string, string>, id: string) {
  const response = await page.request.get(`/bff/v1/race-results/v2/${id}?schemaVersion=2`, {
    headers,
  });
  expect(response.status()).toBe(200);
  const record = raceResultCompatibleReadSchema.parse(await response.json());
  assert.ok('schemaVersion' in record && record.schemaVersion === 2);
  return record;
}

function waitForPublicResponse(page: Page, predicate: (response: Response) => boolean) {
  return page.waitForResponse(predicate, { timeout: 15_000 });
}

for (const shell of shells) {
  test(`${shell.name}: public PNG/PDF proof upload, immutable pin, actual-only edit and source removal`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const own = await browser.newContext({ baseURL: shell.origin });
    const other = await browser.newContext({ baseURL: shell.origin });
    try {
      const page = await own.newPage();
      const headers = await login(page, 'Alice');
      const token = randomUUID();
      const weatherNote = `한국어 합성 기록 ${token}`;
      const caption = `Synthetic finish ${token}`;
      const title = `Synthetic PDF ${token}`;
      const imageName = `finish-${token}.png`;
      const pdfName = `result-${token}.pdf`;
      const firstPdf = pdf('Synthetic reported result');
      const capabilities = await page.request.get('/bff/v1/race-results/capabilities', { headers });
      expect(capabilities.status()).toBe(200);
      expect(raceResultCapabilitiesSchema.parse(await capabilities.json())).toEqual({
        schemaVersion: 1,
        legacyResults: true,
        proofResultsV2: true,
      });
      await page.goto('/gallery');
      await page.getByLabel('설명 (선택)').fill(caption);
      await page
        .getByLabel('파일', { exact: true })
        .setInputFiles({ name: imageName, mimeType: 'image/png', buffer: png });
      await page.getByRole('button', { name: '올리기', exact: true }).click();
      await expect(page.getByRole('link', { name: caption, exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const galleryResponse = await page.request.get('/bff/v1/gallery/media?limit=50&offset=0', {
        headers,
      });
      expect(galleryResponse.status()).toBe(200);
      const image = galleryMediaListSchema
        .parse(await galleryResponse.json())
        .items.find((item) => item.file.originalFileName === imageName);
      assert.ok(image);
      const imageBytes = await page.request.get(
        `/bff/v1/gallery/media/${image.id}/content?variant=original`,
        { headers },
      );
      expect(imageBytes.status()).toBe(200);
      expect(await imageBytes.body()).toEqual(png);
      await page.goto('/resources');
      const upload = page.getByRole('form', { name: '파일 자료 만들기' });
      await upload.getByLabel('제목', { exact: true }).fill(title);
      await upload
        .getByLabel('원본 파일', { exact: true })
        .setInputFiles({ name: pdfName, mimeType: 'application/pdf', buffer: firstPdf });
      await upload.getByRole('button', { name: '원본 파일 업로드' }).click();
      await expect(page).toHaveURL(/\/resources\/[0-9a-f-]+$/);
      const resources = await page.request.get('/bff/v1/resources?limit=50&offset=0', { headers });
      expect(resources.status()).toBe(200);
      const resource = privateResourceListSchema
        .parse(await resources.json())
        .items.find((item) => item.title === title);
      assert.ok(resource?.sourceKind === 'file');
      const firstVersion = resource.currentVersionId;
      const downloaded = await page.request.get(
        `/bff/v1/resources/${resource.id}/content?versionId=${firstVersion}`,
        { headers },
      );
      expect(downloaded.status()).toBe(200);
      expect(await downloaded.body()).toEqual(firstPdf);

      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto('/records?section=results');
      const panel = page.getByRole('region', { name: '실제 대회 결과', exact: true });
      await panel.getByRole('button', { name: '새 실제 대회 결과 등록' }).click();
      await panel.getByLabel('현지 날짜', { exact: true }).fill('2080-01-03');
      await panel.getByLabel('IANA 시간대', { exact: true }).fill('Asia/Seoul');
      await panel.getByLabel('기록 출처', { exact: true }).selectOption('manual');
      await panel.getByLabel('Chip 시간 (초)', { exact: true }).fill('0');
      await panel.getByLabel('날씨 메모', { exact: true }).fill(weatherNote);
      await expect(panel.getByLabel('날씨 메모', { exact: true })).toHaveValue(weatherNote);
      await panel.getByLabel('증빙 HTTPS 링크 (선택)').fill('https://example.org/synthetic-result');
      const imageRead = waitForPublicResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === `/bff/v1/gallery/media/${image.id}` &&
          response.request().method() === 'GET',
      );
      const chooseImage = panel.getByRole('button', {
        name: `이미지 선택 · ${imageName}`,
        exact: true,
      });
      await chooseImage.focus();
      await expect(chooseImage).toBeFocused();
      await chooseImage.press('Enter');
      expect((await imageRead).status()).toBe(200);
      const pdfRead = waitForPublicResponse(page, (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/bff/v1/resources/${resource.id}` &&
          url.searchParams.get('versionId') === firstVersion &&
          response.request().method() === 'GET'
        );
      });
      const choosePdf = panel.getByRole('button', {
        name: `PDF 정확 버전 선택 · ${title}`,
        exact: true,
      });
      await choosePdf.focus();
      await expect(choosePdf).toBeFocused();
      await choosePdf.press('Enter');
      expect((await pdfRead).status()).toBe(200);
      const firstSelection = panel.getByRole('list', { name: '선택한 증빙' });
      await expect(firstSelection).toContainText(imageName);
      await expect(firstSelection).toContainText(title);
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        )
        .toBe(true);
      const saved = waitForPublicResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === '/bff/v1/race-results/v2' &&
          response.request().method() === 'POST',
      );
      await panel.getByRole('button', { name: '저장', exact: true }).click();
      const saveResponse = await saved;
      expect(saveResponse.status()).toBe(201);
      const sent: unknown = saveResponse.request().postDataJSON();
      assert.ok(
        typeof sent === 'object' && sent !== null && 'schemaVersion' in sent && 'values' in sent,
      );
      const command = raceResultCreateV2CommandSchema.parse({
        schemaVersion: sent.schemaVersion,
        values: sent.values,
        idempotencyKey: saveResponse.request().headers()['idempotency-key'],
      });
      expect(command.values.proofs.attachments).toEqual([
        {
          kind: 'gallery-image',
          mediaItemId: image.id,
          expectedAccessRevision: image.accessRevision,
        },
        {
          kind: 'resource-pdf',
          resourceId: resource.id,
          versionId: firstVersion,
          expectedAccessRevision: resource.accessRevision,
        },
      ]);
      const receipt = raceResultV2CommandResultSchema.parse(await saveResponse.json());
      const original = await readResult(page, headers, receipt.id);
      expect(original.chipSeconds).toBe(0);
      expect(original.weatherNote).toBe(weatherNote);
      expect(original.gunSeconds).toBeNull();
      expect(original.proofs.attachments).toHaveLength(2);
      expect(JSON.stringify(original)).not.toMatch(/private\/v1\/|storageRef|verifiedAt/);
      const replay = await page.request.post('/bff/v1/race-results/v2', {
        headers: write(headers, command.idempotencyKey),
        data: command,
      });
      expect(replay.status()).toBe(201);
      expect(raceResultV2CommandResultSchema.parse(await replay.json())).toEqual(receipt);

      await page.goto(`/resources/${resource.id}`);
      const append = page.getByRole('form', { name: '새 파일 자료 버전 저장' });
      const secondPdf = pdf('Explicit new immutable source version');
      await append
        .getByLabel('교체할 원본 파일')
        .setInputFiles({ name: pdfName, mimeType: 'application/pdf', buffer: secondPdf });
      await append.getByRole('button', { name: '새 파일 버전 업로드' }).click();
      await expect(page.getByText(/원문 버전 2 · 원본 파일 저장됨/)).toBeVisible();
      const unchanged = await readResult(page, headers, receipt.id);
      expect(unchanged.proofs).toEqual(original.proofs);
      const pinned = await page.request.get(
        `/bff/v1/resources/${resource.id}/content?versionId=${firstVersion}`,
        { headers },
      );
      expect(await pinned.body()).toEqual(firstPdf);
      await page.goto('/records?section=results');
      const card = panel.getByRole('listitem').filter({
        has: page.getByRole('heading', { name: '2080-01-03 대회 결과', exact: true }),
        hasText: token,
      });
      await card.getByRole('button', { name: '편집', exact: true }).click();
      await expect(panel.getByLabel('편집 범위')).toHaveValue('actual_only');
      await panel.getByLabel('Chip 시간 (초)', { exact: true }).fill('1');
      const actualPatch = waitForPublicResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === `/bff/v1/race-results/${receipt.id}` &&
          response.request().method() === 'PATCH',
      );
      await panel.getByRole('button', { name: '저장', exact: true }).click();
      expect((await actualPatch).status()).toBe(200);
      const edited = await readResult(page, headers, receipt.id);
      expect(edited.chipSeconds).toBe(1);
      expect(edited.weatherNote).toBe(weatherNote);
      expect(edited.proofs).toEqual(original.proofs);

      const bob = await other.newPage();
      const bobHeaders = await login(bob, 'Bob');
      expect(
        (
          await bob.request.get(`/bff/v1/race-results/v2/${receipt.id}?schemaVersion=2`, {
            headers: bobHeaders,
          })
        ).status(),
      ).toBe(404);
      expect(
        (
          await bob.request.post('/bff/v1/race-results/v2', {
            headers: write(bobHeaders),
            data: { schemaVersion: 2, values: command.values },
          })
        ).status(),
      ).toBe(404);
      const {
        id: _id,
        revision: _revision,
        schemaVersion: _schema,
        proofs: _proofs,
        ...actualValues
      } = edited;
      const actualOnly = raceResultValuesSchema.parse(actualValues);
      const foreignEdit = await bob.request.patch(`/bff/v1/race-results/${receipt.id}`, {
        headers: write(bobHeaders),
        data: { expectedRevision: edited.revision, values: actualOnly },
      });
      expect(foreignEdit.status()).toBe(404);
      const conflict = await page.request.post('/bff/v1/race-results/v2', {
        headers: write(headers, command.idempotencyKey),
        data: { ...command, values: { ...command.values, weatherNote: `${token} changed` } },
      });
      expect(conflict.status()).toBe(409);
      const stale = await page.request.patch(`/bff/v1/race-results/${receipt.id}`, {
        headers: write(headers),
        data: { expectedRevision: receipt.revision, values: actualOnly },
      });
      expect(stale.status()).toBe(409);
      const csrf = await page.request.post('/bff/v1/race-results/v2', {
        headers: { ...write(headers), 'x-csrf-token': 'invalid' },
        data: { schemaVersion: 2, values: command.values },
      });
      expect(csrf.status()).toBe(403);

      await page.goto(`/resources/${resource.id}`);
      await page.getByLabel('삭제 결과를 확인했습니다').check();
      await page.getByRole('button', { name: '자료 삭제', exact: true }).click();
      await expect(page).toHaveURL(/\/resources$/);
      const redacted = await readResult(page, headers, receipt.id);
      const missing = redacted.proofs.attachments.find((a) => a.kind === 'resource-pdf');
      expect(missing).toEqual({
        kind: 'resource-pdf',
        resourceId: resource.id,
        versionId: firstVersion,
        status: 'unavailable',
      });
      expect(redacted.chipSeconds).toBe(1);
      expect(
        (
          await page.request.get(
            `/bff/v1/resources/${resource.id}/content?versionId=${firstVersion}`,
            { headers },
          )
        ).status(),
      ).toBe(404);
      await page.goto('/records?section=results');
      await card.getByRole('button', { name: '편집', exact: true }).click();
      await panel.getByLabel('편집 범위').selectOption('proofs');
      await expect(panel.getByRole('list', { name: '선택한 증빙' })).toContainText('사용 불가');
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        )
        .toBe(true);
      await panel.getByRole('button', { name: '증빙 연결 해제 2', exact: true }).click();
      const imageRecheck = waitForPublicResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === `/bff/v1/gallery/media/${image.id}` &&
          response.request().method() === 'GET',
      );
      const reconfirm = panel.getByRole('button', { name: '정확 버전 재확인 1', exact: true });
      await reconfirm.focus();
      await expect(reconfirm).toBeFocused();
      await reconfirm.press('Enter');
      expect((await imageRecheck).status()).toBe(200);
      const selected = panel.getByRole('list', { name: '선택한 증빙' });
      await expect(selected.getByRole('listitem')).toHaveCount(1);
      await expect(selected).toContainText(imageName);
      await expect(
        panel.getByRole('button', { name: '정확 버전 재확인 1', exact: true }),
      ).toHaveCount(0);
      await expect(panel.getByText('증빙 확인 중입니다.', { exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('편집 범위')).toHaveValue('proofs');
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        )
        .toBe(true);
      await expect(panel.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
      const unlink = waitForPublicResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === `/bff/v1/race-results/v2/${receipt.id}` &&
          response.request().method() === 'PATCH',
      );
      await panel.getByRole('button', { name: '저장', exact: true }).click();
      expect((await unlink).status()).toBe(200);
      const final = await readResult(page, headers, receipt.id);
      expect(final.proofs.attachments).toHaveLength(1);
      expect(final.proofs.attachments[0]).toMatchObject({
        kind: 'gallery-image',
        mediaItemId: image.id,
        status: 'available',
      });
      expect(final.chipSeconds).toBe(1);
      expect(final.weatherNote).toBe(weatherNote);
      // Own public cleanup only; disposable runner owns cleanup on an assertion failure.
      const removed = await page.request.delete(`/bff/v1/race-results/${receipt.id}`, {
        headers: write(headers),
        data: { expectedRevision: final.revision },
      });
      expect(removed.status()).toBe(200);
      raceCommandResultSchema.parse(await removed.json());
      const removedMedia = await page.request.delete(`/bff/v1/gallery/media/${image.id}`, {
        headers: write(headers),
        data: { expectedAccessRevision: image.accessRevision },
      });
      expect(removedMedia.status()).toBe(200);
    } finally {
      await Promise.allSettled([own.close(), other.close()]);
    }
  });
}
