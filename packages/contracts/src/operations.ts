import { z } from 'zod';
import { garminConnectionStateSchema } from './garmin.js';
import {
  genericRecoveryExportFields34,
  validateGenericRecoveryExportTuples34,
  validateGenericRecoveryExportTuples36,
  validateGenericRecoveryExportWithManualResults,
} from './generic-recovery-export.js';
import {
  raceNutritionExportFields35,
  validateRaceNutritionExportTuples35,
} from './race-nutrition-export.js';

import {
  checkInTemplateExportFields,
  validateCheckInTemplateExportTuples,
} from './check-in-template-export.js';
import {
  raceManualPersonalExportFields,
  validateRaceManualPersonalExportTuples,
} from './race-manual-personal-export.js';
import {
  raceManualInternalPersonalExportFields,
  raceManualInternalWholePlainSchema,
  validateRaceManualInternalPersonalExportTuples,
} from './race-manual-internal-personal-export.js';
import {
  manualSourcePersonalExportFields,
  validateManualSourcePersonalExportTuples,
} from './manual-source-personal-export.js';
import type { raceManualApprovalResultSchema } from './race-manual-approval.js';
import { planSnapshotSchema } from './planning.js';

const count = z.number().int().nonnegative();
const rows = z.array(z.record(z.string(), z.json())).max(1000);
/** Versioned download artifact, deliberately excludes authentication and command internals. */
const accountExportV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  athleteId: z.string().min(1).max(200),
  exportedAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    consents: rows,
    planSnapshots: rows,
    planHead: rows,
    planHistory: rows,
    activities: rows,
    activitySources: rows,
    sourceRevisions: rows,
    overlays: rows,
    overlayRevisions: rows,
    suppressions: rows,
    checkIns: rows,
    checkInRevisions: rows,
  }),
});
const accountExportV3Schema = accountExportV2Schema.extend({
  schemaVersion: z.literal(3),
  data: accountExportV2Schema.shape.data.extend({
    sessionCompletions: rows,
    sessionCompletionRevisions: rows,
  }),
});
const accountExportV4Schema = accountExportV3Schema.extend({
  schemaVersion: z.literal(4),
  data: accountExportV3Schema.shape.data.extend({
    planScenarios: rows,
    planScenarioRevisions: rows,
    planScenarioApplications: rows,
  }),
});
const accountExportV5Schema = accountExportV4Schema.extend({
  schemaVersion: z.literal(5),
  data: accountExportV4Schema.shape.data.extend({
    coachingThreads: rows,
    coachingMessages: rows,
  }),
});
const accountExportV6Schema = accountExportV5Schema.extend({
  schemaVersion: z.literal(6),
  data: accountExportV5Schema.shape.data.extend({ evidenceSnapshots: rows }),
});
const accountExportV7Schema = accountExportV6Schema.extend({
  schemaVersion: z.literal(7),
  data: accountExportV6Schema.shape.data.extend({
    coachingConstraints: rows,
    coachingConstraintHeads: rows,
  }),
});
const accountExportV8Schema = accountExportV7Schema.extend({
  schemaVersion: z.literal(8),
  data: accountExportV7Schema.shape.data.extend({
    coachingRuns: rows,
    coachingAnalysisOutputs: rows,
  }),
});
const accountExportV9Schema = accountExportV8Schema.extend({
  schemaVersion: z.literal(9),
  data: accountExportV8Schema.shape.data.extend({
    coachingDecisions: rows,
    coachingProposals: rows,
    coachingCandidates: rows,
  }),
});
const accountExportV10Schema = accountExportV9Schema.extend({
  schemaVersion: z.literal(10),
  data: accountExportV9Schema.shape.data.extend({
    nutritionPlanVersions: rows,
    nutritionPlanHeads: rows,
    nutritionPlanHistory: rows,
    foodDefinitionVersions: rows,
    foodDefinitionHeads: rows,
    intakeEntries: rows,
    intakeEntryRevisions: rows,
  }),
});
const accountExportV11Schema = accountExportV10Schema.extend({
  schemaVersion: z.literal(11),
  data: accountExportV10Schema.shape.data.extend({
    supplementaryExerciseVersions: rows,
    supplementaryExerciseHeads: rows,
    supplementaryRoutineVersions: rows,
    supplementaryRoutineHeads: rows,
    supplementaryRoutineTargetRefs: rows,
    supplementarySessionLinks: rows,
    supplementarySessionTargetRefs: rows,
    supplementaryExecutions: rows,
    supplementarySetLogs: rows,
    supplementarySetLogRevisions: rows,
    supplementaryRestTimers: rows,
  }),
});
const accountExportV12Schema = accountExportV11Schema.extend({
  schemaVersion: z.literal(12),
  data: accountExportV11Schema.shape.data.extend({
    resources: rows,
    resourceVersions: rows,
  }),
});
const accountExportV13Schema = accountExportV12Schema.extend({
  schemaVersion: z.literal(13),
});
const accountExportV14Schema = accountExportV13Schema.extend({
  schemaVersion: z.literal(14),
  data: accountExportV13Schema.shape.data.extend({
    resourceUrlIngestions: rows,
    resourceUrlAttempts: rows,
    resourceUrlFetchHops: rows,
    resourceUrlArtifacts: rows,
    resourceUrlProvenance: rows,
    resourceUrlLocators: rows,
  }),
});
const accountExportV15Schema = accountExportV14Schema.extend({
  schemaVersion: z.literal(15),
  data: accountExportV14Schema.shape.data.extend({
    resourceShares: rows,
    resourceAccessAudit: rows,
  }),
});
const accountExportV16Schema = accountExportV15Schema.extend({
  schemaVersion: z.literal(16),
  data: accountExportV15Schema.shape.data.extend({
    galleryMediaItems: rows,
    galleryMediaDerivatives: rows,
  }),
});
/**
 * v17 adds the retrieval derived stores. Passage and excerpt bodies are not
 * exported: they are verbatim copies of resource versions that the export
 * already carries, and citations reference them by identifier and offset. The
 * retrieval cache is not exported at all — it is a rebuildable cache and is
 * dropped on erasure.
 */
const accountExportV17Schema = accountExportV16Schema.extend({
  schemaVersion: z.literal(17),
  data: accountExportV16Schema.shape.data.extend({
    resourcePassages: rows,
    resourceGroundings: rows,
    resourceGroundingExcerpts: rows,
    resourceCitations: rows,
  }),
});
/**
 * v18 adds the stored recorded-track ledger. Coordinates, sample ids and storage
 * references are deliberately absent: the export carries track identity, parser
 * identity, the sample-correspondence digest, aggregate counts and object hashes,
 * while the geometry itself stays behind the authenticated download. Tracks of a
 * deleted activity are excluded exactly as the activity itself is.
 */
