import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Removes identity E2E hand-off files that a killed harness left behind.
 *
 * The harness writes one file per run (see `coaching-worker-context.ts` and
 * `certified-oidc-context.ts`) holding a database URL or fixture passwords, mode 0600, and
 * removes it on SIGTERM/SIGINT. A SIGKILL skips that, so the file stays in the temp directory.
 *
 * A file is removed only when all of these hold:
 * - its name is exactly one of the two hand-off patterns (port and run id as the harness
 *   writes them) — nothing else in the temp directory is touched;
 * - it is a regular file (never a symlink or directory) owned by the current user;
 * - its writer is gone: the file records the harness pid and that process no longer exists,
 *   and the file is older than {@link deadWriterGraceMs}; or the file records no pid (a
 *   harness from before the pid was recorded) and is older than {@link unknownWriterMaxAgeMs}.
 *
 * A running harness — including one started by another checkout on this machine — always
 * keeps its file: its pid is alive. A file written by an older harness that does not record
 * its pid is kept for a day, far longer than any identity run (the slowest observed full run
 * took under 10 minutes).
 */
export const handoffFilePattern =
  /^workout-(?:coaching-worker|certified-oidc)-e2e-\d{1,5}-[a-z0-9-]{1,64}\.json$/;
/** A dead writer's file is left alone this long, so a file mid-write is never read. */
export const deadWriterGraceMs = 60_000;
/** Files without a recorded writer are removed only after this age. */
export const unknownWriterMaxAgeMs = 24 * 60 * 60 * 1000;

export type HandoffSweepOptions = {
  directory?: string;
  now?: number;
  uid?: number;
  isAlive?: (pid: number) => boolean;
};

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function recordedWriter(path: string): Promise<number | null> {
  try {
    const content: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof content === 'object' &&
      content !== null &&
      'harnessPid' in content &&
      Number.isSafeInteger(content.harnessPid) &&
      typeof content.harnessPid === 'number' &&
      content.harnessPid > 0
    )
      return content.harnessPid;
  } catch {
    // Unreadable or partial: treated as having no recorded writer.
  }
  return null;
}

export type HandoffSweepResult = {
  removed: string[];
  /** Files it could not inspect or remove; the sweep never throws, so the harness still starts. */
  skipped: Array<{ name: string; reason: string }>;
};

function reason(error: unknown) {
  return error instanceof Error && 'code' in error ? String(error.code) : String(error);
}

export async function sweepStaleHandoffFiles(
  options: HandoffSweepOptions = {},
): Promise<HandoffSweepResult> {
  const directory = options.directory ?? tmpdir();
  const now = options.now ?? Date.now();
  const uid = options.uid ?? process.getuid?.();
  const isAlive = options.isAlive ?? processIsAlive;
  const result: HandoffSweepResult = { removed: [], skipped: [] };
  if (uid === undefined) return result;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    result.skipped.push({ name: directory, reason: reason(error) });
    return result;
  }
  for (const name of names) {
    if (!handoffFilePattern.test(name)) continue;
    const path = join(directory, name);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.uid !== uid) continue;
      const age = now - stats.mtimeMs;
      const writer = await recordedWriter(path);
      const stale =
        writer === null ? age > unknownWriterMaxAgeMs : age > deadWriterGraceMs && !isAlive(writer);
      if (!stale) continue;
      // unlink, never a recursive rm: if the name became a directory in the meantime, this
      // fails (EISDIR/EPERM) and the entry is only reported.
      await unlink(path);
      result.removed.push(name);
    } catch (error) {
      if (reason(error) === 'ENOENT') continue;
      result.skipped.push({ name, reason: reason(error) });
    }
  }
  return result;
}
