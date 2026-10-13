import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  type CurrentRuntimeInstallationTransaction,
  currentRuntimeTargetTransforms,
} from './current-runtime-installation.js';
import { currentRuntimeV7RpcSourcePins } from './current-runtime-grants-v7.js';
import { verifyCurrentRuntimeV7InstalledIn } from './current-runtime-installation-v7.js';
import {
  currentRuntimeV8ParentMembers,
  currentRuntimeV8ParentManifestSha256,
  currentRuntimeV8ExtensionMembers,
} from './current-runtime-installation-v8.js';
import {
  currentRuntimeV9ParentManifestSha256,
  currentRuntimeV9ExtensionMembers,
} from './current-runtime-installation-v9.js';
import {
  installCurrentRuntimeV10In,
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ParentManifestSha256,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10FunctionPins,
  currentRuntimeV10GuardFunctionSignature,
  currentRuntimeV10GuardTriggerName,
  currentRuntimeV10KnownLedgers,
} from './current-runtime-installation-v10.js';
import {
  galleryNavigationMemberV1,
  galleryRestoreSuppressionMemberV1,
  galleryNavigationFunctionPinsV1,
  galleryRestoreSuppressionFunctionPinsV1,
  galleryNavigationTablesV1,
  galleryRestoreSuppressionTablesV1,
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationRuntimeReadTablesV1,
} from './gallery-navigation-pins-v1.js';
import {
  galleryRenditionMemberV1,
  galleryRenditionFunctionPinsV1,
  galleryRenditionTablesV1,
  galleryRenditionApiFunctionsV1,
  galleryRenditionWorkerFunctionsV1,
  galleryRenditionWorkerRoleV1,
} from './gallery-rendition-pins-v1.js';

// Profile27. Physical11 = parent V10 (physical33: V9 parent32 + 146) plus five extension
// members in install order 143, 144, 145, 147, 148 (logical runtime27, source tip148).
// 145 needs SQL143 objects; 144, 147 and 148 need none of 143..145. 147 performs no catalog
// validation at install time: its generated roster literal (which names every 143..148 table
// and this ledger) is only checked by open_/admit_ at admission, so the numeric order is safe.
// verifyCurrentRuntimeV10InstalledIn rejects the v11 ledger by construction (profile26 refuses
// profile27), so the V10 chain checks are re-implemented here without calling it.
export const currentRuntimeV11ParentManifestSha256 =
  'a46dcaa4adf4465bfd2ae1c08358c8a844ad1f36c0d9f954daadff4611243809';
export const currentRuntimeV11ParentMembers = Object.freeze([
  ...currentRuntimeV10ParentMembers,
  ...currentRuntimeV10ExtensionMembers.map((m) =>
    Object.freeze({
      step: 32 + m.extensionStep,
      sourceDdlId: m.sourceDdlId,
      filename: m.filename,
      sha256: m.sha256,
    }),
  ),
]);
export const currentRuntimeV11ExtensionMembers = Object.freeze([
  Object.freeze({
    extensionStep: 1,
    sourceDdlId: 143,
    filename: galleryNavigationMemberV1.filename,
    sha256: galleryNavigationMemberV1.sha256,
  }),
  Object.freeze({
    extensionStep: 2,
    sourceDdlId: 144,
    filename: galleryRenditionMemberV1.filename,
    sha256: galleryRenditionMemberV1.sha256,
  }),
  Object.freeze({
    extensionStep: 3,
    sourceDdlId: 145,
    filename: galleryRestoreSuppressionMemberV1.filename,
    sha256: galleryRestoreSuppressionMemberV1.sha256,
  }),
  Object.freeze({
    extensionStep: 4,
    sourceDdlId: 147,
    filename: '147_restore_processing_admission.sql',
    sha256: '5282d0f113a85236d7619582caa0fafc78646b7262b55394c20260cff63fa60f',
  }),
  Object.freeze({
    extensionStep: 5,
    sourceDdlId: 148,
    filename: '148_ai_execution_job_store.sql',
    sha256: 'aefbff30f62084084c22b692647d2543119d6e299f95a793c2bb9b2af75c43ca',
  }),
]);
/** The 13 tables 143..148 add, all in public, all FORCE ROW LEVEL SECURITY. */
export const currentRuntimeV11Tables = Object.freeze([
  ...galleryNavigationTablesV1,
  ...galleryRenditionTablesV1,
  ...galleryRestoreSuppressionTablesV1,
  'restore_processing_admit_receipt',
  'ai_synthetic_evidence_attestation',
  'ai_execution_job',
  'ai_execution_job_disposition',
] as const);
/**
 * Table privileges a non-owner may ever hold on a V11 table (non-grantable, never PUBLIC).
 * The runtime grant gives the navigation reads, ai_execution_job SELECT/INSERT and the
 * attestation SELECT; the disposition SELECT/INSERT belongs to the AI dispatcher role.
 * Every other V11 table is owner-only.
 */
export const currentRuntimeV11TableDelegations = Object.freeze({
  ...Object.fromEntries(galleryNavigationRuntimeReadTablesV1.map((t) => [t, ['SELECT']])),
  ai_execution_job: ['SELECT', 'INSERT'],
  ai_synthetic_evidence_attestation: ['SELECT'],
  ai_execution_job_disposition: ['SELECT', 'INSERT'],
} as Readonly<Record<string, readonly ('SELECT' | 'INSERT')[]>>);
/** Fixed principal names. Non-owner EXECUTE on a worker RPC may be held only by the worker
 * role and INSERT on ai_execution_job_disposition only by the dispatcher; neither principal
 * may hold anything else on a V11 object, and a principal holding its privileges must have
 * no members (no inherited path to tenant-wide rendition jobs or dispositions). */