const accountExportV18Schema = accountExportV17Schema.extend({
  schemaVersion: z.literal(18),
  data: accountExportV17Schema.shape.data.extend({
    activityTracks: rows,
    activityTrackRevisions: rows,
  }),
});
/**
 * v19 adds the private course ledger. Course geometry is deliberately absent: the export
 * carries course identity, revision identity, name, the generation conditions, the source
 * lineage, vertex count, planned distance and the content digest, while the coordinates
 * themselves are obtained through the owner's authenticated GPX export. Courses reclaimed
 * with a deleted activity keep their head row and have no revisions, exactly as the read
 * path reports them.
 */
const accountExportV19Schema = accountExportV18Schema.extend({
  schemaVersion: z.literal(19),
  data: accountExportV18Schema.shape.data.extend({
    courses: rows,
    courseRevisions: rows,
  }),
});
/**
 * v20 adds the owner's own course preferences and protected areas (M2-01j).
 *
 * The protected-area **centre is included**, and deliberately so. The "no coordinates"
 * posture elsewhere in this export is about derived records not carrying coordinates they
 * do not need — a generation condition, a revision's provenance. A protected area is not
 * derived: it is a datum the owner typed in, and an export that omits it cannot restore
 * what they had, which is what an export is for. The export is already the sensitive
 * artifact of this product and is handled as one; making it lossy would not make it safer.
 *
 * Preferences are the two allowlisted fields and nothing else, so an export cannot become
 * a back door for state the product refused to store in the first place.
 */
const accountExportV20Schema = accountExportV19Schema.extend({
  schemaVersion: z.literal(20),
  data: accountExportV19Schema.shape.data.extend({
    coursePreferences: rows,
    coursePrivacyZones: rows,
  }),
});
/**
 * v21 adds the stored course thumbnails (M2-01l).
 *
 * **Facts about the picture, never the picture.** A thumbnail is a *derivative*: it is
 * recomputable, byte for byte, from the revision's geometry by the renderer this artifact
 * names, and the owner's authenticated GPX export already carries those coordinates. So
 * exporting the bytes would put a second, pictorial copy of the owner's locations into the
 * most sensitive artifact this product produces, and it would buy nothing a restore cannot
 * rebuild. That is the opposite trade to v20's protected-area centres, which are **not**
 * derived — nothing can recompute what the owner typed in, so leaving them out would make
 * the export lossy. Same rule, two answers: export what cannot be rebuilt.
 *
 * The storage reference is absent for the same reason it is absent from v16 and v18: an
 * object key is not a fact about the owner's data, and the bytes are behind an
 * authenticated download either way. What IS carried is enough to *verify* a rebuild — the
 * revision the picture belongs to, the renderer identity, the content hash, the byte size
 * and the drawn vertex count — so a restored deployment can regenerate the picture and
 * check that it got the same one.
 *
 * Only live pictures appear. A superseded or abandoned render is a tombstone for an object
 * on its way out, and the read model already reports those revisions as having no picture.
 */
const accountExportV21Schema = accountExportV20Schema.extend({
  schemaVersion: z.literal(21),
  data: accountExportV20Schema.shape.data.extend({
    courseThumbnails: rows,
  }),
});
/**
 * v22 adds the owner's accessibility notes about their courses (M2-01r, S13 "접근성 메모").
 *
 * A note is text the owner typed, not something derived: nothing can rebuild it, so an
 * export without it cannot restore what they had. It carries the head revision it was
 * written against so a restore keeps "this note was written for revision N" as it was.
 * Earlier artifacts are read unchanged and are never given an empty collection they did
 * not have.
 */
const accountExportV22Schema = accountExportV21Schema.extend({
  schemaVersion: z.literal(22),
  data: accountExportV21Schema.shape.data.extend({
    courseAccessibilityNotes: rows,
  }),
});
/**
 * v23 adds what may leave the account from a course (M2-01k-o).
 *
 * Each protected area's **secret share offset** is included, for the same reason v20
 * includes the centre: it is an input nothing can rebuild — it was drawn once — and a
 * restore that drew a new one would move every share circle, which lets two links'
 * offsets be combined (R-7). The export is the sensitive artifact of this product and is
 * handled as one.
 *
 * Link **facts** are included and nothing that makes a link work: no token, no token
 * digest and no snapshot. An export can therefore never bring a link back, and nothing in
 * this product restores one from an export (B-5, T13). Confirmation receipts are not
 * exported: they are an hour-long permission, not the owner's data.
 *
 * The owner's **course-deletion ledger** (M2-01ao) is included the way activity
 * suppressions are: course id and when, nothing else. It is what keeps a deleted course
 * deleted, and nothing can rebuild it.
 */
const accountExportV23Schema = accountExportV22Schema.extend({
  schemaVersion: z.literal(23),
  data: accountExportV22Schema.shape.data.extend({
    coursePrivacyZoneShareOffsets: rows,
    courseShares: rows,
    // M2-01ao's course-deletion ledger: course id and when, like the activity suppressions.
    courseDeletions: rows,
  }),
});
/**
 * v24 adds each place's lifetime link budget (M2-01as): per protected area a link was ever cut
 * against, the area id, the coarse 0.01° cell of its centre, its share reach (3 · S) rounded
 * up to 100 m and the lifetime link count of the place it belongs to (every area whose share
 * reach meets it shares one count, so rows of one place carry the same value). It is the
 * owner's own history, and what keeps an area made again over the same place from starting its
 * count afresh; nothing can rebuild it once the links are gone. No centre, no name and no time.
 */
