import { parseResourceCleanupWorkerConfig } from './config.js';
import { runResourceCleanupWorker } from './resource-cleanup-worker.js';

async function main(): Promise<void> {
  const config = parseResourceCleanupWorkerConfig(process.argv.slice(2), process.env);
  const result = await runResourceCleanupWorker(config);
  process.stdout.write(`${JSON.stringify({ kind: 'resource_object_cleanup_result', result })}\n`);
}

try {
  await main();
} catch {
  // Error objects may contain SQL, credentials, storage paths, or object keys.
  process.stderr.write('RESOURCE_OBJECT_CLEANUP_FAILED\n');
  process.exitCode = 1;
}
