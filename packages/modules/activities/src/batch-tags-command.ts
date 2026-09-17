import { z } from 'zod';
import {
  activitySchema,
  activityOverlayWriteSchema,
  activityTagSchema,
  activityTagsSchema,
  type ActivityOverlayWrite,
} from '@workout/contracts/activity';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { batchSelectionLimit, type BatchTarget } from './batch-selection';

export type TagOperation = 'add' | 'remove';
export type PreparedTags = {
  target: BatchTarget;
  previousTags: string[] | undefined;
  command: ActivityOverlayWrite;
};
export type TagsPreviewResult =
  | { target: BatchTarget; status: 'ready'; prepared: PreparedTags }
  | {
      target: BatchTarget;
      status:
        | 'unchanged'
        | 'limit_exceeded'
        | 'conflict'
        | 'unavailable'
        | 'read_error'
        | 'reauth_required'
        | 'not_attempted';
    };
export type BatchTagsResult = {
  prepared: PreparedTags;
  status:
    | 'applied'
    | 'conflict'
    | 'unavailable'
    | 'invalid_input'
    | 'uncertain'
    | 'reauth_required'
    | 'not_attempted';
};
const sameTags = (left: string[], right: string[]) =>
  left.length === right.length && left.every((tag, index) => tag === right[index]);
function checkTargets(targets: BatchTarget[]) {
  if (
    targets.length === 0 ||
    targets.length > batchSelectionLimit ||
    targets.some(
      (target) =>
        !z.uuid().safeParse(target.id).success ||
        !z.int().positive().safeParse(target.revision).success,
    ) ||
    new Set(targets.map((target) => target.id.toLowerCase())).size !== targets.length
  )
    throw new Error('INVALID_BATCH_TARGETS');
}
const sessionError = (error: unknown) => (error instanceof Error ? error.message : null);

export async function prepareActivityBatchTags({
  targets,
  tag,
  operation,
  reason,
  transport,
  signal,
  createId,
}: {
  targets: BatchTarget[];
  tag: string;
  operation: TagOperation;
  reason: string;
  transport: AuthenticatedTransport;
  signal: AbortSignal;
  createId: () => string;
}): Promise<TagsPreviewResult[]> {
  checkTargets(targets);
  const frozen = structuredClone(targets);
  const selected = activityTagSchema.parse(tag);
  if (operation !== 'add' && operation !== 'remove') throw new Error('INVALID_TAG_OPERATION');
  const why = activityOverlayWriteSchema.shape.reason.parse(reason);
  const results: TagsPreviewResult[] = [];
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
      if (activity.id.toLowerCase() !== target.id.toLowerCase()) {
        results.push({ target, status: 'read_error' });
        continue;
      }
      if (activity.revision !== target.revision) {
        results.push({ target, status: 'conflict' });
        continue;
      }
      const previousTags = activity.overlay.tags;
      const currentTags = previousTags ?? [];
      const nextTags =
        operation === 'add'
          ? currentTags.includes(selected)
            ? currentTags
            : [...currentTags, selected]
          : currentTags.filter((tag) => tag !== selected);
      if (sameTags(currentTags, nextTags)) {
        results.push({ target, status: 'unchanged' });
        continue;
      }
      const normalized = activityTagsSchema.safeParse(nextTags);
      if (!normalized.success) {
        results.push({ target, status: 'limit_exceeded' });
        continue;
      }
      const command = activityOverlayWriteSchema.parse({
        expectedRevision: target.revision,
        idempotencyKey: createId(),
        reason: why,
        tags: normalized.data,
      });
      results.push({
        target,
        status: 'ready',
        prepared: structuredClone({ target, previousTags, command }),
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

export async function runActivityBatchTags({
  prepared,
  transport,
  signal,
  onResult,
}: {
  prepared: PreparedTags[];
  transport: AuthenticatedTransport;
  signal: AbortSignal;
  onResult: (result: BatchTagsResult) => void;
}): Promise<BatchTagsResult[]> {
  checkTargets(prepared.map((item) => item.target));
  const frozen = structuredClone(prepared);
  // Reject invalid previews before any write, including an expected revision that changed after confirmation.
  for (const item of frozen) {
    item.command = activityOverlayWriteSchema.parse(item.command);
    if (
      item.command.tags === undefined ||
      item.command.expectedRevision !== item.target.revision ||
      Object.keys(item.command).some(
        (key) => !['expectedRevision', 'idempotencyKey', 'reason', 'tags'].includes(key),
      )
    )
      throw new Error('INVALID_BATCH_PREVIEW');
  }
  const results: BatchTagsResult[] = [];
  let stopped = false;
  for (const item of frozen) {
    let status: BatchTagsResult['status'] = 'not_attempted';
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
          status =
            receipt.id.toLowerCase() === item.target.id.toLowerCase() &&
            receipt.revision === item.target.revision + 1 &&
            receipt.overlay.tags !== undefined &&
            item.command.tags !== undefined &&
            sameTags(receipt.overlay.tags, item.command.tags)
              ? 'applied'
              : 'uncertain';
        } else if (reply.status === 401 || reply.status === 403) {
          status = 'reauth_required';
          stopped = true;
        } else if (reply.status === 409) status = 'conflict';
        else if (reply.status === 404) status = 'unavailable';
        else if (reply.status === 400) status = 'invalid_input';
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
