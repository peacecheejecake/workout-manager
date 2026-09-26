import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

it('starts the supervisor with a decoded module path, including a checkout path with spaces', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../scripts/ext-oidc-local/stack.mts', import.meta.url)),
    'utf8',
  );
  expect(source).toMatch(
    /\.\.\.process\.execArgv, fileURLToPath\(import\.meta\.url\), 'supervise'/,
  );

  const directory = mkdtempSync(join(tmpdir(), 'oidc stack path '));
  try {
    const script = join(directory, 'supervisor fixture.mjs');
    writeFileSync(script, "if (process.argv[2] !== 'supervise') process.exit(1);\n");
    const decoded = fileURLToPath(pathToFileURL(script));
    expect(decoded).toBe(script);
    expect(new URL(pathToFileURL(script)).pathname).toContain('%20');
    expect(spawnSync(process.execPath, [decoded, 'supervise']).status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