export const currentRuntimeV11GalleryWorkerRoleName = galleryRenditionWorkerRoleV1;
export const currentRuntimeV11AiDispatcherRoleName = 'workout_ai_dispatcher';
/** Table privileges only the dispatcher may hold, and everything the dispatcher may hold. */
export const currentRuntimeV11DispatcherOnlyTablePrivileges = Object.freeze({
  ai_execution_job_disposition: Object.freeze(['INSERT'] as const),
} as Readonly<Record<string, readonly ('SELECT' | 'INSERT')[]>>);
export const currentRuntimeV11DispatcherTableAllowance = Object.freeze({
  ai_execution_job_disposition: Object.freeze(['SELECT', 'INSERT'] as const),
} as Readonly<Record<string, readonly ('SELECT' | 'INSERT')[]>>);
export type CurrentRuntimeV11FunctionAccess = 'owner' | 'runtime' | 'worker';
export interface CurrentRuntimeV11FunctionPin {
  readonly signature: string;
  readonly sourceDdlId: 101 | 143 | 144 | 145 | 147 | 148;
  readonly language: 'plpgsql' | 'sql';
  readonly returns: string;
  readonly securityDefiner: boolean;
  readonly volatility: 'i' | 's' | 'v';
  /** Who may hold EXECUTE: owner only, or delegable to the runtime / worker role. */
  readonly access: CurrentRuntimeV11FunctionAccess;
  readonly prosrcSha256: string;
  /** sha256 of the normalized pg_proc row (see metadataSql) without owner/oid/ACL/body. */
  readonly metadataSha256: string;
}
// BEGIN V11 FUNCTION PINS
const functionPinRows: readonly (readonly [
  string,
  CurrentRuntimeV11FunctionPin['sourceDdlId'],
  CurrentRuntimeV11FunctionPin['language'],
  string,
  boolean,
  CurrentRuntimeV11FunctionPin['volatility'],
  CurrentRuntimeV11FunctionAccess,
  string,
  string,
])[] = [
  [
    'public.assert_restore_processing_closed(bigint,uuid,uuid)',
    101,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'owner',
    'f736c665bf0341f7afeb201ba644a474a1473c78ff32ef71c1b008085ab81a02',
    'b86c648bbc0c81abf9ec4a10c7b0d006a7fc05f54a1a5f42b975baf6efa84170',
  ],
  [
    'public.close_restore_processing_exact(bigint,uuid,uuid,uuid)',
    101,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'owner',
    '6c020aa05ac44ebb8011cc1123caa235c7916f3507cfadd7cf0230884299dad2',
    'f3bb6e956d2710df49d3aa7a7c67852a51517248b2237c1f0955ed27eb9b0114',
  ],
  [
    'public.read_restore_processing_admission()',
    101,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'runtime',
    '69b643e4d370717f7e0f1136dff31afbc514b108acaf8c798a5ad3e5a67dd69b',
    'e6ebab104cde50f071e5ddde3a840c597cf6d4c9662135d2e16d60d4afed10a7',
  ],
  [
    'public.require_restore_processing_admission()',
    101,
    'plpgsql',
    'void',
    true,
    'v',
    'runtime',
    '7df7fbdd28be56c9b4af74e9e2dd59babf04398e1a7ca7ff54ab125d5ac83ef8',
    'a2417ae6e2848187334cf5640c56f55251f150ba963c1e4c129c88dd2f36cf94',
  ],
  [
    'public.assert_gallery_album_context_v1()',
    143,
    'plpgsql',
    'text',
    false,
    'v',
    'owner',
    '028de790e7b6d423e41b97c0aaff19299e2682cb9a2c9524dd9b44c8628f682d',
    '8e230b7f55db4afcb6aca929ab2f416d5583b959b3734326ebb800d810a2343b',
  ],
  [
    'public.assert_gallery_album_erasure_context_v1()',
    143,
    'plpgsql',
    'text',
    false,
    'v',
    'owner',
    '17b7776ffc63fced1f9d48440ef55ad1bc735e944b005f06e49b5d5c2e749507',
    '2b188c12bf3c63e12ce6207dfb09f1958397320d21c6ca292636cb9d45214a51',
  ],
  [
    'public.assert_gallery_album_owner_v1()',
    143,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    '45cd505a7e2dc17208eb9db9056fe30817bf15ca454f2c62fbd1c32aaca4f79b',
    'd3d385499e09938aa114f79b119ee1075623821d52e113fda012286f6175f80d',
  ],
  [
    'public.check_gallery_album_terminal_v1()',
    143,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    'a1394828ae9abc564f60749b3285a82689149fbaf8245074578d8a5913172f8d',
    'ae836feb7d1f47868b1904fa6b71de6bef52cacc611ce1cc5324196e084062f1',
  ],
  [
    'public.create_gallery_album_v1(jsonb,text)',
    143,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'runtime',
    'a5b14f58be112fb5d9b8c59c5534c84363c5e45a943511cf913e50f97648f1d0',
    'af9c5bd63fdfee576d156d226b938fed82c02500ce8669f3a6741577ced6cb50',
  ],
  [
    'public.delete_gallery_album_v1(jsonb,text)',
    143,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'runtime',
    'b49ec90843e01972208f9aad02bb501bcfdc2faafa93c3a4308045606b4b1de6',
    '5014f627609153fd619a274cc30035246c67a326d5a58c2374b00e47dbd11401',
  ],
  [
    'public.detach_gallery_album_memberships_v1(uuid,timestamptz)',
    143,
    'plpgsql',
    'integer',
    false,
    'v',
    'owner',
    'ad4b259b2609939e97602a61163d014d5d666f4c699bd88532c5070fea0af9d4',
    'b7685c912c29a42182a7b00445f5e392944c3c480ae882ccc99b5183805ebdcd',
  ],
  [
    'public.erase_gallery_album_rows_v1()',
    143,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    'ac7e72aa09036aabdf697a873a4d3cf19d0cb3d07b32566aee3ab13cc3ea4223',
    '168f53f27930bf7201e0755b1acc22f221e24b1a827a82f574ad0cacb6d20dfc',
  ],
  [
    'public.erase_gallery_navigation_extension_account_v1(text)',
    143,
    'plpgsql',
    'timestamp with time zone',
    true,
    'v',
    'runtime',
    '9144fe7f8dc87ce2f76961727524aaf7578ac5b5ac78289da2edcc628ddb9596',
    '9e60fae8acec8086a1a40462ad58869710a296c3a555d18e25562d7d85f65994',
  ],
  [
    'public.finish_gallery_album_command_v1(text,text,jsonb,uuid,integer,jsonb,timestamptz)',
    143,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    '2f92e105300a247ceebdaf67f5f6b252ce415ceada32161f964f234e777213b8',
    '4c73a608567d08e42f57fc9df7776532bfa2ec91e0e7a21f1c0634c72197e840',
  ],
  [
    'public.gallery_album_dto_v1(public.gallery_album)',
    143,
    'sql',
    'jsonb',
    false,
    's',
    'owner',
    '58a5445153ab49a475efcd606cef18c30dcef70e1c63983ea4374d0c8f8cb3a7',
    '639d47f607f4723095162f89fe216791f102c46570fc30818d8d97d0592b2aad',
  ],
  [
    'public.gallery_album_result_valid_v1(text,uuid,integer,jsonb)',
    143,
    'plpgsql',
    'boolean',
    false,
    'i',
    'owner',
    '77096c24396e1e91ca17bec9718f6b8a10b1e2507325ce3b48c359e58aaf0653',
    '2b7892aba5fda7889f98a7867c455ffb7035c073cb9663c24d260144c2ec9229',
  ],
  [
    'public.gallery_album_title_valid_v1(text)',
    143,
    'plpgsql',
    'boolean',
    false,
    'i',
    'owner',
    '892d2f75ed1ae6aba9e0fc5115266c2476f3a57c8ae6f244be774fbd36801f3a',
    '8d7e705e601020499df5502515543247d1575477f3f4ab56a89c65d771ec525e',
  ],
  [
    'public.gallery_media_navigation_projection_v1(uuid)',
    143,
    'sql',
    'jsonb',
    false,
    's',
    'runtime',
    'cb6aa3421b7510334156a7841e0faef44732cc0ef2b5da19b4bd23eae6bc63df',
    '0e8e2b06412913d1782d936cb70033c4d8b5b1df694230f8f0b8a403f6bd3813',
  ],
  [
    'public.gallery_navigation_revision_valid_v1(jsonb)',
    143,
    'sql',
    'boolean',
    false,
    'i',
    'owner',
    '76006ba7ee62cd052c5c6e8760c352b4771b7eb18abc615de24bda322da4133a',
    '9b733c453ec19574611eb3033ecf15190446741338deff325bf3aa103c0c492f',
  ],
  [
    'public.gallery_navigation_uuid_text_valid_v1(jsonb)',
    143,
    'sql',
    'boolean',
    false,
    'i',
    'owner',
    'b016ddaee9f18f16c8e85a1ef4231ae6f81b4f428b17443614c2fae081bb18c5',
    '11a83c717c96b031dc4b05c42c597b608da6b5aee20236b929e9011adae1d302',
  ],
  [
    'public.guard_gallery_album_deletion_v1()',
    143,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '83ed133964094fb266038d3ee3dab31f2f4e74a9643dc780595a94c3e4fd1891',
    '564e405c49b939f75cd22310a7033fe558fdd9f27cd9729da68c2c274287ed0e',
  ],
  [
    'public.guard_gallery_album_membership_v1()',
    143,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'cb12158466295025f017afe72d20edbc54979254aa226a41b2e0fc3444d8dd3d',
    'ffac5a0192ed07b495aa5d7be29e986689e57c362e2b103103f0791532aeb10c',
  ],
  [
    'public.guard_gallery_album_receipt_v1()',
    143,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '82da861a777dcd0dd08558109eb5f5147543b5c36680da38ed5a736b8a362ca6',
    'bb63c291ee83926950ec2a4ef35e7539c96fa1a2c8920a1e166dec64b6706395',
  ],
  [
    'public.guard_gallery_album_row_v1()',
    143,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '6418d360bbe107aa9403df5b315702bfeeec739bd04f7b6c69396857d0465976',
    'ee93306dd4606a521a9e7456a5a974f0a52ecee28925643ba61ed70ae6d0f119',
  ],
  [
    'public.guard_gallery_media_course_association_v1()',
    143,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '4a7e1143d2f0abf0c4e8b08c0b2cd9c2323aee53db2fd134af69c0d44d9d8e69',
    'b5022658dc72e112c3fd6c08a03b3a03ed6ae0d0f37f831b5a76b5c4137c4555',
  ],
  [
    'public.lock_gallery_album_command_v1()',
    143,
    'plpgsql',
    'text',
    false,
    'v',
    'owner',
    '00ba03f5cdff7fdef69b4c31cbc97104d94f4dc3721f0e5157d55270a675ad7a',
    '0cbe92dfd57a80c9b81b148422410c2b821b70eed0a0aec1dfcaa511437d3ddd',
  ],
  [
    'public.normalize_gallery_album_command_v1(text,jsonb,text)',
    143,
    'plpgsql',
    'jsonb',
    false,
    'i',
    'owner',
    '0b339334c61d8c3615178d02c00238d13dab18daf773151f5f69897e83b57210',
    'e132e80a8a8c1d114e97e153e91cdf2c0e818125ad4988592ad10fff74626352',
  ],
  [
    'public.redact_gallery_album_receipts_v1(uuid)',
    143,
    'plpgsql',
    'integer',
    false,
    'v',
    'owner',
    '87e2066b1cfee34ea84edca987c7e1644d9854a6c11fa45a9527fb27bd17958c',
    '02d06690521b722ee409fb9dd5cb589c98cb559f0d99455ecf86b4c52cd7cdba',
  ],
  [
    'public.remove_gallery_navigation_deleted_media_v1(uuid,integer,timestamptz)',
    143,
    'plpgsql',
    'void',
    true,
    'v',
    'runtime',
    'afec319ba9206bddf00c94a3ac50391ec5b885aa1c466b8a70e6179ba6d633db',
    '4bfc75cd89a97b02741c3b53bccb182afed40cfc3f3b8bc79eefb1babd03a9e6',
  ],
  [
    'public.rename_gallery_album_v1(jsonb,text)',
    143,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'runtime',
    '533e264c733436459cae79934544432404d1a69e265364480c95c04abcd88ca0',
    '2947ceea9eff26854b381a218cf3414363a766441014c4ee3d415b97fd3b9b77',
  ],
  [
    'public.replay_gallery_album_command_v1(text,text,jsonb)',
    143,
    'plpgsql',
    'jsonb',
    false,
    'v',
    'owner',
    '20520d05730b987a3c9dc94fbc04787c4d662fc3964dd10400af485462dea077',
    '110aca1e6543effcb415955b1956169186abc4d28ccf597736b62d1bbd4d2921',
  ],
  [
    'public.require_gallery_navigation_authoring_v1()',
    143,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    '9a0a1cd47fbae8236409b8e2fcaae4073060ce90418ef47c911731526dde24a0',
    'c6a33b541f82642a3d2ab8c4dc1c9244bb6fe3abaf5c7e3519d83262acab072d',
  ],
  [
    'public.set_gallery_media_navigation_v1(jsonb,text)',
    143,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'runtime',
    '5104a83de8fa5ebff1d6c91b1cbcfffa482a3731d05298eaade92f04c0b3704a',
    '14b95763f2cfadae94f6d43da79aee8437ad11d3d8492d8a2e1dd0b59303b3d5',
  ],
  [
    'public.claim_gallery_rendition_sweep_v1(uuid,integer)',
    144,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'worker',
    'd57c9830027afad703b34564053201bc2893a79335a0b7757dd33f5303f76e03',
    '13061dbf3a233cc2cfbce2549baf95c94d2d15cff9e389cf95e8055a470358b8',
  ],
  [
    'public.claim_gallery_rendition_v1(uuid,integer)',
    144,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'worker',
    'c6050c29ef61cb0eef3600e58eb7f8e9db11255460f007e194e29f9ad17f87ca',
    'd2d15cb43dadcc0b1e70edd6e21f9423029fc934a54c9f2667096573664b18f6',
  ],
  [
    'public.enqueue_gallery_renditions_v1(uuid)',
    144,
    'plpgsql',
    'integer',
    true,
    'v',
    'owner',
    '93e92d1318bfcb0518632c5c6a99f5557ff56c9fec0fe8308c64d08014ad5f4a',
    '0dc1c993e46ba8e0c1dc01b910e7933a39733847e9fbf372e134251b43efa2d9',
  ],
  [
    'public.finish_gallery_rendition_sweep_v1(uuid,uuid,boolean)',
    144,
    'plpgsql',
    'boolean',
    true,
    'v',
    'worker',
    '592129440258653222077eee5a35566999fbd6149bbc945266c8629ce2ac6b1c',
    'bd0d39a230e7638747337e3e230736ff2438bfbda6e4dc83ada41a90fb23bc80',
  ],
  [
    'public.gallery_rendition_app_consent_v1(text)',
    144,
    'sql',
    'boolean',
    false,
    's',
    'owner',
    '191a8591adf01bae8466a2cf49babc45daa5ecb137ad64874229f9be050776ea',
    'dd24c561d76d7e27b26de89bcbf6a30f130775ec0ffc4b1539cc920ebf18db6c',
  ],
  [
    'public.gallery_rendition_dto_v1(public.gallery_media_item,text,public.gallery_rendition_job)',
    144,
    'plpgsql',
    'jsonb',
    false,
    's',
    'owner',
    '77adafa21c545ea5e2cf4660d6cc777cdbc275a94b42d04896cac801205da512',
    '1b633464ef2972d04b9e18ca56ca3381d5690d5e25247b30d4d6b5f651bb21fa',
  ],
  [
    'public.gallery_rendition_enqueue_item_v1()',
    144,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    'd14fe6d20b0319ad0626a6050d69a7f2a7a0333068c0bdd0fbb1fd6286b87617',
    '0ad54258a2c947cfbceb2d17110c73d3d40f3362807548cbdc9a5ecbe760ef87',
  ],
  [
    'public.gallery_rendition_insert_jobs_v1(text,uuid)',
    144,
    'plpgsql',
    'integer',
    false,
    'v',
    'owner',
    '92f1a44589e96aa2bce0401f82d0c79fd184fd7eda03ffff6a3430f5812c7857',
    '4e55b1289986b50c70a8726b49ac507722475852ed3f9a9c751e07624d5a4699',
  ],
  [
    'public.gallery_rendition_job_due_v1()',
    144,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    'ef91e9dd56a81a70132c2879d27591d4039a8b1a05c44b528245290834a31d40',
    '753252de12542f624b32a342a7ad8a53fc78c90151d4a67feaa77646db2ea1ea',
  ],
  [
    'public.gallery_rendition_job_guard_v1()',
    144,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'ea50658d46b4d747b8ec12ea2bb04b4c8864ae9d3d50b168be0327f72abba507',
    'd88cd710bf74c7c495d494e5340036ed3d0d554ce932e9e1ff31177e7f317540',
  ],
  [
    'public.gallery_rendition_processing_admitted_v1()',
    144,
    'plpgsql',
    'boolean',
    false,
    'v',
    'owner',
    '84a1a8a5ca48c59afe761afad677d88d69936f56afa3dd8f97d40af29470c931',
    '7f9f764783c7b8f7992c40658b13f6eb1813f97d136ce59fb063e1a914c55884',
  ],
  [
    'public.gallery_rendition_retire_item_v1()',
    144,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    'f7420f4ae956006861633c275d72155130d319f7e0560242187b1517c426a48f',
    'a926cb94fb48e1e3b9dabb68f262e3c9178b4f40978e4f012f7297f3625fd729',
  ],
  [
    'public.gallery_rendition_worker_context_v1(text)',
    144,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    '2d46a09964d31fd6c1255f2c291168776fdc40d8c49cc9bedec93add71b7f32e',
    '7d1b4e769e63f7e7931f2673735c351a66e8e5d12a9d067fa46e9e5da63ac218',
  ],
  [
    'public.read_gallery_renditions_v1(uuid)',
    144,
    'plpgsql',
    'jsonb',
    true,
    's',
    'runtime',
    '4e13c633f884ef3fc9112c96c60e4dacd2404c62068cd100b0562ef175faf1d9',
    'a4303d367ec04bbbc2aef124ef1ac1b080037ec38c62b4276f94436d31912adc',
  ],
  [
    'public.release_gallery_rendition_v1(text,uuid,uuid,text)',
    144,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'worker',
    'c48badaa0d061dd154cb0a67426d5b88aa5578d43500f3b131a87b57735af31b',
    'e433f00cf13b7b8e08de2110930928c457df83f65eb3029633515a37ff1a35d0',
  ],
  [
    'public.require_gallery_rendition_processing_v1()',
    144,
    'plpgsql',
    'void',
    false,
    'v',
    'owner',
    'c3d05751b09caa42a15339412c9c404c33284f4a4f28231db4e3131b0f74d731',
    '75752362388957295556b285fe7bd552d3a800c93f7aed3782c82929aaef3e4b',
  ],
  [
    'public.resolve_gallery_rendition_object_v1(uuid,text)',
    144,
    'plpgsql',
    'jsonb',
    true,
    's',
    'runtime',
    'e3d197f73ba734c329ac29e832845334e4b3b7dd054cae15c1b0505d8cd0df4c',
    '308871c1a37832055332656bb05f7c44ef1baeb8ff114fe27ba85a80e1875197',
  ],
  [
    'public.settle_gallery_rendition_v1(text,uuid,uuid,jsonb)',
    144,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'worker',
    'aeea06087db9d13562ece428395dfc8f60a93662f2561c2d515f55c18e865fe1',
    '44d0e861b2afa61d6a301c69df5eefe94907f3fdea5cd3233d17454c711efdef',
  ],
  [
    'public.record_gallery_album_deletion_suppression_event_v1()',
    145,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    'c3fc12fc0fea849a1ab20df1e4333e512f244026c51e4ff2d7bff2bad24c2eed',
    'c6ae8c7fb332e096440a19c6e3ff0b80dffa91d79b969dca5c715828fd069390',
  ],
  [
    'public.remove_gallery_navigation_on_media_deletion_v1()',
    145,
    'plpgsql',
    'trigger',
    true,
    'v',
    'owner',
    '4a50a379264e32047cc39c3cfbf2c95352f8819a818c2ec8809119491f36c22c',
    '6586e5f8e9dc1a7e6f15071ae5c3b4aa09fa8a68bd20fc776a6d3d9490e54b6f',
  ],
  [
    'public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)',
    145,
    'plpgsql',
    'text',
    false,
    'v',
    'owner',
    '9dc6326c042b8eed66d4e2745eccccbc0bd2074bcd9f2212f1a9d1a11032a854',
    'ede1876e19723f951328f32c8ea7b835a97d33cb947d015ff2380051de82ed75',
  ],
  [
    'public.verify_restore_gallery_album_replay_receipt_v1()',
    145,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'd924eae358645a9559419d1ee4e27a710ac4f04e581d95f68571abee1763406b',
    '094e00fc024c3e7610f686d8761749839bcfd066077b1a08a1472957bc607c63',
  ],
  [
    'public.admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)',
    147,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'owner',
    '4f6b7d8aae39f0607007afa00d9d012a16011bad3a34fb11096458bc699961f7',
    '74b1344856bf7cc12b146c5781d83b7c81b8ebf53514cb7fed4d5c07e4d032fb',
  ],
  [
    'public.guard_restore_processing_admit_receipt()',
    147,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '1f8ba29d7c0769d7baa040257dbdbbc7cc9e5f39f4064ba5e99f7c7aee0ca697',
    '023e30801794bdcfb930f5836cab21d9ef271d233174116291dd4af7e28a541d',
  ],
  [
    'public.guard_restore_processing_force_rls()',
    147,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '05e4aa60d5cb6227ec39b8ffa4f62ffb7fb256b069fb1e3ae5cb009b8bc8a19f',
    'a65830fb8f9d537b6f2d8f0968fe64a8ad127daa866c015142f9cc0d20532df8',
  ],
  [
    'public.open_restore_processing_admission_window(bigint,uuid,uuid)',
    147,
    'plpgsql',
    'jsonb',
    true,
    'v',
    'owner',
    'cb43b3564d1c0a610c96a8a7859e959dcf99613ab3d05b935d685d49ebaf75da',
    '60b12f55ec6413203c65f83b40fd62b60cd3c6b3bcc5f5e131a42ef2b67c94a7',
  ],
  [
    'public.restore_processing_admission_loader_namespaces()',
    147,
    'sql',
    'text[]',
    false,
    'i',
    'owner',
    'ae4e900bb9299852c3387fcab08f57ef63beb3b19cd3cbb5df7e589793427d65',
    'ccb0e36db2088656719ce45a01f84ef41850303ccbe7483b7af404f5c4d029ee',
  ],
  [
    'public.restore_processing_admission_roster()',
    147,
    'sql',
    'record',
    false,
    'i',
    'owner',
    '1d5c54ab403e50819bec5b3e2e5ecf530232e30310f710c6a688ebc7f2b3c3b9',
    '63603b28ebb1ff2c54858b5c5cb625fce513c63c209c9bc17456f10c9c4182be',
  ],
  [
    'public.restore_processing_admission_roster_drift()',
    147,
    'sql',
    'boolean',
    false,
    's',
    'owner',
    'c311e17f1ab804567e1511debd6dd32f20f87bba49373ca8b2a6fc003aaaf3bc',
    'aa8b5ed63dd9026f161247fd3157ae3ea1c062b5c3c0d20b956d102d3ffd44e3',
  ],
  [
    'public.restore_processing_admission_roster_sha256()',
    147,
    'sql',
    'text',
    false,
    'i',
    'owner',
    '58467a506b51129a760f68fdf671b753e5070a55bd308c1895748a6f72302a28',
    '58cbe63794d8b02148a8bfb8684dad9488f2a2aeef10c87aadb7b84f9215f213',
  ],
  [
    'public.restore_processing_plain_owner()',
    147,
    'sql',
    'boolean',
    false,
    's',
    'owner',
    '2902bacc2593c853152cc1d3ddba6203a8dc6f1d79d64d931ca01418072a9f13',
    'b315a7f8498ac10d7e9ffd696a6f035f628bbc6dd282cb1f2a2c385f22a5f681',
  ],
  [
    'public.ai_synthetic_evidence_manifest_v1(jsonb)',
    148,
    'sql',
    'jsonb',
    false,
    'i',
    'owner',
    'f364cda4e5c88633742682c4d5b36bfb7192248b197b3c44ae2d5d0e7851b81a',
    '6e3fa9d6b806db3b3fa8afcd0c9117ed6c450e5d0671b404ad33d217f70f34cf',
  ],
  [
    'public.check_ai_execution_job_commit_v1()',
    148,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '3da0884a51cfa880ca85e877d8466ccdff56d0d530cf0fa3bf2443460cb661aa',
    '4b322281b2955793dacee3bddbccead2aab85e04dea4c682080ff32935a6d69a',
  ],
  [
    'public.check_ai_execution_job_disposition_commit_v1()',
    148,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    '5bc8e61fcc16b80bf19d2c72429421b95b883bb9c78e2179fb91e14a76c814ea',
    'ef69d8c0c1e69a53816f4aa02d8e3877f368a00ea724175949a0e79669478e06',
  ],
  [
    'public.guard_ai_execution_job_disposition_v1()',
    148,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'ffe7a26904666c201b64295099b9bf03ff6f71fcb47d36b9dd0b8a2ea2829e07',
    '701056f43116bed975c8dc4cc5cdc8517076a78b4cca7ff3b4b6cc816d15eee8',
  ],
  [
    'public.guard_ai_execution_job_v1()',
    148,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'bc3e04a581c76d05777a7378a6f2726333d8089a068cb82d66af48bee078c807',
    '51a0b37c47a7ec021fb7ce66a9c5b42c3f431a4b2807754b5f921e363f8d79b6',
  ],
  [
    'public.guard_ai_synthetic_evidence_attestation_v1()',
    148,
    'plpgsql',
    'trigger',
    false,
    'v',
    'owner',
    'bcb0af4d86cc71c670f3cb74aacd4e7b2af4dd4ce4cf2896c040aaa540be4150',
    '7619936c823a9b34efab1fccfef9a04a52f4ce61e5bd5a5397a5d85dcbb32f30',
  ],
];
// END V11 FUNCTION PINS
/**
 * 66 functions created by 143..148 plus the four SQL101 functions 147 replaces in place
 * (read_/require_ keep the runtime EXECUTE that migrate.ts grants; assert_/close_ stay
 * owner-only). Any other replaced parent function is metadata drift.
 */
