import { parseCourseThumbnailWorkerConfig } from './config.js';
import { runCourseThumbnailWorker } from './course-thumbnail-worker.js';

/**
 * One bounded render per invocation.
 *
 * `SIGTERM`/`SIGINT` do not kill the process: they abort the run, which hands an unprepared
 * render's lease and attempt straight back instead of letting a restart hold the work for
 * the lease's whole term. A render that has already recorded its object reference is left to
 * the reaper, which is the only thing that can unwind a recorded name safely.
 */
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown.abort());

async function main(): Promise<void> {
  // Parsing belongs inside the guarded path: a rejected configuration carries the
  // connection string it rejected, and an unguarded throw would print it with a stack.
  const config = parseCourseThumbnailWorkerConfig(process.argv.slice(2), process.env);
  // The run's one event is its log line: outcome, run id and release (M2-01k-c2). It used
  // to be a separate `{kind, result}` line with neither a trace id nor a version.
  await runCourseThumbnailWorker(config, {
    shutdownSignal: shutdown.signal,
    logger: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
}

try {
  await main();
} catch {
  // Error objects may carry SQL, credentials, storage paths, or object keys. Keep the CLI
  // failure generic; the durable state is in the ledger.
  process.stderr.write('COURSE_THUMBNAIL_RENDER_FAILED\n');
  process.exitCode = 1;
}
