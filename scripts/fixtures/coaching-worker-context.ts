import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityApiPort } from './identity-api-port.js';

/** Private, short-lived connection details for the isolated identity E2E PostgreSQL cluster. */
export const coachingWorkerContextPath = join(
  tmpdir(),
  `workout-coaching-worker-e2e-${identityApiPort}.json`,
);