export const currentRuntimeV11FunctionPins: readonly CurrentRuntimeV11FunctionPin[] = Object.freeze(
  functionPinRows.map(
    ([
      signature,
      sourceDdlId,
      language,
      returns,
      securityDefiner,
      volatility,
      access,
      prosrcSha256,
      metadataSha256,
    ]) =>
      Object.freeze({
        signature,
        sourceDdlId,
        language,
        returns,
        securityDefiner,
        volatility,
        access,
        prosrcSha256,
        metadataSha256,
      }),
  ),
);
export interface CurrentRuntimeV11TriggerPin {
  readonly table: string;
  readonly trigger: string;
  readonly function: string;
  /** pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. */
  readonly tgtype: number;
  /** UPDATE OF column list (tgattr), comma-joined; '' when not column-scoped. */
  readonly columns: string;
  readonly constraint: boolean;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
  /** A WHEN condition is present (its text is part of the structure digest). */
  readonly when: boolean;
}
// BEGIN V11 TRIGGER PINS
const triggerPinRows: readonly (readonly [
  string,
  string,
  string,
  number,
  string,
  boolean,
  boolean,
  boolean,
  boolean,
])[] = [
  [
    'ai_execution_job',
    'ai_execution_job_commit_atomic',
    'public.check_ai_execution_job_commit_v1()',
    5,
    '',
    true,
    true,
    true,
    false,
  ],
  [
    'ai_execution_job',
    'ai_execution_job_guard',
    'public.guard_ai_execution_job_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'ai_execution_job',
    'ai_execution_job_no_truncate',
    'public.guard_ai_execution_job_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'ai_execution_job_disposition',
    'ai_execution_job_disposition_commit',
    'public.check_ai_execution_job_disposition_commit_v1()',
    5,
    '',
    true,
    true,
    true,
    false,
  ],
  [
    'ai_execution_job_disposition',
    'ai_execution_job_disposition_guard',
    'public.guard_ai_execution_job_disposition_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'ai_execution_job_disposition',
    'ai_execution_job_disposition_no_truncate',
    'public.guard_ai_execution_job_disposition_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'ai_synthetic_evidence_attestation',
    'ai_synthetic_evidence_attestation_guard',
    'public.guard_ai_synthetic_evidence_attestation_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'ai_synthetic_evidence_attestation',
    'ai_synthetic_evidence_attestation_no_truncate',
    'public.guard_ai_synthetic_evidence_attestation_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_album',
    'gallery_album_no_truncate',
    'public.guard_gallery_album_row_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_album',
    'gallery_album_row_guard',
    'public.guard_gallery_album_row_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_album',
    'gallery_album_terminal_check',
    'public.check_gallery_album_terminal_v1()',
    29,
    '',
    true,
    true,
    true,
    false,
  ],
  [
    'gallery_album',
    'record_gallery_album_deletion_suppression_event',
    'public.record_gallery_album_deletion_suppression_event_v1()',
    17,
    'deleted_at',
    false,
    false,
    false,
    true,
  ],
  [
    'gallery_album_deletion',
    'gallery_album_deletion_guard',
    'public.guard_gallery_album_deletion_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_album_deletion',
    'gallery_album_deletion_no_truncate',
    'public.guard_gallery_album_deletion_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_album_deletion',
    'gallery_album_deletion_terminal_check',
    'public.check_gallery_album_terminal_v1()',
    29,
    '',
    true,
    true,
    true,
    false,
  ],
  [
    'gallery_media_album_membership',
    'gallery_album_membership_guard',
    'public.guard_gallery_album_membership_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_album_membership',
    'gallery_album_membership_no_truncate',
    'public.guard_gallery_album_membership_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_course_association',
    'gallery_media_course_association_guard',
    'public.guard_gallery_media_course_association_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_course_association',
    'gallery_media_course_association_no_truncate',
    'public.guard_gallery_media_course_association_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_item',
    'gallery_navigation_media_deleted',
    'public.remove_gallery_navigation_on_media_deletion_v1()',
    17,
    'deleted_at',
    false,
    false,
    false,
    true,
  ],
  [
    'gallery_media_item',
    'gallery_rendition_enqueue_item',
    'public.gallery_rendition_enqueue_item_v1()',
    5,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_item',
    'gallery_rendition_retire_deleted',
    'public.gallery_rendition_retire_item_v1()',
    17,
    'deleted_at',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_media_item',
    'gallery_rendition_retire_erased',
    'public.gallery_rendition_retire_item_v1()',
    11,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_navigation_command_receipt',
    'gallery_album_receipt_guard',
    'public.guard_gallery_album_receipt_v1()',
    31,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_navigation_command_receipt',
    'gallery_album_receipt_no_truncate',
    'public.guard_gallery_album_receipt_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_rendition_job',
    'gallery_rendition_job_due',
    'public.gallery_rendition_job_due_v1()',
    21,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_rendition_job',
    'gallery_rendition_job_guard',
    'public.gallery_rendition_job_guard_v1()',
    23,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'gallery_rendition_job',
    'gallery_rendition_job_no_truncate',
    'public.gallery_rendition_job_guard_v1()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'restore_gallery_album_replay_receipt',
    'restore_gallery_album_replay_receipt_immutable_rows',
    'public.reject_restore_suppression_event_mutation()',
    27,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'restore_gallery_album_replay_receipt',
    'restore_gallery_album_replay_receipt_immutable_truncate',
    'public.reject_restore_suppression_event_mutation()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'restore_gallery_album_replay_receipt',
    'restore_gallery_album_replay_receipt_verify',
    'public.verify_restore_gallery_album_replay_receipt_v1()',
    7,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'restore_processing_admission',
    'restore_processing_force_rls_at_commit',
    'public.guard_restore_processing_force_rls()',
    17,
    '',
    true,
    true,
    true,
    false,
  ],
  [
    'restore_processing_admit_receipt',
    'restore_processing_admit_receipt_immutable',
    'public.guard_restore_processing_admit_receipt()',
    27,
    '',
    false,
    false,
    false,
    false,
  ],
  [
    'restore_processing_admit_receipt',
    'restore_processing_admit_receipt_no_truncate',
    'public.guard_restore_processing_admit_receipt()',
    34,
    '',
    false,
    false,
    false,
    false,
  ],
];
// END V11 TRIGGER PINS
/** Every non-internal trigger on a V11 table or executing a V11 function (incl. those on
 * parent tables): enabled (O), argument-free, non-transition; WHEN text is in the digest. */
