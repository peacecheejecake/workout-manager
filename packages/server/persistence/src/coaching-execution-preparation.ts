import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  digestExecutionCatalog,
  freezeCoachingExecutionSelection,
  type FrozenExecutionSelection,
  type ExecutionSelectionBlockedCode,
} from '@workout/server-coaching/coaching-execution-selection';
import {
  AppConsentRequiredError,
  AppAdmissionBindingError,
  lockAppAdmission,
} from './app-admission.js';
import { AiSettingsRepositoryError, readCurrentAiCatalogIn } from './ai-settings.js';
import {
  readCoachingExecutionSettingsIn,
  type ExecutionSettingsReadResult,
} from './coaching-execution-settings.js';
import { CoachingRunError, prepareOwnedCoachingEvidenceIn } from './coaching-runs.js';
import type { Transaction } from './database.js';

const revision = z.number().int().positive().max(2_147_483_647);
const version = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const intentSchema = z.strictObject({
  threadId: uuid,
  evidenceSnapshotId: uuid,
  expectedConversationRevision: revision.max(2_147_483_646),
  settings: z.strictObject({
    revision,
    catalogRevision: revision,
    policyVersion: version,
    disclosureVersion: version,
  }),
  purpose: z.enum(['coaching', 'synthetic_comparison']),
});
const consentRows = z
  .array(z.strictObject({ kind: z.enum(['app', 'ai']), granted: z.boolean(), revision }))
  .max(2);
const classification = z.enum(['health', 'synthetic_only']);
export interface CoachingExecutionPreparationPorts {
  /** Trusted server configuration, never values forwarded from a browser. */
  readonly policy: unknown;
  readonly registry: unknown;
  /** Must classify the owned evidence; this does not establish provider readiness. */
  classifyEvidenceIn(transaction: Transaction, evidence: unknown): Promise<unknown>;
}
const authority = {
  storage: 'not_persisted',
  admissionAllowed: false,
  sourceCompleteness: false,
} as const;
export type CoachingExecutionPreparationBlockedCode =
  | ExecutionSelectionBlockedCode
  | Extract<ExecutionSettingsReadResult, { kind: 'blocked' }>['code']
  | CoachingRunError['code']
  | AppConsentRequiredError['code']
  | AppAdmissionBindingError['code']
  | AiSettingsRepositoryError['code']
  | 'INVALID_INTENT'
  | 'INVALID_REGISTRY'
  | 'INVALID_CONSENT_FACTS'
  | 'INVALID_CATALOG'
  | 'INVALID_CLASSIFICATION';
export type CoachingExecutionPreparationResult =
  | (typeof authority & { kind: 'blocked'; code: CoachingExecutionPreparationBlockedCode })
  | (typeof authority & {
      kind: 'prepared';
      frozen: FrozenExecutionSelection;
      evidenceSnapshotId: string;
      threadId: string;
    });
const blocked = (
  code: CoachingExecutionPreparationBlockedCode,
): CoachingExecutionPreparationResult => ({
  ...authority,
  kind: 'blocked',
  code,
});

/** Local epoch fingerprint only. This is neither a complete source manifest nor
 * a SQL-row/witness digest. Fixed order and subject/kind namespaces are intentional. */
function consentDigest(athleteId: string, row: z.infer<typeof consentRows>[number]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 'coaching-execution-consent-v1',
        athleteId,
        kind: row.kind,
        granted: row.granted,
        revision: row.revision,
      }),
    )
    .digest('hex');
}
/** Caller owns the authenticated transaction and global→lifecycle locks. No
 * BEGIN/COMMIT, job/receipt/outbox/hold writes or provider calls. Preparation never
 * opens CLOSED processing and never grants outbound admission. */
