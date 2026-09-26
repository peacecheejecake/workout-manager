// Client authentication (client_secret_basic) and RP-initiated logout registration checks.
// Prints only fixed error codes / statuses, never the client id or secret.
import { loadEnv } from './env.mjs';
import { verifiedProviderTargets } from './provider-target.mjs';
import { safeError } from './safe-error.mjs';

const env = loadEnv();
const issuer = new URL(env.OIDC_ISSUER);
if (issuer.protocol !== 'https:') throw new Error('OIDC_PROBE_PROVIDER_MISMATCH');
const discovery = new URL('.well-known/openid-configuration', issuer);
const d = await (await fetch(discovery, { redirect: 'error' })).json();
const targets = verifiedProviderTargets(issuer.href, d);
const enc = (v) => encodeURIComponent(v).replace(/%20/g, '+');
async function token(label, id, secret) {
  const r = await fetch(targets.tokenEndpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Basic ${Buffer.from(`${enc(id)}:${enc(secret)}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'not-a-real-code',
      redirect_uri: `${env.PUBLIC_ORIGIN}/bff/v1/auth/callback`,
      code_verifier: 'a'.repeat(43),
    }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`[token ${label}] HTTP ${r.status} error=${safeError(j.error)}`);
}
await token('client_secret_basic, configured secret', env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET);
await token('client_secret_basic, wrong secret', env.OIDC_CLIENT_ID, `${env.OIDC_CLIENT_SECRET}x`);

async function endSession(label, postLogout) {
  const u = new URL(targets.endSessionEndpoint);
  u.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  u.searchParams.set('post_logout_redirect_uri', postLogout);
  const r = await fetch(u, { redirect: 'manual' });
  const loc = r.headers.get('location');
  const redirect = loc ? new URL(loc, u) : null;
  const registeredRedirect =
    redirect?.origin === new URL(postLogout).origin &&
    redirect.pathname === new URL(postLogout).pathname;
  console.log(
    `[end_session ${label}] HTTP ${r.status} registered_redirect=${registeredRedirect} error=${safeError(redirect?.searchParams.get('error'))}`,
  );
}
await endSession('registered /account (as the app sends it)', `${env.PUBLIC_ORIGIN}/account`);
await endSession('unregistered URI', `${env.PUBLIC_ORIGIN}/elsewhere`);
