import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeSuppressionHead,
  decodeSuppressionHead,
  type SuppressionHead,
  type VersionedObject,
} from '../src/restore-suppression-coordinator.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import {
  readVerifiedRestoreProcessingProof,
  verifyRestoreProcessingProof,
  type RestoreProcessingInventory,
  type RestoreProcessingProofAuthority,
  type RestoreProcessingPurpose,
} from '../src/restore-processing-proof.js';

// Synthetic crypto/protocol evidence only: no real independent provisioner, DB,
// deployment fence, production key, immutable remote store, or admission action.
const proofKey = Buffer.alloc(32, 3),
  witnessKey = Buffer.alloc(32, 5),
  headKey = Buffer.alloc(32, 7),
  encryptionKey = Buffer.alloc(32, 11);
const now = new Date('2026-10-07T00:00:00Z');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const empty = () => ({ count: 0, sha256: sha('[]') });
const kinds = [
  'tenant_erased',
  'course_deleted',
  'activity_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'healthkit_consent_transition',
  'ai_consent_transition',
  'app_consent_transition',
  'check_in_deleted',
  'resource_share_revoked',
  'course_share_revoked',
  'intake_entry_deleted',
  'recovery_action_deleted',
  'healthkit_workout_deregistration_pending',
  'healthkit_workout_deregistration_released',
  'race_event_deleted',
  'race_result_deleted',
  'training_best_deleted',
] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function sign(value: unknown, key: Buffer, domain: string): Buffer {
  const body = Buffer.from(canonical(value));
  return Buffer.from(
    JSON.stringify({
      body: body.toString('base64'),
      mac: createHmac('sha256', key).update(domain).update(body).digest('hex'),
    }),
  );
}
function fixture(purpose: RestoreProcessingPurpose = 'fresh_bootstrap', emptyTail = false) {
  const target = {
    nonce: randomUUID(),
    generationId: randomUUID(),
    systemIdentifier: purpose === 'live_upgrade' ? '123' : '456',
    databaseIncarnation: randomUUID(),
  };
  const leaseId = randomUUID(),
    athlete = randomUUID(),
    ownerTag = sha(athlete);
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  if (!emptyTail) counts['app_consent_transition'] = 1;
  const inventory: RestoreProcessingInventory =
    purpose === 'fresh_bootstrap'
      ? []
      : [
          {
            ownerTag,
            app: { state: 'present', granted: true, revision: 1 },
            inventories: {
              evidence: empty(),
              run: empty(),
              candidate: empty(),
              integratedCandidate: empty(),
              approval: empty(),
              events: {
                count: emptyTail ? 0 : 1,
                sha256: emptyTail ? sha('[]') : sha('synthetic-event-row'),
              },
              receipts: empty(),
            },
          },
        ];
  const body = {
    localRecordVersion: 1 as const,
    clusterId: '123',
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [
      {
        commitLsn: '0/110',
        endLsn: '0/120',
        records: [
          {
            schemaVersion: 5 as const,
            eventId: randomUUID(),
            athleteId: athlete,
            occurredAt: '2026-10-06 12:00:00+00',
            kind: 'app_consent_transition' as const,
            consentPreviousRevision: null,
            consentPreviousGranted: null,
            consentRevision: 1,
            consentGranted: true,
          },
        ],
      },
    ],
  };
  const envelope = { ...body, sha256: sha(JSON.stringify(body)) };
  const segment = encryptReplaySegment({
    envelope,
    key: encryptionKey,
    keyId: 'synthetic-proof-encryption',
  });
  const head: SuppressionHead = {
    formatVersion: 1,
    clusterId: '123',
    slotName: 'wm_suppression_synthetic',
    throughLsn: emptyTail ? '0/100' : '0/120',
    localHash: emptyTail ? null : envelope.sha256,
    segment: emptyTail
      ? null
      : {
          segmentId: 'synthetic-segment',
          versionId: 'segment-v1',
          sha256: segment.sha256,
          byteLength: segment.byteLength,
          fromLsn: '0/100',
          previousHash: null,
        },
  };
  const headBytes = encodeSuppressionHead(head, headKey);
  const fence = {
    fenceId: randomUUID(),
    leaseId,
    expiresAt: '2026-10-07T00:05:00Z',
    throughLsn: purpose === 'fresh_bootstrap' ? '0/0' : head.throughLsn,
  };
  const schema = {
    version: 100,
    registryFingerprint: sha('independently-pinned-synthetic-schema100'),
  };
  const proof: Record<string, unknown> = {
    protocolVersion: 1,
    purpose,
    proofId: randomUUID(),
    schema,
    target,
    checkpoint: '42',
    leaseId,
    issuedAt: '2026-10-06T23:59:00Z',
    expiresAt: '2026-10-07T00:05:00Z',
    fence,
    owners: inventory,
    baseline:
      purpose === 'fresh_bootstrap'
        ? null
        : {
            snapshotId: 'synthetic-snapshot',
            pointLsn: '0/100',
            inventorySha256: sha('original-source-inventory'),
            publicationFingerprint: sha('independent-publication100'),
            systemIdentifier: '123',
          },
    archive:
      purpose === 'full_restore'
        ? {
            backupId: randomUUID(),
            dumpSha256: sha('synthetic-dump'),
            privateManifestSha256: sha('synthetic-private-manifest'),
            completionVersionId: 'completion-v1',
          }
        : null,
    tail:
      purpose === 'fresh_bootstrap'
        ? null
        : emptyTail
          ? {
              kind: 'empty',
              headVersionId: 'head-v1',
              headSha256: sha(headBytes),
              throughLsn: '0/100',
              localHash: null,
              counts: [{ ownerTag, counts }],
            }
          : {
              kind: 'chain',
              headVersionId: 'head-v1',
              headSha256: sha(headBytes),
              slotName: head.slotName,
              anchor: {
                clusterId: '123',
                fromLsn: '0/100',
                previousHash: null,
                throughLsn: '0/120',
                finalLocalHash: envelope.sha256,
                ciphertextHashes: [segment.sha256],
              },
              segments: [
                {
                  segmentId: 'synthetic-segment',
                  versionId: 'segment-v1',
                  sha256: segment.sha256,
                  byteLength: segment.byteLength,
                },
              ],
              counts: [{ ownerTag, counts }],
            },
  };
  const witness: Record<string, unknown> = {
    protocolVersion: 1,
    purpose,
    proofSha256: '',
    schema,
    target,
    checkpoint: '42',
    leaseId,
    fence,
    ownerTags: inventory.map((row) => row.ownerTag),
    expiresAt: '2026-10-07T00:05:00Z',
  };
  const observedArchive = structuredClone(proof['archive']);
  const authority: RestoreProcessingProofAuthority = {
    proofKey,
    witnessKey,
    headKey,
    encryptionKey,
    encryptionKeyId: 'synthetic-proof-encryption',
    purpose,
    registryFingerprint: schema.registryFingerprint,
    publicationFingerprint: sha('independent-publication100'),
    sourceSystemIdentifier: purpose === 'fresh_bootstrap' ? null : '123',
    expectedTarget: structuredClone(target),
    expectedCheckpoint: '42',
    expectedLeaseId: leaseId,
    expectedWitnessVersionId: 'witness-v42',
    expectedFence: structuredClone(fence),
    expectedOwnerTags: inventory.map((row) => row.ownerTag),
    now: () => now,
    readIndependentWitness: async () => ({
      bytes: sign(witness, witnessKey, 'wm-restore-processing-witness-v1\0'),
      versionId: 'witness-v42',
    }),
    readTargetIdentity: async () => structuredClone(target),
    readTargetInventory: async () => structuredClone(inventory),
    readTargetSchemaFingerprint: async () => schema.registryFingerprint,
    readArchiveIdentity: async () => structuredClone(observedArchive),
    tagOwner: sha,
    remoteStore: {
      readHead: async () => ({ bytes: headBytes, versionId: 'head-v1' }),
      readSegment: async () => ({ bytes: segment.bytes, versionId: 'segment-v1' }),
    },
  };
  function bytes() {
    const signed = sign(proof, proofKey, 'wm-restore-processing-proof-v1\0');
    witness['proofSha256'] = sha(signed);
    return signed;
  }
  return { proof, witness, authority, bytes, inventory, target, headBytes, segment };
}