export async function prepareCoachingExecutionIn(
  transaction: Transaction,
  unknownIntent: unknown,
  ports: CoachingExecutionPreparationPorts,
): Promise<CoachingExecutionPreparationResult> {
  const parsed = intentSchema.safeParse(unknownIntent);
  if (!parsed.success) return blocked('INVALID_INTENT');
  const intent = parsed.data;
  // Snapshot a finite server registry before awaits; this is not a provider
  // availability assertion. The existing selection helper decodes every binding.
  if (!Array.isArray(ports.registry) || ports.registry.length > 40)
    return blocked('INVALID_REGISTRY');
  let registry: unknown;
  try {
    const encoded = JSON.stringify(ports.registry);
    if (Buffer.byteLength(encoded, 'utf8') > 65_536) return blocked('INVALID_REGISTRY');
    registry = JSON.parse(encoded) as unknown;
  } catch {
    return blocked('INVALID_REGISTRY');
  }
  await lockAppAdmission(transaction);
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [
    transaction.athleteId,
  ]);
  await transaction.query('SAVEPOINT execution_preparation_owned');
  let owned: Awaited<ReturnType<typeof prepareOwnedCoachingEvidenceIn>>;
  try {
    owned = await prepareOwnedCoachingEvidenceIn(
      transaction,
      intent.threadId,
      {
        schemaVersion: 1,
        evidenceSnapshotId: intent.evidenceSnapshotId,
        expectedConversationRevision: intent.expectedConversationRevision,
        retrieval: { kind: 'none' },
      },
      ports.policy,
    );
    await transaction.query('RELEASE SAVEPOINT execution_preparation_owned');
  } catch (error) {
    if (
      error instanceof CoachingRunError ||
      error instanceof AppConsentRequiredError ||
      error instanceof AppAdmissionBindingError
    ) {
      await transaction.query('ROLLBACK TO SAVEPOINT execution_preparation_owned');
      await transaction.query('RELEASE SAVEPOINT execution_preparation_owned');
      return blocked(error.code);
    }
    throw error;
  }
  const rows = consentRows.safeParse(
    (
      await transaction.query(
        "SELECT kind,granted,revision FROM consent WHERE athlete_id=$1 AND kind IN ('app','ai') ORDER BY kind",
        [transaction.athleteId],
      )
    ).rows,
  );
  if (!rows.success || new Set(rows.data.map((row) => row.kind)).size !== rows.data.length)
    return blocked('INVALID_CONSENT_FACTS');
  const app = rows.data.find((row) => row.kind === 'app');
  const ai = rows.data.find((row) => row.kind === 'ai');
  if (!app?.granted || !ai?.granted) return blocked('PERMISSION_REQUIRED');
  if (
    owned.dependencies.aiConsent.kind !== 'exists' ||
    owned.dependencies.aiConsent.revision !== ai.revision
  )
    return blocked('PERMISSION_MISMATCH');
  const saved = await readCoachingExecutionSettingsIn(transaction, intent.settings);
  if (saved.kind !== 'read') return blocked(saved.code);
  let currentCatalog: Awaited<ReturnType<typeof readCurrentAiCatalogIn>>;
  try {
    currentCatalog = await readCurrentAiCatalogIn(transaction);
  } catch (error) {
    if (error instanceof AiSettingsRepositoryError) return blocked(error.code);
    throw error;
  }
  const catalogDigest = digestExecutionCatalog(currentCatalog);
  if (!catalogDigest) return blocked('INVALID_CATALOG');
  const payload = classification.safeParse(
    await ports.classifyEvidenceIn(transaction, owned.snapshot),
  );
  if (!payload.success) return blocked('INVALID_CLASSIFICATION');
  const permissions = {
    app: {
      revision: app.revision,
      enabled: true,
      digest: consentDigest(transaction.athleteId, app),
    },
    ai: { revision: ai.revision, enabled: true, digest: consentDigest(transaction.athleteId, ai) },
  };
  const result = freezeCoachingExecutionSelection({
    saved: saved.saved,
    purpose: intent.purpose,
    payloadClassification: payload.data,
    pinnedPermissions: permissions,
    currentPermissions: permissions,
    currentCatalog,
    catalogDigest,
    registry,
  });
  if (result.kind === 'blocked') return blocked(result.code);
  return {
    ...authority,
    kind: 'prepared',
    frozen: result.frozen,
    evidenceSnapshotId: intent.evidenceSnapshotId,
    threadId: intent.threadId,
  };
}
