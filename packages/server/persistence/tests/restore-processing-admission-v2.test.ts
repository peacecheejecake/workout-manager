import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyFullRestoreRelationsV2,
  FullRestoreClassificationErrorV2,
  loadFullRestoreRelationClassificationV2,
  readFullRestoreExpectedStructureV2Bytes,
  restoreAdmissionCensusSha256,
  restoreAdmissionRosterSha256,
  FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256,
  RESTORE_ADMISSION_LOADER_NAMESPACES,
  RESTORE_ADMISSION_ROSTER_SHA256,
} from '../src/full-restore-relation-classification-v2.js';
import { classifyFullRestoreRelationsV1 } from '../src/full-restore-relation-classification-v1.js';
import { evaluateFullRestorePostconditionsV2 } from '../src/full-restore-admission-postconditions-v2.js';
import { createFullRestoreStructureComparatorV1 } from '../src/full-restore-expected-structure-v1.js';
import {
  createRestoreProcessingOwnerPort,
  decodeRestoreProcessingAdmission,
  decodeRestoreProcessingControl,
  requireRestoreProcessingAdmission,
  runRestoreProcessingAdmissionTransaction,
  RestoreProcessingAdmissionError,
  type RestoreProcessingOwnerQueryPort,
} from '../src/restore-processing-admission.js';
import {
  currentParentRelationsV2,
  currentSourceExtraRelationsV2,
  parseCurrentTargetControlRowV2,
} from '../src/restore-current-target-control-v2.js';
import { CURRENT_PARENT_RELATIONS } from '../src/restore-current-parent-artifact.js';
import { currentSourceExtraRelations } from '../src/restore-current-source-partitions.js';
import {
  admissionConfiguration,
  admissionObservation,
  BUDGET_RESERVATION,
  signAdmissionArtifact,
  type RowFacts,
} from './restore-admission-v2-fixtures.js';

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));
const migration = readFileSync(
  new URL('../migrations/147_restore_processing_admission.sql', import.meta.url),
  'utf8',
);
const classification = loadFullRestoreRelationClassificationV2();
const q = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;

function sqlRoster() {
  const begin = migration.indexOf('-- BEGIN GENERATED ROSTER');
  const end = migration.indexOf('-- END GENERATED ROSTER');
  return migration
    .slice(migration.indexOf('\n', begin) + 1, end)
    .trim()
    .split('\n')
    .map((line) => {
      const m = /^ *\('([a-z0-9_]+)','([a-z0-9_]+)','([a-z_]+)',(true|false)\),?$/.exec(line);
      if (!m) throw new Error(`bad roster line ${line}`);
      return {
        schema: m[1] ?? '',
        relation: m[2] ?? '',
        class: m[3] ?? '',
        forceRls: m[4] === 'true',
      };
    });
}

