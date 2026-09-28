import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Copy the exact build inputs into the immutable artifact, indexed without URL paths. */
export async function publishOdblScripts(root, destination, scripts) {
  const entries = Object.entries(scripts).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  await mkdir(join(destination, 'odbl-scripts'), { recursive: true });
  for (const [index, [path, digest]] of entries.entries()) {
    if (!/^scripts\/[A-Za-z0-9/_.-]{1,120}$/.test(path) || path.split('/').includes('..'))
      throw new Error('ODBL_SCRIPT_PATH_INVALID');
    const bytes = await readFile(join(root, path));
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('ODBL_SCRIPT_HASH_MISMATCH');
    await writeFile(join(destination, 'odbl-scripts', `${index}.txt`), bytes);
  }
}
