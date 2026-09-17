import { activitySchema } from '@workout/contracts/activity';
import { transportReplySchema } from '@workout/contracts/core';
export const tagActivityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function tagActivity(tags?: string[]) {
  const values = {
    title: '합성 태그 활동',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer',
    distanceMeters: null,
  };
  return activitySchema.parse({
    id: tagActivityId,
    revision: 2,
    source: { kind: 'fixture', sourceId: 'fixture', revision: 1, contentHash: 'a'.repeat(64) },
    original: values,
    effective: values,
    overlay: tags === undefined ? {} : { tags },
    userReport: {
      definitionVersion: 'activity-report-v1',
      source: 'user',
      method: 'self_report',
      sessionRpe: 0,
      note: '합성 보고',
      rpeReportedAt: '2026-09-17T00:00:00Z',
      planLink: null,
    },
  });
}
export const tagResponse = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
