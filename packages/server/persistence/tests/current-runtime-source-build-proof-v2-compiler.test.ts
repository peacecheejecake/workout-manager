import { it, expect, vi } from 'vitest';
vi.mock('../src/current-runtime-source-build-proof-v2-pin.js', () => ({
  currentRuntimeSourceBuildProofV2AssetSha256: null,
}));
import { compileCurrentRuntimeSourceBuildProofV2 as entry } from '../src/current-runtime-source-build-proof-v2-compiler.js';
import { compileCurrentRuntimeSourceBuildProofV2 as implementation } from '../src/current-runtime-source-build-proof-v2.js';
it('uses the same guarded build implementation through the separately registered compiler entrypoint', () => {
  expect(entry).toBe(implementation);
  expect(() => entry('/', '../manifest', '0'.repeat(64))).toThrow('INVALID_INPUT');
});
