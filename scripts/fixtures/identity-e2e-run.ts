/**
 * The identity E2E run these files belong to.
 *
 * `playwright.identity.config.ts` sets `IDENTITY_E2E_RUN_ID` once per run; the harness and the
 * spec workers inherit it, so their hand-off files are private to that run. Without it every
 * harness on the machine shared one file per port, and a finishing harness — whose closers
 * remove the file only after its servers have released the ports — could delete the file a
 * newer harness had just written (every coaching spec then failed with ENOENT).
 */
const configured = process.env.IDENTITY_E2E_RUN_ID ?? 'default';
if (!/^[a-z0-9-]{1,64}$/.test(configured)) throw new Error('INVALID_IDENTITY_E2E_RUN_ID');
export const identityE2eRunId = configured;