const accountExportV24Schema = accountExportV23Schema.extend({
  schemaVersion: z.literal(24),
  data: accountExportV23Schema.shape.data.extend({
    courseShareAreaBudgets: rows,
  }),
});
/** v25 carries raw HealthKit workout state, deletion tombstones and batch receipts (M3-02a). */
const accountExportV25Schema = accountExportV24Schema.extend({
  schemaVersion: z.literal(25),
  data: accountExportV24Schema.shape.data.extend({
    healthKitWorkoutSamples: rows,
    healthKitWorkoutBatchReceipts: rows,
  }),
});
/** v26 records the non-canonical HealthKit workout review lineage (M3-02d). */
const accountExportV26Schema = accountExportV25Schema.extend({
  schemaVersion: z.literal(26),
  data: accountExportV25Schema.shape.data.extend({
    healthKitWorkoutLineage: z
      .array(
        z.strictObject({
          sample_id: z.uuid(),
          state: z.enum(['pending_review', 'suppressed', 'deleted']),
        }),
      )
      .max(1000),
  }),
});
/** v27 preserves explicit existing-Activity links without exporting raw sample digests. */
const accountExportV27Schema = accountExportV26Schema.extend({
  schemaVersion: z.literal(27),
  data: accountExportV26Schema.shape.data.extend({
    healthKitWorkoutLineage: z
      .array(
        z.strictObject({
          sample_id: z.uuid(),
          state: z.enum(['pending_review', 'linked_existing', 'suppressed', 'deleted']),
        }),
      )
      .max(1000),
    healthKitExistingBindings: z
      .array(
        z.strictObject({
          sample_id: z.uuid(),
          activity_id: z.uuid(),
          target_revision: z.number().int().positive(),
          bound_at: z.iso.datetime({ offset: true }),
        }),
      )
      .max(1000),
  }),
});
/** v28 distinguishes an explicitly created HealthKit-primary Activity from a supplement. */
const accountExportV28Schema = accountExportV27Schema.extend({
  schemaVersion: z.literal(28),
  data: accountExportV27Schema.shape.data.extend({
    healthKitWorkoutLineage: z
      .array(
        z.strictObject({
          sample_id: z.uuid(),
          state: z.enum([
            'pending_review',
            'linked_existing',
            'created_activity',
            'suppressed',
            'deleted',
          ]),
        }),
      )
      .max(1000),
  }),
});
/** v29 exports attribution facts, never command receipts or reusable claim epochs.
 * A portable account artifact is not a command to restore active ownership. */
const accountExportV29Schema = accountExportV28Schema.extend({
  schemaVersion: z.literal(29),
  data: accountExportV28Schema.shape.data.extend({
    healthKitWorkoutClaims: z
      .array(
        z.strictObject({
          sample_id: z.uuid(),
          consent_revision: z.number().int().min(1).max(2_147_483_647),
          created_at: z.iso.datetime({ offset: true }),
        }),
      )
      .max(1000),
    healthKitWorkoutRegistryHeads: z
      .array(
        z.strictObject({
          revision: z.number().int().min(1).max(2_147_483_647),
        }),
      )
      .max(1),
    healthKitWorkoutRegistrations: z
      .array(
        z.strictObject({
          registry_revision: z.number().int().min(1).max(2_147_483_647),
          registered_count: z.number().int().min(1).max(50),
        }),
      )
      .max(1000),
  }),
});
/** v30 distinguishes claims awaiting cleanup and portable deregistration facts.
 * These facts never carry executable ownership or suppression replay commands. */
const accountExportV30Schema = accountExportV29Schema.extend({
  schemaVersion: z.literal(30),
  data: accountExportV29Schema.shape.data.extend({
    healthKitWorkoutClaims: z
      .array(
        accountExportV29Schema.shape.data.shape.healthKitWorkoutClaims.element.extend({
          state: z.enum(['active', 'pending_cleanup']),
        }),
      )
      .max(1000),
    healthKitWorkoutDeregistrations: z
      .array(
        z
          .strictObject({
            operation_id: z.uuid(),
            sample_id: z.uuid(),
            state: z.enum(['pending_cleanup', 'released']),
            registry_revision: z.number().int().min(1).max(2_147_483_647),
            requested_at: z.iso.datetime({ offset: true }),
            released_at: z.iso.datetime({ offset: true }).nullable(),
          })
          .refine(
            (operation) => (operation.state === 'released') === (operation.released_at !== null),
            {
              message:
                'Released operations require a release timestamp; pending operations cannot have one',
            },
          ),
      )
      .max(1000),
  }),
});
/** v31 adds planned races and separate user-reported performance ledgers. */
const accountExportV31Schema = accountExportV30Schema.extend({
  schemaVersion: z.literal(31),
  data: accountExportV30Schema.shape.data.extend({
    raceEvents: rows,
    raceEventRevisions: rows,
    raceResults: rows,
    raceResultRevisions: rows,
    trainingBests: rows,
    trainingBestRevisions: rows,
    raceCollectionHeads: rows,
  }),
});
/** v32 exports immutable app attribution facts, never receipt keys or replay commands.
 * Portable facts cannot authorize processing or recreate admission bindings. */
const accountExportV32Schema = accountExportV31Schema.extend({
  schemaVersion: z.literal(32),
  data: accountExportV31Schema.shape.data.extend({
    evidenceAppBindings: z
      .array(
        z.strictObject({
          evidence_snapshot_id: z.uuid(),
          binding_version: z.literal(1),
          app_revision: z.number().int().min(1).max(2147483647),
          captured_at: z.iso.datetime({ offset: true }),
        }),
      )
      .max(1000),
    runAppBindings: z
      .array(
        z.strictObject({
          run_id: z.uuid(),
          evidence_snapshot_id: z.uuid(),
          binding_version: z.literal(1),
        }),
      )
      .max(1000),
    candidateAppBindings: z
      .array(
        z.strictObject({
          candidate_id: z.uuid(),
          run_id: z.uuid(),
          binding_version: z.literal(1),
        }),
      )
      .max(1000),
    integratedCandidateAppBindings: z
      .array(
        z.strictObject({
          candidate_id: z.uuid(),
          evidence_snapshot_id: z.uuid(),
          binding_version: z.literal(1),
        }),
      )
      .max(1000),
    approvalAppBindings: z
      .array(
        z
          .strictObject({
            candidate_id: z.uuid().nullable(),
            integrated_candidate_id: z.uuid().nullable(),
            integrated_approval_id: z.uuid().nullable(),
            binding_version: z.literal(1),
            created_at: z.iso.datetime({ offset: true }),
          })
          .refine(
            (value) => (value.candidate_id === null) !== (value.integrated_candidate_id === null),
          )
          .refine(
            (value) =>
              value.integrated_approval_id === null || value.integrated_candidate_id !== null,
          ),
      )
      .max(1000),
  }),
});
// Preference history is portable data, never executable consent or model permission.
const aiSettingIdentifier = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
const aiSettingDefinition = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const aiSettingsExportRevision = z
  .strictObject({
    revision: z.number().int().min(1).max(2147483647),
    updated_at: z.iso.datetime({ offset: true }),
    catalog_revision: z.number().int().min(1).max(2147483647),
    policy_version: aiSettingDefinition,
    disclosure_version: aiSettingDefinition,
    default_provider_id: aiSettingIdentifier.nullable(),
    default_model_id: aiSettingIdentifier.nullable(),
    comparison_kind: z.enum(['off', 'selected']),
    comparison_provider_id: aiSettingIdentifier.nullable(),
    comparison_model_id: aiSettingIdentifier.nullable(),
  })
  .refine((row) => (row.default_provider_id === null) === (row.default_model_id === null))
  .refine((row) =>
    row.comparison_kind === 'off'
      ? row.comparison_provider_id === null && row.comparison_model_id === null
      : row.comparison_provider_id !== null && row.comparison_model_id !== null,
  );
