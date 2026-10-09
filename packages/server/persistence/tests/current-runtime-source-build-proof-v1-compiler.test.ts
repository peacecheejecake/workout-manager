import { it, expect } from 'vitest';
import { compileCurrentRuntimeSourceBuildProofV1 as entry } from '../src/current-runtime-source-build-proof-v1-compiler.js';
import { compileCurrentRuntimeSourceBuildProofV1 as implementation } from '../src/current-runtime-source-build-proof-v1.js';
it('uses the same guarded build implementation through the separately registered compiler entrypoint', () => {
  expect(entry).toBe(implementation);
  expect(() => entry('/', '../manifest', '0'.repeat(64))).toThrow('INVALID_INPUT');
});
