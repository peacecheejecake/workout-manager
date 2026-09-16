import {
  activitySchema,
  activityValuesSchema,
  activityOverlaySchema,
  type Activity,
} from '@workout/contracts/activity';
export const selectActivity = `SELECT c.id,c.revision,c.original,s.kind,s.source_id,s.source_revision,s.content_hash,coalesce(o.values_json,'{}'::jsonb) AS overlay FROM activity_canonical c JOIN activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND NOT c.deleted`;
export function decodeActivity(row: Record<string, unknown>): Activity {
  const original = activityValuesSchema.parse(row['original']);
  const overlay = activityOverlaySchema.parse(row['overlay']);
  return activitySchema.parse({
    id: row['id'],
    revision: row['revision'],
    source: {
      kind: row['kind'],
      sourceId: row['source_id'],
      revision: row['source_revision'],
      contentHash: row['content_hash'],
    },
    original,
    overlay,
    userReport: overlay.userReport ?? null,
    effective: {
      ...original,
      ...(overlay.kind === undefined ? {} : { kind: overlay.kind }),
      ...(overlay.startedAt === undefined
        ? {}
        : { startedAt: overlay.startedAt, timezone: overlay.timezone }),
      ...(overlay.title === undefined ? {} : { title: overlay.title }),
      ...(overlay.distanceMeters === undefined ? {} : { distanceMeters: overlay.distanceMeters }),
      ...(overlay.durationSeconds === undefined
        ? {}
        : { durationSeconds: overlay.durationSeconds, durationKind: overlay.durationKind }),
    },
  });
}
