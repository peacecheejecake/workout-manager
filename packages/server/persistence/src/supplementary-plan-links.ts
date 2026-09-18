import {
  supplementarySessionLinkSchema,
  type SupplementarySessionLink,
} from '@workout/contracts/supplementary-core';
import type { PlanDraft } from '@workout/contracts/planning';
import type { Transaction } from './database.js';
import {
  insertSupplementarySessionLink,
  SupplementaryReferenceError,
} from './supplementary-core.js';

export interface SupplementaryLinkChange {
  plannedSessionId: string;
  content: SupplementarySessionLink['content'] | null;
}

/** Copy immutable content forward and apply explicit changes in the plan-write transaction. */
export async function persistSupplementarySessionLinks(
  tx: Transaction,
  previousPlanVersionId: string | null,
  newPlanVersionId: string,
  nextDraft: PlanDraft,
  overrides: readonly SupplementaryLinkChange[],
): Promise<void> {
  const strengthIds = new Set(
    nextDraft.sessions
      .filter((session) => session.sport === 'strength')
      .map((session) => session.id),
  );
  const bySession = new Map<string, SupplementarySessionLink['content']>();
  if (previousPlanVersionId !== null) {
    const prior = await tx.query(
      `SELECT planned_session_id,content_kind,routine_version_id,embedded_spec_json
         FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=$2`,
      [tx.athleteId, previousPlanVersionId],
    );
    for (const row of prior.rows) {
      const plannedSessionId = String(row['planned_session_id']);
      const link = supplementarySessionLinkSchema.parse({
        schemaVersion: 2,
        planVersionId: previousPlanVersionId,
        plannedSessionId,
        content:
          row['content_kind'] === 'routine_version'
            ? { kind: 'routine_version', routineVersionId: row['routine_version_id'] }
            : { kind: 'embedded', spec: row['embedded_spec_json'] },
      });
      if (strengthIds.has(plannedSessionId)) bySession.set(plannedSessionId, link.content);
    }
  }
  const seen = new Set<string>();
  for (const override of overrides) {
    if (!strengthIds.has(override.plannedSessionId) || seen.has(override.plannedSessionId))
      throw new SupplementaryReferenceError('SESSION_LINK_INVALID');
    seen.add(override.plannedSessionId);
    if (override.content === null) bySession.delete(override.plannedSessionId);
    else bySession.set(override.plannedSessionId, override.content);
  }
  for (const [plannedSessionId, content] of [...bySession].sort(([a], [b]) => a.localeCompare(b))) {
    await insertSupplementarySessionLink(tx, {
      schemaVersion: 2,
      planVersionId: newPlanVersionId,
      plannedSessionId,
      content,
    });
  }
}
