import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type * as V10 from '../src/current-runtime-installation-v10.js';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import {
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10KnownLedgers,
} from '../src/current-runtime-installation-v10.js';
import {
  currentRuntimeV11ParentMembers,
  currentRuntimeV11ParentManifestSha256,
  currentRuntimeV11ExtensionMembers,
  currentRuntimeV11FunctionPins,
  currentRuntimeV11TriggerPins,
  currentRuntimeV11StructurePins,
  currentRuntimeV11ParentChange,
  currentRuntimeV11Tables,
  currentRuntimeV11TableDelegations,
  currentRuntimeV11KnownLedgers,
  currentRuntimeV11CatalogDelta,
  currentRuntimeV11StructureDigest,
  installCurrentRuntimeV11In,
  verifyCurrentRuntimeV11InstalledIn,
  type CurrentRuntimeV11CatalogLine,
} from '../src/current-runtime-installation-v11.js';
import {
  galleryNavigationFunctionPinsV1,
  galleryNavigationTriggersV1,
  galleryRestoreSuppressionFunctionPinsV1,
  galleryRestoreSuppressionTriggersV1,
} from '../src/gallery-navigation-pins-v1.js';
import {
  galleryRenditionFunctionPinsV1,
  galleryRenditionTriggersV1,
} from '../src/gallery-rendition-pins-v1.js';
import { RESTORE_ADMISSION_ROSTER_TALLIES } from '../src/full-restore-relation-classification-v2.js';

vi.mock('../src/current-runtime-installation-v10.js', async (original) => ({
  ...(await original<typeof V10>()),
  installCurrentRuntimeV10In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV10InstalledIn: vi.fn(async () => {
    throw Error('V11_MUST_NOT_CALL_V10_VERIFY');
  }),
}));
afterEach(() => vi.clearAllMocks());
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const migration = (file: string) =>
  readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');

