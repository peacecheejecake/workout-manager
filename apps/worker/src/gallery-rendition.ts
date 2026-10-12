import { randomUUID } from 'node:crypto';

import { parseGalleryRenditionWorkerConfig } from './config.js';
import { runGalleryRenditionWorker } from './gallery-rendition-run.js';

/**
 * One bounded derived-rendition run per invocation (M2-03c). An invalid configuration is
 * rejected before any connection, and a role without exactly the worker RPCs ends the run as
 * unavailable. `SIGTERM`/`SIGINT` abort the run so an in-flight job releases its lease.
 */
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown.abort());
const cliRunId = randomUUID();
const configuredRelease = process.env['WORKOUT_RELEASE'];
const version =
  configuredRelease && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configuredRelease)
    ? configuredRelease
    : 'unreleased';

async function main(): Promise<void> {
  // Parsing stays inside the guarded path: a rejected configuration carries the connection
  // string it rejected, and an unguarded throw would print it with a stack.
  const config = parseGalleryRenditionWorkerConfig(process.argv.slice(2), process.env);
  const event = await runGalleryRenditionWorker(config, {
    shutdownSignal: shutdown.signal,
    logger: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  });
  // A closed restore window is a scheduled skip, not a failure: the next invocation resumes.
  if (event.result !== 'completed' && event.result !== 'restore_closed') process.exitCode = 1;
}

try {
  await main();
} catch {
  // Error objects may carry SQL, credentials, storage paths or object keys.
  process.stderr.write(
    `${JSON.stringify({ kind: 'gallery_rendition_cli_failed', runId: cliRunId, version })}\n`,
  );
  process.exitCode = 1;
}
