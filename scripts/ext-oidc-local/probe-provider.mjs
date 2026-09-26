// Machine-checks the configured OIDC provider's public metadata. Prints no client id/secret.
import { loadEnv } from './env.mjs';

const env = loadEnv();
const issuer = new URL(env.OIDC_ISSUER);
console.log('env: PUBLIC_ORIGIN =', env.PUBLIC_ORIGIN);
console.log('env: ALLOW_INSECURE_LOCALHOST =', env.ALLOW_INSECURE_LOCALHOST);
console.log('env: OIDC_ISSUER =', issuer.href);
console.log('env: client id present =', Boolean(env.OIDC_CLIENT_ID), 'secret present =', Boolean(env.OIDC_CLIENT_SECRET));

const wellKnown = new URL(
  `${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`,
  issuer,
);
const res = await fetch(wellKnown, { signal: AbortSignal.timeout(10000) });
console.log('discovery HTTP', res.status, res.headers.get('content-type'));
const m = await res.json();
const pick = (k) => console.log(`  ${k}:`, JSON.stringify(m[k]));
console.log('issuer match (URL-normalized):', new URL(m.issuer).href === issuer.href, '| raw issuer:', m.issuer);
for (const k of [
  'authorization_endpoint',
  'token_endpoint',
  'userinfo_endpoint',
  'jwks_uri',
  'end_session_endpoint',
  'revocation_endpoint',
  'introspection_endpoint',
  'code_challenge_methods_supported',
  'token_endpoint_auth_methods_supported',
  'id_token_signing_alg_values_supported',
  'response_types_supported',
  'grant_types_supported',
  'scopes_supported',
  'claims_supported',
  'prompt_values_supported',
  'request_parameter_supported',
  'claims_parameter_supported',
  'backchannel_logout_supported',
  'backchannel_logout_session_supported',
  'frontchannel_logout_supported',
  'frontchannel_logout_session_supported',
  'authorization_response_iss_parameter_supported',
  'subject_types_supported',
  'ui_locales_supported',
])
  pick(k);
console.log('all keys:', Object.keys(m).sort().join(','));
const https = ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint'].map(
  (k) => [k, typeof m[k] === 'string' && new URL(m[k]).protocol === 'https:'],
);
console.log('https endpoints:', JSON.stringify(Object.fromEntries(https)));

const jwksRes = await fetch(m.jwks_uri, { signal: AbortSignal.timeout(10000) });
console.log('JWKS HTTP', jwksRes.status, 'cache-control:', jwksRes.headers.get('cache-control'));
const jwks = await jwksRes.json();
for (const key of jwks.keys ?? [])
  console.log('  key:', JSON.stringify({ kty: key.kty, alg: key.alg, use: key.use, kid: key.kid, crv: key.crv, nbits: key.n ? Buffer.from(key.n, 'base64url').length * 8 : undefined }));