describe('admission roster successor (classification v2)', () => {
  it('pins 254 rows with the reviewed tallies and the SQL roster digest formula', () => {
    expect(classification.relations).toHaveLength(254);
    expect(classification.census).toHaveLength(225);
    expect(classification.census.filter((r) => r.forceRls)).toHaveLength(216);
    expect(classification.rosterSha256).toBe(RESTORE_ADMISSION_ROSTER_SHA256);
    expect(restoreAdmissionRosterSha256(classification.relations)).toBe(
      RESTORE_ADMISSION_ROSTER_SHA256,
    );
    expect(classification.authority).toBe('none');
  });
  it('147 literal roster equals roster.json row for row (generated, not hand-edited)', () => {
    const rows = sqlRoster();
    expect(rows).toEqual(classification.relations.map((r) => ({ ...r })));
    expect(migration.match(/-- BEGIN GENERATED ROSTER/g)).toHaveLength(1);
  });
  it('is the v1 classification plus exactly the reviewed profile27 successor relations', () => {
    const v1 = classifyFullRestoreRelationsV1(
      read('../src/full-restore-native-catalog-v2/source-owned-roster.json'),
    );
    const v1Names = new Set(v1.relations.map(q));
    const extra = classification.relations.filter((r) => !v1Names.has(q(r))).map(q);
    expect(extra).toEqual([
      'public.ai_execution_job',
      'public.ai_execution_job_disposition',
      'public.ai_synthetic_evidence_attestation',
      'public.gallery_album',
      'public.gallery_album_deletion',
      'public.gallery_media_album_membership',
      'public.gallery_media_course_association',
      'public.gallery_navigation_command_receipt',
      'public.gallery_rendition_due',
      'public.gallery_rendition_job',
      'public.gallery_rendition_sweep',
      'public.restore_gallery_album_replay_receipt',
      'public.restore_processing_admit_receipt',
      'wm_runtime_installation.profile_extension_v10',
      'wm_runtime_installation.profile_extension_v11',
    ]);
    for (const r of v1.relations) {
      const successor = classification.relations.find((s) => q(s) === q(r));
      expect(successor?.class).toBe(
        r.classification === 'authentication_reset'
          ? 'authentication_reset'
          : r.classification === 'target_local_exclude'
            ? 'target_local'
            : 'retained',
      );
    }
  });
  it('all seven authentication_reset relations equal the artifact configuration set', () => {
    expect(classification.authenticationReset.map(q)).toEqual([
      'identity_private.login_attempt',
      'identity_private.native_exchange_code',
      'identity_private.native_login_attempt',
      'identity_private.session',
      'public.garmin_attempt',
      'public.garmin_connection',
      'public.garmin_unofficial_connection',
    ]);
    expect(admissionConfiguration(classification).authenticationResetRelations.map(q)).toEqual(
      sqlRoster()
        .filter((r) => r.class === 'authentication_reset')
        .map(q),
    );
  });
  it('loader namespaces (D5) match the SQL function', () => {
    expect(migration).toContain(
      `SELECT ARRAY[${RESTORE_ADMISSION_LOADER_NAMESPACES.map((n) => `'${n}'`).join(',')}]::text[]`,
    );
  });
  it('rejects tampered roster or successor bytes', () => {
    const base = {
      v1RosterBytes: read('../src/full-restore-native-catalog-v2/source-owned-roster.json'),
      successorBytes: read('../src/full-restore-admission-roster-v1/successor-relations.json'),
      admissionRosterBytes: read('../src/full-restore-admission-roster-v1/roster.json'),
    };
    const flip = (bytes: Uint8Array) => {
      const copy = Uint8Array.from(bytes);
      const i = new TextDecoder().decode(copy).indexOf('"forceRls": true');
      copy[i + 12] = 'f'.charCodeAt(0);
      return copy;
    };
    expect(() =>
      classifyFullRestoreRelationsV2({
        ...base,
        admissionRosterBytes: flip(base.admissionRosterBytes),
      }),
    ).toThrow(FullRestoreClassificationErrorV2);
    expect(() =>
      classifyFullRestoreRelationsV2({
        ...base,
        successorBytes: Uint8Array.from([...base.successorBytes, 32]),
      }),
    ).toThrow('ADMISSION_ROSTER_PIN_MISMATCH');
  });
  it('successor expected structure is pinned and covers the roster in code-point order', () => {
    const comparator = createFullRestoreStructureComparatorV1({
      expectedBytes: readFullRestoreExpectedStructureV2Bytes(),
      expectedSha256: FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256,
    });
    expect(comparator.relations.map(q)).toEqual(classification.relations.map(q));
  });
});

const NONCE = '44444444-4444-4444-8444-444444444444';
const INCARNATION = '55555555-5555-4555-8555-555555555555';
const target = { targetNonce: NONCE, targetIncarnation: INCARNATION, closedRevision: '3' };
const facts = new Map<string, RowFacts>([
  ['public.command_receipt', { rowCount: 4, rowsSha256: 'a'.repeat(64) }],
  ['public.consent', { rowCount: 2, rowsSha256: 'b'.repeat(64) }],
]);
function ready(
  overrides: Partial<Parameters<typeof admissionObservation>[0]> = {},
  segments?: [string, string, number][],
) {
  const artifact = signAdmissionArtifact({ classification, facts, target, segments });
  const observation = admissionObservation({
    classification,
    artifact,
    transaction: { xid: '900', backendPid: 77 },
    window: { xid: '900', rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256 },
    control: {
      state: 'CLOSED',
      localRevision: '3',
      targetNonce: NONCE,
      targetIncarnation: INCARNATION,
    },
    postTail: facts,
    ...overrides,
  });
  return { artifact, observation };
}
const policy = { commandId: randomUUID(), budgetReservationRelation: BUDGET_RESERVATION };

