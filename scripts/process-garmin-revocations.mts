import { configuredGarmin } from '../packages/server/identity/src/garmin-config.ts';
import { processGarminRevocations } from '../packages/server/identity/src/garmin-service.ts';
import { createGarminRevocationStore } from '../packages/server/persistence/src/garmin.ts';

// Deployment scheduler invokes a bounded batch using a separate least-privilege DB role.
if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
  console.log('Usage: pnpm exec tsx scripts/process-garmin-revocations.mts --execute');
} else {
  try {
    const connectionString = process.env.GARMIN_WORKER_DATABASE_URL;
    const publicOrigin = process.env.PUBLIC_ORIGIN;
    if (!connectionString || !publicOrigin) throw new Error('MISSING_WORKER_CONFIGURATION');
    const databaseUrl = new URL(connectionString);
    const originUrl = new URL(publicOrigin);
    if (
      !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
      originUrl.protocol !== 'https:' ||
      originUrl.origin !== publicOrigin
    )
      throw new Error('INVALID_WORKER_CONFIGURATION');
    const configured = configuredGarmin(process.env, publicOrigin);
    if (!configured) throw new Error('GARMIN_NOT_CONFIGURED');
    const store = createGarminRevocationStore({ connectionString });
    try {
      const result = await processGarminRevocations({ store, ...configured, limit: 20 });
      console.log(JSON.stringify({ event: 'garmin_revocation_batch', ...result }));
    } finally {
      await store.close();
    }
  } catch {
    console.error(
      'Garmin revocation batch failed; check worker configuration and retry scheduling.',
    );
    process.exitCode = 1;
  }
}
