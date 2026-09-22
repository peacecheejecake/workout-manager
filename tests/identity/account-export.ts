import assert from 'node:assert/strict';
import { accountExportSchema, type AccountExport } from '../../packages/contracts/src/operations';

/**
 * The account export version the product currently writes.
 *
 * Every identity spec that reads an export asserts this exact version, because an export
 * that silently changed shape is a contract change and must be noticed. That assertion
 * was previously copied into six specs as a literal, and when the export went v15 → v16 →
 * v17 → v18 all six were left behind and failed together. The literal lives here now, so
 * a version bump is one edit and the assertion each spec makes is unchanged.
 *
 * This is not a "whatever the server said" check: an unexpected version still fails.
 */
export const currentAccountExportVersion = 19;

export type CurrentAccountExport = Extract<AccountExport, { schemaVersion: 19 }>;

/**
 * Parse an export body against the contract and assert it is the current version, then
 * narrow it so a spec can read the collections that version carries.
 */
export function parseCurrentAccountExport(body: unknown): CurrentAccountExport {
  const artifact = accountExportSchema.parse(body);
  assert.equal(artifact.schemaVersion, currentAccountExportVersion);
  if (artifact.schemaVersion !== currentAccountExportVersion)
    throw new Error(`Expected account export v${currentAccountExportVersion}`);
  return artifact;
}
