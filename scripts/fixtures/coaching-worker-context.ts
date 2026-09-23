import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityApiPort } from './identity-api-port.js';
import { identityE2eRunId } from './identity-e2e-run.js';

/** Private, short-lived connection details for the isolated identity E2E PostgreSQL cluster. */
export const coachingWorkerContextPath = join(
  tmpdir(),
  `workout-coaching-worker-e2e-${identityApiPort}-${identityE2eRunId}.json`,
);