describe('postconditions v2 (census derivation and command)', () => {
  it('ready: exact SQL147 command with authenticated census and census digest', () => {
    const { artifact, observation } = ready();
    const result = evaluateFullRestorePostconditionsV2(
      artifact,
      classification,
      observation,
      policy,
    );
    expect(result.failures).toEqual([]);
    if (!result.ready) throw new Error('not ready');
    const c = result.command;
    expect(c.census).toHaveLength(225);
    expect(c.census.find((e) => q(e) === 'public.command_receipt')?.rowCount).toBe(4);
    expect(c.censusSha256).toBe(restoreAdmissionCensusSha256(c.census));
    expect(c.censusSha256).toBe(
      createHash('sha256')
        .update(
          `wm-restore-admission-census-v1\n${c.census.map((e) => `${q(e)}=${e.rowCount}`).join('\n')}`,
        )
        .digest('hex'),
    );
    expect(c).toMatchObject({
      expectedRevision: '3',
      commandId: policy.commandId,
      targetNonce: NONCE,
      targetIncarnation: INCARNATION,
      observedXid: '900',
    });
    expect(result.admissionAllowed).toBe(false);
    expect(Object.keys(c).sort()).toEqual([
      'artifactSha256',
      'census',
      'censusSha256',
      'commandId',
      'expectedRevision',
      'headSha256',
      'observedXid',
      'postconditionsSha256',
      'targetIncarnation',
      'targetNonce',
    ]);
  });
  it('D6: any tail segment fails closed with TAIL_DELTA_UNAVAILABLE', () => {
    const { artifact, observation } = ready({}, [['0/16B3740', '0/16B3800', 1]]);
    const result = evaluateFullRestorePostconditionsV2(
      artifact,
      classification,
      observation,
      policy,
    );
    expect(result.ready).toBe(false);
    expect(result.failures).toContain('TAIL_DELTA_UNAVAILABLE');
  });
  it('rejects window/xid, roster, post-tail, authentication and look-alike drift', () => {
    const cases: [Partial<Parameters<typeof admissionObservation>[0]>, string][] = [
      [
        { window: { xid: '901', rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256 } },
        'WINDOW_BINDING_MISMATCH',
      ],
      [{ window: { xid: '900', rosterSha256: 'c'.repeat(64) } }, 'ROSTER_NOT_PINNED'],
      [
        {
          postTail: new Map([
            ...facts,
            ['public.consent', { rowCount: 1, rowsSha256: 'b'.repeat(64) }],
          ]),
        },
        'POST_TAIL_RELATION_MISMATCH',
      ],
      [
        { authenticationReset: new Map([['public.garmin_connection', 1]]) },
        'AUTHENTICATION_STATE_LIVE',
      ],
      [
        {
          control: {
            state: 'ADMITTED',
            localRevision: '3',
            targetNonce: NONCE,
            targetIncarnation: INCARNATION,
          },
        },
        'CONTROL_NOT_CLOSED',
      ],
    ];
    for (const [override, failure] of cases) {
      const { artifact, observation } = ready(override);
      expect(
        evaluateFullRestorePostconditionsV2(artifact, classification, observation, policy).failures,
      ).toContain(failure);
    }
    const { artifact, observation } = ready();
    expect(
      evaluateFullRestorePostconditionsV2(artifact, { ...classification }, observation, policy)
        .failures,
    ).toEqual(['CLASSIFICATION_NOT_VERIFIED']);
    expect(
      evaluateFullRestorePostconditionsV2(artifact, classification, observation, {
        ...policy,
        commandId: 'x',
      }).failures,
    ).toEqual(['INVALID_COMMAND_ID']);
    const truncated = { ...observation, postTailRelations: observation.postTailRelations.slice(1) };
    expect(
      evaluateFullRestorePostconditionsV2(artifact, classification, truncated, policy).failures,
    ).toContain('POST_TAIL_RELATION_MISMATCH');
  });
});

