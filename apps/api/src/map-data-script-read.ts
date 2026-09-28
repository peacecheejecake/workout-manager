import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** An index, never a request-supplied filesystem path, selects a manifest entry. */
export async function readPinnedMapDataScript(
  artifactDirectory: string,
  scripts: Readonly<Record<string, string>>,
  indexText: string,
): Promise<Buffer | null> {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(indexText)) return null;
  const entries = Object.entries(scripts).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const index = Number(indexText);
  const entry = entries[index];
  if (entry === undefined) return null;
  const [path, digest] = entry;
  if (!/^scripts\/[A-Za-z0-9/_.-]{1,120}$/.test(path) || path.split('/').includes('..'))
    return null;
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  const file = join(artifactDirectory, 'odbl-scripts', `${index}.txt`);
  try {
    const root = await realpath(artifactDirectory);
    const target = await realpath(file);
    if (!target.startsWith(root + sep) || !(await lstat(file)).isFile()) return null;
    const size = (await lstat(file)).size;
    if (size > 1024 * 1024) return null;
    const bytes = await readFile(file);
    if (bytes.byteLength > 1024 * 1024) return null;
    return createHash('sha256').update(bytes).digest('hex') === digest ? bytes : null;
  } catch {
    return null;
  }
}