// Shape spread avoids adding another nested Extend layer to the historical schema chain.
const accountExportV33Schema = z.strictObject({
  ...accountExportV32Schema.shape,
  schemaVersion: z.literal(33),
  data: z.strictObject({
    ...accountExportV32Schema.shape.data.shape,
    aiSettingsHeads: z
      .array(z.strictObject({ revision: z.number().int().min(1).max(2147483647) }))
      .max(1),
    aiSettingsRevisions: z.array(aiSettingsExportRevision).max(1000),
  }),
});
// v34 adds retained routine/recovery facts without executable command metadata.
const accountExportV34Schema = z.strictObject({
  ...accountExportV33Schema.shape,
  schemaVersion: z.literal(34),
  data: z
    .strictObject({
      ...accountExportV33Schema.shape.data.shape,
      ...genericRecoveryExportFields34,
    })
    .superRefine(validateGenericRecoveryExportTuples34),
});
/** Current retained facts, with strict race/nutrition tuples. Export validation
 * does not authenticate an operational archive or authorize restored processing. */
export const accountExportV35Schema = z.strictObject({
  ...accountExportV34Schema.shape,
  schemaVersion: z.literal(35),
  data: z
    .strictObject({
      ...accountExportV34Schema.shape.data.shape,
      ...raceNutritionExportFields35,
    })
    .superRefine(validateGenericRecoveryExportTuples34)
    .superRefine(validateRaceNutritionExportTuples35),
});
/** V36 adds user-retained templates and normalized manual public successes.
 * Existing V35 checks remain intact. This is portable structural correspondence,
 * never source authentication, current permission or restored admission. */
export const trainingPlanAggregateExportSchema = z.strictObject({
  version_id: planSnapshotSchema.shape.id.transform((value) =>
    z.uuid().safeParse(value).success ? value.toLowerCase() : value,
  ),
  aggregate_id: z.uuid().transform((value) => value.toLowerCase()),
});
export const trainingPlanAggregateExportFields = {
  trainingPlanAggregates: z.array(trainingPlanAggregateExportSchema).max(1000),
};
const retainedExportData36 = z
  .strictObject({
    ...accountExportV35Schema.shape.data.shape,
    ...checkInTemplateExportFields,
    ...raceManualPersonalExportFields,
    ...trainingPlanAggregateExportFields,
  })
  .superRefine(validateRaceNutritionExportTuples35)
  .superRefine(validateCheckInTemplateExportTuples)
  .superRefine(validateRaceManualPersonalExportTuples)
  .superRefine(validateGenericRecoveryExportTuples36);
type RetainedExportData36 = z.infer<typeof retainedExportData36>;
const trainingExportSnapshot36 = z.strictObject({
  id: planSnapshotSchema.shape.id,
  version: planSnapshotSchema.shape.version,
  created_at: planSnapshotSchema.shape.createdAt,
  draft: planSnapshotSchema.shape.draft,
});
const normalizedExportId36 = (value: string) =>
  z.uuid().safeParse(value).success ? value.toLowerCase() : value;
function sameExportInstant36(left: string, right: string) {
  const parts = (value: string) => {
    const match = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match?.[1] || !match[3]) return null;
    const seconds = Date.parse(match[1] + match[3]);
    return Number.isSafeInteger(seconds)
      ? `${seconds}:${(match[2] ?? '').replace(/0+$/, '')}`
      : null;
  };
  const a = parts(left);
  return a !== null && a === parts(right);
}
type ManualCommittedResult = Extract<
  z.infer<typeof raceManualApprovalResultSchema>,
  { status: 'committed' }
>;
function publicManualResults(data: RetainedExportData36): ManualCommittedResult[] {
  return data.manualRaceCommandResults.flatMap((row) =>
    row.operation === 'approve' && row.result.status === 'committed' ? [row.result] : [],
  );
}
function validateManualDomainVersions36(data: RetainedExportData36, ctx: z.RefinementCtx) {
  validateManualDomainVersions(
    data,
    ctx,
    publicManualResults(data),
    data.manualRaceApprovalHistory,
  );
}
function validateManualDomainVersions(
  data: RetainedExportData36,
  ctx: z.RefinementCtx,
  results: readonly ManualCommittedResult[],
  histories: RetainedExportData36['manualRaceApprovalHistory'],
) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sameId = (left: string, right: string) =>
    normalizedExportId36(left) === normalizedExportId36(right);
  const mappings = new Map<string, string>();
  for (const mapping of data.trainingPlanAggregates) {
    const key = normalizedExportId36(mapping.version_id);
    if (mappings.has(key)) fail('Duplicate training version aggregate mapping');
    mappings.set(key, mapping.aggregate_id);
    const rows = data.planSnapshots.filter(
      (row) => typeof row['id'] === 'string' && sameId(row['id'], mapping.version_id),
    );
    if (rows.length !== 1 || !trainingExportSnapshot36.safeParse(rows[0]).success)
      fail('Training mapping requires its exact exported snapshot/body');
  }
  for (const history of histories) {
    const result = results.find((row) => row.candidateId === history.candidateId);
    if (!result) continue; // Each source's exact tuple verifier reports missing originals.
    const committed = result.versions.find(
      (row) =>
        row.domain === history.domain &&
        sameId(row.aggregateId, history.aggregateId) &&
        sameId(row.versionId, history.versionId),
    );
    if (!committed) continue; // The exact manual tuple validator reports this mismatch.
    switch (history.domain) {
      case 'training': {
        const matches = data.planSnapshots.filter(
          (row) => typeof row['id'] === 'string' && sameId(row['id'], history.versionId),
        );
        const snapshot =
          matches.length === 1 ? trainingExportSnapshot36.safeParse(matches[0]) : null;
        if (
          !snapshot?.success ||
          committed.domain !== 'training' ||
          snapshot.data.version !== committed.version ||
          mappings.get(normalizedExportId36(history.versionId)) !==
            normalizedExportId36(history.aggregateId) ||
          !data.planHistory.some(
            (row) =>
              typeof row['version_id'] === 'string' &&
              sameId(row['version_id'], history.versionId) &&
              row['action'] === 'candidate_approved',
          )
        )
          fail('Manual training approval requires its exact immutable snapshot/body/history');
        break;
      }
      case 'nutrition': {
        const matches = data.nutritionPlanVersions.filter(
          (row) =>
            sameId(row.plan_id, history.aggregateId) && sameId(row.version_id, history.versionId),
        );
        if (
          matches.length !== 1 ||
          committed.domain !== 'nutrition' ||
          matches[0]?.version !== committed.version ||
          !matches[0] ||
          !sameExportInstant36(matches[0].approved_at, history.approvedAt) ||
          !data.nutritionPlanHistory.some(
            (row) =>
              sameId(row.plan_id, history.aggregateId) &&
              sameId(row.version_id, history.versionId) &&
              sameId(row.approval_id, matches[0]?.approval_id ?? '') &&
              sameExportInstant36(row.created_at, history.approvedAt),
          )
        )
          fail('Manual nutrition approval requires its exact stored body and domain history');
        break;
      }
      case 'recovery': {
        const matches = data.recoveryStrategyVersions.filter(
          (row) =>
            sameId(row.strategy_id, history.aggregateId) &&
            sameId(row.version_id, history.versionId),
        );
        if (
          matches.length !== 1 ||
          committed.domain !== 'recovery' ||
          matches[0]?.version !== committed.version ||
          matches[0]?.record_json.status !== 'user_confirmed'
        )
          fail(
            'Manual recovery approval requires its exact stored body and original manual history',
          );
        break;
      }
      case 'routine_schedule': {
        const matches = data.genericRoutineScheduleVersions.filter(
          (row) =>
            sameId(row.schedule_id, history.aggregateId) &&
            sameId(row.version_id, history.versionId),
        );
        if (matches.length !== 1)
          fail(
            'Manual routine approval requires its exact stored body and original manual history',
          );
        break;
      }
    }
  }
}
export const accountExportV36Schema = z.strictObject({
  ...accountExportV35Schema.shape,
  schemaVersion: z.literal(36),
  data: retainedExportData36.superRefine(validateManualDomainVersions36),
});
export type AccountExportV36 = z.infer<typeof accountExportV36Schema>;
/** V37 adds every retained internal family, without changing V36's public-only
 * producer policy or converting portable observations to authorization. */
