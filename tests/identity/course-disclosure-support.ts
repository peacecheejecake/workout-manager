import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  courseDisclosurePreviewSchema,
  courseDisclosureReceiptSchema,
  type CourseDisclosurePreview,
  type CourseDisclosurePurpose,
} from '../../packages/contracts/src/course-sharing';

/**
 * The privacy confirmation through the real API (M2-01k-o §5), for specs that need a GPX
 * body. A GPX is given only behind a receipt now, so a spec that reads one goes through
 * exactly what the screen goes through: the server's preview, then a confirmation of one of
 * the options it offered.
 *
 * `exact` asks for the line as stored wherever the server allows it — the owner's exact
 * line after its warning (D3b), or the exact ends when there is no protected area (D3a) —
 * so a spec about something else is not changed by a protected area another spec added.
 * `default` takes the server's default, which for ends inside an area is the trimmed line
 * and appends a revision.
 */
export async function confirmCourseDisclosure(
  page: Page,
  headers: Record<string, string>,
  courseId: string,
  options: {
    readonly purpose?: CourseDisclosurePurpose;
    readonly prefer?: 'exact' | 'default';
    readonly includeNames?: boolean;
  } = {},
): Promise<{ preview: CourseDisclosurePreview; receiptId: string }> {
  const purpose = options.purpose ?? 'export';
  const previewResponse = await page.request.get(
    `/bff/v1/courses/${courseId}/disclosure-preview?purpose=${purpose}`,
    { headers },
  );
  expect(previewResponse.status()).toBe(200);
  const preview = courseDisclosurePreviewSchema.parse(await previewResponse.json());
  const exact = preview.options.find(
    (option) => option.exposure === 'owner-exact' || option.exposure === 'no-zones-exact',
  );
  const chosen =
    options.prefer === 'exact' && exact
      ? exact
      : preview.options.find((option) => option.exposure === preview.defaultExposure);
  if (!chosen) throw new Error(`nothing to confirm: ${preview.outcome}`);
  const confirmation = await page.request.post(
    `/bff/v1/courses/${courseId}/disclosure-confirmations`,
    {
      headers: { ...headers, 'idempotency-key': `confirm-${randomUUID()}` },
      data: {
        purpose,
        expectedRevision: preview.courseRevision,
        acknowledgedZoneSetDigest: preview.zoneSetDigest,
        exposure: chosen.exposure,
        includeNames: options.includeNames ?? preview.includeNamesDefault,
        acknowledgedRisk: chosen.requiresAcknowledgement,
      },
    },
  );
  expect(confirmation.status()).toBe(200);
  const receipt = courseDisclosureReceiptSchema.parse(await confirmation.json());
  return { preview, receiptId: receipt.receiptId };
}

/**
 * Remove every protected area of the signed-in account. The identity accounts are shared by
 * every spec of a run, and a protected area another spec left over this spec's course would
 * — correctly — make its export a refused trim (M2-01k-o D3).
 */
export async function clearProtectedAreas(page: Page, headers: Record<string, string>) {
  const listed = (await (
    await page.request.get('/bff/v1/courses/privacy-zones', { headers })
  ).json()) as { zones: { zoneId: string }[] };
  for (const zone of listed.zones) {
    const removed = await page.request.delete(`/bff/v1/courses/privacy-zones/${zone.zoneId}`, {
      headers,
    });
    expect(removed.status()).toBe(200);
  }
}

/** Confirm and download the GPX body through the API. */
export async function confirmedGpx(
  page: Page,
  headers: Record<string, string>,
  courseId: string,
  options: { readonly prefer?: 'exact' | 'default'; readonly includeNames?: boolean } = {},
) {
  const { receiptId, preview } = await confirmCourseDisclosure(page, headers, courseId, options);
  const response = await page.request.get(
    `/bff/v1/courses/${courseId}/export.gpx?receipt=${receiptId}`,
    { headers },
  );
  return { response, receiptId, preview };
}

/**
 * The screen's own path to a GPX: "GPX 내보내기" opens the confirmation, and the download
 * starts only from "확인하고 GPX 내보내기". With `exact` (the default here) the owner's exact
 * line is chosen where the screen offers it, after its warning, so the course is not given a
 * trimmed revision by a spec about something else; the no-protected-area warning is ticked
 * when it is shown.
 */
export async function exportOnScreen(
  workbench: Locator,
  options: { readonly prefer?: 'exact' | 'default' } = {},
) {
  await workbench.getByTestId('course-export').click();
  const region = workbench.getByRole('region', { name: 'GPX 내보내기 전 확인' });
  const confirm = region.getByRole('button', { name: '확인하고 GPX 내보내기' });
  await expect(confirm).toBeVisible();
  if ((options.prefer ?? 'exact') === 'exact') {
    const exact = region.getByRole('radio', { name: '정확한 선 (내 GPX 파일에만)' });
    if ((await exact.count()) > 0) {
      await exact.check();
      await region.getByLabel('보호 구역 안의 좌표가 포함된다는 것을 확인했습니다.').check();
    }
  }
  const noZones = region.getByLabel(
    '보호 구역이 없어 정확한 시작·끝이 포함된다는 것을 확인했습니다.',
  );
  if ((await noZones.count()) > 0) await noZones.check();
  await confirm.click();
}
