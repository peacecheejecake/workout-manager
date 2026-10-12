import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { SuppressionLedgerSourceBinding } from './suppression-ledger-config.js';

/**
 * Local head witness: the exact remote head (versionId, sha256) the next run must find, and
 * the sha256 of a head this worker is about to publish (`pendingHeadSha256`), written before
 * the conditional head write so an interrupted publish can be adopted only for those exact
 * bytes. It is not a remote witness and grants no restore authority.
 */
export type SuppressionHeadWitness = {
  schemaVersion: 1;
  captureId: string;
  relationProfile: SuppressionLedgerSourceBinding['relationProfile'];
  headVersionId: string | null;
  headSha256: string | null;
  pendingHeadSha256: string | null;
};

const MAX_WITNESS_BYTES = 4096;
const hash = /^[a-f0-9]{64}$/;
const fields = [
  'schemaVersion',
  'captureId',
  'relationProfile',
  'headVersionId',
  'headSha256',
  'pendingHeadSha256',
] as const;

function fail(): never {
  throw new Error('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED');
}

function checked(value: unknown): SuppressionHeadWitness {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).join(',') !== fields.join(',')) return fail();
  const versionId = body['headVersionId'];
  const sha = body['headSha256'];
  const pending = body['pendingHeadSha256'];
  if (
    body['schemaVersion'] !== 1 ||
    typeof body['captureId'] !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body['captureId']) ||
    (body['relationProfile'] !== 'suppression-physical-v7' &&
      body['relationProfile'] !== 'suppression-physical-v8') ||
    (versionId !== null &&
      (typeof versionId !== 'string' ||
        versionId.length < 1 ||
        versionId.length > 1000 ||
        versionId === 'null')) ||
    (sha !== null && (typeof sha !== 'string' || !hash.test(sha))) ||
    (pending !== null && (typeof pending !== 'string' || !hash.test(pending))) ||
    (versionId === null) !== (sha === null) ||
    (sha === null && pending === null) ||
    (sha !== null && sha === pending)
  )
    return fail();
  return body as SuppressionHeadWitness;
}

export function encodeSuppressionHeadWitness(witness: SuppressionHeadWitness): Buffer {
  const value = checked(witness);
  return Buffer.from(`${JSON.stringify(Object.fromEntries(fields.map((f) => [f, value[f]])))}\n`);
}

/** Reads the witness without following symlinks; null only when the file does not exist. */
export function readSuppressionHeadWitness(path: string): SuppressionHeadWitness | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    return fail();
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size < 2 ||
      stat.size > MAX_WITNESS_BYTES
    )
      return fail();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) return fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) return fail();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return fail();
    }
    const witness = checked(parsed);
    if (!encodeSuppressionHeadWitness(witness).equals(bytes)) return fail();
    return witness;
  } finally {
    closeSync(fd);
  }
}

/**
 * Durably replaces (or, with `create`, exclusively creates) the witness: an exclusive 0600
 * temporary file in the same directory, fsync, rename, directory fsync.
 */
export function writeSuppressionHeadWitness(
  path: string,
  witness: SuppressionHeadWitness,
  options: { create?: boolean } = {},
): void {
  const bytes = encodeSuppressionHeadWitness(witness);
  const directory = dirname(path);
  const temporary = join(directory, `${basename(path)}.tmp-${randomBytes(8).toString('hex')}`);
  let written = false;
  try {
    if (options.create) {
      // Exclusive claim of the final name; refuses an existing witness.
      const claim = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeAll(claim, bytes);
      } finally {
        closeSync(claim);
      }
      written = true;
    } else {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeAll(fd, bytes);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      written = true;
    }
    const dir = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    if (!written) rmSync(temporary, { force: true });
    return fail();
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}
