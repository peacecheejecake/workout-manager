import { z } from 'zod';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

/**
 * Pins of the gallery navigation members of profile27 (no installer, ledger or grant code).
 *
 * SQL143 (owned albums, membership, saved course link) and SQL145 (album deletion restore
 * suppression, exact album replay and media-deletion relation cleanup) are installed only as
 * members of the profile27 current-runtime installer over the named profile26 parent. The
 * former extension-v1 installer, its private ledger schema wm_gallery_installation and its V9
 * dependency are retired; a database carrying that schema is a legacy development stage.
 */
export const galleryNavigationMemberV1 = Object.freeze({
  sourceDdlId: 143,
  filename: '143_gallery_albums.sql',
  sha256: '8e1844a4032f35ef41657a7036e4367da0f908c42922d8766bba26a2c723b08a',
});
export const galleryNavigationTablesV1 = Object.freeze([
  'gallery_album',
  'gallery_media_album_membership',
  'gallery_media_course_association',
  'gallery_navigation_command_receipt',
  'gallery_album_deletion',
] as const);
/** Runtime reads: navigation, album list and the V39 export gallery section. */
export const galleryNavigationRuntimeReadTablesV1 = Object.freeze([
  'gallery_album',
  'gallery_media_album_membership',
  'gallery_media_course_association',
  'gallery_album_deletion',
] as const);
/** The only SQL143 functions the runtime role may execute. Everything else is owner-only. */
export const galleryNavigationRuntimeFunctionsV1 = Object.freeze([
  'public.gallery_media_navigation_projection_v1(uuid)',
  'public.create_gallery_album_v1(jsonb,text)',
  'public.rename_gallery_album_v1(jsonb,text)',
  'public.delete_gallery_album_v1(jsonb,text)',
  'public.set_gallery_media_navigation_v1(jsonb,text)',
  'public.remove_gallery_navigation_deleted_media_v1(uuid,integer,timestamptz)',
  'public.erase_gallery_navigation_extension_account_v1(text)',
] as const);
/** Exact SQL143 function roster: body SHA-256 of pg_proc.prosrc and SECURITY DEFINER. */
export const galleryNavigationFunctionPinsV1 = Object.freeze(
  (
    [
      [
        'public.gallery_album_title_valid_v1(text)',
        false,
        '892d2f75ed1ae6aba9e0fc5115266c2476f3a57c8ae6f244be774fbd36801f3a',
      ],
      [
        'public.assert_gallery_album_owner_v1()',
        false,
        '45cd505a7e2dc17208eb9db9056fe30817bf15ca454f2c62fbd1c32aaca4f79b',
      ],
      [
        'public.assert_gallery_album_context_v1()',
        false,
        '028de790e7b6d423e41b97c0aaff19299e2682cb9a2c9524dd9b44c8628f682d',
      ],
      [
        'public.lock_gallery_album_command_v1()',
        false,
        '00ba03f5cdff7fdef69b4c31cbc97104d94f4dc3721f0e5157d55270a675ad7a',
      ],
      [
        'public.require_gallery_navigation_authoring_v1()',
        false,
        '9a0a1cd47fbae8236409b8e2fcaae4073060ce90418ef47c911731526dde24a0',
      ],
      [
        'public.assert_gallery_album_erasure_context_v1()',
        false,
        '17b7776ffc63fced1f9d48440ef55ad1bc735e944b005f06e49b5d5c2e749507',
      ],
      [
        'public.guard_gallery_album_row_v1()',
        false,
        '6418d360bbe107aa9403df5b315702bfeeec739bd04f7b6c69396857d0465976',
      ],
      [
        'public.guard_gallery_album_membership_v1()',
        false,
        'cb12158466295025f017afe72d20edbc54979254aa226a41b2e0fc3444d8dd3d',
      ],
      [
        'public.guard_gallery_media_course_association_v1()',
        false,
        '4a7e1143d2f0abf0c4e8b08c0b2cd9c2323aee53db2fd134af69c0d44d9d8e69',
      ],
      [
        'public.check_gallery_album_terminal_v1()',
        true,
        'a1394828ae9abc564f60749b3285a82689149fbaf8245074578d8a5913172f8d',
      ],
      [
        'public.guard_gallery_album_deletion_v1()',
        false,
        '83ed133964094fb266038d3ee3dab31f2f4e74a9643dc780595a94c3e4fd1891',
      ],
      [
        'public.gallery_navigation_uuid_text_valid_v1(jsonb)',
        false,
        'b016ddaee9f18f16c8e85a1ef4231ae6f81b4f428b17443614c2fae081bb18c5',
      ],
      [
        'public.gallery_navigation_revision_valid_v1(jsonb)',
        false,
        '76006ba7ee62cd052c5c6e8760c352b4771b7eb18abc615de24bda322da4133a',
      ],
      [
        'public.normalize_gallery_album_command_v1(text,jsonb,text)',
        false,
        '0b339334c61d8c3615178d02c00238d13dab18daf773151f5f69897e83b57210',
      ],
      [
        'public.gallery_album_dto_v1(public.gallery_album)',
        false,
        '58a5445153ab49a475efcd606cef18c30dcef70e1c63983ea4374d0c8f8cb3a7',
      ],
      [
        'public.gallery_media_navigation_projection_v1(uuid)',
        false,
        'cb6aa3421b7510334156a7841e0faef44732cc0ef2b5da19b4bd23eae6bc63df',
      ],
      [
        'public.gallery_album_result_valid_v1(text,uuid,integer,jsonb)',
        false,
        '77096c24396e1e91ca17bec9718f6b8a10b1e2507325ce3b48c359e58aaf0653',
      ],
      [
        'public.guard_gallery_album_receipt_v1()',
        false,
        '82da861a777dcd0dd08558109eb5f5147543b5c36680da38ed5a736b8a362ca6',
      ],
      [
        'public.replay_gallery_album_command_v1(text,text,jsonb)',
        false,
        '20520d05730b987a3c9dc94fbc04787c4d662fc3964dd10400af485462dea077',
      ],
      [
        'public.finish_gallery_album_command_v1(text,text,jsonb,uuid,integer,jsonb,timestamptz)',
        false,
        '2f92e105300a247ceebdaf67f5f6b252ce415ceada32161f964f234e777213b8',
      ],
      [
        'public.redact_gallery_album_receipts_v1(uuid)',
        false,
        '87e2066b1cfee34ea84edca987c7e1644d9854a6c11fa45a9527fb27bd17958c',
      ],
      [
        'public.detach_gallery_album_memberships_v1(uuid,timestamptz)',
        false,
        'ad4b259b2609939e97602a61163d014d5d666f4c699bd88532c5070fea0af9d4',
      ],
      [
        'public.create_gallery_album_v1(jsonb,text)',
        true,
        'a5b14f58be112fb5d9b8c59c5534c84363c5e45a943511cf913e50f97648f1d0',
      ],
      [
        'public.rename_gallery_album_v1(jsonb,text)',
        true,
        '533e264c733436459cae79934544432404d1a69e265364480c95c04abcd88ca0',
      ],
      [
        'public.delete_gallery_album_v1(jsonb,text)',
        true,
        'b49ec90843e01972208f9aad02bb501bcfdc2faafa93c3a4308045606b4b1de6',
      ],
      [
        'public.set_gallery_media_navigation_v1(jsonb,text)',
        true,
        '636f4aac10333f04a11f4df22a6912e748cf4763e6882d0e483779ff1f0976e7',
      ],
      [
        'public.remove_gallery_navigation_deleted_media_v1(uuid,integer,timestamptz)',
        true,
        'afec319ba9206bddf00c94a3ac50391ec5b885aa1c466b8a70e6179ba6d633db',
      ],
      [
        'public.erase_gallery_album_rows_v1()',
        false,
        'ac7e72aa09036aabdf697a873a4d3cf19d0cb3d07b32566aee3ab13cc3ea4223',
      ],
      [
        'public.erase_gallery_navigation_extension_account_v1(text)',
        true,
        '9144fe7f8dc87ce2f76961727524aaf7578ac5b5ac78289da2edcc628ddb9596',
      ],
    ] as const
  ).map(([signature, securityDefiner, prosrcSha256]) =>
    Object.freeze({ signature, securityDefiner, prosrcSha256 }),
  ),
);

