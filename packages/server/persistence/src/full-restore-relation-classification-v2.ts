import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  classifyFullRestoreRelationsV1,
  type FullRestoreRelationClassV1,
} from './full-restore-relation-classification-v1.js';

/**
 * Admission roster successor (EXT-RESTOREa, profile27 / SQL147).
 *
 * The v1 classification and its pinned 239-row native catalog roster (e13dc970…0619) are not
 * modified. This successor reads the generated admission roster
 * (`full-restore-admission-roster-v1/roster.json`), which is the exact relation set of the SQL
 * function `public.restore_processing_admission_roster()` in 147, and proves that it is the v1
 * classification (source_retained + durable7 -> retained, authentication_reset,
 * target_local_exclude -> target_local) plus exactly the reviewed successor relations. Both files
 * and the SQL roster digest are regenerated together by
 * `scripts/generate-restore-admission-roster.mts`; any later relation must be added there.
 * The result is a classification only: authority none, no admission.
 */
// BEGIN GENERATED PINS (scripts/generate-restore-admission-roster.mts)
export const RESTORE_ADMISSION_ROSTER_SHA256 =
  'c20f35af23c894ebfc7e4c89f0ce18897e14cea0d73d658dcedf5b8fa7a62c62';
export const FULL_RESTORE_ADMISSION_ROSTER_V1_FILE_SHA256 =
  '2b1f7e712bf86aa9e43e5af7de6f1a032b809771ec1e0325ddfc38ca7890eda1';
export const FULL_RESTORE_ADMISSION_SUCCESSOR_RELATIONS_V1_FILE_SHA256 =
  'b007f4ea4f0ce8441f84bcb299861b66532ef10145bc8202c2b575992e8b3438';
export const FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256 =
  '389f2874091536495d6e2ad53199cb9e42741cda33e9c0f7af95308aac98e644';
export const RESTORE_ADMISSION_ROSTER_TALLIES = Object.freeze({
  relations: 254,
  retained: 218,
  retainedForced: 213,
  authenticationReset: 7,
  authenticationResetForced: 3,
  targetLocal: 29,
  census: 225,
  censusForced: 216,
});
// END GENERATED PINS
export const RESTORE_ADMISSION_ROSTER_DOMAIN = 'wm-restore-admission-roster-v1';
export const RESTORE_ADMISSION_CENSUS_DOMAIN = 'wm-restore-admission-census-v1';
export const RESTORE_ADMISSION_LOADER_NAMESPACES = Object.freeze([
  'wm_current_app_load',
  'wm_current_original_postimages',
  'wm_identity_target_load',
]);

