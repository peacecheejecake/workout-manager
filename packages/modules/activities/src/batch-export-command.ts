import { activitySchema, type Activity } from '@workout/contracts/activity';
import {
  selectedActivityExportSchema,
  selectedActivityExportMaxBytes,
  type SelectedActivityExport,
} from '@workout/contracts/activity-export';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { batchSelectionLimit, type BatchTarget } from './batch-selection';

export type ExportReadResult =
  | { target: BatchTarget; status: 'ready'; activity: Activity }
  | {
      target: BatchTarget;
      status: 'conflict' | 'unavailable' | 'read_error' | 'reauth_required' | 'not_attempted';
    };
function validateTargets(targets: BatchTarget[]) {
  if (
    targets.length === 0 ||
    targets.length > batchSelectionLimit ||
    new Set(targets.map((target) => target.id.toLowerCase())).size !== targets.length
  )
    throw new Error('INVALID_EXPORT_TARGETS');
}
export async function prepareActivityBatchExport({
  targets,
  transport,
  signal,
}: {
  targets: BatchTarget[];
  transport: AuthenticatedTransport;
  signal: AbortSignal;
}): Promise<ExportReadResult[]> {
  validateTargets(targets);
  const frozen = structuredClone(targets),
    results: ExportReadResult[] = [];
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
      results.push({ target, status: 'ready', activity: structuredClone(activity) });
    } catch (error) {
      const code = error instanceof Error ? error.message : null;
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
export function serializeActivityBatchExport({
  results,
  generatedAt,
}: {
  results: ExportReadResult[];
  generatedAt: string;
}): { data: SelectedActivityExport; json: string } {
  validateTargets(results.map((result) => result.target));
  const activities = results.map((result) => {
    if (result.status !== 'ready') throw new Error('EXPORT_NOT_READY');
    if (
      result.activity.id.toLowerCase() !== result.target.id.toLowerCase() ||
      result.activity.revision !== result.target.revision
    )
      throw new Error('EXPORT_REVISION_MISMATCH');
    return result.activity;
  });
  const data = selectedActivityExportSchema.parse({
    schemaVersion: 1,
    format: 'workout-manager-activity-summary',
    generatedAt,
    consistency: 'per-activity-revision',
    activities,
  });
  const json = JSON.stringify(data, null, 2);
  if (new TextEncoder().encode(json).length > selectedActivityExportMaxBytes)
    throw new Error('EXPORT_TOO_LARGE');
  return { data, json };
}
