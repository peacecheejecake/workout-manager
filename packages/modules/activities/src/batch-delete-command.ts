import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { batchSelectionLimit, type BatchTarget } from './batch-selection';

export type BatchResult = {
  target: BatchTarget;
  status:
    'deleted' | 'conflict' | 'unavailable' | 'uncertain' | 'not_attempted' | 'reauth_required';
};
/** Each item is an independent command; cancellation never proves a sent delete did not commit. */
export async function runActivityBatchDelete({
  targets,
  transport,
  signal,
  onResult,
}: {
  targets: BatchTarget[];
  transport: AuthenticatedTransport;
  signal: AbortSignal;
  onResult(result: BatchResult): void;
}): Promise<BatchResult[]> {
  if (
    targets.length > batchSelectionLimit ||
    new Set(targets.map((target) => target.id)).size !== targets.length
  )
    throw new Error('INVALID_BATCH_TARGETS');
  const frozen = targets.map((target) => ({ ...target }));
  const results: BatchResult[] = [];
  let stopped = false;
  for (const target of frozen) {
    let status: BatchResult['status'] = 'not_attempted';
    if (!stopped && !signal.aborted) {
      try {
        const reply = await transport.request({
          path: `/bff/v1/activities/${encodeURIComponent(target.id)}`,
          method: 'DELETE',
          body: { expectedRevision: target.revision },
          idempotencyKey: null,
          signal,
        });
        const parsed = transportReplySchema.safeParse(reply);
        if (signal.aborted || !parsed.success) status = 'uncertain';
        else
          switch (parsed.data.status) {
            case 204:
              status = 'deleted';
              break;
            case 409:
              status = 'conflict';
              break;
            case 404:
              status = 'unavailable';
              break;
            case 401:
            case 403:
              status = 'reauth_required';
              stopped = true;
              break;
            default:
              status = 'uncertain';
          }
      } catch (error) {
        if (!signal.aborted && error instanceof Error && error.message === 'SESSION_EXPIRED') {
          status = 'reauth_required';
          stopped = true;
        } else {
          status = 'uncertain';
          if (error instanceof Error && error.message === 'SESSION_UNAVAILABLE') stopped = true;
        }
      }
    }
    const result = { target: { ...target }, status };
    results.push(result);
    if (!signal.aborted) onResult({ target: { ...target }, status });
  }
  return results;
}