type Reply = { rows: Record<string, unknown>[]; rowCount: number | null };
function fakePort(replies: ((sql: string, values?: unknown[]) => Reply | Promise<Reply>)[]) {
  const log: string[] = [];
  const port: RestoreProcessingOwnerQueryPort & { athleteId: string } = {
    athleteId: 'x',
    async query(sql, values) {
      log.push(sql);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected ${sql}`);
      return next(sql, values);
    },
  };
  return { port, log };
}
const owner = (): Reply => ({
  rows: [{ role: 'o', session_role: 'o', owner: 'o', rolsuper: false, rolbypassrls: false }],
  rowCount: 1,
});
const admitted = (allowed = true, revision = '4') => ({
  state: 'ADMITTED',
  localRevision: revision,
  generationId: randomUUID(),
  targetNonce: NONCE,
  targetIncarnation: INCARNATION,
  admissionAllowed: allowed,
  targetAttested: true,
});

describe('restore-processing-admission decoders and owner ports (no database)', () => {
  it('CLOSED decoder rejects ADMITTED; union decoder accepts only well-formed ADMITTED', () => {
    expect(() => decodeRestoreProcessingAdmission(admitted())).toThrow(
      'INVALID_RESTORE_PROCESSING_CONTROL',
    );
    expect(decodeRestoreProcessingControl(admitted(false)).admissionAllowed).toBe(false);
    for (const bad of [
      { ...admitted(), targetAttested: false },
      { ...admitted(), targetNonce: null },
      { ...admitted(), extra: 1 },
      { ...admitted(), state: 'OPEN' },
    ])
      expect(() => decodeRestoreProcessingControl(bad)).toThrow(
        'INVALID_RESTORE_PROCESSING_CONTROL',
      );
  });
  it('requireRestoreProcessingAdmission needs SQL success AND a same-transaction ADMITTED/allowed read', async () => {
    const closed = {
      ...admitted(),
      state: 'CLOSED',
      admissionAllowed: false,
      targetAttested: false,
    };
    for (const control of [closed, admitted(false), { ...admitted(), targetAttested: false }]) {
      const { port } = fakePort([
        () => ({ rows: [{}], rowCount: 1 }),
        () => ({ rows: [{ control }], rowCount: 1 }),
      ]);
      await expect(requireRestoreProcessingAdmission(port)).rejects.toThrow(
        'INVALID_RESTORE_PROCESSING_CONTROL',
      );
    }
    const { port, log } = fakePort([
      () => ({ rows: [{}], rowCount: 1 }),
      () => ({ rows: [{ control: admitted() }], rowCount: 1 }),
    ]);
    await expect(requireRestoreProcessingAdmission(port)).resolves.toBeUndefined();
    expect(log).toEqual([
      'SELECT public.require_restore_processing_admission()',
      'SELECT public.read_restore_processing_admission() AS control',
    ]);
    const denied = fakePort([
      () => {
        throw Object.assign(new Error('RESTORE_PROCESSING_CLOSED'), { code: 'P0001' });
      },
    ]);
    await expect(requireRestoreProcessingAdmission(denied.port)).rejects.toMatchObject({
      code: 'RESTORE_PROCESSING_CLOSED',
    });
  });
  it('admit validates the strict command (order, digest) before any owner query', async () => {
    const { artifact, observation } = ready();
    const result = evaluateFullRestorePostconditionsV2(
      artifact,
      classification,
      observation,
      policy,
    );
    if (!result.ready) throw new Error('fixture');
    const command = { ...result.command, census: [...result.command.census] };
    for (const bad of [
      { ...command, census: [...command.census].reverse() },
      { ...command, censusSha256: 'd'.repeat(64) },
      { ...command, observedXid: '0' },
      { ...command, extra: true },
    ]) {
      const { port, log } = fakePort([]);
      await expect(createRestoreProcessingOwnerPort(port).admit(bad)).rejects.toThrow(
        'INVALID_RESTORE_PROCESSING_ADMIT',
      );
      expect(log).toEqual([]);
    }
    // A success-shaped result with a different revision/roster is never an admission.
    const wrong = fakePort([
      owner,
      () => ({
        rows: [
          {
            control: {
              replayed: false,
              resultRevision: '9',
              rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256,
              censusSha256: command.censusSha256,
              control: admitted(true, '9'),
            },
          },
        ],
        rowCount: 1,
      }),
    ]);
    await expect(createRestoreProcessingOwnerPort(wrong.port).admit(command)).rejects.toThrow(
      'INVALID_RESTORE_PROCESSING_CONTROL',
    );
    const good = fakePort([
      owner,
      () => ({
        rows: [
          {
            control: {
              replayed: false,
              resultRevision: '4',
              rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256,
              censusSha256: command.censusSha256,
              control: admitted(true, '4'),
            },
          },
        ],
        rowCount: 1,
      }),
    ]);
    await expect(createRestoreProcessingOwnerPort(good.port).admit(command)).resolves.toMatchObject(
      {
        replayed: false,
        resultRevision: '4',
      },
    );
  });
  it('window result must carry the pinned roster digest and census size', async () => {
    const { port } = fakePort([
      owner,
      () => ({
        rows: [{ control: { xid: '5', censusRelations: 225, rosterSha256: 'e'.repeat(64) } }],
        rowCount: 1,
      }),
    ]);
    await expect(
      createRestoreProcessingOwnerPort(port).openAdmissionWindow({
        expectedRevision: '3',
        targetNonce: NONCE,
        targetIncarnation: INCARNATION,
      }),
    ).rejects.toThrow('RESTORE_PROCESSING_ROSTER_MISMATCH');
  });
  it('transaction helper rolls back on observer failure or a foreign xid and never commits', async () => {
    for (const observe of [
      async () => {
        throw new Error('observer failed');
      },
      async () => ({ observedXid: '6' }) as never,
    ]) {
      const { port, log } = fakePort([
        () => ({ rows: [], rowCount: null }),
        () => ({ rows: [], rowCount: null }),
        owner,
        () => ({
          rows: [
            {
              control: {
                xid: '5',
                censusRelations: 225,
                rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256,
              },
            },
          ],
          rowCount: 1,
        }),
        () => ({ rows: [], rowCount: null }),
      ]);
      await expect(
        runRestoreProcessingAdmissionTransaction(port, {
          window: { expectedRevision: '3', targetNonce: NONCE, targetIncarnation: INCARNATION },
          lockTimeoutMs: 1000,
          observe,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(log[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(log.at(-1)).toBe('ROLLBACK');
      expect(log).not.toContain('COMMIT');
    }
    await expect(
      runRestoreProcessingAdmissionTransaction(fakePort([]).port, {
        window: { expectedRevision: '3', targetNonce: NONCE, targetIncarnation: INCARNATION },
        lockTimeoutMs: 0,
        observe: async () => ({}) as never,
      }),
    ).rejects.toBeInstanceOf(RestoreProcessingAdmissionError);
  });
});

describe('successor target-control capture schemas', () => {
  it('lists are v1 plus the admit receipt, sorted, v1 unchanged', () => {
    expect(currentSourceExtraRelationsV2).toHaveLength(currentSourceExtraRelations.length + 1);
    expect(currentParentRelationsV2).toHaveLength(CURRENT_PARENT_RELATIONS.length + 1);
    for (const list of [currentSourceExtraRelationsV2, currentParentRelationsV2]) {
      expect(list.filter((r) => r === 'restore_processing_admit_receipt')).toHaveLength(1);
      expect([...list].sort()).toEqual([...list]);
    }
    expect(currentSourceExtraRelations).not.toContain('restore_processing_admit_receipt');
  });
  it('decodes the 9-column control row and rejects the 6-column shape', () => {
    const row = {
      singleton: true,
      state: 'ADMITTED',
      local_revision: '4',
      generation_id: randomUUID(),
      target_nonce: NONCE,
      target_incarnation: INCARNATION,
      admitted_artifact_sha256: 'a'.repeat(64),
      admitted_head_sha256: 'b'.repeat(64),
      admitted_postconditions_sha256: 'c'.repeat(64),
    };
    expect(parseCurrentTargetControlRowV2('restore_processing_admission', row)).toMatchObject({
      targetDisposition: 'TARGET_CONTROL',
      authority: 'none',
    });
    const {
      admitted_artifact_sha256: _a,
      admitted_head_sha256: _b,
      admitted_postconditions_sha256: _c,
      ...old
    } = row;
    expect(() => parseCurrentTargetControlRowV2('restore_processing_admission', old)).toThrow(
      'INVALID_TARGET_CONTROL_ROW_V2',
    );
    expect(() => parseCurrentTargetControlRowV2('toString', row)).toThrow(
      'INVALID_TARGET_CONTROL_ROW_V2',
    );
  });
});
