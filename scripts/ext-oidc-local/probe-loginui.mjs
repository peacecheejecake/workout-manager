// What does the provider's login screen offer (e.g. a cancel/back control)? No credentials used.
import { createHash, randomBytes } from 'node:crypto';
import { loadEnv } from './env.mjs';

const env = loadEnv();
const d = await (await fetch(new URL('.well-known/openid-configuration', env.OIDC_ISSUER))).json();
const b64 = (b) => b.toString('base64url');
const verifier = b64(randomBytes(32));
const u = new URL(d.authorization_endpoint);
for (const [k, v] of Object.entries({
  client_id: env.OIDC_CLIENT_ID,
  redirect_uri: `${env.PUBLIC_ORIGIN}/bff/v1/auth/callback`,
  response_type: 'code',
  scope: 'openid',
  state: b64(randomBytes(32)),
  nonce: b64(randomBytes(32)),
  code_challenge: b64(createHash('sha256').update(verifier).digest()),
  code_challenge_method: 'S256',
  prompt: 'login',
  max_age: '0',
  ui_locales: 'ko',
}))
  u.searchParams.set(k, v);
let res = await fetch(u, { redirect: 'manual' });
let loc = new URL(res.headers.get('location'), u);
console.log('authorize ->', res.status, `${loc.origin}${loc.pathname}`);
res = await fetch(loc, { redirect: 'manual', headers: { 'accept-language': 'ko' } });
console.log('login page ->', res.status, new URL(res.headers.get('location') ?? '/', loc).pathname);
if (res.status >= 300 && res.status < 400) {
  loc = new URL(res.headers.get('location'), loc);
  res = await fetch(loc, { redirect: 'manual', headers: { 'accept-language': 'ko' } });
  console.log('next ->', res.status);
}
const html = await res.text();
const texts = new Set();
for (const m of html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
  const t = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) texts.add(`${m[1]}: ${t.slice(0, 60)}`);
}
console.log([...texts].join('\n'));
console.log('mentions cancel/back/취소/뒤로:', /cancel|back|취소|뒤로/i.test(html));