/** SQL143 triggers; each must exist, be enabled and call exactly this function. */
export const galleryNavigationTriggersV1 = Object.freeze(
  (
    [
      ['gallery_album', 'gallery_album_row_guard', 'guard_gallery_album_row_v1'],
      ['gallery_album', 'gallery_album_no_truncate', 'guard_gallery_album_row_v1'],
      ['gallery_album', 'gallery_album_terminal_check', 'check_gallery_album_terminal_v1'],
      [
        'gallery_media_album_membership',
        'gallery_album_membership_guard',
        'guard_gallery_album_membership_v1',
      ],
      [
        'gallery_media_album_membership',
        'gallery_album_membership_no_truncate',
        'guard_gallery_album_membership_v1',
      ],
      [
        'gallery_media_course_association',
        'gallery_media_course_association_guard',
        'guard_gallery_media_course_association_v1',
      ],
      [
        'gallery_media_course_association',
        'gallery_media_course_association_no_truncate',
        'guard_gallery_media_course_association_v1',
      ],
      [
        'gallery_navigation_command_receipt',
        'gallery_album_receipt_guard',
        'guard_gallery_album_receipt_v1',
      ],
      [
        'gallery_navigation_command_receipt',
        'gallery_album_receipt_no_truncate',
        'guard_gallery_album_receipt_v1',
      ],
      [
        'gallery_album_deletion',
        'gallery_album_deletion_terminal_check',
        'check_gallery_album_terminal_v1',
      ],
      ['gallery_album_deletion', 'gallery_album_deletion_guard', 'guard_gallery_album_deletion_v1'],
      [
        'gallery_album_deletion',
        'gallery_album_deletion_no_truncate',
        'guard_gallery_album_deletion_v1',
      ],
    ] as const
  ).map(([table, trigger, fn]) => Object.freeze({ table, trigger, fn })),
);

