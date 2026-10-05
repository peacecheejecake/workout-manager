import { randomUUID } from 'node:crypto';

import { parseResourceCleanupWorkerConfig } from './config.js';
import { runResourceCleanupWorker } from './resource-cleanup-worker.js';

const runId = randomUUID();
const configuredRelease = process.env['WORKOUT_RELEASE'];
const version =
  configuredRelease && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configuredRelease)
    ? configuredRelease
    : 'unreleased';

async function main(): Promise<void> {
  const config = parseResourceCleanupWorkerConfig(process.argv.slice(2), process.env);
  const result = await runResourceCleanupWorker(config);
  process.stdout.write(
    `${JSON.stringify({ kind: 'resource_cleanup_result', result, runId, version })}\n`,
  );
}

try {
  await main();
} catch {
  // Error objects may contain SQL, credentials, storage paths, or object keys.
  process.stderr.write(`${JSON.stringify({ kind: 'resource_cleanup_failed', runId, version })}\n`);
  process.exitCode = 1;
}
