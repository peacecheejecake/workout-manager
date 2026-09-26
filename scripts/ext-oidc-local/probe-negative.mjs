// Negative controls: does the provider refuse an unregistered redirect_uri / unknown client?
// (So that its acceptance of the app's request means something.) Prints no secrets.
import { safeError } from './safe-error.mjs';
const res = await fetch('http://localhost:3100/bff/v1/auth/login', { redirect: 'manual' });
const base = new URL(res.headers.get('location'));
async function ask(label, mutate) {
  const u = new URL(base);
  mutate(u.searchParams);
  const op = await fetch(u, { redirect: 'manual' });
  const loc = op.headers.get('location');
  const redirect = loc ? new URL(loc, u) : null;
  console.log(
    `[${label}] HTTP ${op.status} redirect=${redirect !== null} error=${safeError(redirect?.searchParams.get('error'))}`,
  );
}
await ask('as sent by the app', () => {});
await ask('redirect_uri not registered', (p) =>
  p.set('redirect_uri', 'http://localhost:3100/bff/v1/auth/other'),
);
await ask('unknown client_id', (p) => p.set('client_id', '000000000000000000'));
await ask('code_challenge_method=plain', (p) => p.set('code_challenge_method', 'plain'));
await ask('post-logout check skipped here', () => {});
