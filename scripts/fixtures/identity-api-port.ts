/** Test harness override only; never attaches to an existing API or database. */
const configuredPort = process.env.WORKOUT_IDENTITY_API_PORT ?? '4300';
if (!/^[0-9]{4,5}$/.test(configuredPort)) throw new Error('INVALID_IDENTITY_API_PORT');
export const identityApiPort = Number(configuredPort);
if (identityApiPort < 1024 || identityApiPort > 65535) throw new Error('INVALID_IDENTITY_API_PORT');
