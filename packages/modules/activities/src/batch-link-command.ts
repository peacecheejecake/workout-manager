import { z } from 'zod';
import {
  activitySchema,
  activityOverlayWriteSchema,
  activityReportValuesSchema,
  type ActivityReportValues,
  type ActivityOverlayWrite,
} from '@workout/contracts/activity';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { batchSelectionLimit, type BatchTarget } from './batch-selection';

export type PlanLink = ActivityReportValues['planLink'];
export type PreparedLink = {
  target: BatchTarget;
  previousLink: PlanLink;
  command: ActivityOverlayWrite;
};
export type LinkPreviewResult =
  | { target: BatchTarget; status: 'ready'; prepared: PreparedLink }
  | {
      target: BatchTarget;
      status:
        | 'unchanged'
        | 'conflict'
        | 'unavailable'
        | 'read_error'
        | 'reauth_required'
        | 'not_attempted';
    };
export type BatchLinkResult = {
  prepared: PreparedLink;
  status:
    | 'applied'
    | 'conflict'
    | 'unavailable'
    | 'invalid_link'
    | 'uncertain'
    | 'reauth_required'
    | 'not_attempted';
};
const sameLink = (left: PlanLink, right: PlanLink) =>
  left === null || right === null
    ? left === right
    : left.planVersionId.toLowerCase() === right.planVersionId.toLowerCase() &&
      left.sessionId === right.sessionId;
function checkTargets(targets: BatchTarget[]) {
  if (
    targets.length > batchSelectionLimit ||
    new Set(targets.map((target) => target.id)).size !== targets.length
  )
    throw new Error('INVALID_BATCH_TARGETS');
}
const sessionError = (error: unknown) => (error instanceof Error ? error.message : null);

export async function prepareActivityBatchLink({
  targets,
  link,
  reason,
  transport,
  signal,
  createId,
}: {
  targets: BatchTarget[];
  link: PlanLink;
  reason: string;
  transport: AuthenticatedTransport;
  signal: AbortSignal;
  createId: () => string;
}): Promise<LinkPreviewResult[]> {
  checkTargets(targets);
  const frozen = structuredClone(targets);
  const selected = activityReportValuesSchema.shape.planLink.parse(structuredClone(link));
  const why = activityOverlayWriteSchema.shape.reason.parse(reason);
  const results: LinkPreviewResult[] = [];
  let stopped = false;
  for (const target of frozen) {
    if (stopped || signal.aborted) {
      results.push({ target, status: 'not_attempted' });
      continue;
    }
    try {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/activities/${encodeURIComponent(target.id)}`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (signal.aborted) {
        results.push({ target, status: 'not_attempted' });
        continue;
      }
      if (reply.status === 401 || reply.status === 403) {
        stopped = true;
        results.push({ target, status: 'reauth_required' });
        continue;
      }
      if (reply.status !== 200) {
        results.push({ target, status: reply.status === 404 ? 'unavailable' : 'read_error' });
        continue;
      }
      const activity = activitySchema.parse(reply.body);
      if (activity.id !== target.id) {
        results.push({ target, status: 'read_error' });
        continue;
      }
      if (activity.revision !== target.revision) {
        results.push({ target, status: 'conflict' });
        continue;
      }
      const report = activity.userReport ?? activity.overlay.userReport;
      const previousLink = report?.planLink ?? null;
      if (sameLink(previousLink, selected)) {
        results.push({ target, status: 'unchanged' });
        continue;
      }
      const command = activityOverlayWriteSchema.parse({
        expectedRevision: target.revision,
        idempotencyKey: createId(),
        reason: why,
        report: {
          sessionRpe: report?.sessionRpe ?? null,
          note: report?.note ?? null,
          planLink: selected,
        },
      });
      results.push({
        target,
        status: 'ready',
        prepared: structuredClone({ target, previousLink, command }),
      });
    } catch (error) {
      const code = sessionError(error);
      if (code === 'SESSION_EXPIRED' || code === 'SESSION_UNAVAILABLE') stopped = true;
      results.push({
        target,
        status: signal.aborted
          ? 'not_attempted'
          : code === 'SESSION_EXPIRED'
            ? 'reauth_required'
            : 'read_error',
      });
    }
  }
  return results;
}

export async function runActivityBatchLink({
  prepared,
  transport,
  signal,
  onResult,
}: {
  prepared: PreparedLink[];
  transport: AuthenticatedTransport;
  signal: AbortSignal;
  onResult: (result: BatchLinkResult) => void;
}): Promise<BatchLinkResult[]> {
  checkTargets(prepared.map((item) => item.target));
  const frozen = structuredClone(prepared);
  // Reject invalid previews before any write, including an expected revision that changed after confirmation.
  for (const item of frozen) {
    item.command = activityOverlayWriteSchema.parse(item.command);
    if (item.command.report === undefined || item.command.expectedRevision !== item.target.revision)
      throw new Error('INVALID_BATCH_PREVIEW');
  }
  const results: BatchLinkResult[] = [];
  let stopped = false;
  for (const item of frozen) {
    let status: BatchLinkResult['status'] = 'not_attempted';
    if (!stopped && !signal.aborted) {
      try {
        const { idempotencyKey, ...body } = item.command;
        const reply = transportReplySchema.parse(
          await transport.request({
            path: `/bff/v1/activities/${encodeURIComponent(item.target.id)}`,
            method: 'PATCH',
            body: z.json().parse(body),
            idempotencyKey,
            signal,
          }),
        );
        if (signal.aborted) status = 'uncertain';
        else if (reply.status === 200) {
          const receipt = activitySchema.parse(reply.body);
          const report = receipt.userReport ?? receipt.overlay.userReport;
          const expected = item.command.report;
          status =
            receipt.id === item.target.id &&
            receipt.revision === item.target.revision + 1 &&
            report !== undefined &&
            report !== null &&
            expected !== undefined &&
            report.sessionRpe === expected.sessionRpe &&
            report.note === expected.note &&
            sameLink(report.planLink, expected.planLink)
              ? 'applied'
              : 'uncertain';
        } else if (reply.status === 401 || reply.status === 403) {
          status = 'reauth_required';
          stopped = true;
        } else if (reply.status === 409) status = 'conflict';
        else if (reply.status === 404) status = 'unavailable';
        else if (
          reply.status === 400 &&
          typeof reply.body === 'object' &&
          reply.body !== null &&
          !Array.isArray(reply.body) &&
          typeof reply.body.error === 'object' &&
          reply.body.error !== null &&
          !Array.isArray(reply.body.error) &&
          reply.body.error.code === 'PLAN_LINK_INVALID'
        )
          status = 'invalid_link';
        else status = 'uncertain';
      } catch (error) {
        const code = sessionError(error);
        if (code === 'SESSION_EXPIRED' || code === 'SESSION_UNAVAILABLE') stopped = true;
        status = !signal.aborted && code === 'SESSION_EXPIRED' ? 'reauth_required' : 'uncertain';
      }
    }
    const result = { prepared: structuredClone(item), status };
    results.push(result);
    if (!signal.aborted) onResult(structuredClone(result));
  }
  return results;
}