/** SQL145: gallery album deletion suppression successor over SQL143 and the 116 CHECKs. */
export const galleryRestoreSuppressionMemberV1 = Object.freeze({
  sourceDdlId: 145,
  filename: '145_gallery_restore_suppression.sql',
  sha256: '352fb8c00783a6f6a25142d18eccc5865291babebffa4897e97a0368d7dc0c46',
});
/** Owner-only restore receipt table; never granted. */
export const galleryRestoreSuppressionTablesV1 = Object.freeze([
  'restore_gallery_album_replay_receipt',
] as const);
/** restore_suppression_event wire values of the album deletion event. */
export const galleryAlbumDeletionEventV1 = Object.freeze({
  recordVersion: 8,
  kind: 'gallery_album_deleted',
} as const);
/** Exact SQL145 function roster. None is executable by the runtime or worker role. */
export const galleryRestoreSuppressionFunctionPinsV1 = Object.freeze(
  (
    [
      [
        'public.record_gallery_album_deletion_suppression_event_v1()',
        true,
        'c3fc12fc0fea849a1ab20df1e4333e512f244026c51e4ff2d7bff2bad24c2eed',
      ],
      [
        'public.remove_gallery_navigation_on_media_deletion_v1()',
        true,
        '4a50a379264e32047cc39c3cfbf2c95352f8819a818c2ec8809119491f36c22c',
      ],
      [
        'public.verify_restore_gallery_album_replay_receipt_v1()',
        false,
        'd924eae358645a9559419d1ee4e27a710ac4f04e581d95f68571abee1763406b',
      ],
      [
        'public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)',
        false,
        '9dc6326c042b8eed66d4e2745eccccbc0bd2074bcd9f2212f1a9d1a11032a854',
      ],
    ] as const
  ).map(([signature, securityDefiner, prosrcSha256]) =>
    Object.freeze({ signature, securityDefiner, prosrcSha256 }),
  ),
);
/** SQL145 triggers. The receipt immutability triggers reuse the historical suppression guard. */
export const galleryRestoreSuppressionTriggersV1 = Object.freeze(
  (
    [
      [
        'gallery_album',
        'record_gallery_album_deletion_suppression_event',
        'record_gallery_album_deletion_suppression_event_v1',
      ],
      [
        'gallery_media_item',
        'gallery_navigation_media_deleted',
        'remove_gallery_navigation_on_media_deletion_v1',
      ],
      [
        'restore_gallery_album_replay_receipt',
        'restore_gallery_album_replay_receipt_verify',
        'verify_restore_gallery_album_replay_receipt_v1',
      ],
      [
        'restore_gallery_album_replay_receipt',
        'restore_gallery_album_replay_receipt_immutable_rows',
        'reject_restore_suppression_event_mutation',
      ],
      [
        'restore_gallery_album_replay_receipt',
        'restore_gallery_album_replay_receipt_immutable_truncate',
        'reject_restore_suppression_event_mutation',
      ],
    ] as const
  ).map(([table, trigger, fn]) => Object.freeze({ table, trigger, fn })),
);

export interface GalleryFunctionPinV1 {
  readonly signature: string;
  readonly securityDefiner: boolean;
  readonly prosrcSha256: string;
}
const functionRowSchema = z.strictObject({
  signature: z.string().max(250),
  owned: z.literal(true),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  securityDefiner: z.boolean(),
  pinnedSearchPath: z.literal(true),
  publicExecute: z.literal(false),
  safeDelegation: z.literal(true),
});
export class GalleryPinObservationError extends Error {
  constructor(readonly code: 'GALLERY_FUNCTION_DRIFT' | 'GALLERY_TRIGGER_DRIFT') {
    super(code);
    this.name = 'GalleryPinObservationError';
  }
}
/**
 * Observes installed function bodies for pin maintenance and verification. Every row must be
 * owned by session_user, pin search_path, deny PUBLIC and delegate at most EXECUTE on one of
 * `delegable` (non-grantable). Body/definer comparison against the pins is the caller's.
 */