export type RestoreAdmissionRelationClass = 'retained' | 'authentication_reset' | 'target_local';
export type RestoreAdmissionRosterRow = Readonly<{
  schema: string;
  relation: string;
  class: RestoreAdmissionRelationClass;
  forceRls: boolean;
}>;
export class FullRestoreClassificationErrorV2 extends Error {
  constructor(
    readonly code:
      | 'ADMISSION_ROSTER_PIN_MISMATCH'
      | 'ADMISSION_ROSTER_INVALID'
      | 'ADMISSION_ROSTER_BASE_MISMATCH'
      | 'ADMISSION_ROSTER_SUCCESSOR_MISMATCH',
  ) {
    super(code);
    this.name = 'FullRestoreClassificationErrorV2';
  }
}
const fail = (code: FullRestoreClassificationErrorV2['code']): never => {
  throw new FullRestoreClassificationErrorV2(code);
};
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const relationClass = z.enum(['retained', 'authentication_reset', 'target_local']);
const rosterRowSchema = z.strictObject({
  schema: identifier,
  relation: identifier,
  class: relationClass,
  forceRls: z.boolean(),
});
const successorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseRosterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  relations: z
    .array(
      z.strictObject({
        schema: identifier,
        relation: identifier,
        class: relationClass,
        introducedBy: z.string().min(1).max(200),
      }),
    )
    .max(1000),
});
const rosterFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('wm-restore-admission-roster-v1'),
  baseRosterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  successorRelationsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rosterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  relations: z.array(rosterRowSchema).min(1).max(1000),
});

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const qualified = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
/** (schema, relation) code-point order; equals SQL `COLLATE "C"` for [a-z0-9_] identifiers. */
export function compareRestoreAdmissionRelations(
  a: { schema: string; relation: string },
  b: { schema: string; relation: string },
): number {
  if (a.schema !== b.schema) return a.schema < b.schema ? -1 : 1;
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;
  return 0;
}
export function mapV1RelationClass(
  value: FullRestoreRelationClassV1,
): RestoreAdmissionRelationClass {
  if (value === 'source_retained' || value === 'source_retained_durable_codec_v1')
    return 'retained';
  if (value === 'authentication_reset') return 'authentication_reset';
  return 'target_local';
}
/** Same formula as SQL `restore_processing_admission_roster_sha256()`. */
export function restoreAdmissionRosterSha256(rows: readonly RestoreAdmissionRosterRow[]): string {
  const lines = [...rows]
    .sort(compareRestoreAdmissionRelations)
    .map((r) => `${qualified(r)}|${r.class}|${String(r.forceRls)}`);
  return sha256(`${RESTORE_ADMISSION_ROSTER_DOMAIN}\n${lines.join('\n')}`);
}
/** Same formula as SQL `admit_restore_processing_exact` census_sha256. */
export function restoreAdmissionCensusSha256(
  census: readonly { schema: string; relation: string; rowCount: number }[],
): string {
  return sha256(
    `${RESTORE_ADMISSION_CENSUS_DOMAIN}\n${census.map((c) => `${qualified(c)}=${c.rowCount}`).join('\n')}`,
  );
}

/**
 * Pure derivation shared by the generator and the verifier: v1 classification plus successor
 * rows. `forceRls` comes from the caller (the generator reads the clean-install catalog).
 */
export function deriveRestoreAdmissionRosterClasses(
  v1RosterBytes: Uint8Array,
  successorBytes: Uint8Array,
): readonly Readonly<{ schema: string; relation: string; class: RestoreAdmissionRelationClass }>[] {
  const v1 = classifyFullRestoreRelationsV1(v1RosterBytes);
  let successor: z.infer<typeof successorSchema>;
  try {
    successor = successorSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(successorBytes)),
    );
  } catch {
    return fail('ADMISSION_ROSTER_SUCCESSOR_MISMATCH');
  }
  if (successor.baseRosterSha256 !== v1.rosterSha256) fail('ADMISSION_ROSTER_BASE_MISMATCH');
  const rows = [
    ...v1.relations.map((r) => ({
      schema: r.schema,
      relation: r.relation,
      class: mapV1RelationClass(r.classification),
    })),
    ...successor.relations.map((r) => ({ schema: r.schema, relation: r.relation, class: r.class })),
  ].sort(compareRestoreAdmissionRelations);
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1],
      current = rows[i];
    if (previous && current && compareRestoreAdmissionRelations(previous, current) === 0)
      fail('ADMISSION_ROSTER_SUCCESSOR_MISMATCH');
  }
  return Object.freeze(rows.map((r) => Object.freeze(r)));
}