export const currentRuntimeV11TriggerPins: readonly CurrentRuntimeV11TriggerPin[] = Object.freeze(
  triggerPinRows.map(
    ([table, trigger, fn, tgtype, columns, constraint, deferrable, initiallyDeferred, when]) =>
      Object.freeze({
        table,
        trigger,
        function: fn,
        tgtype,
        columns,
        constraint,
        deferrable,
        initiallyDeferred,
        when,
      }),
  ),
);
// BEGIN V11 STRUCTURE PINS
/** sha256 over the sorted structure lines (catalogLinesSql, ACL lines excluded) of each V11
 * table and of each parent relation that 143..148 change, with the line count. */
const structurePinRows: readonly (readonly [string, number, string])[] = [
  [
    'public.ai_execution_job',
    84,
    'd3f5e42da3fa4238dca1b0c76bed0d91b3af0c02fe533a317282df06fc646017',
  ],
  [
    'public.ai_execution_job_disposition',
    20,
    '94de87b1c8ccd7dcbe0dcc9ac63909f212cffcd49aaac9eb43dc1ff41acf17e5',
  ],
  [
    'public.ai_settings_catalog_definition',
    22,
    '620aa309ebd83eb249f0fc206599c57662d1e1f92d489a8ec82fa1afaf3f3275',
  ],
  [
    'public.ai_settings_revision',
    46,
    '06acf3d83593921cab9f8b86a5584c22bf2852f2db26bb99ac813f123d197f13',
  ],
  [
    'public.ai_synthetic_evidence_attestation',
    23,
    '6cde26e19dec5465957339cffe79fca610a3a0db344e44ef10864edb2c5febfa',
  ],
  ['public.coaching_run', 40, 'c2ace6f3df4a969a9607112255a4166e023445ac2791bc41fbd084cf5e9daaf5'],
  [
    'public.core_evidence_snapshot',
    26,
    '1a0e9e0899cdea004449514dae68ea96d4a8f61ec3d4df426c71e81622e7437b',
  ],
  ['public.gallery_album', 27, '5ded25f049c363ddb90dbf05e7479a0cc21b4473a690e61b4814e739aba3a39a'],
  [
    'public.gallery_album_deletion',
    15,
    'c373ae81c3e5ca05ee4aa322af332fae3c543c7a9e645b0c96589933959cb9e6',
  ],
  [
    'public.gallery_media_album_membership',
    16,
    '9e13a6e5d3907609ee2a4130c0aff5d4cd5c2a6508141803ba500bc31eab863d',
  ],
  [
    'public.gallery_media_course_association',
    16,
    'ce367364854df07f2b237b1a862b20327420d71871584733a3cde0dc30fd63b4',
  ],
  [
    'public.gallery_media_item',
    66,
    'bb3e51531dc7dd8c32f763fe2e7f3df74445f98351183bfc6a7d144adef9d5fa',
  ],
  [
    'public.gallery_navigation_command_receipt',
    35,
    '1622127847e0863c36f826b5e2774f90fb131ced948db7fc213b55eca2cdc9ae',
  ],
  [
    'public.gallery_rendition_due',
    12,
    '7e95dcbdd3483aa02f7382585ed5634b93a2c712391607080ccd8565340d922e',
  ],
  [
    'public.gallery_rendition_job',
    66,
    'bd1215bffc577d8d6f91971fb7c48d6255a4cb01a2feeb6867fe5d6fc819ef03',
  ],
  [
    'public.gallery_rendition_sweep',
    25,
    'a1461d9dc1cc844a2c8da3ec2a0dc4b8bdfbabbfaf2f8cdb4fd0f4b2f37b9ba1',
  ],
  [
    'public.restore_gallery_album_replay_receipt',
    17,
    '2bd0af7a9a1fcc93612eb183567a2f9a929c0e4a2c5ab34180381d40f473a2f5',
  ],
  [
    'public.restore_processing_admission',
    26,
    '9eba665cfca4a2c32a8fc08431e95a3c45c9c29369c63fc5683a84e21e7c3093',
  ],
  [
    'public.restore_processing_admit_receipt',
    26,
    'bb06097b92dc49b3344332ea34bc6a6a931d67741da026348f2bbc10267b5050',
  ],
  [
    'public.restore_suppression_event',
    106,
    '985ce6b501cb9e725c85858abba51d186876bcb34506824bb23376c813eee870',
  ],
];
/** The exact parent catalog change of the install: lines removed and added on parent owners. */
const parentRemovedRows: readonly (readonly [string, string, string, string])[] = [
  [
    'public.assert_restore_processing_closed(bigint, uuid, uuid)',
    'function',
    '',
    '0dd0c2830e47f5994e618228f56550de198cc51121521781dc5da50cd3af4458',
  ],
  [
    'public.close_restore_processing_exact(bigint, uuid, uuid, uuid)',
    'function',
    '',
    '5b1de9a6dc07773e5b24b6c5b251743f1758410725063aee48c3a46ba9c339ad',
  ],
  [
    'public.read_restore_processing_admission()',
    'function',
    '',
    'b06833e5da0f6b5b224ce3154ff4e53fdc283972d0fbe63f341e1bccf7e5ac4e',
  ],
  [
    'public.require_restore_processing_admission()',
    'function',
    '',
    '84d68ca3b25663212c4e8be03529fe040488b9a3cde7caf6e840e84eadbb700d',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admission_state_check',
    'ea73916457d7e0b07d9d599f0b64b3fbc7abc0f9431e7bb0b11033db513a07b8',
  ],
  [
    'public.restore_suppression_event',
    'constraint',
    'restore_suppression_event_kind_target_check',
    'd24416aefa4780a2af05ab5aaa02f2b89ff6855aa4a2e2c2335d2747a765c7c0',
  ],
  [
    'public.restore_suppression_event',
    'constraint',
    'restore_suppression_event_record_version_check',
    'b1dc50483ef3c7f15c767e921c71a4ea3245bce7917820eede630d0a6308f28f',
  ],
];
const parentAddedRows: readonly (readonly [string, string, string, string])[] = [
  [
    'public.ai_settings_catalog_definition',
    'trigger',
    'internal:ai_execution_job_catalog_revision_fkey:pg_catalog."RI_FKey_noaction_del":9',
    'ba66353af13470526566fee6b205623391d067ffd7e4e20a2edec9b7ff1027a7',
  ],
  [
    'public.ai_settings_catalog_definition',
    'trigger',
    'internal:ai_execution_job_catalog_revision_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    '94531ae3aa2d81832b564f1a996fc6b79832f4529eb8d5bff7941b761ea4fcf1',
  ],
  [
    'public.ai_settings_revision',
    'trigger',
    'internal:ai_execution_job_athlete_id_settings_revision_fkey:pg_catalog."RI_FKey_cascade_del":9',
    'b0e233d3f5f16387c9b4c6d71e82627830566a9a4e055f3f31e125b8f22722d9',
  ],
  [
    'public.ai_settings_revision',
    'trigger',
    'internal:ai_execution_job_athlete_id_settings_revision_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    '19556011ed17ddb94f737835630436a8097ce5fce7acbb6565462700a8c327ca',
  ],
  [
    'public.assert_restore_processing_closed(bigint, uuid, uuid)',
    'function',
    '',
    '33f03c92c0b3546b0a67983f8ef6adc3da5d1e7cefa7dddfbbad818109265c65',
  ],
  [
    'public.close_restore_processing_exact(bigint, uuid, uuid, uuid)',
    'function',
    '',
    '624eb01727d1ec870fa61106ba93775223244003232e10d137acaadbb5fefc4e',
  ],
  [
    'public.coaching_run',
    'trigger',
    'internal:ai_execution_job_athlete_id_run_id_fkey:pg_catalog."RI_FKey_cascade_del":9',
    '68a892d2fd526f3b5e2d9e14da0892932095629833c591d6393350a913632a8a',
  ],
  [
    'public.coaching_run',
    'trigger',
    'internal:ai_execution_job_athlete_id_run_id_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    'f448c5296a6e605f6cc0967a14ccaba740a6e0fe3aee57971d8033ea191d5470',
  ],
  [
    'public.core_evidence_snapshot',
    'trigger',
    'internal:ai_synthetic_evidence_attesta_athlete_id_evidence_snapshot_fkey:pg_catalog."RI_FKey_cascade_del":9',
    '8f90531303f409c84bbe09f3fda9da1edeeb06874dc16bc6b7a05600833d0951',
  ],
  [
    'public.core_evidence_snapshot',
    'trigger',
    'internal:ai_synthetic_evidence_attesta_athlete_id_evidence_snapshot_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    'f6aa331f7160d7d3d6fc4d89c2b81f80bf309f9210ae8d96a9aa031332b0277a',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'gallery_navigation_media_deleted',
    '57476c24f2eea4e64e66c8b85053282ebb5073653ae5f831243eba73c3228ada',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'gallery_rendition_enqueue_item',
    '521bbd2fe04bde288a52ece9b462701916eea2c007444a2c440924e1bea26cbb',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'gallery_rendition_retire_deleted',
    'f630e8bc63504b277a25df5745de2c34895a2db935c94db1cac28f908fb8cfc7',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'gallery_rendition_retire_erased',
    'fc160582e353b60610f60cea33cb06aee3e87b8db5f8c66227481ec201eee641',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_media_album_membership_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_noaction_del":9',
    '9f7b3b3de7e04b3a6ff27c68bda4e3773f8201674aed0d2411f5e9b9b17a9270',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_media_album_membership_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    '6566995dfeb09c2a9a3203225368cd8d9ac039d85bc4ca60ea56864f93fea7cb',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_media_course_association_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_noaction_del":9',
    '0718fabf6fe6299b740662996053b20964c180a4080eac3c14a0c84749ef7ce5',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_media_course_association_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    '98ce3b4d40d098dc56e947d4ca248eb06404277f5cab7cb2e43ebfcb296050e0',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_navigation_command_re_athlete_id_target_media_item_fkey:pg_catalog."RI_FKey_noaction_del":9',
    'da97611922c9c71c1907ef20417b36f306499ae1b0008427ebc69e7637dc14e6',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_navigation_command_re_athlete_id_target_media_item_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    'ef2bb5e8f70541a4fe4e78c00eb7db19ed309cd36d40a0be6237d259dc167069',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_rendition_job_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_cascade_del":9',
    'f779120cb69fade9b9ab852736c05bc21e5ac1756acb88cf2d343e9bcfa04e4a',
  ],
  [
    'public.gallery_media_item',
    'trigger',
    'internal:gallery_rendition_job_athlete_id_media_item_id_fkey:pg_catalog."RI_FKey_noaction_upd":17',
    '6bf9eaa961b7e17bfd6a1fc4e9686012953362692f3b71066f7a0e5e19437271',
  ],
  [
    'public.read_restore_processing_admission()',
    'function',
    '',
    '418b9338d6fcdb7b00ad0967cab586cf952fabad4cf131438a40d19f01021378',
  ],
  [
    'public.require_restore_processing_admission()',
    'function',
    '',
    '7d9f45c013b929c8316094bcdbb2022df5d47ea8977b01b38a67525fedc5ddb0',
  ],
  [
    'public.restore_processing_admission',
    'column',
    'admitted_artifact_sha256',
    'dcc544e0e10aa7315293ac50a3e0c59875e9e531fc5cc9dd035adb73cd9530a6',
  ],
  [
    'public.restore_processing_admission',
    'column',
    'admitted_head_sha256',
    '66f6935311e7d7efc78c95e94d67fb437ac48488d47e6546960dac999db8c2c5',
  ],
  [
    'public.restore_processing_admission',
    'column',
    'admitted_postconditions_sha256',
    '95a4b6ec3e7b8fc4978dffda4858a39fe34799692da9c0e90fbf3f7ed118d5df',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admission_admitted_artifact_sha256_check',
    'e7414b96ecb6df7716a75a1b96e1bb84765a28e24992880b35873e8618f6273a',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admission_admitted_head_sha256_check',
    '11934ea7b10a0a1b807626f8de4f1726c3652e6425e9f6e958fa88dac992bc08',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admission_admitted_postconditions_sha2_check',
    '7f8566495b96c65bbb63f242ba6d1a56a3905843831ffa3bb84e0cbb45dacf7f',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admission_state_check',
    'ecc2e8de672e39b9ba7189e972fcda309c2d3f00863e17bc2907d2c39ac71205',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_admitted_shape',
    '20779a2ab3772e6a5b594a167419cede0f7f18edf04b497ba14c4a37c786f48d',
  ],
  [
    'public.restore_processing_admission',
    'constraint',
    'restore_processing_force_rls_at_commit',
    '9261414569721d402a32ae217ded6673027e12fdd80e6e55fdf5b0a0618b05c2',
  ],
  [
    'public.restore_processing_admission',
    'trigger',
    'restore_processing_force_rls_at_commit',
    '6bc2467f488278996750a9bcccb9ff49ae9930366bd0bd85a76935b798e863b9',
  ],
  [
    'public.restore_suppression_event',
    'constraint',
    'restore_suppression_event_kind_target_check',
    '9c8c07ef51ee88b52dbca1035c1ef0030046ed4a400e93b150be119395ee7136',
  ],
  [
    'public.restore_suppression_event',
    'constraint',
    'restore_suppression_event_record_version_check',
    'c2c1348a4b362d1e0890c33166fac4ae556676398c4bfe8a2daca4848507eb1e',
  ],
  [
    'public.restore_suppression_event',
    'index',
    'restore_suppression_event_gallery_album_once',
    '7802e6e6c1f681538d545e8950887ebf9ab0721a10c5851b2b5fde122e0ff450',
  ],
];
// END V11 STRUCTURE PINS
export const currentRuntimeV11StructurePins = Object.freeze(
  structurePinRows.map(([relation, lines, sha256]) => Object.freeze({ relation, lines, sha256 })),
);
export const currentRuntimeV11ParentChange = Object.freeze({
  removed: Object.freeze(
    parentRemovedRows.map(([owner, kind, name, detailSha256]) =>
      Object.freeze({ owner, kind, name, detailSha256 }),
    ),
  ),
  added: Object.freeze(
    parentAddedRows.map(([owner, kind, name, detailSha256]) =>
      Object.freeze({ owner, kind, name, detailSha256 }),
    ),
  ),
});
export const currentRuntimeV11LegacyLedgerNamespaces = Object.freeze([
  'wm_gallery_installation',
  'wm_gallery_rendition_installation',
] as const);
/** Parent-side markers of 145/147 (staged detection beyond the new tables and functions). */
const stagedParentTriggers = Object.freeze([
  'gallery_rendition_enqueue_item',
  'gallery_rendition_retire_deleted',
  'gallery_rendition_retire_erased',
  'gallery_navigation_media_deleted',
]);
// Literal copy of V10's unexported four guard pins (V9 frozen); V10 stays byte-frozen.
const guardPins = [
  {
    signature: 'public.assert_manual_race_v2_caller()',
    prosrcSha256: '94fe931526ec9a6926bdd7eda5055ab0ebda0560224626af454d4b06837ae348',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_race_v2_caller',
      prorows: 0,
      pronargs: 0,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: null,
      proargtypes: [],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.manual_race_v2_assert_json_bound(jsonb)',
    prosrcSha256: 'eddb8a3273e013884e6400bf00bc8cf7d3a03d49edacad80d7f57b526113f2cb',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'manual_race_v2_assert_json_bound',
      prorows: 0,
      pronargs: 1,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: ['body'],
      proargtypes: ['3802'],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'i',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.assert_manual_review_global_lock()',
    prosrcSha256: '6e353607c9be44e4fb4af3e6bdea0c3fa37d7b3a141e88b6f41ddd8eacb68507',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_review_global_lock',
      prorows: 0,
      pronargs: 0,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: null,
      proargtypes: [],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.assert_manual_review_lifecycle_lock(text)',
    prosrcSha256: '61b1e390437aac9946ac4c095aa6ff75bc6fc7b992e09bb600994efe11d7aae7',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_review_lifecycle_lock',
      prorows: 0,
      pronargs: 1,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: ['tenant'],
      proargtypes: ['25'],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
];
function freezeValue(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
}
freezeValue(guardPins);
// The gallery pin modules (lane hand-off) and these pins must agree on body and definer.
for (const pin of [
  ...galleryNavigationFunctionPinsV1,
  ...galleryRenditionFunctionPinsV1,
  ...galleryRestoreSuppressionFunctionPinsV1,
]) {
  const own = currentRuntimeV11FunctionPins.find((p) => p.signature === pin.signature);
  if (
    !own ||
    own.prosrcSha256 !== pin.prosrcSha256 ||
    own.securityDefiner !== pin.securityDefiner ||
    own.access !==
      ((galleryNavigationRuntimeFunctionsV1 as readonly string[]).includes(pin.signature) ||
      (galleryRenditionApiFunctionsV1 as readonly string[]).includes(pin.signature)
        ? 'runtime'
        : (galleryRenditionWorkerFunctionsV1 as readonly string[]).includes(pin.signature)
          ? 'worker'
          : 'owner')
  )
    throw new Error('CURRENT_RUNTIME_V11_COMPILED_PINS_INVALID');
}

export class CurrentRuntimeInstallationV11Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V11_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V11_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V11_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER'
      | 'CURRENT_RUNTIME_V11_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V11_TRANSACTION_REQUIRED'
      | 'CURRENT_RUNTIME_V11_FUNCTION_DRIFT'
      | 'CURRENT_RUNTIME_V11_TRIGGER_DRIFT'
      | 'CURRENT_RUNTIME_V11_STRUCTURE_DRIFT'
      | 'CURRENT_RUNTIME_V11_METADATA_CHANGED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV11Error['code']): never {
  throw new CurrentRuntimeInstallationV11Error(code);
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
const parentEncoding = JSON.stringify({
  encoding: 'current-runtime-profile-v10-parent-manifest-v1',
  profileVersion: 10,
  baselineSchemaVersion: 107,
  runtimeStep: 26,
  members: currentRuntimeV11ParentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function sources() {
  if (hash(parentEncoding) !== currentRuntimeV11ParentManifestSha256)
    fail('CURRENT_RUNTIME_V11_PARENT_MISMATCH');
  for (const member of currentRuntimeV11ParentMembers) {
    const body = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(body) !== member.sha256) fail('CURRENT_RUNTIME_V11_PARENT_MISMATCH');
  }
  const result: string[] = [];
  for (const member of currentRuntimeV11ExtensionMembers) {
    const text = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(text) !== member.sha256) fail('CURRENT_RUNTIME_V11_SOURCE_MISMATCH');
    result.push(text);
  }
  return result;
}
function jsonMap(
  members: readonly { extensionStep: number; filename: string; sha256: string }[],
  field: 'filename' | 'sha256',
) {
  // Canonical PostgreSQL jsonb text for a fixed small key/string map.
  return (
    '{' +
    members
      .map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + JSON.stringify(m[field]))
      .join(', ') +
    '}'
  );
}
function ddlMap(members: readonly { extensionStep: number; sourceDdlId: number }[]) {
  return (
    '{' +
    members.map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + m.sourceDdlId).join(', ') +
    '}'
  );
}
type Check = readonly [name: string, expression: string];
function constraintsOf(table: string, checks: readonly Check[]) {
  return [
    ...checks.map(([name, expression]) => ({
      name,
      kind: 'c',
      definition: `CHECK ((${expression}))`,
      validated: true,
      deferrable: false,
      deferred: false,
    })),
    {
      name: `${table}_pkey`,
      kind: 'p',
      definition: 'PRIMARY KEY (extension_step)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
    {
      name: `${table}_source_ddl_id_key`,
      kind: 'u',
      definition: 'UNIQUE (source_ddl_id)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
    {
      name: `${table}_filename_key`,
      kind: 'u',
      definition: 'UNIQUE (filename)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const checks = [
  ['profile_extension_v11_step', 'extension_step = ANY (ARRAY[1, 2, 3, 4, 5])'],
  [
    'profile_extension_v11_ddl',
    `source_ddl_id = ((${literal(ddlMap(currentRuntimeV11ExtensionMembers))}::jsonb ->> (extension_step)::text))::integer`,
  ],
  [
    'profile_extension_v11_filename',
    `filename = (${literal(jsonMap(currentRuntimeV11ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v11_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV11ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v11_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV11ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v11 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v11_step CHECK(${checks[0][1]}),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v11_ddl CHECK(${checks[1][1]}),
 filename text NOT NULL CONSTRAINT profile_extension_v11_filename CHECK(${checks[2][1]}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v11_source CHECK(${checks[3][1]}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v11_parent CHECK(${checks[4][1]}),
 CONSTRAINT profile_extension_v11_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v11_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v11_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v11 FROM PUBLIC;`;
const expectedConstraints = constraintsOf('profile_extension_v11', checks);
// Copies of V10's parent V8/V9 receipt checks and V10's own receipt check (all frozen).
const v8Checks = [
  ['profile_extension_v8_step', 'extension_step = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7, 8])'],
  ['profile_extension_v8_ddl', 'source_ddl_id = (133 + extension_step)'],
  [
    'profile_extension_v8_filename',
    `filename = (${literal(jsonMap(currentRuntimeV8ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV8ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV8ParentManifestSha256)}::text`,
  ],
] as const;
const v8Constraints = constraintsOf('profile_extension_v8', v8Checks);
const v9Checks = [
  ['profile_extension_v9_step', 'extension_step = 1'],
  ['profile_extension_v9_ddl', 'source_ddl_id = 142'],
  [
    'profile_extension_v9_filename',
    `filename = (${literal(jsonMap(currentRuntimeV9ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV9ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV9ParentManifestSha256)}::text`,
  ],
] as const;
const v9Constraints = constraintsOf('profile_extension_v9', v9Checks);
const v10Checks = [
  ['profile_extension_v10_step', 'extension_step = 1'],
  ['profile_extension_v10_ddl', 'source_ddl_id = 146'],
  [
    'profile_extension_v10_filename',
    `filename = (${literal(jsonMap(currentRuntimeV10ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v10_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV10ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v10_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV10ParentManifestSha256)}::text`,
  ],
] as const;
const v10Constraints = constraintsOf('profile_extension_v10', v10Checks);
const catalogSchema = z.strictObject({
  owner: z.literal(true),
  private: z.literal(true),
  columns: z.literal(true),
  constraints: z.literal(true),
  shape: z.literal(true),
});
// Finite module-owned ledger names only; never derived from caller JSON/catalog.
type LedgerName =
  | 'profile_extension_v8'
  | 'profile_extension_v9'
  | 'profile_extension_v10'
  | 'profile_extension_v11';
function catalogSql(table: LedgerName) {
  return `SELECT current_user=session_user AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND n.nspowner=c.relowner AS owner,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee<>c.relowner) AS private,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0)
 ='[["extension_step","integer",true],["source_ddl_id","integer",true],["filename","text",true],["source_sha256","text",true],["parent_manifest_sha256","text",true]]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND (a.attisdropped OR a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS columns,
 (SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid)=$1::jsonb AS constraints,
 c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition
 AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indisunique OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u')))) AS shape
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relname='${table}'`;
}
async function ledgerReceipts<T>(
  tx: CurrentRuntimeInstallationTransaction,
  table: LedgerName,
  constraints: readonly unknown[],
  roster: z.ZodType<T>,
  expected: readonly unknown[],
): Promise<T> {
  const c = await tx.query(catalogSql(table), [JSON.stringify(constraints)]);
  if (c.rows.length !== 1 || !catalogSchema.safeParse(c.rows[0]).success)
    fail('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  const rows = await tx.query(
    `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.${table} ORDER BY extension_step`,
  );
  const parsed = roster.safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  if (JSON.stringify(parsed.data) !== JSON.stringify(expected))
    fail('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  return parsed.data;
}
function receiptRoster(
  steps: number,
  ddl: readonly number[],
  parentManifestSha256: string,
): z.ZodType<
  {
    extensionStep: number;
    sourceDdlId: number;
    filename: string;
    sha256: string;
    parentManifestSha256: string;
  }[]
> {
  return z
    .array(
      z.strictObject({
        extensionStep: z.number().int().min(1).max(steps),
        sourceDdlId: z
          .number()
          .int()
          .refine((v) => ddl.includes(v)),
        filename: z.string().min(1).max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        parentManifestSha256: z.literal(parentManifestSha256),
      }),
    )
    .length(steps);
}
const receiptRosterSchema = receiptRoster(
  5,
  [143, 144, 145, 147, 148],
  currentRuntimeV11ParentManifestSha256,
);
async function receipts(tx: CurrentRuntimeInstallationTransaction) {
  return ledgerReceipts(
    tx,
    'profile_extension_v11',
    expectedConstraints,
    receiptRosterSchema,
    currentRuntimeV11ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV11ParentManifestSha256,
    })),
  );
}
const stateSchema = z.strictObject({
  ledger: z.boolean(),
  staged: z.boolean(),
  knownLedgers: z.literal(true),
  legacy: z.boolean(),
});
export const currentRuntimeV11KnownLedgers = Object.freeze([
  ...currentRuntimeV10KnownLedgers,
  'profile_extension_v11',
] as const);
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v11') IS NOT NULL AS ledger,
 (EXISTS(SELECT 1 FROM unnest($1::text[]) r(name) WHERE to_regclass('public.'||r.name) IS NOT NULL)
  OR EXISTS(SELECT 1 FROM unnest($2::text[]) f(signature) WHERE to_regprocedure(f.signature) IS NOT NULL)
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.gallery_media_item') AND t.tgname=ANY($3::text[]))
  OR to_regclass('public.restore_suppression_event_gallery_album_once') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.restore_processing_admission') AND a.attnum>0
    AND a.attname IN ('admitted_artifact_sha256','admitted_head_sha256','admitted_postconditions_sha256'))
  OR EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('public.restore_processing_admission')
    AND k.conname='restore_processing_admitted_shape')) AS staged,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relkind IN ('r','p','v','m','f','S') AND c.relname<>ALL($4::text[])) AS "knownLedgers",
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($5::text[])) AS legacy`,
    [
      [...currentRuntimeV11Tables],
      currentRuntimeV11FunctionPins.filter((p) => p.sourceDdlId !== 101).map((p) => p.signature),
      [...stagedParentTriggers],
      [...currentRuntimeV11KnownLedgers],
      [...currentRuntimeV11LegacyLedgerNamespaces],
    ],
  );
  const parsed = stateSchema.safeParse(rows.rows[0]);
  if (rows.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  return parsed.data;
}

// Deparsed catalog text (format_type, pg_get_*def) qualifies names by search_path. Every
// catalog observation below runs with search_path=pg_catalog, pg_temp, set transaction-locally
// and restored; outside a transaction block the setting would not persist, so it is refused.
async function withCatalogPath<T>(
  tx: CurrentRuntimeInstallationTransaction,
  run: () => Promise<T>,
): Promise<T> {
  const prior = await tx.query(
    "SELECT current_setting('search_path') AS path, set_config('search_path','pg_catalog, pg_temp',true) AS applied",
  );
  const path = prior.rows[0]?.['path'];
  if (prior.rows.length !== 1 || typeof path !== 'string' || path.length > 4096)
    fail('CURRENT_RUNTIME_V11_TRANSACTION_REQUIRED');
  const active = await tx.query("SELECT current_setting('search_path') AS path");
  if (active.rows[0]?.['path'] !== 'pg_catalog, pg_temp')
    fail('CURRENT_RUNTIME_V11_TRANSACTION_REQUIRED');
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await tx.query("SELECT set_config('search_path',$1,true)", [path]).catch(() => undefined);
    throw error;
  }
  await tx.query("SELECT set_config('search_path',$1,true)", [path]);
  return result;
}

const aclText = (acl: string, owner: string) =>
  `coalesce((SELECT string_agg(concat_ws(':',CASE WHEN x.grantor=${owner} THEN 'owner' ELSE coalesce(pg_get_userbyid(x.grantor),'?') END,
   CASE WHEN x.grantee=0 THEN 'PUBLIC' WHEN x.grantee=${owner} THEN 'owner' ELSE coalesce(pg_get_userbyid(x.grantee),'?') END,
   x.privilege_type,x.is_grantable::text),',' ORDER BY 1) FROM aclexplode(${acl}) x),'')`;
/**
 * One row per catalog fact of every non-system relation/function/namespace (or of the named
 * relations only): owner, kind, name and the sha256 of a search-path-pinned, OID-free detail.
 * Internal (RI) triggers are named by their constraint, function and tgtype.
 */
const catalogLinesSql = `WITH rel AS (
 SELECT c.oid,c.relowner,format('%I.%I',n.nspname,c.relname) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
  AND ($1::text[] IS NULL OR format('%I.%I',n.nspname,c.relname)=ANY($1::text[]))
), fn AS (
 SELECT p.oid,p.proowner,format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE $1::text[] IS NULL AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
), line AS (
 SELECT r.owner::text AS owner,'relation'::text AS kind,''::text AS name,concat_ws('|',c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
  coalesce(c.reloptions::text,''),CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) ELSE '' END,
  (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))::text)::text AS detail FROM rel r JOIN pg_class c ON c.oid=r.oid
 UNION ALL SELECT r.owner,'acl','',${aclText(`coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))`, 'c.relowner')} FROM rel r JOIN pg_class c ON c.oid=r.oid
 UNION ALL SELECT r.owner,'column',a.attname::text,concat_ws('|',a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),
  a.attidentity,a.attgenerated,a.attisdropped,coalesce((SELECT format('%I.%I',cn.nspname,co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation),''))
  FROM rel r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 UNION ALL SELECT r.owner,'column_acl',a.attname::text,${aclText('a.attacl', 'r.relowner')} FROM rel r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 WHERE a.attacl IS NOT NULL
 UNION ALL SELECT r.owner,'constraint',k.conname::text,concat_ws('|',k.contype,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal)
  FROM rel r JOIN pg_constraint k ON k.conrelid=r.oid
 UNION ALL SELECT r.owner,'index',ic.relname::text,concat_ws('|',pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisreplident)
  FROM rel r JOIN pg_index i ON i.indrelid=r.oid JOIN pg_class ic ON ic.oid=i.indexrelid
 UNION ALL SELECT r.owner,'trigger',CASE WHEN t.tgisinternal THEN concat_ws(':','internal',k.conname,format('%I.%I',tn.nspname,tp.proname),t.tgtype) ELSE t.tgname::text END,
  concat_ws('|',format('%I.%I(%s)',tn.nspname,tp.proname,oidvectortypes(tp.proargtypes)),t.tgtype,t.tgenabled,t.tgisinternal,
   coalesce((SELECT string_agg(ta.attname,',' ORDER BY u.o) FROM unnest(t.tgattr::int2[]) WITH ORDINALITY u(n,o) JOIN pg_attribute ta ON ta.attrelid=t.tgrelid AND ta.attnum=u.n),''),
   t.tgqual IS NOT NULL,t.tgnargs,encode(t.tgargs,'hex'),t.tgdeferrable,t.tginitdeferred,t.tgparentid<>0,coalesce(k.conname,''),
   coalesce((SELECT format('%I.%I',cn.nspname,cc.relname) FROM pg_class cc JOIN pg_namespace cn ON cn.oid=cc.relnamespace WHERE cc.oid=t.tgconstrrelid),''),
   t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL,CASE WHEN t.tgisinternal THEN '' ELSE pg_get_triggerdef(t.oid) END)
  FROM rel r JOIN pg_trigger t ON t.tgrelid=r.oid JOIN pg_proc tp ON tp.oid=t.tgfoid JOIN pg_namespace tn ON tn.oid=tp.pronamespace LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint
 UNION ALL SELECT r.owner,'policy',po.polname::text,concat_ws('|',po.polcmd,po.polpermissive,
   (SELECT string_agg(CASE WHEN g=0 THEN 'PUBLIC' WHEN g=r.relowner THEN 'owner' ELSE coalesce(pg_get_userbyid(g),'?') END,',' ORDER BY 1) FROM unnest(po.polroles) g),
   coalesce(pg_get_expr(po.polqual,po.polrelid),''),coalesce(pg_get_expr(po.polwithcheck,po.polrelid),''))
  FROM rel r JOIN pg_policy po ON po.polrelid=r.oid
 UNION ALL SELECT r.owner,'rule',ru.rulename::text,pg_get_ruledef(ru.oid) FROM rel r JOIN pg_rewrite ru ON ru.ev_class=r.oid WHERE ru.rulename<>'_RETURN'
 UNION ALL SELECT f.owner,'function','',concat_ws('|',l.lanname,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),
   ((to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc','proargtypes','prorettype','proallargtypes'])
    ||jsonb_build_object('returns',format_type(p.prorettype,NULL),
     'argtypes',coalesce((SELECT jsonb_agg(format_type(u.t,NULL) ORDER BY u.o) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(t,o)),'[]'::jsonb),
     'allargtypes',(SELECT jsonb_agg(format_type(u.t,NULL) ORDER BY u.o) FROM unnest(p.proallargtypes) WITH ORDINALITY u(t,o))))::text,
   (p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))::text)
  FROM fn f JOIN pg_proc p ON p.oid=f.oid JOIN pg_language l ON l.oid=p.prolang
 UNION ALL SELECT f.owner,'acl','',${aclText("coalesce(p.proacl,acldefault('f',p.proowner))", 'p.proowner')} FROM fn f JOIN pg_proc p ON p.oid=f.oid
 UNION ALL SELECT format('%I',n.nspname),'namespace','',concat_ws('|',(n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))::text,
   ${aclText("coalesce(n.nspacl,acldefault('n',n.nspowner))", 'n.nspowner')})
  FROM pg_namespace n WHERE $1::text[] IS NULL AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
)
SELECT owner,kind,name,encode(sha256(convert_to(detail,'UTF8')),'hex') AS "detailSha256" FROM line
ORDER BY 1,2,3,4`;
const lineSchema = z.strictObject({
  owner: z.string().min(1).max(600),
  kind: z.enum([
    'relation',
    'acl',
    'column',
    'column_acl',
    'constraint',
    'index',
    'trigger',
    'policy',
    'rule',
    'function',
    'namespace',
  ]),
  name: z.string().max(400),
  detailSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CurrentRuntimeV11CatalogLine = z.infer<typeof lineSchema>;
/** Owner observation (search_path pinned) of the catalog lines of every non-system object,
 * or of the named relations only (`schema.relation`, quoted as format('%I.%I')). */
export async function captureCurrentRuntimeV11CatalogLinesIn(
  tx: CurrentRuntimeInstallationTransaction,
  relations: readonly string[] | null = null,
): Promise<readonly CurrentRuntimeV11CatalogLine[]> {
  return withCatalogPath(tx, async () => {
    const rows = await tx.query(catalogLinesSql, [relations === null ? null : [...relations]]);
    const parsed = z.array(lineSchema).max(200000).safeParse(rows.rows);
    if (!parsed.success) fail('CURRENT_RUNTIME_V11_STRUCTURE_DRIFT');
    return parsed.data;
  });
}
const lineKey = (l: { owner: string; kind: string; name: string; detailSha256: string }) =>
  `${l.owner}\u0000${l.kind}\u0000${l.name}\u0000${l.detailSha256}`;
/** Structure digest of one owner: sorted kind|name|detail lines, ACL lines excluded. */
export function currentRuntimeV11StructureDigest(
  lines: readonly CurrentRuntimeV11CatalogLine[],
  owner: string,
) {
  const own = lines
    .filter((l) => l.owner === owner && l.kind !== 'acl' && l.kind !== 'column_acl')
    .map((l) => `${l.kind}|${l.name}|${l.detailSha256}`)
    .sort();
  return {
    lines: own.length,
    sha256: hash(`wm-current-runtime-v11-structure\n${own.join('\n')}`),
  };
}
/** Pure diff of two whole-catalog observations taken before and after the members ran. */
export function currentRuntimeV11CatalogDelta(
  before: readonly CurrentRuntimeV11CatalogLine[],
  after: readonly CurrentRuntimeV11CatalogLine[],
) {
  const parents = new Set(before.map((l) => l.owner));
  const beforeKeys = new Set(before.map(lineKey));
  const afterKeys = new Set(after.map(lineKey));
  const order = (a: CurrentRuntimeV11CatalogLine, b: CurrentRuntimeV11CatalogLine) => {
    const x = lineKey(a),
      y = lineKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return {
    removed: before.filter((l) => !afterKeys.has(lineKey(l))).sort(order),
    added: after.filter((l) => parents.has(l.owner) && !beforeKeys.has(lineKey(l))).sort(order),
    newOwners: [...new Set(after.filter((l) => !parents.has(l.owner)).map((l) => l.owner))].sort(),
  };
}

const functionRow = z.strictObject({
  signature: z.string().max(250),
  owner: z.literal(true),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataMatches: z.literal(true),
  safeAcl: z.literal(true),
  namespace: z.literal(true),
});
const v11FunctionRow = z.strictObject({
  signature: z.string().max(250),
  owner: z.literal(true),
  namespace: z.literal(true),
  language: z.enum(['plpgsql', 'sql']),
  returns: z.string().max(200),
  securityDefiner: z.boolean(),
  volatility: z.enum(['i', 's', 'v']),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pinnedSearchPath: z.literal(true),
  safeAcl: z.literal(true),
});
const triggerRow = z.strictObject({
  count: z.literal(1),
  functionUses: z.literal(1),
  exact: z.literal(true),
});
const v11TriggerRow = z.strictObject({
  table: z.string().max(200),
  trigger: z.string().max(200),
  function: z.string().max(250),
  tgtype: z.number().int(),
  columns: z.string().max(2000),
  constraint: z.boolean(),
  deferrable: z.boolean(),
  initiallyDeferred: z.boolean(),
  when: z.boolean(),
  exact: z.literal(true),
});
const tableRow = z.strictObject({
  table: z.string().max(200),
  forced: z.literal(true),
  safeAcl: z.literal(true),
});
// Normalized pg_proc row: OID-free (format_type names, search_path pinned) and without the
// owner, ACL and body, which are checked separately.
const metadataSql = `encode(sha256(convert_to(((to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc','proargtypes','prorettype','proallargtypes'])
 ||jsonb_build_object('returns',format_type(p.prorettype,NULL),
  'argtypes',coalesce((SELECT jsonb_agg(format_type(u.t,NULL) ORDER BY u.o) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(t,o)),'[]'::jsonb),
  'allargtypes',(SELECT jsonb_agg(format_type(u.t,NULL) ORDER BY u.o) FROM unnest(p.proallargtypes) WITH ORDINALITY u(t,o))))::text,'UTF8')),'hex')`;
async function verifyV10Functions(tx: CurrentRuntimeInstallationTransaction) {
  const pins = [...currentRuntimeV10FunctionPins, ...guardPins];
  const rows = await tx.query(
    `SELECT pin.value->>'signature' AS signature,
 current_user=session_user AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner,
 CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END AS "bodySha256",
 (to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc'])=pin.value->'metadata'
 AND l.lanname=pin.value->>'language' AS "metadataMatches",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR pin.value->>'runtimeDirect'<>'true')) AS "safeAcl",
 n.nspname=split_part(pin.value->>'signature','.',1) AND (n.nspname='public' OR n.nspowner=p.proowner) AS namespace
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY pin(value,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(pin.value->>'signature') JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY pin.ordinal`,
    [JSON.stringify(pins)],
  );
  const parsed = z.array(functionRow).length(31).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const pin = pins[i];
    if (!pin || row.signature !== pin.signature || row.bodySha256 !== pin.prosrcSha256)
      fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
  }
  const shape = await tx.query(`SELECT count(*)::int AS count,
 coalesce(bool_and(n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)),false) AS private FROM pg_namespace n JOIN pg_proc p ON p.pronamespace=n.oid WHERE n.nspname='wm_manual_pooled'`);
  if (
    shape.rows.length !== 1 ||
    shape.rows[0]?.['count'] !== 13 ||
    shape.rows[0]?.['private'] !== true
  )
    fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
  // V10's exact 146 trigger pin: one enabled ROW BEFORE UPDATE OF values_json trigger.
  const trigger = await tx.query(
    `SELECT (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.race_event') AND t.tgname=$2) AS count,
 (SELECT count(*)::int FROM pg_trigger t WHERE t.tgfoid=to_regprocedure($1)) AS "functionUses",
 coalesce((SELECT t.tgfoid=to_regprocedure($1) AND t.tgtype=19 AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
   AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgparentid=0
   AND t.tgattr::text=(SELECT a.attnum::text FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attname='values_json' AND NOT a.attisdropped)
   FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.race_event') AND t.tgname=$2),false) AS exact`,
    [currentRuntimeV10GuardFunctionSignature, currentRuntimeV10GuardTriggerName],
  );
  if (trigger.rows.length !== 1 || !triggerRow.safeParse(trigger.rows[0]).success)
    fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
}
async function verifyV11Functions(tx: CurrentRuntimeInstallationTransaction) {
  const pins = currentRuntimeV11FunctionPins;
  const rows = await tx.query(
    `SELECT pin.value->>'signature' AS signature,
 current_user=session_user AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner,
 n.nspname='public' AND p.oid=to_regprocedure(pin.value->>'signature') AS namespace,
 l.lanname AS language,format_type(p.prorettype,NULL) AS returns,p.prosecdef AS "securityDefiner",p.provolatile AS volatility,
 CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END AS "bodySha256",
 ${metadataSql} AS "metadataSha256",
 coalesce(p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'],false) AS "pinnedSearchPath",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
   AND (a.grantee=0 OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR pin.value->>'access'='owner'
    OR (pin.value->>'access'='worker' AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=$2))
    OR (pin.value->>'access'<>'worker' AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3)))
    OR (pin.value->>'access'='worker' AND EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.roleid=a.grantee)))) AS "safeAcl"
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY pin(value,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(pin.value->>'signature')
 JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY pin.ordinal`,
    [
      JSON.stringify(pins),
      currentRuntimeV11GalleryWorkerRoleName,
      currentRuntimeV11AiDispatcherRoleName,
    ],
  );
  const parsed = z.array(v11FunctionRow).length(pins.length).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const pin = pins[i];
    if (
      !pin ||
      row.signature !== pin.signature ||
      row.language !== pin.language ||
      row.returns !== pin.returns ||
      row.securityDefiner !== pin.securityDefiner ||
      row.volatility !== pin.volatility ||
      row.bodySha256 !== pin.prosrcSha256 ||
      row.metadataSha256 !== pin.metadataSha256
    )
      fail('CURRENT_RUNTIME_V11_FUNCTION_DRIFT');
  }
}
const triggerObservationSql = `SELECT c.relname AS table,t.tgname AS trigger,format('%I.%I(%s)',tn.nspname,tp.proname,oidvectortypes(tp.proargtypes)) AS function,
 t.tgtype::int AS tgtype,
 coalesce((SELECT string_agg(ta.attname,',' ORDER BY u.o) FROM unnest(t.tgattr::int2[]) WITH ORDINALITY u(n,o) JOIN pg_attribute ta ON ta.attrelid=t.tgrelid AND ta.attnum=u.n),'') AS columns,
 t.tgconstraint<>0 AS constraint,t.tgdeferrable AS deferrable,t.tginitdeferred AS "initiallyDeferred",
 t.tgqual IS NOT NULL AS when,t.tgenabled='O' AND t.tgnargs=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgparentid=0 AS exact
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace
 JOIN pg_proc tp ON tp.oid=t.tgfoid JOIN pg_namespace tn ON tn.oid=tp.pronamespace
 WHERE NOT t.tgisinternal AND cn.nspname='public' AND (c.relname=ANY($1::text[])
  OR t.tgfoid IN (SELECT to_regprocedure(s) FROM unnest($2::text[]) s)
  OR (c.relname,t.tgname) IN (SELECT * FROM unnest($3::text[],$4::text[])))
 ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`;
