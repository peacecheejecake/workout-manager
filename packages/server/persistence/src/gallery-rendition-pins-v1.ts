import { z } from 'zod';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

/**
 * Pins of the gallery rendition member of profile27 (no installer, ledger or grant code).
 *
 * SQL144 (derived renditions) is installed only as a member of the profile27 current-runtime
 * installer, after SQL143, over the named profile26 parent. It references no SQL143 object.
 * The former extension-v1 installer, its private ledger schema
 * wm_gallery_rendition_installation and its V9 dependency are retired.
 *
 * Restore admission: new jobs and every worker RPC require the SQL143 authoring predicate
 * (CLOSED, no pending target, current generation). A restore load mints no job; admission
 * regenerates jobs through enqueue_gallery_renditions_v1.
 */
export const galleryRenditionMemberV1 = Object.freeze({
  sourceDdlId: 144,
  filename: '144_gallery_renditions.sql',
  sha256: '1aa9673a80ea16db92e694f781caa8403f6744450b2fec22fa3d7a12289e0116',
});
/** Never granted to the runtime or worker role. Derived state: not exported (U1). */
export const galleryRenditionTablesV1 = Object.freeze([
  'gallery_rendition_job',
  'gallery_rendition_due',
  'gallery_rendition_sweep',
] as const);
/** API runtime role: presentation state and ready bytes only. No enqueue, no table access. */
export const galleryRenditionApiFunctionsV1 = Object.freeze([
  'public.read_gallery_renditions_v1(uuid)',
  'public.resolve_gallery_rendition_object_v1(uuid,text)',
] as const);
/** Dedicated worker role: lease, settle, release and the delayed sweep. */
export const galleryRenditionWorkerFunctionsV1 = Object.freeze([
  'public.claim_gallery_rendition_v1(uuid,integer)',
  'public.settle_gallery_rendition_v1(text,uuid,uuid,jsonb)',
  'public.release_gallery_rendition_v1(text,uuid,uuid,text)',
  'public.claim_gallery_rendition_sweep_v1(uuid,integer)',
  'public.finish_gallery_rendition_sweep_v1(uuid,uuid,boolean)',
] as const);
/** The compiled worker role name the worker CLI requires (apps/worker config). */
export const galleryRenditionWorkerRoleV1 = 'workout_gallery_rendition_worker';
export const galleryRenditionDelegableFunctionsV1 = Object.freeze([
  ...galleryRenditionApiFunctionsV1,
  ...galleryRenditionWorkerFunctionsV1,
]);
/** Exact SQL144 function roster: body SHA-256 of pg_proc.prosrc and SECURITY DEFINER. */
export const galleryRenditionFunctionPinsV1 = Object.freeze(
  (
    [
      [
        'public.gallery_rendition_job_guard_v1()',
        false,
        'ea50658d46b4d747b8ec12ea2bb04b4c8864ae9d3d50b168be0327f72abba507',
      ],
      [
        'public.gallery_rendition_job_due_v1()',
        true,
        'ef91e9dd56a81a70132c2879d27591d4039a8b1a05c44b528245290834a31d40',
      ],
      [
        'public.gallery_rendition_processing_admitted_v1()',
        false,
        '84a1a8a5ca48c59afe761afad677d88d69936f56afa3dd8f97d40af29470c931',
      ],
      [
        'public.require_gallery_rendition_processing_v1()',
        false,
        'c3d05751b09caa42a15339412c9c404c33284f4a4f28231db4e3131b0f74d731',
      ],
      [
        'public.gallery_rendition_insert_jobs_v1(text,uuid)',
        false,
        '92f1a44589e96aa2bce0401f82d0c79fd184fd7eda03ffff6a3430f5812c7857',
      ],
      [
        'public.gallery_rendition_enqueue_item_v1()',
        true,
        'd14fe6d20b0319ad0626a6050d69a7f2a7a0333068c0bdd0fbb1fd6286b87617',
      ],
      [
        'public.gallery_rendition_retire_item_v1()',
        true,
        'f7420f4ae956006861633c275d72155130d319f7e0560242187b1517c426a48f',
      ],
      [
        'public.gallery_rendition_app_consent_v1(text)',
        false,
        '191a8591adf01bae8466a2cf49babc45daa5ecb137ad64874229f9be050776ea',
      ],
      [
        'public.claim_gallery_rendition_v1(uuid,integer)',
        true,
        'c6050c29ef61cb0eef3600e58eb7f8e9db11255460f007e194e29f9ad17f87ca',
      ],
      [
        'public.gallery_rendition_worker_context_v1(text)',
        false,
        '2d46a09964d31fd6c1255f2c291168776fdc40d8c49cc9bedec93add71b7f32e',
      ],
      [
        'public.settle_gallery_rendition_v1(text,uuid,uuid,jsonb)',
        true,
        'aeea06087db9d13562ece428395dfc8f60a93662f2561c2d515f55c18e865fe1',
      ],
      [
        'public.release_gallery_rendition_v1(text,uuid,uuid,text)',
        true,
        'c48badaa0d061dd154cb0a67426d5b88aa5578d43500f3b131a87b57735af31b',
      ],
      [
        'public.claim_gallery_rendition_sweep_v1(uuid,integer)',
        true,
        'd57c9830027afad703b34564053201bc2893a79335a0b7757dd33f5303f76e03',
      ],
      [
        'public.finish_gallery_rendition_sweep_v1(uuid,uuid,boolean)',
        true,
        '592129440258653222077eee5a35566999fbd6149bbc945266c8629ce2ac6b1c',
      ],
      [
        'public.gallery_rendition_dto_v1(public.gallery_media_item,text,public.gallery_rendition_job)',
        false,
        '77adafa21c545ea5e2cf4660d6cc777cdbc275a94b42d04896cac801205da512',
      ],
      [
        'public.read_gallery_renditions_v1(uuid)',
        true,
        '4e13c633f884ef3fc9112c96c60e4dacd2404c62068cd100b0562ef175faf1d9',
      ],
      [
        'public.resolve_gallery_rendition_object_v1(uuid,text)',
        true,
        'e3d197f73ba734c329ac29e832845334e4b3b7dd054cae15c1b0505d8cd0df4c',
      ],
      [
        'public.enqueue_gallery_renditions_v1(uuid)',
        true,
        '93e92d1318bfcb0518632c5c6a99f5557ff56c9fec0fe8308c64d08014ad5f4a',
      ],
    ] as const
  ).map(([signature, securityDefiner, prosrcSha256]) =>
    Object.freeze({ signature, securityDefiner, prosrcSha256 }),
  ),
);
/** Deletion suppression, admission and lineage depend on these triggers. */
export const galleryRenditionTriggersV1 = Object.freeze(
  (
    [
      ['gallery_rendition_job', 'gallery_rendition_job_guard', 'gallery_rendition_job_guard_v1'],
      [
        'gallery_rendition_job',
        'gallery_rendition_job_no_truncate',
        'gallery_rendition_job_guard_v1',
      ],
      ['gallery_rendition_job', 'gallery_rendition_job_due', 'gallery_rendition_job_due_v1'],
      ['gallery_media_item', 'gallery_rendition_enqueue_item', 'gallery_rendition_enqueue_item_v1'],
      [
        'gallery_media_item',
        'gallery_rendition_retire_deleted',
        'gallery_rendition_retire_item_v1',
      ],
      ['gallery_media_item', 'gallery_rendition_retire_erased', 'gallery_rendition_retire_item_v1'],
    ] as const
  ).map(([table, trigger, fn]) => Object.freeze({ table, trigger, fn })),
);

