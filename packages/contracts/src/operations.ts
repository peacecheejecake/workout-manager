import { z } from 'zod';
import { garminConnectionStateSchema } from './garmin.js';

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
