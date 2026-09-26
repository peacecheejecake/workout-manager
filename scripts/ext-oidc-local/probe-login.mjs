// Probes /bff/v1/auth/login through the web shell as a browser would. Prints no client id,
// state, nonce, code challenge or cookie value — only shapes and booleans.
import { loadEnv } from './env.mjs';

const env = loadEnv();
const discovery = await (
  await fetch(new URL('.well-known/openid-configuration', env.OIDC_ISSUER))
).json();

async function probe(label, cookie) {
  const res = await fetch('http://localhost:3100/bff/v1/auth/login', {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  console.log(`\n[${label}] HTTP ${res.status}`);
  const loc = new URL(res.headers.get('location'));
  const p = loc.searchParams;
  console.log(
    '  location = authorization_endpoint:',
    `${loc.origin}${loc.pathname}` === discovery.authorization_endpoint,
  );
  console.log('  params:', [...p.keys()].sort().join(','));
  console.log('  client_id matches env:', p.get('client_id') === env.OIDC_CLIENT_ID);
  console.log('  redirect_uri:', p.get('redirect_uri'));
  console.log('  response_type:', p.get('response_type'), ' scope:', p.get('scope'));
  console.log(
    '  code_challenge_method:',
    p.get('code_challenge_method'),
    ' code_challenge len:',
    p.get('code_challenge')?.length,
    ' base64url:',
    /^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? ''),
  );
  console.log('  state len:', p.get('state')?.length, ' nonce len:', p.get('nonce')?.length);
  console.log('  prompt:', p.get('prompt'), ' max_age:', p.get('max_age'));
  const setCookie = res.headers.getSetCookie();
  for (const c of setCookie)
    console.log(
      '  set-cookie:',
      c.replace(/=([^;]*)/, (_m, v) => (v ? '=<value>' : '=')),
    );
  // Ask the provider what it does with exactly this request (no credentials, no redirects followed).
  const op = await fetch(loc, { redirect: 'manual' });
  const opLoc = op.headers.get('location');
  let where = '(none)';
  if (opLoc) {
    const u = new URL(opLoc, loc);
    const isCallback = u.href.startsWith(p.get('redirect_uri'));
    where = isCallback
      ? `CALLBACK error=${u.searchParams.get('error')}`
      : `${u.origin}${u.pathname} (query keys: ${[...u.searchParams.keys()].join(',')})`;
  }
  console.log(`  provider answer: HTTP ${op.status} -> ${where}`);
  if (op.status === 200) {
    const body = await op.text();
    console.log('  provider body mentions error:', /error|invalid/i.test(body.slice(0, 5000)));
  }
}

await probe('first sign-in (no cookies)');
await probe('after app sign-out (signed-out marker cookie)', 'workout_signed_out=probe');
await probe('account switch (session cookie present)', 'workout_session=probe');
