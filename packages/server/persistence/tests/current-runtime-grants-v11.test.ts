import { beforeEach, expect, it, vi } from 'vitest';
import {
  currentRuntimeV10RpcSourcePins,
  currentRuntimeV10OwnerOnlyPublicHelpers,
  currentRuntimeV10PrivateHelpers,
  currentRuntimeV10TriggerFunctions,
} from '../src/current-runtime-grants-v10.js';
import {
  currentRuntimeV11RpcSignatures,
  currentRuntimeV11RpcSourcePins,
  currentRuntimeV11WorkerRpcSignatures,
  currentRuntimeV11OwnerOnlyFunctions,
  currentRuntimeV11RuntimeTableGrants,
  currentRuntimeV11AiDispatcherTableGrants,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
  grantCurrentRuntimeV11ProfileIn,
  grantCurrentRuntimeV11GalleryWorkerIn,
  grantCurrentRuntimeV11AiDispatcherIn,
  grantCurrentRuntimeV11GalleryWorker,
} from '../src/current-runtime-grants-v11.js';
import {
  currentRuntimeV11FunctionPins,
  verifyCurrentRuntimeV11InstalledIn,
} from '../src/current-runtime-installation-v11.js';
import {
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationRuntimeReadTablesV1,
} from '../src/gallery-navigation-pins-v1.js';
import {
  galleryRenditionApiFunctionsV1,
  galleryRenditionWorkerFunctionsV1,
} from '../src/gallery-rendition-pins-v1.js';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';