const retainedExportShape37 = z
  .strictObject({
    ...accountExportV35Schema.shape.data.shape,
    ...checkInTemplateExportFields,
    ...raceManualPersonalExportFields,
    ...trainingPlanAggregateExportFields,
  })
  .safeExtend({
    ...raceManualInternalPersonalExportFields,
    sourceProvenanceCoverage: z.literal('not_exported_policy_unresolved'),
  });
type RetainedExportData37 = Omit<z.infer<typeof retainedExportShape37>, 'sourceProvenanceCoverage'>;
function sameRetainedFact37(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value: unknown, index) => sameRetainedFact37(value, b[index]))
    );
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a),
    right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && sameRetainedFact37(value, right.get(key)))
  );
}
/** Arrays representing ordered planned content remain ordered. Only explicitly
 * keyed factual rosters are compared as sets. */
function sameRetainedRoster37<T>(a: readonly T[], b: readonly T[], key: (row: T) => string) {
  const left = new Map(a.map((row) => [key(row), row]));
  const right = new Map(b.map((row) => [key(row), row]));
  return (
    left.size === a.length &&
    right.size === b.length &&
    left.size === right.size &&
    [...left].every(([id, row]) => right.has(id) && sameRetainedFact37(row, right.get(id)))
  );
}
function validateRetainedOverlap37(data: RetainedExportData37, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const candidates = new Map(data.manualInternalCandidates.map((v) => [v.candidateId, v]));
  for (const review of data.manualRaceReviews) {
    const internal = candidates.get(review.reference.candidateId);
    if (
      !internal ||
      internal.chain.evidenceId !== review.reference.chain.evidenceId ||
      internal.chain.decisionId !== review.reference.chain.decisionId ||
      internal.chain.proposalId !== review.reference.chain.proposalId ||
      !sameExportInstant36(internal.createdAt, review.createdAt) ||
      internal.body.state !== review.bodyState
    ) {
      fail('Public review requires exact internal candidate/state/chain');
      continue;
    }
    // Public purge DTO deliberately contains no purge event/time. Internal tuple
    // validation checks that provenance; no missing public facts are invented.
    if (internal.body.state !== 'present' || review.preview?.status !== 'present') continue;
    if (internal.body.storedApplicationState !== 'ready_for_explicit_approval')
      fail('Public ready review requires original ready candidate');
    const a = review.preview,
      b = internal.body.planned;
    if (
      !sameRetainedFact37(a.race, b.race) ||
      !sameRetainedRoster37(a.affected, b.affected, (v) =>
        JSON.stringify([v.domain, v.aggregateId]),
      ) ||
      !sameRetainedRoster37(a.retainedUnplanned, b.retainedUnplanned, (v) => v.runId)
    )
      fail('Exact overlapping race/affected/retained run facts required');
    for (const domain of ['training', 'nutrition', 'recovery', 'routines'] as const) {
      const x = a[domain],
        y = b[domain];
      if (x.state !== y.state) fail('Exact overlapping domain roster required');
    }
    if (
      a.training.state === 'present' &&
      b.training.state === 'present' &&
      !sameRetainedRoster37(a.training.members, b.training.members, (v) => v.aggregateId)
    )
      fail('Exact overlapping training facts required');
    if (a.nutrition.state === 'present' && b.nutrition.state === 'present') {
      const publicRows = a.nutrition.members.map((m) => ({
        aggregateId: m.aggregateId,
        before: {
          ...m.before,
          plan: {
            ...m.before.plan,
            items: m.before.plan.items.map((i) => ({
              ...i,
              targets: i.targets.map((t) => ({
                metric: t.metric,
                amount: {
                  min: t.amount.min,
                  max: t.amount.max,
                  unit: t.amount.unit,
                  basis: t.amount.basis,
                },
              })),
            })),
          },
        },
        after: {
          plan: {
            ...m.after.plan,
            items: m.after.plan.items.map((i) => ({
              ...i,
              targets: i.targets.map((t) => ({
                metric: t.metric,
                amount: {
                  min: t.amount.min,
                  max: t.amount.max,
                  unit: t.amount.unit,
                  basis: t.amount.basis,
                },
              })),
            })),
          },
          linkedTraining: m.after.linkedTraining,
        },
        timings: m.timings,
      }));
      const internalRows = b.nutrition.members.map((m) => ({
        aggregateId: m.aggregateId,
        before: m.before,
        after: m.after,
        timings: m.timings.map(({ itemId, state, before, after }) => ({
          itemId,
          state,
          before,
          after,
        })),
      }));
      if (!sameRetainedRoster37(publicRows, internalRows, (v) => v.aggregateId))
        fail('Exact overlapping nutrition content/timing/link required');
    }
    if (a.recovery.state === 'present' && b.recovery.state === 'present') {
      const publicRows = a.recovery.members.map((m) => ({
        aggregateId: m.aggregateId,
        before: m.before,
        after: {
          plan: m.after.plan,
          status: m.after.status,
          selectedOptionId: m.after.selectedOptionId,
          planLinks: m.after.planLinks,
        },
      }));
      const internalRows = b.recovery.members.map((m) => ({
        aggregateId: m.aggregateId,
        before: m.before,
        after: m.after,
      }));
      if (!sameRetainedRoster37(publicRows, internalRows, (v) => v.aggregateId))
        fail('Exact overlapping recovery content/link required');
    }
    if (a.routines.state === 'present' && b.routines.state === 'present') {
      const publicRows = a.routines.members.map((m) => ({
        aggregateId: m.aggregateId,
        blueprint: m.blueprint,
        before: { schedule: m.before.schedule, expansion: m.before.expansion },
        after: { schedule: m.after.schedule, expansion: m.after.expansion },
        retainedStarted: m.retainedStarted,
      }));
      const internalRows = b.routines.members.map((m) => ({
        aggregateId: m.aggregateId,
        blueprint: m.blueprint,
        before: { schedule: m.before.schedule, expansion: m.before.expansion },
        after: { schedule: m.after.schedule, expansion: m.after.expansion },
        retainedStarted: m.retainedStarted,
      }));
      if (!sameRetainedRoster37(publicRows, internalRows, (v) => v.aggregateId))
        fail('Exact overlapping frozen routine facts required');
    }
  }
  const results = new Map(data.manualInternalApprovalResults.map((v) => [v.candidateId, v]));
  for (const result of publicManualResults(data)) {
    const internal = results.get(result.candidateId);
    if (!internal || !sameRetainedFact37(result, internal))
      fail('Public approval requires identical internal original result');
    const publicHistory = data.manualRaceApprovalHistory.filter(
      (v) => v.candidateId === result.candidateId,
    );
    const internalHistory = data.manualInternalApprovalHistory.filter(
      (v) => v.candidateId === result.candidateId,
    );
    if (
      !sameRetainedRoster37(publicHistory, internalHistory, (v) =>
        JSON.stringify([v.approvalId, v.domain, v.aggregateId]),
      )
    )
      fail('Public approval requires identical complete internal history');
  }
}
function validateRetainedData37(data: RetainedExportData37, ctx: z.RefinementCtx) {
  validateRaceNutritionExportTuples35(data, ctx);
  validateCheckInTemplateExportTuples(data, ctx);
  validateRaceManualPersonalExportTuples(data, ctx);
  validateRaceManualInternalPersonalExportTuples(data, ctx);
  validateRetainedOverlap37(data, ctx);
  // Internal ALL already contains public originals. Exact overlap is validated
  // above, so each successful approval is fed to common verifiers only once.
  validateGenericRecoveryExportWithManualResults(data, ctx, data.manualInternalApprovalResults);
  validateManualDomainVersions(
    data,
    ctx,
    data.manualInternalApprovalResults,
    data.manualInternalApprovalHistory,
  );
}
export const accountExportV37Schema = z
  .strictObject({
    ...accountExportV36Schema.shape,
    schemaVersion: z.literal(37),
    data: retainedExportShape37.superRefine(validateRetainedData37),
  })
  .superRefine((raw, ctx) => {
    if (!raceManualInternalWholePlainSchema.safeParse(raw).success)
      ctx.addIssue({ code: 'custom', message: 'Bounded whole-account V37 artifact required' });
  });
