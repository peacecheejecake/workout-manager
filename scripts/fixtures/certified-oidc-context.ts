import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityApiPort } from './identity-api-port.js';
import { identityE2eRunId } from './identity-e2e-run.js';

/**
 * Where `IDENTITY_E2E_OIDC=certified` leaves the generated account passwords for the
 * browser spec: mode 0600, removed when the harness stops. Never committed or logged.
 */
export const certifiedOidcContextPath = join(
  tmpdir(),
  `workout-certified-oidc-e2e-${identityApiPort}-${identityE2eRunId}.json`,
);
