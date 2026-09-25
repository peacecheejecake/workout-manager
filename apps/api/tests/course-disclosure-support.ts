import { randomUUID } from 'node:crypto';

import {
  courseDisclosurePreviewSchema,
  courseDisclosureReceiptSchema,
  type CourseDisclosureExposure,
  type CourseDisclosurePurpose,
} from '@workout/contracts/course-sharing';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

/**
 * The owner's confirmation flow through the real routes (M2-01k-o §5): read the preview,
 * confirm one option, and hand back the receipt. Tests that only need "a confirmed export"
 * go through exactly the path the screen takes, never around it.
 */
export async function confirmDisclosure(
  app: FastifyInstance,
  headers: Record<string, string>,
  courseId: string,
  options: {
    readonly purpose?: CourseDisclosurePurpose;
    readonly exposure?: CourseDisclosureExposure;
    readonly includeNames?: boolean;
    readonly acknowledgedRisk?: boolean;
  } = {},
) {
  const purpose = options.purpose ?? 'export';
  const previewResponse = await app.inject({
    method: 'GET',
    url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=${purpose}`,
    headers,
  });
  expect(previewResponse.statusCode).toBe(200);
  const preview = courseDisclosurePreviewSchema.parse(previewResponse.json());
  const exposure = options.exposure ?? preview.defaultExposure;
  if (exposure === null) throw new Error(`nothing to confirm: ${preview.outcome}`);
  const confirmation = await app.inject({
    method: 'POST',
    url: `/bff/v1/courses/${courseId}/disclosure-confirmations`,
    headers: { ...headers, 'idempotency-key': `confirm-${randomUUID()}` },
    payload: {
      purpose,
      expectedRevision: preview.courseRevision,
      acknowledgedZoneSetDigest: preview.zoneSetDigest,
      exposure,
      includeNames: options.includeNames ?? preview.includeNamesDefault,
      acknowledgedRisk:
        options.acknowledgedRisk ??
        preview.options.find((option) => option.exposure === exposure)?.requiresAcknowledgement ??
        false,
    },
  });
  return { preview, confirmation };
}

/** Confirm with the preview's defaults and download the GPX with the receipt. */
export async function confirmedExport(
  app: FastifyInstance,
  headers: Record<string, string>,
  courseId: string,
  options: Parameters<typeof confirmDisclosure>[3] = {},
) {
  const { confirmation } = await confirmDisclosure(app, headers, courseId, options);
  expect(confirmation.statusCode).toBe(200);
  const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
  const response = await app.inject({
    method: 'GET',
    url: `/bff/v1/courses/${courseId}/export.gpx?receipt=${receipt.receiptId}`,
    headers,
  });
  return { receipt, response };
}
