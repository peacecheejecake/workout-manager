import { randomUUID } from 'node:crypto';

import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
} from '@workout/server-coaching/runner';
import { createDatabase } from '@workout/server-persistence/database';
import { createCoachingRunWorkerStore } from '@workout/server-persistence/coaching-runs';
import { parseFixtureWorkerConfig } from './config.js';

const runId = randomUUID();
const configuredRelease = process.env['WORKOUT_RELEASE'];
const version =
  configuredRelease && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configuredRelease)
    ? configuredRelease
    : 'unreleased';

async function main(): Promise<void> {
  const config = parseFixtureWorkerConfig(process.argv.slice(2), process.env);
  const database = createDatabase({ connectionString: config.connectionString, max: 1 });
  try {
    const result = await runOneCoachingJob({
      athleteId: config.athleteId,
      store: createCoachingRunWorkerStore(database, {
        policy: config.policy,
        source: config.source,
      }),
      adapter: createDeterministicFixtureAdapter(config.source.fixtureId),
    });
    process.stdout.write(
      `${JSON.stringify({ kind: 'coaching_fixture_worker_result', result, runId, version })}\n`,
    );
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch {
  // Error objects may contain SQL, credentials, or evidence. Keep the CLI failure generic.
  process.stderr.write(
    `${JSON.stringify({ kind: 'coaching_fixture_worker_failed', runId, version })}\n`,
  );
  process.exitCode = 1;
}