export async function observeGalleryFunctionsV1In(
  tx: CurrentRuntimeInstallationTransaction,
  pins: readonly GalleryFunctionPinV1[],
  delegable: readonly string[],
) {
  const rows = await tx.query(
    `SELECT i.signature,
      p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,
      encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS "bodySha256",
      p.prosecdef AS "securityDefiner",
      coalesce(p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'],false) AS "pinnedSearchPath",
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE a.grantee=0) AS "publicExecute",
      NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable
        OR NOT (i.signature=ANY($2::text[])))) AS "safeDelegation"
     FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal)
     JOIN pg_proc p ON p.oid=to_regprocedure(i.signature) ORDER BY i.ordinal`,
    [pins.map((pin) => pin.signature), [...delegable]],
  );
  const parsed = z.array(functionRowSchema).length(pins.length).safeParse(rows.rows);
  if (!parsed.success) throw new GalleryPinObservationError('GALLERY_FUNCTION_DRIFT');
  return parsed.data;
}
/** Exact pin comparison over observeGalleryFunctionsV1In. */
export async function assertGalleryFunctionPinsV1In(
  tx: CurrentRuntimeInstallationTransaction,
  pins: readonly GalleryFunctionPinV1[],
  delegable: readonly string[],
) {
  const rows = await observeGalleryFunctionsV1In(tx, pins, delegable);
  for (const [index, row] of rows.entries()) {
    const pin = pins[index];
    if (
      !pin ||
      row.signature !== pin.signature ||
      row.bodySha256 !== pin.prosrcSha256 ||
      row.securityDefiner !== pin.securityDefiner
    )
      throw new GalleryPinObservationError('GALLERY_FUNCTION_DRIFT');
  }
}
/** Every pinned trigger exists on its public table, is enabled and calls exactly its function. */
export async function assertGalleryTriggersV1In(
  tx: CurrentRuntimeInstallationTransaction,
  triggers: readonly { table: string; trigger: string; fn: string }[],
) {
  const rows = await tx.query(
    `SELECT EXISTS(SELECT 1 FROM pg_trigger g
       JOIN pg_proc p ON p.oid=g.tgfoid
       WHERE g.tgrelid=to_regclass('public.'||t.relname) AND g.tgname=t.tgname
        AND NOT g.tgisinternal AND g.tgenabled IN ('O','A')
        AND p.oid=to_regprocedure('public.'||t.fn||'()')) AS ok
     FROM unnest($1::text[],$2::text[],$3::text[]) WITH ORDINALITY t(relname,tgname,fn,ordinal)
     ORDER BY t.ordinal`,
    [triggers.map((t) => t.table), triggers.map((t) => t.trigger), triggers.map((t) => t.fn)],
  );
  if (
    !z
      .array(z.strictObject({ ok: z.literal(true) }))
      .length(triggers.length)
      .safeParse(rows.rows).success
  )
    throw new GalleryPinObservationError('GALLERY_TRIGGER_DRIFT');
}

const capabilitySchema = z.strictObject({
  functions: z.literal(true),
  tables: z.literal(true),
  writes: z.literal(false),
});
/** Runtime-role startup capability probe: privileges present, no DML/receipt access. It is
 * not proof of the profile ledger or function bodies (the profile27 verifier is). */
export async function probeGalleryNavigationRuntimeV1In(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<'available' | 'unavailable'> {
  try {
    const rows = await tx.query(
      `SELECT
        (SELECT bool_and(to_regprocedure(f) IS NOT NULL AND has_function_privilege(to_regprocedure(f),'EXECUTE'))
          FROM unnest($1::text[]) f) AS functions,
        (SELECT bool_and(to_regclass(t) IS NOT NULL AND has_table_privilege(to_regclass(t),'SELECT'))
          FROM unnest($2::text[]) t) AS tables,
        (SELECT bool_or(has_table_privilege(to_regclass(t),'INSERT,UPDATE,DELETE,TRUNCATE'))
          FROM unnest($3::text[]) t) AS writes`,
      [
        [...galleryNavigationRuntimeFunctionsV1],
        galleryNavigationRuntimeReadTablesV1.map((t) => `public.${t}`),
        galleryNavigationTablesV1.map((t) => `public.${t}`),
      ],
    );
    return capabilitySchema.safeParse(rows.rows[0]).success ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
