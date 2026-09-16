import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  accountExportSchema,
  operationsStatusSchema,
  type AccountExport,
  type OperationsStatus,
} from '@workout/contracts/operations';
import type { Database } from './database.js';

export class OperationsError extends Error {
  constructor(readonly code: 'EXPORT_TOO_LARGE' | 'ACCOUNT_ERASED') {
    super(code);
  }
}
export interface OperationsRepository {
  exportAccount(athleteId: string): Promise<AccountExport>;
  eraseAccount(athleteId: string): Promise<{ erased: true }>;
  status(athleteId: string): Promise<OperationsStatus>;
}
const collections = [
  ['consents', 'consent', 'kind,granted,revision', 'kind'],
  ['planSnapshots', 'plan_snapshot', 'id,version,created_at,draft', 'version'],
  ['planHead', 'plan_head', 'version_id', 'version_id'],
  ['planHistory', 'plan_history', 'version_id,action', 'version_id'],
  ['activities', 'activity_canonical', 'id,revision,original,deleted', 'id'],
  [
    'activitySources',
    'activity_source_head',
    'kind,source_id,source_revision,content_hash,activity_id',
    'kind,source_id',
  ],
  [
    'sourceRevisions',
    'activity_source_revision',
    'kind,source_id,source_revision,content_hash,normalized_raw',
    'kind,source_id,source_revision',
  ],
  ['overlays', 'activity_overlay', 'activity_id,values_json', 'activity_id'],
  [
    'overlayRevisions',
    'activity_overlay_revision',
    'activity_id,revision,values_json',
    'activity_id,revision',
  ],
  ['suppressions', 'activity_suppression', 'kind,source_id', 'kind,source_id'],
] as const;
const maxBytes = 8 * 1024 * 1024;
// Identifiers are a static allowlist; no caller-controlled SQL or authentication tables.
const exportSql = `WITH rows AS MATERIALIZED (${collections.map(([name, table, fields, order]) => `SELECT '${name}' AS collection,to_jsonb(r) AS payload,row_number() OVER () AS ordinal FROM (SELECT ${fields} FROM ${table} WHERE athlete_id=$1 ORDER BY ${order} LIMIT 1001) r`).join(' UNION ALL ')}), sizes AS (SELECT collection,count(*) AS count,sum(octet_length(payload::text)) AS bytes FROM rows GROUP BY collection), valid AS (SELECT coalesce(max(count),0)<=1000 AND coalesce(sum(bytes),0)<=${maxBytes - 65536} AS ok FROM sizes), groups AS (SELECT collection,jsonb_agg(payload ORDER BY ordinal) AS payload FROM rows WHERE (SELECT ok FROM valid) GROUP BY collection) SELECT (SELECT ok FROM valid) AS ok,coalesce(jsonb_object_agg(collection,payload),'{}'::jsonb) AS data FROM groups`;

export function createOperationsRepository(database: Database): OperationsRepository {
  return {
    exportAccount(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(exportSql, [athleteId]);
        const row = z
          .object({
            ok: z.boolean(),
            data: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
          })
          .parse(result.rows[0]);
        if (!row.ok) throw new OperationsError('EXPORT_TOO_LARGE');
        const data = Object.fromEntries(collections.map(([name]) => [name, row.data[name] ?? []]));
        const artifact = accountExportSchema.parse({
          schemaVersion: 1,
          athleteId,
          exportedAt: new Date().toISOString(),
          data,
        });
        if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes)
          throw new OperationsError('EXPORT_TOO_LARGE');
        await tx.query(
          "INSERT INTO operations_audit(athlete_id,id,action) VALUES($1,$2,'export_requested')",
          [athleteId, randomUUID()],
        );
        return artifact;
      });
    },
    eraseAccount(athleteId) {
      return database.exclusiveTenant(athleteId, async (tx) => {
        await tx.query('SELECT public.erase_account($1)', [athleteId]);
        return { erased: true };
      });
    },
    status(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT clock_timestamp() AS checked_at,
        CASE WHEN public.garmin_pending(clock_timestamp()) THEN 'disconnecting' ELSE coalesce((SELECT CASE WHEN state='disconnected' OR (state='connecting' AND (attempt_expires_at<=clock_timestamp() OR NOT public.garmin_session_active($1,attempt_session_id,clock_timestamp()))) THEN 'not_connected' WHEN state='connected' AND refresh_expires_at<=clock_timestamp() THEN 'reconnect_required' ELSE state END FROM garmin_connection WHERE athlete_id=$1),'not_connected') END AS garmin_state,
        (SELECT jsonb_build_object('pending',count(*) FILTER(WHERE completed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp())),'leased',count(*) FILTER(WHERE completed_at IS NULL AND lease_until>clock_timestamp()),'retrying',count(*) FILTER(WHERE completed_at IS NULL AND attempts>0 AND (lease_until IS NULL OR lease_until<=clock_timestamp())),'completed',count(*) FILTER(WHERE completed_at IS NOT NULL)) FROM outbox WHERE athlete_id=$1) AS outbox,
        (SELECT coalesce(jsonb_agg(a ORDER BY created_at DESC,id),'[]'::jsonb) FROM(SELECT id,action,created_at FROM operations_audit WHERE athlete_id=$1 ORDER BY created_at DESC,id LIMIT 10) a) AS audit`,
          [athleteId],
        );
        const row = z
          .object({
            checked_at: z.date(),
            garmin_state: z.string(),
            outbox: z.unknown(),
            audit: z.array(
              z.object({
                id: z.uuid(),
                action: z.enum(['export_requested', 'account_erased']),
                created_at: z.string(),
              }),
            ),
          })
          .parse(result.rows[0]);
        return operationsStatusSchema.parse({
          checkedAt: row.checked_at.toISOString(),
          outbox: row.outbox,
          providers: { garmin: row.garmin_state, healthkit: 'not_connected' },
          audit: row.audit.map((item) => ({
            id: item.id,
            action: item.action,
            createdAt: item.created_at,
          })),
        });
      });
    },
  };
}
