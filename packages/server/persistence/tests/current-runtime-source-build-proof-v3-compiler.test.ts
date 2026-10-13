import { it, expect, vi } from 'vitest';
vi.mock('../src/current-runtime-source-build-proof-v3-pin.js', () => ({
  currentRuntimeSourceBuildProofV3AssetSha256: null,
}));
import { compileCurrentRuntimeSourceBuildProofV3 as entry } from '../src/current-runtime-source-build-proof-v3-compiler.js';
import { compileCurrentRuntimeSourceBuildProofV3 as implementation } from '../src/current-runtime-source-build-proof-v3.js';
it('uses the same guarded build implementation through the separately registered compiler entrypoint', () => {
  expect(entry).toBe(implementation);
  expect(() => entry('/', '../manifest', '0'.repeat(64))).toThrow('INVALID_INPUT');
});
