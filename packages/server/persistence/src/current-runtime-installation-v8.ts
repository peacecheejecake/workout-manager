import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  type CurrentRuntimeInstallationTransaction,
  currentRuntimeTargetTransforms,
} from './current-runtime-installation.js';
import { currentRuntimeV7RpcSourcePins } from './current-runtime-grants-v7.js';
import {
  installCurrentRuntimeV7In,
  verifyCurrentRuntimeV7InstalledIn,
} from './current-runtime-installation-v7.js';

// Actual Root post141 metadata SHA0d1a47a090572a9da1525ec0e17b52b42a1955d2d0aa4ff247a093a5decf449e.
// Historical end140 source/PG evidence is not final end141 acceptance.
// This is a fixed installation witness, not a processing/restore authority.
export const currentRuntimeV8ParentManifestSha256 =
  'c2ca2ba588f0406813f4cc51934824156da084b6907cf0ce403d24243ddf69fb';
export const currentRuntimeV8ParentMembers = Object.freeze(
  [
    {
      step: 1,
      sourceDdlId: 108,
      filename: '108_nutrition_race_disconnection.sql',
      sha256: 'b71fc7ab7cb863932f1472c28d46200f42f22bc25d8ca198b529b6cc564a20f4',
    },
    {
      step: 2,
      sourceDdlId: 109,
      filename: '109_race_result_proof_lifecycle.sql',
      sha256: 'fd2ecf020660c48d39990acdedc5838651ff873e7970b882814264b58808a9fa',
    },
    {
      step: 3,
      sourceDdlId: 110,
      filename: '110_nutrition_disconnection_lineage.sql',
      sha256: 'd2891aeaeb3af586c42e4e2ee924eb4adc9de0e61af3011219c654a185c91614',
    },
    {
      step: 4,
      sourceDdlId: 111,
      filename: '111_race_result_preserved_proof_updates.sql',
      sha256: '69b7689c8579575eb899d2602e979db697039cb75b8a7b8f71ab54154b0d4576',
    },
    {
      step: 5,
      sourceDdlId: 112,
      filename: '112_training_plan_aggregate_history.sql',
      sha256: '4cff9ecaae439618e3ec2b24de5428fb377f4c8a843df983aba7a765171b3dfb',
    },
    {
      step: 6,
      sourceDdlId: 113,
      filename: '113_race_media_cleanup_source.sql',
      sha256: 'b5e97aeb781d59c7b5fdef60962a6a05aed5f43336ebbc98debff455276e88b9',
    },
    {
      step: 7,
      sourceDdlId: 114,
      filename: '114_manual_review_owned_source_bindings_v2.sql',
      sha256: 'a0673efde1a0d5ae89248438d4a62a68744b0783388c560400ddedc507d2dfdf',
    },
    {
      step: 8,
      sourceDdlId: 115,
      filename: '115_manual_review_full_owned_source_bindings_v2.sql',
      sha256: '5ee731099bf520290aabab179fcb94872b984b515cc2d556fda990eb228841b3',
    },
    {
      step: 9,
      sourceDdlId: 116,
      filename: '116_manual_race_chain_v2.sql',
      sha256: '2d1a9b5f7443de7f8b1d5a37e405d038513f86c39fb9c9d8fb9eb11c17e2c4ea',
    },
    {
      step: 10,
      sourceDdlId: 118,
      filename: '118_race_manual_atomic_approval.sql',
      sha256: '781f329238f379408f33726e6cb5faf55212918bf32fa353841a9bc42684b623',
    },
    {
      step: 11,
      sourceDdlId: 120,
      filename: '120_manual_race_multi_owned_sources.sql',
      sha256: 'f95368d67ce3793561bc09a15e252df7f2eadc78dfde799a35a1cb733e3bac78',
    },
    {
      step: 12,
      sourceDdlId: 121,
      filename: '121_routine_versioned_occurrences.sql',
      sha256: '82eb2b4c597f5e8259de35af6a984b0613f6740e1bb36140673c05c4cae29cd8',
    },
    {
      step: 13,
      sourceDdlId: 122,
      filename: '122_race_manual_public_receipts.sql',
      sha256: '14d85313329b6d0d8ae4e209efc219e45046fb2cd760109841864a72013d9dda',
    },
    {
      step: 14,
      sourceDdlId: 123,
      filename: '123_check_in_template_versions.sql',
      sha256: '6d3ad2f18cb7b1c99d63ccff582214b6ba8f0318a72c1238092140a5ffc9444c',
    },
    {
      step: 15,
      sourceDdlId: 124,
      filename: '124_race_manual_public_preview_source.sql',
      sha256: '6a339bd014f9f9240378202b70907fe28221440ab522281ca725d27d57666955',
    },
    {
      step: 16,
      sourceDdlId: 126,
      filename: '126_manual_race_checklist_uuid_comparison.sql',
      sha256: 'eaf7019d29b27ec2696881e406b22b86bb55bdc8b86d1cc322adb28817bc6b0c',
    },
    {
      step: 17,
      sourceDdlId: 127,
      filename: '127_manual_race_nutrition_resolution_id.sql',
      sha256: 'caff05ddaed839a61a049b0ab72d46b2ee339dacca8b1b91c59ff1acbe0c54b4',
    },
    {
      step: 18,
      sourceDdlId: 128,
      filename: '128_personal_export_retained_runtime.sql',
      sha256: 'dde66cf3882cf0bbdc982dd6fa489f531091caf2941f61be1d73e0e0dbd2962d',
    },
    {
      step: 19,
      sourceDdlId: 129,
      filename: '129_manual_internal_retained_export.sql',
      sha256: '9a8267e4bfc2b9effedddb2dc5c5200a5bea634daf5d86c9bad8c22ab7bfd49a',
    },
    {
      step: 20,
      sourceDdlId: 130,
      filename: '130_retained_source_provenance_export.sql',
      sha256: 'dc3d7e4b5d301c6804561c6f1405eaa37992fad4a46b7ee2b4b7457cbdc083a5',
    },
    {
      step: 21,
      sourceDdlId: 131,
      filename: '131_manual_race_same_tx_parent_ack.sql',
      sha256: '45b65db20f8d2e3c646722bed14962c007c72c7540775828e6d4638299a0fb44',
    },
    {
      step: 22,
      sourceDdlId: 132,
      filename: '132_manual_retained_source_export_batch.sql',
      sha256: '07088ed6119fa52129dd8e4615253e6b00814d5b1d085fc98cc5268fcea9c30c',
    },
    {
      step: 23,
      sourceDdlId: 133,
      filename: '133_nutrition_v4_indexed_application.sql',
      sha256: '44b4705652ed5dd27ad2e414b95a63c1f2ba252569f837ea3951fcaed34a529b',
    },
  ].map((m) => Object.freeze(m)),
);
export const currentRuntimeV8ExtensionMembers = Object.freeze(
  [
    {
      extensionStep: 1,
      sourceDdlId: 134,
      filename: '134_manual_pooled_preparation_resolver.sql',
      sha256: '21d3b99fa3e837e9e3726ae2c9ea9beeb3a00a6c3beb8485b77aa1d4e438f3a0',
    },
    {
      extensionStep: 2,
      sourceDdlId: 135,
      filename: '135_manual_pooled_store_and_basis.sql',
      sha256: '38e669ae98c26b067e670b78318f9053d5707b05cf2a528073bbb6004114a97b',
    },
    {
      extensionStep: 3,
      sourceDdlId: 136,
      filename: '136_manual_pooled_chain_reader_and_ack.sql',
      sha256: '94cd6097e7e304117c45511f4e5eba9f4a3fab1fe763a8e2041af794252c46e3',
    },
    {
      extensionStep: 4,
      sourceDdlId: 137,
      filename: '137_manual_pooled_application.sql',
      sha256: 'a40138f54ab38ad7769952c5501395b7a10f936f7279d58afefb0061e0fe37e5',
    },
    {
      extensionStep: 5,
      sourceDdlId: 138,
      filename: '138_manual_pooled_public_finish_and_preview.sql',
      sha256: 'af53d5bff8e3a8cf821b4ade965d12472cc920eac754266d5aa42713d5962238',
    },
    {
      extensionStep: 6,
      sourceDdlId: 139,
      filename: '139_manual_pooled_personal_export_batch.sql',
      sha256: 'afe65f33afa297ac92d752acd3eb1bb40be728444cf9b6957537622ea696e9f8',
    },
    {
      extensionStep: 7,
      sourceDdlId: 140,
      filename: '140_manual_pooled_same_invocation_lookup.sql',
      sha256: '748596663ad63c868cdcf22bbc149d7328d3438230826cd7d61a8dd6270dd3ac',
    },
    {
      extensionStep: 8,
      sourceDdlId: 141,
      filename: '141_manual_pooled_application_local_validation.sql',
      sha256: 'cab05bdb0aa3b081d886efd3c0b4eabcbd0cbb5a38baf5c1ffadde30df10008d',
    },
  ].map((m) => Object.freeze(m)),
);
export const currentRuntimeV8FunctionPins = Object.freeze(
  [
    {
      signature:
        'public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      prosrcSha256: 'e21ba72f44e2cdf563d3a8a7b7c9f1c6b0e51877db9ab7be12e13f6bfd6bc4ff',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'store_manual_race_pooled_chain_v1',
        prorows: 0,
        pronargs: 8,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: [
          'evidence_id',
          'decision_id',
          'proposal_id',
          'receipt_key',
          'request',
          'payload',
          'basis',
          'lifecycle',
        ],
        proargtypes: ['2950', '2950', '2950', '25', '3802', '3802', '3802', '3802'],
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
      signature: 'public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)',
      prosrcSha256: 'd1b54a97a1c3474d8d5c416dc9bdaeb2337eadac91bcd2830c24e7d0028e83c7',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'validate_race_manual_pooled_application_basis_v1',
        prorows: 0,
        pronargs: 3,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['retained', 'basis', 'lifecycle'],
        proargtypes: ['3802', '3802', '3802'],
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
      signature: 'public.read_manual_race_pooled_chain_v1(uuid)',
      prosrcSha256: 'f784d2489f73d8ab0abcbae155da78d06ab6d15bb78cfedd7ac3d8ceab058845',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_manual_race_pooled_chain_v1',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['evidence_id'],
        proargtypes: ['2950'],
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
      signature: 'public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)',
      prosrcSha256: '6aa33358717089873f595aefba8d233a2104e2c6a96cb0cd9f7dbf9f0d7172c4',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'ack_manual_race_pooled_same_tx_parent_v1',
        prorows: 0,
        pronargs: 5,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['evidence', 'decision', 'proposal', 'readonly_digest', 'expected_retained'],
        proargtypes: ['2950', '2950', '2950', '25', '3802'],
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
      signature: 'public.race_manual_pooled_relative_membership_v1(jsonb)',
      prosrcSha256: 'a590a7597091c30e3d2b0bcc92ffb3c1ffee7c58d09c984957e068e9a5505687',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'race_manual_pooled_relative_membership_v1',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['retained'],
        proargtypes: ['3802'],
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
      signature: 'public.race_manual_pooled_routine_expansion_v1(jsonb,jsonb,jsonb,text)',
      prosrcSha256: '6a32c5e54b3e204e2e4af0e8829beb1675bd41387d041aa588b1261b3a306fdf',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'race_manual_pooled_routine_expansion_v1',
        prorows: 0,
        pronargs: 4,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['retained', 'projected', 'schedule', 'source_id'],
        proargtypes: ['3802', '3802', '3802', '25'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'public.race_manual_pooled_validate_recipes_v1(jsonb,jsonb)',
      prosrcSha256: '7c8cc6bfdcc9ee27de8d2430f81e399080b25649c3a43207d289b699f29dbb66',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'race_manual_pooled_validate_recipes_v1',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['candidate', 'retained'],
        proargtypes: ['3802', '3802'],
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
      signature: 'public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      prosrcSha256: 'f2d6e04df35f304b6e66ee457bff72429bd23d18af00879d7ba28cd53c03b7d0',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'prepare_race_manual_pooled_application_v1',
        prorows: 0,
        pronargs: 4,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['candidate', 'basis', 'retained', 'lifecycle'],
        proargtypes: ['3802', '3802', '3802', '3802'],
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
      signature: 'public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      prosrcSha256: '2a16d60ad9e74d6fd43d88353b399bc7d3e27a031836225e0eb0cd5a97e74f05',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'begin_race_manual_pooled_application_v1',
        prorows: 0,
        pronargs: 4,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '2950',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['command', 'basis', 'retained', 'lifecycle'],
        proargtypes: ['3802', '3802', '3802', '3802'],
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
      signature: 'public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid)',
      prosrcSha256: '63466e68cd2c8f0be7cc6e14b935535b3daff48e838f6f17da755e36ed78851b',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'finish_race_manual_pooled_public_review_v1',
        prorows: 0,
        pronargs: 3,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['key', 'command', 'candidate'],
        proargtypes: ['25', '3802', '2950'],
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
      signature: 'public.read_race_manual_pooled_public_preview_source_v1(uuid)',
      prosrcSha256: '46299cca3e89a11d19ff5104d653e9ac0f93cdb99c8ab8b7f1df649c328a96ba',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_race_manual_pooled_public_preview_source_v1',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['candidate'],
        proargtypes: ['2950'],
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
      signature: 'public.read_manual_race_pooled_personal_export_batch_v1(integer)',
      prosrcSha256: '9007410b714a09d7093c4b5eacd7d7326bd450b6f0f22524178cf9d7ae24d6df',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_manual_race_pooled_personal_export_batch_v1',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['byte_limit'],
        proargtypes: ['23'],
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
      signature: 'wm_manual_pooled.assert_owner()',
      prosrcSha256: '9924268629b85961a0ec32398bdbd8745746c419bb05ad739f6ce9befaa601f7',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'assert_owner',
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
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'wm_manual_pooled.exact_keys(jsonb,text[])',
      prosrcSha256: '9c1b8e95b74508d1fa33c013610cb0496cdfc78a6b1220cac5d9b63e57da4aa2',
      language: 'sql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'exact_keys',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '16',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['v', 'k'],
        proargtypes: ['3802', '1009'],
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
      signature: 'wm_manual_pooled.path_parts(text,boolean)',
      prosrcSha256: 'a56655e900f4bd211b9b5c27356bb37eb5fbdcb9d97197075f2e0cbea9817cdf',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'path_parts',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '1009',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['v', 'allow_root'],
        proargtypes: ['25', '16'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 'i',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults:
          '({CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]})',
        pronargdefaults: 1,
      },
    },
    {
      signature: 'wm_manual_pooled.at_exact(jsonb,text[])',
      prosrcSha256: '9c0f04724dbef25fedb8f2f3248d425897301d09c587bfaff6cabe1f65428994',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'at_exact',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['v', 'p'],
        proargtypes: ['3802', '1009'],
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
      signature: 'wm_manual_pooled.check_encoded(jsonb)',
      prosrcSha256: 'd54fb68ffbaf44eab7a6956e21f16cecb5a103efef125b20976d752e9cd3f4e0',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'check_encoded',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['e'],
        proargtypes: ['3802'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'wm_manual_pooled.lookup(jsonb,text)',
      prosrcSha256: 'f27c360738286816fee3b744c9bbbc417394a14c02c17ddffcb746ab9894ebb7',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'lookup',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['e', 'path'],
        proargtypes: ['3802', '25'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'wm_manual_pooled.read_internal_export_v2(integer)',
      prosrcSha256: '73e020f790197b8c4a3b39e9d51a5f79aa7b7ddcc3898760f605852a543a9d99',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_internal_export_v2',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['byte_limit'],
        proargtypes: ['23'],
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
      signature: 'wm_manual_pooled.read_public_export_metadata_v2(integer)',
      prosrcSha256: 'f8bf0820d46f446979e7ad359d248f7ff3df52292f59eb8c8eb7d2b5bcc5b587',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_public_export_metadata_v2',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['byte_limit'],
        proargtypes: ['23'],
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
      signature: 'wm_manual_pooled.lookup_validated_local(jsonb,text)',
      prosrcSha256: '9af916337f6a2f31ded78ab541b320245947ec3e38900d77cf05ecc8380d0527',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'lookup_validated_local',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['e', 'path'],
        proargtypes: ['3802', '25'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'wm_manual_pooled.relative_membership_validated_local_v1(jsonb)',
      prosrcSha256: 'ba5f652c5e8607404ec00d750f13c1ca1c1de070705870d52ae19dbce746213c',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'relative_membership_validated_local_v1',
        prorows: 0,
        pronargs: 1,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['retained'],
        proargtypes: ['3802'],
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
      signature: 'wm_manual_pooled.routine_expansion_validated_local_v1(jsonb,jsonb,jsonb,text)',
      prosrcSha256: '09918e5fa3ddd375d7f5aacdb01ca8e3687a8de0edd0d78198138d292de260ff',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'routine_expansion_validated_local_v1',
        prorows: 0,
        pronargs: 4,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['retained', 'projected', 'schedule', 'source_id'],
        proargtypes: ['3802', '3802', '3802', '25'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
    {
      signature: 'wm_manual_pooled.validate_recipes_validated_local_v1(jsonb,jsonb)',
      prosrcSha256: '70d47fb4f649baf555acafe6c872c72d8bc81a04fc8fd0ffe265644a190202f9',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'validate_recipes_validated_local_v1',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '2278',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['candidate', 'retained'],
        proargtypes: ['3802', '3802'],
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
  ].map((p) => Object.freeze(p)),
);
function freezeCompilerValue(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeCompilerValue(child);
    Object.freeze(value);
  }
}
freezeCompilerValue(currentRuntimeV8FunctionPins);
export class CurrentRuntimeInstallationV8Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V8_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V8_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V8_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V8_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V8_FUNCTION_DRIFT'
      | 'CURRENT_RUNTIME_V8_METADATA_CHANGED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV8Error['code']): never {
  throw new CurrentRuntimeInstallationV8Error(code);
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
const parentEncoding = JSON.stringify({
  encoding: 'current-runtime-profile-v7-parent-manifest-v1',
  profileVersion: 7,
  baselineSchemaVersion: 107,
  runtimeStep: 23,
  members: currentRuntimeV8ParentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function sources() {
  if (hash(parentEncoding) !== currentRuntimeV8ParentManifestSha256)
    fail('CURRENT_RUNTIME_V8_PARENT_MISMATCH');
  const result: string[] = [];
  for (const member of currentRuntimeV8ExtensionMembers) {
    const text = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(text) !== member.sha256) fail('CURRENT_RUNTIME_V8_SOURCE_MISMATCH');
    result.push(text);
  }
  return result;
}
const receiptSchema = z.strictObject({
  extensionStep: z.number().int().min(1).max(8),
  sourceDdlId: z.number().int().min(134).max(141),
  filename: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parentManifestSha256: z.literal(currentRuntimeV8ParentManifestSha256),
});
const receiptRosterSchema = z.array(receiptSchema).length(8);
function jsonMap(field: 'filename' | 'sha256') {
  // Canonical PostgreSQL jsonb text for this fixed eight-key/string map.
  return (
    '{' +
    currentRuntimeV8ExtensionMembers
      .map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + JSON.stringify(m[field]))
      .join(', ') +
    '}'
  );
}
const checks = [
  ['profile_extension_v8_step', 'extension_step = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7, 8])'],
  ['profile_extension_v8_ddl', 'source_ddl_id = (133 + extension_step)'],
  [
    'profile_extension_v8_filename',
    `filename = (${literal(jsonMap('filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_source',
    `source_sha256 = (${literal(jsonMap('sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV8ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v8 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v8_step CHECK(${checks[0][1]}),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v8_ddl CHECK(${checks[1][1]}),
 filename text NOT NULL CONSTRAINT profile_extension_v8_filename CHECK(${checks[2][1]}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v8_source CHECK(${checks[3][1]}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v8_parent CHECK(${checks[4][1]}),
 CONSTRAINT profile_extension_v8_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v8_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v8_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v8 FROM PUBLIC;`;
const expectedConstraints = [
  ...checks.map(([name, expression]) => ({
    name,
    kind: 'c',
    definition: `CHECK ((${expression}))`,
    validated: true,
    deferrable: false,
    deferred: false,
  })),
  {
    name: 'profile_extension_v8_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v8_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v8_filename_key',
    kind: 'u',
    definition: 'UNIQUE (filename)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const catalogSchema = z.strictObject({
  owner: z.literal(true),
  private: z.literal(true),
  columns: z.literal(true),
  constraints: z.literal(true),
  shape: z.literal(true),
});
const catalogSql = `SELECT current_user=session_user AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND n.nspowner=c.relowner AS owner,
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
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v8'`;
async function receipts(tx: CurrentRuntimeInstallationTransaction) {
  const c = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (c.rows.length !== 1 || !catalogSchema.safeParse(c.rows[0]).success)
    fail('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  const rows = await tx.query(
    `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v8 ORDER BY extension_step`,
  );
  const parsed = receiptRosterSchema.safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  if (
    JSON.stringify(parsed.data) !==
    JSON.stringify(
      currentRuntimeV8ExtensionMembers.map((m) => ({
        ...m,
        parentManifestSha256: currentRuntimeV8ParentManifestSha256,
      })),
    )
  )
    fail('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  return parsed.data;
}
const stateSchema = z.strictObject({
  ledger: z.boolean(),
  pooled: z.boolean(),
  knownLedgers: z.literal(true),
});
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v8') IS NOT NULL AS ledger,
 to_regnamespace('wm_manual_pooled') IS NOT NULL OR EXISTS(SELECT 1 FROM unnest($1::text[]) s(signature) WHERE to_regprocedure(s.signature) IS NOT NULL) AS pooled,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relkind IN ('r','p','v','m','f','S') AND c.relname NOT IN ('migration','profile_extension_v2','profile_extension_v3','profile_extension_v4','profile_extension_v5','profile_extension_v6','profile_extension_v7','profile_extension_v8')) AS "knownLedgers"`,
    [currentRuntimeV8FunctionPins.map((p) => p.signature)],
  );
  const parsed = stateSchema.safeParse(rows.rows[0]);
  if (rows.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  return parsed.data;
}
const functionRow = z.strictObject({
  signature: z.string().max(250),
  owner: z.literal(true),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataMatches: z.literal(true),
  safeAcl: z.literal(true),
  namespace: z.literal(true),
});
async function verifyFunctions(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT pin.value->>'signature' AS signature,
 current_user=session_user AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner,
 CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END AS "bodySha256",
 (to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc'])=pin.value->'metadata'
 AND l.lanname=pin.value->>'language' AS "metadataMatches",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR pin.value->>'runtimeDirect'<>'true')) AS "safeAcl",
 n.nspname=split_part(pin.value->>'signature','.',1) AND (n.nspname='public' OR n.nspowner=p.proowner) AS namespace
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY pin(value,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(pin.value->>'signature') JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY pin.ordinal`,
    [JSON.stringify(currentRuntimeV8FunctionPins)],
  );
  const parsed = z.array(functionRow).length(24).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V8_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const pin = currentRuntimeV8FunctionPins[i];
    if (!pin || row.signature !== pin.signature || row.bodySha256 !== pin.prosrcSha256)
      fail('CURRENT_RUNTIME_V8_FUNCTION_DRIFT');
  }
  const shape = await tx.query(`SELECT count(*)::int AS count,
 coalesce(bool_and(n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)),false) AS private FROM pg_namespace n JOIN pg_proc p ON p.pronamespace=n.oid WHERE n.nspname='wm_manual_pooled'`);
  if (
    shape.rows.length !== 1 ||
    shape.rows[0]?.['count'] !== 12 ||
    shape.rows[0]?.['private'] !== true
  )
    fail('CURRENT_RUNTIME_V8_FUNCTION_DRIFT');
}
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
    fail('CURRENT_RUNTIME_V8_PARENT_MISMATCH');
  return found;
}
// Full parent33 source/meta and ledger rows+xmin are compared across installation.
// Retained domain bodies/credentials are never selected here.
const prefixFunctionsSchema = z
  .array(
    z.strictObject({
      signature: z.string().max(250),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .length(33);
async function prefix(tx: CurrentRuntimeInstallationTransaction) {
  const functions = await tx.query(
    `SELECT requested.signature,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint FROM unnest($1::text[]) WITH ORDINALITY requested(signature,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature) ORDER BY requested.ordinal`,
    [currentRuntimeV7RpcSourcePins.map((p) => p.signature)],
  );
  const parsed = prefixFunctionsSchema.safeParse(functions.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V8_METADATA_CHANGED');
  for (const [i, row] of parsed.data.entries())
    if (row.signature !== currentRuntimeV7RpcSourcePins[i]?.signature)
      fail('CURRENT_RUNTIME_V8_METADATA_CHANGED');
  const ledgerNames = [
    'migration',
    'profile_extension_v2',
    'profile_extension_v3',
    'profile_extension_v4',
    'profile_extension_v5',
    'profile_extension_v6',
    'profile_extension_v7',
  ] as const;
  const ledger = [];
  for (const name of ledgerNames) {
    // Finite module-owned identifier only; never derived from caller JSON/catalog.
    const found = await tx.query(
      `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM wm_runtime_installation.${name} t`,
    );
    const stamp = z
      .strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(found.rows[0]);
    if (found.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V8_METADATA_CHANGED');
    ledger.push({ name, ...stamp.data });
  }
  const baseline = await tx.query(
    `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY version),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM public.schema_migrations t`,
  );
  const stamp = z
    .strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(baseline.rows[0]);
  if (baseline.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V8_METADATA_CHANGED');
  return { functions: parsed.data, ledger, baseline: stamp.data };
}

function result(extensionReceipts: z.infer<typeof receiptRosterSchema>) {
  return {
    profileVersion: 8 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 23 as const,
    extensionSteps: 8 as const,
    runtimeStep: 24 as const,
    sourceDdlTip: 141 as const,
    parentManifestSha256: currentRuntimeV8ParentManifestSha256,
    parentAppliedMembers: currentRuntimeV8ParentMembers,
    extensionMembers: currentRuntimeV8ExtensionMembers,
    extensionReceipts,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
export async function verifyCurrentRuntimeV8InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  await sources();
  await parent(tx);
  const p = await presence(tx);
  if (!p.ledger || !p.pooled) fail('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  const r = await receipts(tx);
  await verifyFunctions(tx);
  return result(r);
}
export async function installCurrentRuntimeV8In(tx: CurrentRuntimeInstallationTransaction) {
  const texts = await sources();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  await installCurrentRuntimeV7In(tx);
  await parent(tx);
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV8InstalledIn(tx);
  if (p.pooled) fail('CURRENT_RUNTIME_V8_UNREGISTERED_STAGE');
  const before = await prefix(tx);
  await tx.query(bootstrap);
  for (const [i, text] of texts.entries()) {
    const member = currentRuntimeV8ExtensionMembers[i];
    if (!member) fail('CURRENT_RUNTIME_V8_SOURCE_MISMATCH');
    await tx.query(text);
    await tx.query(
      'INSERT INTO wm_runtime_installation.profile_extension_v8(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES($1,$2,$3,$4,$5)',
      [
        member.extensionStep,
        member.sourceDdlId,
        member.filename,
        member.sha256,
        currentRuntimeV8ParentManifestSha256,
      ],
    );
  }
  if (JSON.stringify(await prefix(tx)) !== JSON.stringify(before))
    fail('CURRENT_RUNTIME_V8_METADATA_CHANGED');
  return verifyCurrentRuntimeV8InstalledIn(tx);
}
export async function installCurrentRuntimeV8(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    const tx = await pool.connect();
    let discard = false;
    try {
      await tx.query('BEGIN');
      const r = await installCurrentRuntimeV8In(tx);
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