export type FullRestoreRelationClassificationV2 = Readonly<{
  kind: 'full_restore_relation_classification_v2';
  rosterSha256: string;
  rosterFileSha256: string;
  relations: readonly RestoreAdmissionRosterRow[];
  /** retained + authentication_reset, code-point ordered: the SQL147 census set. */
  census: readonly RestoreAdmissionRosterRow[];
  authenticationReset: readonly RestoreAdmissionRosterRow[];
  authority: 'none';
}>;
const issued = new WeakSet<object>();
export function isFullRestoreRelationClassificationV2(
  value: unknown,
): value is FullRestoreRelationClassificationV2 {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export function classifyFullRestoreRelationsV2(input: {
  readonly v1RosterBytes: Uint8Array;
  readonly successorBytes: Uint8Array;
  readonly admissionRosterBytes: Uint8Array;
}): FullRestoreRelationClassificationV2 {
  const { v1RosterBytes, successorBytes, admissionRosterBytes } = input;
  if (
    !(admissionRosterBytes instanceof Uint8Array) ||
    !(successorBytes instanceof Uint8Array) ||
    sha256(admissionRosterBytes) !== FULL_RESTORE_ADMISSION_ROSTER_V1_FILE_SHA256 ||
    sha256(successorBytes) !== FULL_RESTORE_ADMISSION_SUCCESSOR_RELATIONS_V1_FILE_SHA256
  )
    fail('ADMISSION_ROSTER_PIN_MISMATCH');
  let file: z.infer<typeof rosterFileSchema>;
  try {
    file = rosterFileSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(admissionRosterBytes)),
    );
  } catch {
    return fail('ADMISSION_ROSTER_INVALID');
  }
  const derived = deriveRestoreAdmissionRosterClasses(v1RosterBytes, successorBytes);
  if (
    file.successorRelationsSha256 !== sha256(successorBytes) ||
    file.baseRosterSha256 !== sha256(v1RosterBytes) ||
    file.relations.length !== derived.length ||
    file.relations.some((row, i) => {
      const want = derived[i];
      return !want || qualified(want) !== qualified(row) || want.class !== row.class;
    })
  )
    fail('ADMISSION_ROSTER_BASE_MISMATCH');
  const rosterSha256 = restoreAdmissionRosterSha256(file.relations);
  if (rosterSha256 !== file.rosterSha256 || rosterSha256 !== RESTORE_ADMISSION_ROSTER_SHA256)
    fail('ADMISSION_ROSTER_PIN_MISMATCH');
  const relations = Object.freeze(file.relations.map((r) => Object.freeze({ ...r })));
  const census = Object.freeze(relations.filter((r) => r.class !== 'target_local'));
  const authenticationReset = Object.freeze(
    relations.filter((r) => r.class === 'authentication_reset'),
  );
  const t = RESTORE_ADMISSION_ROSTER_TALLIES;
  const count = (rows: readonly RestoreAdmissionRosterRow[], forced?: boolean) =>
    rows.filter((r) => forced === undefined || r.forceRls === forced).length;
  const retained = relations.filter((r) => r.class === 'retained');
  if (
    relations.length !== t.relations ||
    retained.length !== t.retained ||
    count(retained, true) !== t.retainedForced ||
    authenticationReset.length !== t.authenticationReset ||
    count(authenticationReset, true) !== t.authenticationResetForced ||
    census.length !== t.census ||
    count(census, true) !== t.censusForced ||
    relations.length - census.length !== t.targetLocal
  )
    fail('ADMISSION_ROSTER_PIN_MISMATCH');
  const result: FullRestoreRelationClassificationV2 = Object.freeze({
    kind: 'full_restore_relation_classification_v2',
    rosterSha256,
    rosterFileSha256: sha256(admissionRosterBytes),
    relations,
    census,
    authenticationReset,
    authority: 'none',
  });
  issued.add(result);
  return result;
}

const fileUrl = (path: string) => new URL(path, import.meta.url);
/** Reads the three committed files next to this module. */
export function loadFullRestoreRelationClassificationV2(): FullRestoreRelationClassificationV2 {
  return classifyFullRestoreRelationsV2({
    v1RosterBytes: new Uint8Array(
      readFileSync(fileUrl('./full-restore-native-catalog-v2/source-owned-roster.json')),
    ),
    successorBytes: new Uint8Array(
      readFileSync(fileUrl('./full-restore-admission-roster-v1/successor-relations.json')),
    ),
    admissionRosterBytes: new Uint8Array(
      readFileSync(fileUrl('./full-restore-admission-roster-v1/roster.json')),
    ),
  });
}
/** Successor expected structure bytes (C4 comparison input for profile27). */
export function readFullRestoreExpectedStructureV2Bytes(): Uint8Array {
  return new Uint8Array(
    readFileSync(fileUrl('./full-restore-admission-roster-v1/expected-structure.json')),
  );
}
