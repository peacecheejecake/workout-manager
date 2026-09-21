import { createHash } from 'node:crypto';
import { parseTrackFileWithDigest, type ParseTrackFileOptions } from '../src/parse';

/**
 * Synchronous parse for tests.
 *
 * The package itself must not import a Node built-in, so its only platform-neutral
 * digest is `crypto.subtle`, which is asynchronous. These tests assert throw behaviour
 * and boundary values on the synchronous core, so they inject the digest here instead.
 * `tests/digest.test.ts` is what proves the shipped digest matches this one.
 */
export const parseTrackFile = (bytes: Uint8Array, options: ParseTrackFileOptions = {}) =>
  parseTrackFileWithDigest(bytes, createHash('sha256').update(bytes).digest('hex'), options);
