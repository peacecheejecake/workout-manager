/** Ports for one isolated identity E2E run. Defaults preserve the original fixture addresses. */
function configuredPort(name: string, fallback: number): number {
  const value = process.env[name] ?? String(fallback);
  if (!/^[0-9]{4,5}$/.test(value)) throw new Error(`INVALID_IDENTITY_E2E_PORT: ${name}`);
  const port = Number(value);
  if (port < 1024 || port > 65535) throw new Error(`INVALID_IDENTITY_E2E_PORT: ${name}`);
  return port;
}

export const identityWebPort = configuredPort('WORKOUT_IDENTITY_WEB_PORT', 3100);
export const identityMobilePort = configuredPort('WORKOUT_IDENTITY_MOBILE_PORT', 4200);
export const identityApiPort = configuredPort('WORKOUT_IDENTITY_API_PORT', 4300);
export const identityOidcPort = configuredPort('WORKOUT_IDENTITY_OIDC_PORT', 4400);
export const identityGarminPort = configuredPort('WORKOUT_IDENTITY_GARMIN_PORT', 4500);

if (
  new Set([
    identityWebPort,
    identityMobilePort,
    identityApiPort,
    identityOidcPort,
    identityGarminPort,
  ]).size !== 5
)
  throw new Error('IDENTITY_E2E_PORT_CONFLICT');

export const identityWebOrigin = `http://127.0.0.1:${identityWebPort}`;
export const identityMobileOrigin = `http://127.0.0.1:${identityMobilePort}`;
export const identityApiOrigin = `http://127.0.0.1:${identityApiPort}`;
export const identityOidcOrigin = `http://127.0.0.1:${identityOidcPort}`;
export const identityGarminOrigin = `http://127.0.0.1:${identityGarminPort}`;