async function verifyV11Triggers(tx: CurrentRuntimeInstallationTransaction) {
  const pins = currentRuntimeV11TriggerPins;
  const rows = await tx.query(triggerObservationSql, [
    [...currentRuntimeV11Tables],
    currentRuntimeV11FunctionPins.map((p) => p.signature),
    pins.map((p) => p.table),
    pins.map((p) => p.trigger),
  ]);
  const parsed = z.array(v11TriggerRow).length(pins.length).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V11_TRIGGER_DRIFT');
  const expected = [...pins].sort((a, b) =>
    a.table === b.table ? (a.trigger < b.trigger ? -1 : 1) : a.table < b.table ? -1 : 1,
  );
  for (const [i, row] of parsed.data.entries()) {
    const pin = expected[i];
    if (
      !pin ||
      row.table !== pin.table ||
      row.trigger !== pin.trigger ||
      row.function !== pin.function ||
      row.tgtype !== pin.tgtype ||
      row.columns !== pin.columns ||
      row.constraint !== pin.constraint ||
      row.deferrable !== pin.deferrable ||
      row.initiallyDeferred !== pin.initiallyDeferred ||
      row.when !== pin.when
    )
      fail('CURRENT_RUNTIME_V11_TRIGGER_DRIFT');
  }
}
async function verifyV11Structure(tx: CurrentRuntimeInstallationTransaction) {
  const tables = await tx.query(
    `SELECT t.name AS table,coalesce(c.relrowsecurity AND c.relforcerowsecurity AND c.relkind='r' AND c.relpersistence='p',false) AS forced,
 coalesce(NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner
   AND (a.grantee=0 OR a.is_grantable
    OR a.privilege_type NOT IN (SELECT jsonb_array_elements_text(coalesce($2::jsonb->t.name,'[]'::jsonb)))
    OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname=$3)
    OR (a.grantee IN (SELECT oid FROM pg_roles WHERE rolname=$4)
     AND a.privilege_type NOT IN (SELECT jsonb_array_elements_text(coalesce($6::jsonb->t.name,'[]'::jsonb))))
    OR (a.privilege_type IN (SELECT jsonb_array_elements_text(coalesce($5::jsonb->t.name,'[]'::jsonb)))
     AND (a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=$4)
      OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.roleid=a.grantee)))))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL),false) AS "safeAcl"
 FROM unnest($1::text[]) WITH ORDINALITY t(name,ordinal) LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||t.name) ORDER BY t.ordinal`,
    [
      [...currentRuntimeV11Tables],
      JSON.stringify(currentRuntimeV11TableDelegations),
      currentRuntimeV11GalleryWorkerRoleName,
      currentRuntimeV11AiDispatcherRoleName,
      JSON.stringify(currentRuntimeV11DispatcherOnlyTablePrivileges),
      JSON.stringify(currentRuntimeV11DispatcherTableAllowance),
    ],
  );
  if (!z.array(tableRow).length(currentRuntimeV11Tables.length).safeParse(tables.rows).success)
    fail('CURRENT_RUNTIME_V11_STRUCTURE_DRIFT');
  const owners = currentRuntimeV11StructurePins.map((p) => p.relation);
  const lines = await captureCurrentRuntimeV11CatalogLinesIn(tx, owners);
  for (const pin of currentRuntimeV11StructurePins) {
    const digest = currentRuntimeV11StructureDigest(lines, pin.relation);
    if (digest.lines !== pin.lines || digest.sha256 !== pin.sha256)
      fail('CURRENT_RUNTIME_V11_STRUCTURE_DRIFT');
  }
}
// Re-implements V10's chain checks (verifyV7 + V8/V9/V10 receipts + V10 pins) without
// calling verifyCurrentRuntimeV10InstalledIn, which refuses the v11 ledger.
async function parent(tx: CurrentRuntimeInstallationTransaction) {
  const found = await verifyCurrentRuntimeV7InstalledIn(tx);
  const actual = [
    ...found.parentAppliedMembers,
    {
      step: 23,
      sourceDdlId: found.extensionReceipt.sourceDdlId,
      filename: found.extensionReceipt.filename,
      sha256: found.extensionReceipt.sha256,
    },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(currentRuntimeV8ParentMembers))
    fail('CURRENT_RUNTIME_V11_PARENT_MISMATCH');
  const v8 = await ledgerReceipts(
    tx,
    'profile_extension_v8',
    v8Constraints,
    receiptRoster(
      8,
      [134, 135, 136, 137, 138, 139, 140, 141],
      currentRuntimeV8ParentManifestSha256,
    ),
    currentRuntimeV8ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV8ParentManifestSha256,
    })),
  );
  const v9 = await ledgerReceipts(
    tx,
    'profile_extension_v9',
    v9Constraints,
    receiptRoster(1, [142], currentRuntimeV9ParentManifestSha256),
    currentRuntimeV9ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV9ParentManifestSha256,
    })),
  );
  const v10 = await ledgerReceipts(
    tx,
    'profile_extension_v10',
    v10Constraints,
    receiptRoster(1, [146], currentRuntimeV10ParentManifestSha256),
    currentRuntimeV10ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV10ParentManifestSha256,
    })),
  );
  const chain = [
    ...v8.map((m) => ({ step: 23 + m.extensionStep, ...m })),
    ...v9.map((m) => ({ step: 31 + m.extensionStep, ...m })),
    ...v10.map((m) => ({ step: 32 + m.extensionStep, ...m })),
  ].map((m) => ({
    step: m.step,
    sourceDdlId: m.sourceDdlId,
    filename: m.filename,
    sha256: m.sha256,
  }));
  if (JSON.stringify(chain) !== JSON.stringify(currentRuntimeV11ParentMembers.slice(23)))
    fail('CURRENT_RUNTIME_V11_PARENT_MISMATCH');
  await verifyV10Functions(tx);
}
// Parent V7 RPC + V10 function fingerprints (60), ledgers migration and v2..v10 rows+xmin,
// and schema_migrations are compared across installation, as V10 does.
const prefixSignatures = Object.freeze(
  [...currentRuntimeV7RpcSourcePins, ...currentRuntimeV10FunctionPins].map((p) => p.signature),
);
const prefixFunctionsSchema = z
  .array(
    z.strictObject({
      signature: z.string().max(250),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .length(60);
const fingerprintSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
async function prefix(tx: CurrentRuntimeInstallationTransaction) {
  const functions = await tx.query(
    `SELECT requested.signature,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint FROM unnest($1::text[]) WITH ORDINALITY requested(signature,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature) ORDER BY requested.ordinal`,
    [[...prefixSignatures]],
  );
  const parsed = prefixFunctionsSchema.safeParse(functions.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
  for (const [i, row] of parsed.data.entries())
    if (row.signature !== prefixSignatures[i]) fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
  const ledger = [];
  for (const name of currentRuntimeV11KnownLedgers.slice(0, 10)) {
    // Finite module-owned identifier only; never derived from caller JSON/catalog.
    const found = await tx.query(
      `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM wm_runtime_installation.${name} t`,
    );
    const stamp = fingerprintSchema.safeParse(found.rows[0]);
    if (found.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
    ledger.push({ name, ...stamp.data });
  }
  const baseline = await tx.query(
    `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY version),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM public.schema_migrations t`,
  );
  const stamp = fingerprintSchema.safeParse(baseline.rows[0]);
  if (baseline.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
  return { functions: parsed.data, ledger, baseline: stamp.data };
}
/** The whole-catalog change of the members must be exactly the pinned parent change plus
 * the pinned new tables, the v11 ledger and the pinned new functions. */
async function checkDelta(
  tx: CurrentRuntimeInstallationTransaction,
  before: readonly CurrentRuntimeV11CatalogLine[],
  after: readonly CurrentRuntimeV11CatalogLine[],
) {
  const delta = currentRuntimeV11CatalogDelta(before, after);
  const plain = (l: { owner: string; kind: string; name: string; detailSha256: string }) => ({
    owner: l.owner,
    kind: l.kind,
    name: l.name,
    detailSha256: l.detailSha256,
  });
  if (
    JSON.stringify(delta.removed.map(plain)) !==
      JSON.stringify(currentRuntimeV11ParentChange.removed) ||
    JSON.stringify(delta.added.map(plain)) !== JSON.stringify(currentRuntimeV11ParentChange.added)
  )
    fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
  const owners = await withCatalogPath(tx, () =>
    tx.query(
      `SELECT format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) AS owner FROM unnest($1::text[]) s
       JOIN pg_proc p ON p.oid=to_regprocedure(s) JOIN pg_namespace n ON n.oid=p.pronamespace`,
      [currentRuntimeV11FunctionPins.filter((p) => p.sourceDdlId !== 101).map((p) => p.signature)],
    ),
  );
  const expected = [
    ...currentRuntimeV11Tables.map((t) => `public.${t}`),
    'wm_runtime_installation.profile_extension_v11',
    ...owners.rows.map((r) => String(r['owner'])),
  ].sort();
  if (JSON.stringify(delta.newOwners) !== JSON.stringify(expected))
    fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
}
function result(extensionReceipts: z.infer<typeof receiptRosterSchema>) {
  return {
    profileVersion: 11 as const,
    parentProfileVersion: 10 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 26 as const,
    extensionSteps: 5 as const,
    runtimeStep: 27 as const,
    sourceDdlTip: 148 as const,
    parentManifestSha256: currentRuntimeV11ParentManifestSha256,
    parentAppliedMembers: currentRuntimeV11ParentMembers,
    extensionMembers: currentRuntimeV11ExtensionMembers,
    extensionReceipts,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
export type CurrentRuntimeV11Installation = ReturnType<typeof result>;
/** Read-only owner verification of the exact physical11/runtime27 receipts, the V10 chain and
 * pins, the 70 V11 function pins, the V11 trigger pins and the V11 structure digests.
 * Caller owns BEGIN/ROLLBACK (catalog text is read under a transaction-local search_path). */
export async function verifyCurrentRuntimeV11InstalledIn(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<CurrentRuntimeV11Installation> {
  await sources();
  await parent(tx);
  const p = await presence(tx);
  if (p.legacy) fail('CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER');
  if (!p.ledger || !p.staged) fail('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  const r = await receipts(tx);
  await withCatalogPath(tx, async () => {
    await verifyV11Functions(tx);
    await verifyV11Triggers(tx);
  });
  await verifyV11Structure(tx);
  return result(r);
}
/** Same-transaction install: fresh normal107 installs the whole V10 chain first; a committed
 * profile26 only receives 143, 144, 145, 147, 148 and their receipts. Caller owns BEGIN/COMMIT. */
export async function installCurrentRuntimeV11In(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<CurrentRuntimeV11Installation> {
  const texts = await sources();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const p = await presence(tx);
  if (p.legacy) fail('CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER');
  if (p.ledger) return verifyCurrentRuntimeV11InstalledIn(tx);
  if (p.staged) fail('CURRENT_RUNTIME_V11_UNREGISTERED_STAGE');
  await installCurrentRuntimeV10In(tx);
  await parent(tx);
  const before = await prefix(tx);
  const catalogBefore = await captureCurrentRuntimeV11CatalogLinesIn(tx);
  await tx.query(bootstrap);
  for (const [i, text] of texts.entries()) {
    const member = currentRuntimeV11ExtensionMembers[i];
    if (!member) fail('CURRENT_RUNTIME_V11_SOURCE_MISMATCH');
    await tx.query(text);
    await tx.query(
      'INSERT INTO wm_runtime_installation.profile_extension_v11(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES($1,$2,$3,$4,$5)',
      [
        member.extensionStep,
        member.sourceDdlId,
        member.filename,
        member.sha256,
        currentRuntimeV11ParentManifestSha256,
      ],
    );
  }
  if (JSON.stringify(await prefix(tx)) !== JSON.stringify(before))
    fail('CURRENT_RUNTIME_V11_METADATA_CHANGED');
  await checkDelta(tx, catalogBefore, await captureCurrentRuntimeV11CatalogLinesIn(tx));
  return verifyCurrentRuntimeV11InstalledIn(tx);
}
export async function installCurrentRuntimeV11(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    query_timeout: 65000,
  });
  try {
    const tx = await pool.connect();
    let discard = false;
    try {
      await tx.query('BEGIN');
      const r = await installCurrentRuntimeV11In(tx);
      await tx.query('COMMIT');
      return r;
    } catch (e) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      tx.release(discard);
    }
  } finally {
    await pool.end();
  }
}