it('pins parent physical33, five extension members in install order and logical27', async () => {
  expect(currentRuntimeV11ParentMembers).toHaveLength(33);
  expect(currentRuntimeV11ParentMembers.slice(0, 32)).toEqual(currentRuntimeV10ParentMembers);
  expect(currentRuntimeV11ParentMembers[32]).toEqual({
    step: 33,
    sourceDdlId: 146,
    filename: '146_race_event_local_date_approval_guard.sql',
    sha256: currentRuntimeV10ExtensionMembers[0]?.sha256,
  });
  expect(currentRuntimeV11ExtensionMembers).toEqual([
    {
      extensionStep: 1,
      sourceDdlId: 143,
      filename: '143_gallery_albums.sql',
      sha256: '2beb8a2c1872a4ade51cbc2ddec4a8d204b8213b249a5af6756e302c6cc99ab2',
    },
    {
      extensionStep: 2,
      sourceDdlId: 144,
      filename: '144_gallery_renditions.sql',
      sha256: '1aa9673a80ea16db92e694f781caa8403f6744450b2fec22fa3d7a12289e0116',
    },
    {
      extensionStep: 3,
      sourceDdlId: 145,
      filename: '145_gallery_restore_suppression.sql',
      sha256: '352fb8c00783a6f6a25142d18eccc5865291babebffa4897e97a0368d7dc0c46',
    },
    {
      extensionStep: 4,
      sourceDdlId: 147,
      filename: '147_restore_processing_admission.sql',
      sha256: '5282d0f113a85236d7619582caa0fafc78646b7262b55394c20260cff63fa60f',
    },
    {
      extensionStep: 5,
      sourceDdlId: 148,
      filename: '148_ai_execution_job_store.sql',
      sha256: 'aefbff30f62084084c22b692647d2543119d6e299f95a793c2bb9b2af75c43ca',
    },
  ]);
  const encoding = JSON.stringify({
    encoding: 'current-runtime-profile-v10-parent-manifest-v1',
    profileVersion: 10,
    baselineSchemaVersion: 107,
    runtimeStep: 26,
    members: currentRuntimeV11ParentMembers.map((m) => [
      m.step,
      m.sourceDdlId,
      m.filename,
      m.sha256,
    ]),
  });
  expect(sha(encoding)).toBe(currentRuntimeV11ParentManifestSha256);
  for (const m of [...currentRuntimeV11ParentMembers, ...currentRuntimeV11ExtensionMembers])
    expect(sha(await readFile(new URL(`../migrations/${m.filename}`, import.meta.url)))).toBe(
      m.sha256,
    );
  expect(currentRuntimeV11KnownLedgers).toEqual([
    ...currentRuntimeV10KnownLedgers,
    'profile_extension_v11',
  ]);
});
it('147 carries the regenerated 254-relation roster, including every V11 table and the ledger', async () => {
  const text = await migration('147_restore_processing_admission.sql');
  const block = text.slice(
    text.indexOf('-- BEGIN GENERATED ROSTER'),
    text.indexOf('-- END GENERATED ROSTER'),
  );
  const rows = [
    ...block.matchAll(/^ {2}\('([a-z_]+)','([a-z0-9_]+)','([a-z_]+)',(true|false)\)/gm),
  ];
  expect(rows).toHaveLength(RESTORE_ADMISSION_ROSTER_TALLIES.relations);
  expect(RESTORE_ADMISSION_ROSTER_TALLIES).toEqual({
    relations: 254,
    retained: 218,
    retainedForced: 213,
    authenticationReset: 7,
    authenticationResetForced: 3,
    targetLocal: 29,
    census: 225,
    censusForced: 216,
  });
  const byName = new Map(rows.map((r) => [`${r[1]}.${r[2]}`, `${r[3]}|${r[4]}`]));
  expect(byName.get('wm_runtime_installation.profile_extension_v11')).toBe('target_local|false');
  const expected: Record<string, string> = {
    gallery_album: 'retained',
    gallery_media_album_membership: 'retained',
    gallery_media_course_association: 'retained',
    gallery_navigation_command_receipt: 'retained',
    gallery_album_deletion: 'retained',
    gallery_rendition_job: 'target_local',
    gallery_rendition_due: 'target_local',
    gallery_rendition_sweep: 'target_local',
    restore_gallery_album_replay_receipt: 'retained',
    restore_processing_admit_receipt: 'target_local',
    ai_synthetic_evidence_attestation: 'target_local',
    ai_execution_job: 'retained',
    ai_execution_job_disposition: 'retained',
  };
  expect(Object.keys(expected).sort()).toEqual([...currentRuntimeV11Tables].sort());
  for (const [table, cls] of Object.entries(expected))
    expect(byName.get(`public.${table}`)).toBe(`${cls}|true`);
});
it('function pins: 66 created + 4 replaced SQL101, bodies equal the member bytes', async () => {
  const pins = currentRuntimeV11FunctionPins;
  expect(pins).toHaveLength(70);
  expect(new Set(pins.map((p) => p.signature)).size).toBe(70);
  const count = (ddl: number) => pins.filter((p) => p.sourceDdlId === ddl).length;
  expect([101, 143, 144, 145, 147, 148].map(count)).toEqual([4, 29, 18, 4, 9, 6]);
  expect(pins.filter((p) => p.sourceDdlId === 101).map((p) => [p.signature, p.access])).toEqual([
    ['public.assert_restore_processing_closed(bigint,uuid,uuid)', 'owner'],
    ['public.close_restore_processing_exact(bigint,uuid,uuid,uuid)', 'owner'],
    ['public.read_restore_processing_admission()', 'runtime'],
    ['public.require_restore_processing_admission()', 'runtime'],
  ]);
  expect(pins.filter((p) => p.access === 'runtime')).toHaveLength(11);
  expect(pins.filter((p) => p.access === 'worker')).toHaveLength(5);
  for (const p of pins) {
    expect(p.signature.startsWith('public.')).toBe(true);
    expect(Object.isFrozen(p)).toBe(true);
  }
  // Each pin's prosrc SHA equals the dollar-quoted body in its member migration.
  const bodies = new Map<string, string>();
  for (const file of [
    '143_gallery_albums.sql',
    '144_gallery_renditions.sql',
    '145_gallery_restore_suppression.sql',
    '147_restore_processing_admission.sql',
    '148_ai_execution_job_store.sql',
  ]) {
    const text = await migration(file);
    for (const m of text.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([\s\S]*?\bAS (\$\w*\$)([\s\S]*?)\2/g,
    )) {
      expect(bodies.has(m[1] ?? '')).toBe(false);
      bodies.set(m[1] ?? '', sha(m[3] ?? ''));
    }
  }
  expect(bodies.size).toBe(70);
  for (const p of pins)
    expect([p.signature, bodies.get(p.signature.slice(7, p.signature.indexOf('(')))]).toEqual([
      p.signature,
      p.prosrcSha256,
    ]);
  // The gallery lane pin modules agree on body, definer and roster.
  const gallery = [
    ...galleryNavigationFunctionPinsV1,
    ...galleryRenditionFunctionPinsV1,
    ...galleryRestoreSuppressionFunctionPinsV1,
  ];
  expect(gallery).toHaveLength(51);
  for (const g of gallery)
    expect(pins.find((p) => p.signature === g.signature)).toMatchObject({
      prosrcSha256: g.prosrcSha256,
      securityDefiner: g.securityDefiner,
    });
});
it('trigger, structure and parent-change pins are exact and cover the lane trigger rosters', () => {
  expect(currentRuntimeV11TriggerPins).toHaveLength(34);
  for (const t of [
    ...galleryNavigationTriggersV1,
    ...galleryRenditionTriggersV1,
    ...galleryRestoreSuppressionTriggersV1,
  ])
    expect(
      currentRuntimeV11TriggerPins.find(
        (p) => p.table === t.table && p.trigger === t.trigger && p.function === `public.${t.fn}()`,
      ),
    ).toBeTruthy();
  expect(
    currentRuntimeV11TriggerPins
      .filter((p) => !(currentRuntimeV11Tables as readonly string[]).includes(p.table))
      .map((p) => `${p.table}.${p.trigger}`),
  ).toEqual([
    'gallery_media_item.gallery_navigation_media_deleted',
    'gallery_media_item.gallery_rendition_enqueue_item',
    'gallery_media_item.gallery_rendition_retire_deleted',
    'gallery_media_item.gallery_rendition_retire_erased',
    'restore_processing_admission.restore_processing_force_rls_at_commit',
  ]);
  expect(currentRuntimeV11StructurePins.map((p) => p.relation)).toEqual(
    [
      ...currentRuntimeV11Tables.map((t) => `public.${t}`),
      'public.ai_settings_catalog_definition',
      'public.ai_settings_revision',
      'public.coaching_run',
      'public.core_evidence_snapshot',
      'public.gallery_media_item',
      'public.restore_processing_admission',
      'public.restore_suppression_event',
    ].sort(),
  );
  const { removed, added } = currentRuntimeV11ParentChange;
  expect(removed.map((l) => `${l.owner}|${l.kind}|${l.name}`)).toEqual([
    'public.assert_restore_processing_closed(bigint, uuid, uuid)|function|',
    'public.close_restore_processing_exact(bigint, uuid, uuid, uuid)|function|',
    'public.read_restore_processing_admission()|function|',
    'public.require_restore_processing_admission()|function|',
    'public.restore_processing_admission|constraint|restore_processing_admission_state_check',
    'public.restore_suppression_event|constraint|restore_suppression_event_kind_target_check',
    'public.restore_suppression_event|constraint|restore_suppression_event_record_version_check',
  ]);
  expect(added).toHaveLength(37);
  // Only these parent owners change; parent RI triggers come only from V11 foreign keys.
  expect([...new Set(added.map((l) => l.owner))]).toEqual([
    'public.ai_settings_catalog_definition',
    'public.ai_settings_revision',
    'public.assert_restore_processing_closed(bigint, uuid, uuid)',
    'public.close_restore_processing_exact(bigint, uuid, uuid, uuid)',
    'public.coaching_run',
    'public.core_evidence_snapshot',
    'public.gallery_media_item',
    'public.read_restore_processing_admission()',
    'public.require_restore_processing_admission()',
    'public.restore_processing_admission',
    'public.restore_suppression_event',
  ]);
  for (const line of added.filter((l) => l.name.startsWith('internal:')))
    expect(line.name).toMatch(
      /^internal:(ai_execution_job|ai_synthetic_evidence_attesta|gallery_media_album_membership|gallery_media_course_association|gallery_navigation_command_re|gallery_rendition_job)_/,
    );
  expect(added.filter((l) => l.kind === 'acl' || l.kind === 'namespace')).toEqual([]);
  expect(Object.keys(currentRuntimeV11TableDelegations).sort()).toEqual(
    [
      'ai_execution_job',
      'ai_execution_job_disposition',
      'ai_synthetic_evidence_attestation',
      'gallery_album',
      'gallery_album_deletion',
      'gallery_media_album_membership',
      'gallery_media_course_association',
    ].sort(),
  );
});
it('catalog delta and structure digest are pure and order independent', () => {
  const line = (owner: string, kind: string, name: string, d: string) =>
    ({ owner, kind, name, detailSha256: d.repeat(64) }) as CurrentRuntimeV11CatalogLine;
  const before = [line('public.a', 'column', 'x', 'a'), line('public.a', 'constraint', 'c', 'a')];
  const after = [
    line('public.a', 'constraint', 'c', 'b'),
    line('public.a', 'column', 'x', 'a'),
    line('public.a', 'trigger', 't', 'c'),
    line('public.n', 'relation', '', 'd'),
  ];
  expect(currentRuntimeV11CatalogDelta(before, after)).toEqual({
    removed: [before[1]],
    added: [after[0], after[2]],
    newOwners: ['public.n'],
  });
  const acl = line('public.a', 'acl', '', 'e');
  expect(currentRuntimeV11StructureDigest([...after, acl], 'public.a')).toEqual(
    currentRuntimeV11StructureDigest([...after].reverse(), 'public.a'),
  );
  expect(currentRuntimeV11StructureDigest(after, 'public.a').lines).toBe(3);
});
function fixture(
  options: { ledger?: boolean; staged?: boolean; legacy?: boolean; unknown?: boolean } = {},
) {
  const statements: string[] = [];
  const tx: CurrentRuntimeInstallationTransaction = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('AS ledger'))
        return {
          rows: [
            {
              ledger: options.ledger ?? false,
              staged: options.staged ?? false,
              knownLedgers: !options.unknown,
              legacy: options.legacy ?? false,
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      throw Error('FIXTURE_STOP');
    },
  };
  return { tx, statements };
}
it('staged, legacy and unknown-ledger databases fail closed before any parent install', async () => {
  const v10 = await import('../src/current-runtime-installation-v10.js');
  for (const [options, code] of [
    [{ staged: true }, 'CURRENT_RUNTIME_V11_UNREGISTERED_STAGE'],
    [{ legacy: true }, 'CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER'],
    [{ legacy: true, ledger: true, staged: true }, 'CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER'],
    [{ unknown: true }, 'CURRENT_RUNTIME_V11_LEDGER_INVALID'],
  ] as const) {
    const f = fixture(options);
    await expect(installCurrentRuntimeV11In(f.tx)).rejects.toThrow(code);
    expect(f.statements.slice(0, 2)).toEqual([
      'SELECT pg_advisory_xact_lock(872194,1)',
      'SELECT pg_advisory_xact_lock(77210,1)',
    ]);
    expect(f.statements.some((s) => s.startsWith('CREATE') || s.startsWith('INSERT'))).toBe(false);
  }
  expect(v10.installCurrentRuntimeV10In).not.toHaveBeenCalled();
  expect(v10.verifyCurrentRuntimeV10InstalledIn).not.toHaveBeenCalled();
});
it('an existing ledger is verified (never re-installed) and the verifier never calls V10 verify', async () => {
  const v10 = await import('../src/current-runtime-installation-v10.js');
  const f = fixture({ ledger: true, staged: true });
  await expect(installCurrentRuntimeV11In(f.tx)).rejects.toThrow();
  await expect(verifyCurrentRuntimeV11InstalledIn(fixture().tx)).rejects.toThrow();
  expect(v10.installCurrentRuntimeV10In).not.toHaveBeenCalled();
  expect(v10.verifyCurrentRuntimeV10InstalledIn).not.toHaveBeenCalled();
  expect(f.statements.some((s) => s.startsWith('CREATE TABLE'))).toBe(false);
});