const expectClosed = async (input: ReturnType<typeof fixture>, authority = input.authority) => {
  expect(await verifyRestoreProcessingProof(input.bytes(), authority)).toMatchObject({
    status: 'closed',
    admissionAllowed: false,
  });
};

describe('restore processing proof protocol, synthetic unit evidence only', () => {
  it.each(['fresh_bootstrap', 'live_upgrade', 'full_restore'] as const)(
    'verifies strict %s purpose without admitting or writing',
    async (purpose) => {
      const input = fixture(purpose);
      const result = await verifyRestoreProcessingProof(input.bytes(), input.authority);
      expect(result.status).toBe('proof_verified');
      expect(result.admissionAllowed).toBe(false);
      if (result.status !== 'proof_verified') throw new Error('Synthetic protocol proof rejected');
      const summary = readVerifiedRestoreProcessingProof(result.handle);
      expect(summary).toMatchObject({
        purpose,
        checkpoint: '42',
        eventCount: purpose === 'fresh_bootstrap' ? 0 : 1,
      });
      expect(Object.isFrozen(summary)).toBe(true);
      expect(() => readVerifiedRestoreProcessingProof({ ...result.handle })).toThrow(
        'RESTORE_PROCESSING_PROOF_HANDLE_INVALID',
      );
    },
  );
  it.each(['live_upgrade', 'full_restore'] as const)(
    'accepts signed explicit zero tail for %s only with exact fenced head',
    async (purpose) => {
      const input = fixture(purpose, true);
      expect((await verifyRestoreProcessingProof(input.bytes(), input.authority)).status).toBe(
        'proof_verified',
      );
    },
  );
  it('requires independent witness rather than caller verified flag or copied database identity', async () => {
    const input = fixture();
    expect(await verifyRestoreProcessingProof(input.bytes())).toEqual({
      status: 'closed',
      admissionAllowed: false,
      code: 'WITNESS_UNAVAILABLE',
    });
    await expectClosed(input, { ...input.authority, readIndependentWitness: async () => null });
    input.proof['verified'] = true;
    await expectClosed(input);
  });
  it.each([
    'purpose',
    'schema',
    'checkpoint',
    'lease',
    'target',
    'fence',
    'expiry',
    'roster',
  ] as const)('rejects authenticated but independently conflicting %s', async (field) => {
    const input = fixture('full_restore');
    if (field === 'purpose') input.proof['purpose'] = 'live_upgrade';
    if (field === 'schema')
      input.proof['schema'] = {
        version: 100,
        registryFingerprint: sha('untrusted-self-pinned-db'),
      };
    if (field === 'checkpoint') input.proof['checkpoint'] = '41';
    if (field === 'lease') input.proof['leaseId'] = randomUUID();
    if (field === 'target') input.proof['target'] = { ...input.target, nonce: randomUUID() };
    if (field === 'fence')
      input.proof['fence'] = { ...input.authority.expectedFence, fenceId: randomUUID() };
    if (field === 'expiry') input.proof['expiresAt'] = '2026-10-06T23:59:59Z';
    if (field === 'roster') input.proof['owners'] = [];
    await expectClosed(input);
  });
  it('rejects missing, forged, wrong-key, stale-version and expired independent witnesses', async () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => {
        input.witness['proofSha256'] = sha('different-proof');
      },
      (input: ReturnType<typeof fixture>) => {
        input.witness['expiresAt'] = '2026-10-06T00:00:00Z';
      },
      (input: ReturnType<typeof fixture>) => {
        input.witness['verified'] = true;
      },
    ]) {
      const input = fixture();
      const bytes = input.bytes();
      mutate(input);
      expect((await verifyRestoreProcessingProof(bytes, input.authority)).status).toBe('closed');
    }
    const input = fixture();
    await expectClosed(input, { ...input.authority, expectedWitnessVersionId: 'stale-version' });
    await expectClosed(input, { ...input.authority, witnessKey: proofKey });
    await expectClosed(input, { ...input.authority, witnessKey: Buffer.alloc(32, 99) });
  });
  it('rejects tampered bytes, wrong domain/key, duplicate JSON keys and oversized payload before remote calls', async () => {
    const input = fixture();
    const remote = vi.fn(input.authority.readIndependentWitness);
    const bytes = input.bytes();
    const index = bytes.length - 3;
    const value = bytes[index];
    if (value === undefined) throw new Error('Empty synthetic signed envelope');
    bytes[index] = value ^ 1;
    for (const invalid of [
      bytes,
      sign(input.proof, witnessKey, 'wm-restore-processing-proof-v1\0'),
      sign(input.proof, proofKey, 'baseline-anchor-candidate-v1\0'),
      Buffer.alloc(1024 * 1024 + 1),
    ]) {
      expect(
        (
          await verifyRestoreProcessingProof(invalid, {
            ...input.authority,
            readIndependentWitness: remote,
          })
        ).status,
      ).toBe('closed');
    }
    const duplicate = Buffer.from(
      canonical(input.proof).replace(
        '"protocolVersion":1',
        '"protocolVersion":0,"protocolVersion":1',
      ),
    );
    const duplicatedEnvelope = Buffer.from(
      JSON.stringify({
        body: duplicate.toString('base64'),
        mac: createHmac('sha256', proofKey)
          .update('wm-restore-processing-proof-v1\0')
          .update(duplicate)
          .digest('hex'),
      }),
    );
    expect((await verifyRestoreProcessingProof(duplicatedEnvelope, input.authority)).status).toBe(
      'closed',
    );
    expect(remote).not.toHaveBeenCalled();
  });
  it('rejects missing inventory keys, noncanonical zero digests, duplicate owners and lower schema versions', async () => {
    const input = fixture('live_upgrade');
    input.proof['owners'] = [{ ...input.inventory[0], inventories: { evidence: empty() } }];
    await expectClosed(input);
    input.proof['owners'] = [
      {
        ...input.inventory[0],
        inventories: {
          ...input.inventory[0]?.inventories,
          evidence: { count: 0, sha256: sha('unknown-zero') },
        },
      },
    ];
    await expectClosed(input);
    input.proof['owners'] = [input.inventory[0], input.inventory[0]];
    await expectClosed(input);
    input.proof['schema'] = {
      version: 99,
      registryFingerprint: input.authority.registryFingerprint,
    };
    await expectClosed(input);
  });
  it('requires exact observed target and full inventory without accepting self-reporting DB fields', async () => {
    const input = fixture('full_restore');
    await expectClosed(input, {
      ...input.authority,
      readTargetIdentity: async () => ({ ...input.target, generationId: randomUUID() }),
    });
    await expectClosed(input, {
      ...input.authority,
      readTargetIdentity: async () => ({ ...input.target, admitted: true }),
    });
    await expectClosed(input, { ...input.authority, readTargetInventory: async () => [] });
  });
  it('preserves explicit absent app owner without granting or inferring consent', async () => {
    const input = fixture('live_upgrade', true);
    const absent: RestoreProcessingInventory = input.inventory.map((row) => ({
      ...row,
      app: { state: 'absent' },
    }));
    input.proof['owners'] = absent;
    expect(
      (
        await verifyRestoreProcessingProof(input.bytes(), {
          ...input.authority,
          readTargetInventory: async () => absent,
        })
      ).status,
    ).toBe('proof_verified');
  });
  it('requires independently expected source identity and observed schema/archive identities', async () => {
    const input = fixture('full_restore');
    await expectClosed(input, { ...input.authority, sourceSystemIdentifier: '999' });
    await expectClosed(input, {
      ...input.authority,
      readTargetSchemaFingerprint: async () => sha('self-pinned-wrong-schema'),
    });
    await expectClosed(input, { ...input.authority, readArchiveIdentity: async () => null });
    input.proof['archive'] = {
      backupId: randomUUID(),
      dumpSha256: sha('different-old-backup'),
      privateManifestSha256: sha('different-private-files'),
      completionVersionId: 'old-completion',
    };
    await expectClosed(input);
  });
  it('requires explicit per-kind zeros and exact decrypted tail counts rather than a signed total alone', async () => {
    const input = fixture('full_restore');
    const alteredCounts = Object.fromEntries(
      kinds.map((kind) => [kind, kind === 'ai_consent_transition' ? 1 : 0]),
    );
    const tail = input.proof['tail'];
    if (tail === null || typeof tail !== 'object' || Array.isArray(tail))
      throw new Error('Missing synthetic tail');
    input.proof['tail'] = {
      ...tail,
      counts: [{ ownerTag: input.inventory[0]?.ownerTag, counts: alteredCounts }],
    };
    await expectClosed(input);
    input.proof['tail'] = {
      ...tail,
      counts: [{ ownerTag: input.inventory[0]?.ownerTag, counts: { app_consent_transition: 1 } }],
    };
    await expectClosed(input);
  });
  it('rejects authenticated head coordinates that disagree with the exact last encrypted segment', async () => {
    const input = fixture('full_restore');
    const head = decodeSuppressionHead(input.headBytes, headKey);
    if (!head.segment) throw new Error('Missing synthetic final segment');
    const wrongHead = encodeSuppressionHead(
      { ...head, segment: { ...head.segment, fromLsn: '0/101' } },
      headKey,
    );
    const tail = input.proof['tail'];
    if (tail === null || typeof tail !== 'object' || Array.isArray(tail))
      throw new Error('Missing tail');
    input.proof['tail'] = { ...tail, headSha256: sha(wrongHead) };
    const remote = input.authority.remoteStore;
    if (!remote) throw new Error('Missing remote');
    await expectClosed(input, {
      ...input.authority,
      remoteStore: {
        ...remote,
        readHead: async () => ({ bytes: wrongHead, versionId: 'head-v1' }),
      },
    });
  });
  it('rejects inventory digest/count overflow and legacy complete:false candidates without promoting them', async () => {
    const input = fixture('live_upgrade');
    input.proof['owners'] = input.inventory.map((row) => ({
      ...row,
      inventories: { ...row.inventories, events: { count: 100001, sha256: sha('overflow') } },
    }));
    await expectClosed(input);
    const legacy = {
      kind: 'baseline-anchor-candidate',
      schemaVersion: 1,
      complete: false,
      restoreAccessAllowed: false,
    };
    expect(
      (
        await verifyRestoreProcessingProof(
          sign(legacy, proofKey, 'wm-restore-processing-proof-v1\0'),
          input.authority,
        )
      ).status,
    ).toBe('closed');
    expect(legacy).toEqual({
      kind: 'baseline-anchor-candidate',
      schemaVersion: 1,
      complete: false,
      restoreAccessAllowed: false,
    });
    const valid = fixture('live_upgrade');
    await expectClosed(valid, {
      ...valid.authority,
      readTargetInventory: async () =>
        valid.inventory.map((row) => ({
          ...row,
          inventories: {
            ...row.inventories,
            events: { count: 1, sha256: sha('different-observed-row') },
          },
        })),
    });
  });
  it.each([
    'head-version',
    'head-hash',
    'segment-version',
    'segment-bytes',
    'tag-owner',
    'remote-error',
  ] as const)(
    'rejects %s source transport failure with CLOSED and bounded errors',
    async (problem) => {
      const input = fixture('full_restore');
      const store = input.authority.remoteStore;
      if (!store) throw new Error('Missing synthetic remote');
      const head = async (): Promise<VersionedObject | null> =>
        problem === 'head-version'
          ? { bytes: input.headBytes, versionId: 'rolled-back-head' }
          : problem === 'head-hash'
            ? { bytes: Buffer.alloc(8), versionId: 'head-v1' }
            : store.readHead();
      const segment = async (): Promise<VersionedObject | null> => {
        if (problem === 'remote-error') throw new Error('private credentials must not be exposed');
        if (problem === 'segment-version')
          return { bytes: input.segment.bytes, versionId: 'foreign-version' };
        if (problem === 'segment-bytes')
          return { bytes: Buffer.alloc(input.segment.byteLength), versionId: 'segment-v1' };
        return store.readSegment('synthetic-segment', 'segment-v1');
      };
      await expectClosed(input, {
        ...input.authority,
        remoteStore: { readHead: head, readSegment: segment },
        tagOwner: problem === 'tag-owner' ? () => sha('foreign-owner') : sha,
      });
    },
  );
});