export type GalleryRenditionRoleKindV1 = 'api' | 'worker';
function grantedFunctions(kind: GalleryRenditionRoleKindV1) {
  return kind === 'api' ? galleryRenditionApiFunctionsV1 : galleryRenditionWorkerFunctionsV1;
}
function otherFunctions(kind: GalleryRenditionRoleKindV1) {
  return grantedFunctions(kind === 'api' ? 'worker' : 'api');
}
const capabilitySchema = z.strictObject({
  granted: z.literal(true),
  foreign: z.literal(false),
  tables: z.literal(false),
});
/**
 * Startup capability probe for one role kind: its RPCs are executable, the other kind's are
 * not, and no rendition table is readable or writable. It is not proof of the profile ledger
 * or function bodies (the profile27 verifier is).
 */
export async function probeGalleryRenditionRuntimeV1In(
  tx: CurrentRuntimeInstallationTransaction,
  kind: GalleryRenditionRoleKindV1,
): Promise<'available' | 'unavailable'> {
  if (kind !== 'api' && kind !== 'worker') return 'unavailable';
  try {
    const rows = await tx.query(
      `SELECT
        (SELECT bool_and(to_regprocedure(f) IS NOT NULL AND has_function_privilege(to_regprocedure(f),'EXECUTE'))
          FROM unnest($1::text[]) f) AS granted,
        (SELECT coalesce(bool_or(to_regprocedure(f) IS NULL OR has_function_privilege(to_regprocedure(f),'EXECUTE')),true)
          FROM unnest($2::text[]) f) AS foreign,
        (SELECT coalesce(bool_or(to_regclass(t) IS NULL
            OR has_table_privilege(to_regclass(t),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),true)
          FROM unnest($3::text[]) t) AS tables`,
      [
        [...grantedFunctions(kind)],
        [...otherFunctions(kind)],
        galleryRenditionTablesV1.map((t) => `public.${t}`),
      ],
    );
    return capabilitySchema.safeParse(rows.rows[0]).success ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
