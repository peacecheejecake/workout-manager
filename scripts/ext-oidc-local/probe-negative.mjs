// Negative controls: does the provider refuse an unregistered redirect_uri / unknown client?
// (So that its acceptance of the app's request means something.) Prints no secrets.
const res = await fetch('http://localhost:3100/bff/v1/auth/login', { redirect: 'manual' });
const base = new URL(res.headers.get('location'));
async function ask(label, mutate) {
  const u = new URL(base);
  mutate(u.searchParams);
  const op = await fetch(u, { redirect: 'manual' });
  const loc = op.headers.get('location');
  let where = '(none)';
  if (loc) {
    const l = new URL(loc, u);
    where = `${l.origin}${l.pathname} keys=${[...l.searchParams.keys()].join(',')}${l.searchParams.get('error') ? ` error=${l.searchParams.get('error')}` : ''}`;
  }
  let body = '';
  if (op.status !== 302) body = (await op.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.log(`[${label}] HTTP ${op.status} -> ${where} ${body}`);
}
await ask('as sent by the app', () => {});
await ask('redirect_uri not registered', (p) => p.set('redirect_uri', 'http://localhost:3100/bff/v1/auth/other'));
await ask('unknown client_id', (p) => p.set('client_id', '000000000000000000'));
await ask('code_challenge_method=plain', (p) => p.set('code_challenge_method', 'plain'));
await ask('post-logout check skipped here', () => {});