vi.mock(import('../src/current-runtime-installation-v11.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV11InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV11InstalledIn);
beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue({ profileVersion: 11 } as never);
});
function rpcRows(signatures: readonly string[]) {
  return signatures.map((signature, index) => {
    const v10 = currentRuntimeV10RpcSourcePins.find((p) => p.signature === signature);
    const v11 = currentRuntimeV11FunctionPins.find((p) => p.signature === signature);
    return {
      ordinal: index + 1,
      signature,
      owned: true,
      language: v10?.language ?? v11?.language,
      result_type: v10?.result_type ?? v11?.returns,
      security_definer: v10?.security_definer ?? v11?.securityDefiner,
      volatility: v10?.volatility ?? v11?.volatility,
      source_sha256: v10?.prosrcSha256 ?? v11?.prosrcSha256,
      public_execute: false,
      safe_delegation: true,
      configuration: v10 ? [...v10.configuration] : ['search_path=pg_catalog, pg_temp'],
    };
  });
}
function fixture(
  options: { safe?: unknown; rpc?: (rows: unknown[]) => unknown[]; granted?: unknown } = {},
) {
  const statements: string[] = [];
  // The mock boundary is intentionally unknown; invalid observations exercise validation.
  const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];
  const tx: CurrentRuntimeInstallationTransaction = {
    async query(sql, values = []) {
      statements.push(sql);
      if (sql.includes('AS safe FROM pg_roles r'))
        return { rows: rowsOf([options.safe ?? { safe: true }]), rowCount: 1 };
      if (sql.startsWith('SELECT i.ordinal')) {
        const rows = rpcRows(values[0] as string[]);
        return { rows: rowsOf(options.rpc ? options.rpc(rows) : rows), rowCount: rows.length };
      }
      if (sql.includes('AS functions'))
        return {
          rows: rowsOf([options.granted ?? { functions: true, tables: true }]),
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, statements };
}
it('runtime roster: V10 roots42 + 7 navigation + 2 rendition reads; worker5 and owner-only are disjoint', () => {
  expect(currentRuntimeV11RpcSignatures).toHaveLength(51);
  expect(currentRuntimeV11RpcSourcePins.slice(0, 42)).toEqual(currentRuntimeV10RpcSourcePins);
  expect(currentRuntimeV11RpcSignatures.slice(42)).toEqual([
    ...galleryNavigationRuntimeFunctionsV1,
    ...galleryRenditionApiFunctionsV1,
  ]);
  expect(currentRuntimeV11WorkerRpcSignatures).toEqual(galleryRenditionWorkerFunctionsV1);
  expect(currentRuntimeV11GalleryWorkerRole).toBe('workout_gallery_rendition_worker');
  expect(currentRuntimeV11AiDispatcherRole).toBe('workout_ai_dispatcher');
  expect(currentRuntimeV11OwnerOnlyFunctions).toHaveLength(
    currentRuntimeV10OwnerOnlyPublicHelpers.length +
      currentRuntimeV10PrivateHelpers.length +
      currentRuntimeV10TriggerFunctions.length +
      54,
  );
  for (const s of [
    'public.open_restore_processing_admission_window(bigint,uuid,uuid)',
    'public.admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)',
    'public.close_restore_processing_exact(bigint,uuid,uuid,uuid)',
    'public.assert_restore_processing_closed(bigint,uuid,uuid)',
    'public.restore_processing_admission_roster()',
    'public.enqueue_gallery_renditions_v1(uuid)',
    'public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)',
  ])
    expect(currentRuntimeV11OwnerOnlyFunctions).toContain(s);
  // Restore admission stays read_/require_ (+ lock_) through migrate.ts; V11 grants none of it.
  expect(currentRuntimeV11RpcSignatures.filter((s) => s.includes('restore_processing'))).toEqual(
    [],
  );
  expect(currentRuntimeV11RuntimeTableGrants).toEqual([
    ...galleryNavigationRuntimeReadTablesV1.map((table) => ({ table, privileges: ['SELECT'] })),
    { table: 'ai_execution_job', privileges: ['SELECT', 'INSERT'] },
    { table: 'ai_synthetic_evidence_attestation', privileges: ['SELECT'] },
  ]);
  expect(currentRuntimeV11AiDispatcherTableGrants).toEqual([
    { table: 'ai_execution_job_disposition', privileges: ['SELECT', 'INSERT'] },
  ]);
});
it('runtime grant: locks, verify, principal safety and RPC pins precede exactly 51 EXECUTE + 6 table grants', async () => {
  const f = fixture();
  const result = await grantCurrentRuntimeV11ProfileIn(f.tx, 'workout_runtime');
  expect(result).toMatchObject({
    runtimeRole: 'workout_runtime',
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(f.statements.slice(0, 2)).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(verify).toHaveBeenCalledOnce();
  const grants = f.statements.filter((s) => s.startsWith('GRANT'));
  expect(grants).toHaveLength(57);
  expect(grants.slice(51)).toEqual([
    'GRANT SELECT ON public.gallery_album TO "workout_runtime"',
    'GRANT SELECT ON public.gallery_media_album_membership TO "workout_runtime"',
    'GRANT SELECT ON public.gallery_media_course_association TO "workout_runtime"',
    'GRANT SELECT ON public.gallery_album_deletion TO "workout_runtime"',
    'GRANT SELECT,INSERT ON public.ai_execution_job TO "workout_runtime"',
    'GRANT SELECT ON public.ai_synthetic_evidence_attestation TO "workout_runtime"',
  ]);
  const firstGrant = f.statements.findIndex((s) => s.startsWith('GRANT'));
  expect(f.statements.findIndex((s) => s.includes('AS safe FROM'))).toBeLessThan(firstGrant);
  expect(f.statements.findIndex((s) => s.startsWith('SELECT i.ordinal'))).toBeLessThan(firstGrant);
  expect(f.statements.at(-1)).toContain('AS functions');
  expect(grants.join('\n')).not.toContain('disposition');
  expect(grants.join('\n')).not.toMatch(/claim_gallery|settle_gallery|restore_processing/);
});
it('unsafe principal, RPC drift, failed post-grant check and overlapping names fail closed', async () => {
  for (const options of [
    { safe: { safe: false } },
    { safe: { safe: true, extra: true } },
    { rpc: (rows: unknown[]) => rows.slice(1) },
    {
      rpc: (rows: unknown[]) =>
        rows.map((r, i) => (i === 50 ? { ...(r as object), source_sha256: '0'.repeat(64) } : r)),
    },
    {
      rpc: (rows: unknown[]) =>
        rows.map((r, i) => (i === 44 ? { ...(r as object), public_execute: true } : r)),
    },
  ]) {
    const f = fixture(options);
    await expect(grantCurrentRuntimeV11ProfileIn(f.tx, 'workout_runtime')).rejects.toThrow(
      /CURRENT_RUNTIME_V11_(UNSAFE_ROLE|RPC_INVALID)/,
    );
    expect(f.statements.some((s) => s.startsWith('GRANT'))).toBe(false);
  }
  const unverified = fixture({ granted: { functions: true, tables: false } });
  await expect(grantCurrentRuntimeV11ProfileIn(unverified.tx, 'workout_runtime')).rejects.toThrow(
    'CURRENT_RUNTIME_V11_GRANT_UNVERIFIED',
  );
  for (const role of [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole]) {
    const f = fixture();
    await expect(grantCurrentRuntimeV11ProfileIn(f.tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    );
    expect(f.statements).toEqual([]);
  }
  for (const role of ['', 'Upper', 'x"; DROP', 'a'.repeat(64), 1])
    await expect(grantCurrentRuntimeV11ProfileIn(fixture().tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V11_INVALID_ROLE',
    );
  verify.mockRejectedValueOnce(Error('CURRENT_RUNTIME_V11_LEDGER_INVALID'));
  const refused = fixture();
  await expect(grantCurrentRuntimeV11ProfileIn(refused.tx, 'workout_runtime')).rejects.toThrow(
    'CURRENT_RUNTIME_V11_LEDGER_INVALID',
  );
  expect(refused.statements.some((s) => s.startsWith('GRANT'))).toBe(false);
});
it('worker and dispatcher grants require their fixed names and grant only their own objects', async () => {
  const w = fixture();
  const worker = await grantCurrentRuntimeV11GalleryWorkerIn(
    w.tx,
    'workout_gallery_rendition_worker',
  );
  expect(worker.grantedFunctions).toEqual(galleryRenditionWorkerFunctionsV1);
  expect(w.statements.filter((s) => s.startsWith('GRANT'))).toEqual(
    galleryRenditionWorkerFunctionsV1.map(
      (s) => `GRANT EXECUTE ON FUNCTION ${s} TO "workout_gallery_rendition_worker"`,
    ),
  );
  expect(w.statements.find((s) => s.includes('AS safe FROM'))).toContain('pg_auth_members');
  const d = fixture();
  await grantCurrentRuntimeV11AiDispatcherIn(d.tx, 'workout_ai_dispatcher');
  expect(d.statements.filter((s) => s.startsWith('GRANT'))).toEqual([
    'GRANT SELECT,INSERT ON public.ai_execution_job_disposition TO "workout_ai_dispatcher"',
  ]);
  for (const [run, role] of [
    [grantCurrentRuntimeV11GalleryWorkerIn, 'workout_runtime'],
    [grantCurrentRuntimeV11GalleryWorkerIn, 'workout_ai_dispatcher'],
    [grantCurrentRuntimeV11AiDispatcherIn, 'workout_gallery_rendition_worker'],
    [grantCurrentRuntimeV11AiDispatcherIn, 'workout_runtime'],
  ] as const) {
    const f = fixture();
    await expect(run(f.tx, role)).rejects.toThrow('CURRENT_RUNTIME_V11_INVALID_ROLE');
    expect(f.statements).toEqual([]);
  }
  await expect(grantCurrentRuntimeV11GalleryWorker('postgres://x', 'other')).rejects.toThrow(
    'CURRENT_RUNTIME_V11_INVALID_ROLE',
  );
  const unsafe = fixture({ safe: { safe: false } });
  await expect(
    grantCurrentRuntimeV11GalleryWorkerIn(unsafe.tx, 'workout_gallery_rendition_worker'),
  ).rejects.toThrow('CURRENT_RUNTIME_V11_UNSAFE_ROLE');
  expect(unsafe.statements.some((s) => s.startsWith('GRANT'))).toBe(false);
});