export type AccountExportV37 = z.infer<typeof accountExportV37Schema>;
/** Unknown transport callers must bound plain input before nested parsing. The
 * object schema remains available for the historical discriminated union. */
export function parseAccountExportV37(raw: unknown): AccountExportV37 {
  raceManualInternalWholePlainSchema.parse(raw);
  return accountExportV37Schema.parse(raw);
}

/** Personal saved dependency facts are observations, never source/event authentication. */
const retainedExportShape38 = z.strictObject({
  ...retainedExportShape37.shape,
  ...manualSourcePersonalExportFields,
  sourceProvenanceCoverage: z.literal('saved_safe_dependency_facts'),
  sourceAuthentication: z.literal('not_authenticated'),
  originalEventAuthentication: z.literal('not_authenticated'),
});
type RetainedExportData38 = z.infer<typeof retainedExportShape38>;
function sourceNutritionPlanned38(
  record: RetainedExportData38['nutritionPlanVersions'][number]['record_json'],
) {
  return {
    period: record.period,
    purpose: record.purpose,
    timezone: record.timezone,
    items: record.items.map(({ id, category, title, anchor, foods, targets, instructions }) => ({
      id,
      category,
      title,
      anchor,
      foods,
      targets: targets.map((t) => ({
        metric: t.metric,
        amount: {
          min: t.amount.min,
          max: t.amount.max,
          unit: t.amount.unit,
          basis: t.amount.basis,
        },
      })),
      instructions,
    })),
  };
}
function sourceRecoveryPlanned38(
  record: RetainedExportData38['recoveryStrategyVersions'][number]['record_json'],
) {
  const { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment } =
    record.draft;
  return { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment };
}
function validateSavedSourceData38(data: RetainedExportData38, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  validateRetainedData37(data, ctx);
  validateManualSourcePersonalExportTuples(data, ctx);
  const chains = new Map(data.manualInternalChains.map((c) => [c.evidenceId, c]));
  if (data.manualSourceChains.length !== chains.size)
    fail('Exact ALL internal/source chain census required');
  for (const source of data.manualSourceChains) {
    const chain = chains.get(source.evidenceId);
    if (
      !chain ||
      chain.decisionId !== source.decisionId ||
      chain.proposalId !== source.proposalId ||
      chain.body.state !== source.body.state
    ) {
      fail('Exact original internal/source chain roles and state required');
      continue;
    }
    if (
      chain.body.state === 'purged' &&
      source.body.state === 'purged' &&
      (chain.body.purgeEventId !== source.body.eventId ||
        !sameExportInstant36(chain.body.purgedAt, source.body.occurredAt))
    )
      fail('Exact original source purge event and microseconds required');
  }
  const trainingBodies = new Map(
    data.planSnapshots.flatMap((raw) => {
      const parsed = trainingExportSnapshot36.safeParse(raw);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );
  const nutritionBodies = new Map(
    data.nutritionPlanVersions.map((r) => [
      JSON.stringify([r.plan_id, r.version_id]),
      r.record_json,
    ]),
  );
  const recoveryBodies = new Map(
    data.recoveryStrategyVersions.map((r) => [
      JSON.stringify([r.strategy_id, r.version_id]),
      r.record_json,
    ]),
  );
  const blueprintBodies = new Map(
    data.genericRoutineBlueprintVersions.map((r) => [
      JSON.stringify([r.routine_id, r.version_id]),
      r.record_json,
    ]),
  );
  const scheduleBodies = new Map(
    data.genericRoutineScheduleVersions.map((r) => [
      JSON.stringify([r.schedule_id, r.version_id]),
      r.record_json,
    ]),
  );
  const raceBodies = new Map(
    data.raceEventRevisions.map((r) => [
      JSON.stringify([r['entity_id'], r['revision']]),
      r['values_json'],
    ]),
  );
  const mappings = new Set(
    data.trainingPlanAggregates.map((r) => JSON.stringify([r.aggregate_id, r.version_id])),
  );
  const bodyCorrespondence = new Map<string, boolean>();
  const checkBody = (key: string, check: () => boolean): boolean => {
    const existing = bodyCorrespondence.get(key);
    if (existing !== undefined) return existing;
    const valid = check();
    bodyCorrespondence.set(key, valid);
    return valid;
  };
  for (const ref of data.manualSavedSourceRefs) {
    if (ref.location.state !== 'known') continue;
    const chain = chains.get(ref.evidenceId);
    if (!chain || chain.body.state !== 'present') {
      fail('Known source location requires frozen present chain');
      continue;
    }
    const body = chain.body.planned;
    for (const loc of ref.location.members) {
      if (loc.side !== 'before') {
        fail('Saved source cannot identify hypothetical future content');
        continue;
      }
      const parent = loc.parent;
      let matched = false;
      switch (loc.domain) {
        case 'training':
          if (body.training.state === 'present' && parent.family === 'plan-snapshot')
            matched = body.training.members.some(
              (m) =>
                m.aggregateId === loc.aggregateId &&
                parent.sourceId === m.before.ref.versionId &&
                parent.version === m.before.ref.version &&
                trainingBodies.get(m.before.ref.versionId)?.version === m.before.ref.version &&
                checkBody(
                  JSON.stringify([
                    ref.evidenceId,
                    'training',
                    m.aggregateId,
                    m.before.ref.versionId,
                  ]),
                  () =>
                    sameRetainedFact37(
                      trainingBodies.get(m.before.ref.versionId)?.draft,
                      m.before.plan,
                    ),
                ) &&
                mappings.has(JSON.stringify([m.aggregateId, m.before.ref.versionId])) &&
                m.before.plan.sessions.some((i) => i.id === loc.memberId),
            );
          break;
        case 'nutrition':
          if (body.nutrition.state === 'present' && parent.family === 'nutrition-plan')
            matched = body.nutrition.members.some(
              (m) =>
                m.aggregateId === loc.aggregateId &&
                parent.sourceId === m.aggregateId &&
                parent.versionId === m.before.ref.versionId &&
                checkBody(
                  JSON.stringify([
                    ref.evidenceId,
                    'nutrition',
                    m.aggregateId,
                    m.before.ref.versionId,
                  ]),
                  () => {
                    const r = nutritionBodies.get(
                      JSON.stringify([m.aggregateId, m.before.ref.versionId]),
                    );
                    return (
                      r !== undefined &&
                      r.version === m.before.ref.version &&
                      (m.before.linkedTraining.kind === 'absent'
                        ? r.linkedTrainingPlanVersionId === null
                        : m.before.linkedTraining.kind === 'retained' &&
                          r.linkedTrainingPlanVersionId === m.before.linkedTraining.versionId) &&
                      sameRetainedFact37(sourceNutritionPlanned38(r), m.before.plan)
                    );
                  },
                ) &&
                m.before.plan.items.some((i) => i.id === loc.memberId),
            );
          break;
        case 'recovery':
          if (body.recovery.state === 'present' && parent.family === 'recovery-strategy')
            matched = body.recovery.members.some(
              (m) =>
                m.aggregateId === loc.aggregateId &&
                parent.sourceId === m.aggregateId &&
                parent.versionId === m.before.ref.versionId &&
                checkBody(
                  JSON.stringify([
                    ref.evidenceId,
                    'recovery',
                    m.aggregateId,
                    m.before.ref.versionId,
                  ]),
                  () => {
                    const r = recoveryBodies.get(
                      JSON.stringify([m.aggregateId, m.before.ref.versionId]),
                    );
                    return (
                      r !== undefined &&
                      r.version === m.before.ref.version &&
                      sameRetainedFact37(
                        r.draft.planRefs.map((ref) => ({
                          domain: ref.kind,
                          aggregateId: ref.aggregateId,
                          version: { kind: 'retained', versionId: ref.headVersionId },
                        })),
                        m.before.planLinks,
                      ) &&
                      sameRetainedFact37(sourceRecoveryPlanned38(r), m.before.plan) &&
                      r.status === m.before.status &&
                      r.selectedOptionId === m.before.selectedOptionId
                    );
                  },
                ) &&
                m.before.plan.options.some((i) => i.id === loc.memberId),
            );
          break;
        case 'routine_schedule':
          if (body.routines.state === 'present')
            matched = body.routines.members.some(
              (m) =>
                m.aggregateId === loc.aggregateId &&
                sameRetainedFact37(
                  blueprintBodies.get(
                    JSON.stringify([m.blueprint.routineId, m.blueprint.versionId]),
                  ),
                  m.blueprint,
                ) &&
                sameRetainedFact37(
                  scheduleBodies.get(
                    JSON.stringify([m.before.schedule.id, m.before.schedule.versionId]),
                  ),
                  m.before.schedule,
                ) &&
                ((parent.family === 'routine-blueprint' &&
                  parent.sourceId === m.blueprint.routineId &&
                  parent.versionId === m.blueprint.versionId) ||
                  (parent.family === 'routine-schedule' &&
                    parent.sourceId === m.before.schedule.id &&
                    parent.versionId === m.before.schedule.versionId)) &&
                m.blueprint.steps.some((i) => i.id === loc.memberId),
            );
          break;
        case 'race':
          matched =
            parent.family === 'race-event' &&
            parent.sourceId === body.race.eventId &&
            parent.revision === body.race.expectedRevision &&
            loc.aggregateId === body.race.eventId &&
            loc.memberId === null &&
            (() => {
              const r = raceBodies.get(
                JSON.stringify([body.race.eventId, body.race.expectedRevision]),
              );
              if (r === null || typeof r !== 'object' || Array.isArray(r)) return false;
              const facts = new Map(Object.entries(r));
              return Object.entries(body.race.before).every(([k, v]) =>
                sameRetainedFact37(facts.get(k), v),
              );
            })();
          break;
      }
      if (!matched)
        fail('Known source location requires exact frozen before member and parent tuple');
    }
  }
  const versionKey = (planId: string, versionId: string) =>
    JSON.stringify([planId.toLowerCase(), versionId.toLowerCase()]);
  const itemKey = (planId: string, versionId: string, itemId: string) =>
    JSON.stringify([planId.toLowerCase(), versionId.toLowerCase(), itemId]);
  const versions = new Map(
    data.nutritionPlanVersions.map((v) => [versionKey(v.plan_id, v.version_id), v]),
  );
  const items = new Map(
    [...versions.values()].flatMap((row) =>
      row.record_json.items.map(
        (item) => [itemKey(row.plan_id, row.version_id, item.id), item] as const,
      ),
    ),
  );
  const origins = new Map(
    data.nutritionDisconnectionOrigins.map((o) => [itemKey(o.planId, o.versionId, o.itemId), o]),
  );
  const lineages = new Map(
    data.nutritionDisconnectionLineage.map((l) => [itemKey(l.planId, l.versionId, l.itemId), l]),
  );
  for (const origin of data.nutritionDisconnectionOrigins) {
    const item = items.get(itemKey(origin.planId, origin.versionId, origin.itemId));
    if (!item || item.anchor.kind !== 'disconnected')
      fail('Nutrition original marker requires actual disconnected immutable item');
  }
  for (const line of data.nutritionDisconnectionLineage) {
    const row = versions.get(versionKey(line.planId, line.versionId));
    const prior = versions.get(versionKey(line.planId, line.priorVersionId));
    const item = items.get(itemKey(line.planId, line.versionId, line.itemId));
    const previousItem = items.get(itemKey(line.planId, line.priorVersionId, line.itemId));
    if (
      !row ||
      !prior ||
      !item ||
      !previousItem ||
      row.version !== line.version ||
      prior.version !== line.priorVersion ||
      row.previous_version_id?.toLowerCase() !== line.priorVersionId.toLowerCase()
    ) {
      fail('Nutrition lineage requires exact exported immutable version/prior/item bodies');
      continue;
    }
    if (
      line.disposition === 'retained' &&
      (item.anchor.kind !== 'disconnected' || previousItem.anchor.kind !== 'disconnected')
    )
      fail('Retained nutrition lineage cannot implicitly reconnect');
    if (line.disposition === 'reconnected') {
      if (previousItem.anchor.kind !== 'disconnected')
        fail('Reconnect requires actual disconnected prior item');
      // Later deletion may redact this historical reconnect. Only its own actual
      // new marker explains that state; never reconstruct the deleted pin.
      if (item.anchor.kind === 'disconnected') {
        if (!origins.has(itemKey(line.planId, line.versionId, line.itemId)))
          fail('Redacted historical reconnect requires actual new deletion marker');
      } else if (
        item.anchor.kind !== 'relative' ||
        item.anchor.entity !== 'race' ||
        !('schemaVersion' in row.record_json) ||
        row.record_json.schemaVersion !== 4 ||
        !row.record_json.itemRaceTimingBindings.some(
          (b) =>
            b.itemId === line.itemId &&
            b.binding.state === 'captured' &&
            b.binding.eventId === (item.anchor.kind === 'relative' ? item.anchor.entityId : null),
        )
      )
        fail('Reconnected lineage requires actual immutable captured race binding');
    }
    // SQL110 carried means original lineage carried forward, not an unchanged
    // anchor or food edit. Do not add a new reconnection policy to this export.
    if (
      line.disposition === 'carried' &&
      item.anchor.kind === 'disconnected' &&
      !origins.has(itemKey(line.planId, line.versionId, line.itemId))
    )
      fail('Redacted historical carry requires actual new deletion marker');
  }
  for (const row of versions.values()) {
    if (!('schemaVersion' in row.record_json) || row.record_json.schemaVersion !== 4) continue;
    for (const item of row.record_json.items)
      if (
        item.anchor.kind === 'disconnected' &&
        !origins.has(itemKey(row.plan_id, row.version_id, item.id)) &&
        !lineages.has(itemKey(row.plan_id, row.version_id, item.id))
      )
        fail('Disconnected V4 item requires actual origin or immutable lineage');
  }
}
export const accountExportV38Schema = z
  .strictObject({
    ...accountExportV36Schema.shape,
    schemaVersion: z.literal(38),
    data: retainedExportShape38.superRefine(validateSavedSourceData38),
  })
  .superRefine((raw, ctx) => {
    if (!raceManualInternalWholePlainSchema.safeParse(raw).success)
      ctx.addIssue({ code: 'custom', message: 'Bounded whole-account V38 artifact required' });
  });
export type AccountExportV38 = z.infer<typeof accountExportV38Schema>;
/** Unknown V38 ingress must use this preguard. Union direct parsing is postbounded. */
export function parseAccountExportV38(raw: unknown): AccountExportV38 {
  raceManualInternalWholePlainSchema.parse(raw);
  return accountExportV38Schema.parse(raw);
}

// Read historical artifacts unchanged; never manufacture absent collections.
export const accountExportSchema = z.discriminatedUnion('schemaVersion', [
  accountExportV2Schema,
  accountExportV3Schema,
  accountExportV4Schema,
  accountExportV5Schema,
  accountExportV6Schema,
  accountExportV7Schema,
  accountExportV8Schema,
  accountExportV9Schema,
  accountExportV10Schema,
  accountExportV11Schema,
  accountExportV12Schema,
  accountExportV13Schema,
  accountExportV14Schema,
  accountExportV15Schema,
  accountExportV16Schema,
  accountExportV17Schema,
  accountExportV18Schema,
  accountExportV19Schema,
  accountExportV20Schema,
  accountExportV21Schema,
  accountExportV22Schema,
  accountExportV23Schema,
  accountExportV24Schema,
  accountExportV25Schema,
  accountExportV26Schema,
  accountExportV27Schema,
  accountExportV28Schema,
  accountExportV29Schema,
  accountExportV30Schema,
  accountExportV31Schema,
  accountExportV32Schema,
  accountExportV33Schema,
  accountExportV34Schema,
  accountExportV35Schema,
  accountExportV36Schema,
  accountExportV37Schema,
  accountExportV38Schema,
]);
export const operationsStatusSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }),
  outbox: z.strictObject({ pending: count, leased: count, retrying: count, completed: count }),
  providers: z.strictObject({
    garmin: garminConnectionStateSchema,
    healthkit: z.literal('not_connected'),
  }),
  audit: z
    .array(
      z.strictObject({
        id: z.uuid(),
        action: z.enum(['export_requested', 'account_erased']),
        createdAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(10),
});
export const eraseAccountSchema = z.strictObject({ confirmation: z.literal('DELETE MY ACCOUNT') });
export const eraseAccountResultSchema = z.strictObject({ erased: z.literal(true) });
export type AccountExport = z.infer<typeof accountExportSchema>;
export type OperationsStatus = z.infer<typeof operationsStatusSchema>;
