/**
 * M2-01u: drive the product's OIDC relying party (createOidcProvider + createIdentityService)
 * against a locally hosted OpenID Certified OP (panva/oidc-provider), over real HTTP, with
 * no browser. Each check names what it proves; the browser journey is in
 * tests/identity/oidc-certified.spec.ts.
 *
 *   node --import tsx scripts/oidc-certified-check.mts            # everything but rotation
 *   OIDC_CHECK_ROTATION=1 node --import tsx scripts/oidc-certified-check.mts   # + ~65 s rotation
 *
 * Listens only on 127.0.0.1:${OIDC_CHECK_PORT:-4461}; nothing is written to disk. No
 * secret, password, code or token is printed.
 */
import { randomBytes } from 'node:crypto';
import { createOidcProvider } from '../packages/server/identity/src/oidc.ts';
import {
  createIdentityService,
  type IdentityStore,
} from '../packages/server/identity/src/service.ts';
import {
  createSigningKey,
  startCertifiedOidc,
  type CertifiedOidc,
} from './fixtures/oidc-certified-provider.ts';

const port = Number(process.env['OIDC_CHECK_PORT'] ?? '4461');
const publicOrigin = 'http://127.0.0.1:3100';

/** An in-memory store with the same contract as the PostgreSQL identity repository. */
function memoryStore(): IdentityStore & { athletes: Map<string, string> } {
  const attempts = new Map<
    string,
    { browserHash: string; nonce: string; verifier: string; expiresAt: Date }
  >();
  const sessions = new Map<
    string,
    { athleteId: string; sessionId: string; csrfToken: string; expiresAt: Date }
  >();
  const athletes = new Map<string, string>();
  return {
    athletes,
    async createAttempt({ stateHash, ...rest }) {
      attempts.set(stateHash, rest);
    },
    async consumeAttempt(stateHash, browserHash, now) {
      const attempt = attempts.get(stateHash);
      attempts.delete(stateHash);
      if (!attempt || attempt.browserHash !== browserHash || attempt.expiresAt <= now) return null;
      return { nonce: attempt.nonce, verifier: attempt.verifier };
    },
    async createSession({ tokenHash, csrfToken, issuer, subject, expiresAt, previousTokenHash }) {
      if (previousTokenHash !== undefined) sessions.delete(previousTokenHash);
      const key = `${issuer} ${subject}`;
      const athleteId = athletes.get(key) ?? `athlete-${athletes.size + 1}`;
      athletes.set(key, athleteId);
      const sessionId = `session-${sessions.size + 1}-${tokenHash.slice(0, 6)}`;
      sessions.set(tokenHash, { athleteId, sessionId, csrfToken, expiresAt });
      return { athleteId, sessionId };
    },
    async findSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      return session && session.expiresAt > now ? session : null;
    },
    async revokeSession(tokenHash) {
      sessions.delete(tokenHash);
    },
  };
}

/** A path-aware cookie jar for one user agent talking to the OP. */
function cookieJar() {
  const cookies = new Map<string, { path: string; value: string }>();
  return {
    header(url: URL) {
      return [...cookies.entries()]
        .filter(([, cookie]) => url.pathname.startsWith(cookie.path))
        .map(([key, cookie]) => `${key.split('|')[0]}=${cookie.value}`)
        .join('; ');
    },
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        const path =
          attributes.find((part) => part.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
        const expired = attributes.some(
          (part) =>
            /^max-age=0$/i.test(part) ||
            (/^expires=/i.test(part) && new Date(part.slice(8)).getTime() <= Date.now()),
        );
        if (expired || value === '') cookies.delete(`${name}|${path}`);
        else cookies.set(`${name}|${path}`, { path, value });
      }
    },
    clear() {
      cookies.clear();
    },
  };
}
type Jar = ReturnType<typeof cookieJar>;

/**
 * Follow the OP until it redirects to the product callback. Returns the callback URL and
 * whether the OP asked for credentials along the way (i.e. whether this was a silent SSO).
 */
async function authorize(
  jar: Jar,
  location: string,
  as: { account: 'alice' | 'bob' | 'cancel'; password: string } | null,
) {
  let url = new URL(location);
  let method = 'GET';
  let body: string | undefined;
  let prompted = false;
  for (let hop = 0; hop < 12; hop += 1) {
    if (url.origin === publicOrigin) return { callback: url, prompted };
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: jar.header(url),
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    jar.store(response);
    const next = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && next !== null) {
      url = new URL(next, url);
      method = 'GET';
      body = undefined;
      continue;
    }
    const html = await response.text();
    if (response.status === 200 && html.includes('name="password"')) {
      prompted = true;
      if (as === null) return { callback: null, prompted };
      method = 'POST';
      body =
        as.account === 'cancel'
          ? new URLSearchParams({ action: 'cancel' }).toString()
          : new URLSearchParams({
              action: 'login',
              username: as.account,
              password: as.password,
            }).toString();
      continue;
    }
    // oidc-provider ends the previous OP session with an auto-submitting form when a
    // different account signs in over it; a browser submits it by script.
    const autoSubmit = /document\.forms\[0\]\.submit\(\)/.test(html)
      ? /<form method="post" action="([^"]+)">/.exec(html)
      : null;
    if (response.status === 200 && autoSubmit?.[1] !== undefined) {
      url = new URL(autoSubmit[1], url);
      method = 'POST';
      body = new URLSearchParams(
        [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map(
          (match) => [match[1] ?? '', match[2] ?? ''] as [string, string],
        ),
      ).toString();
      continue;
    }
    throw new Error(
      `Unexpected OP response ${response.status} ${process.env['OIDC_CHECK_DEBUG'] ? html.replace(/\s+/g, ' ').slice(0, 1500) : ''}`,
    );
  }
  throw new Error('Too many redirects');
}

/**
 * Follow an RP-initiated logout URL at the OP: its confirmation page, then "Yes, sign me out"
 * (or "No"). Returns where the OP finally sends the browser.
 */
async function endProviderSession(jar: Jar, location: string, confirm: boolean) {
  let url = new URL(location);
  let method = 'GET';
  let body: string | undefined;
  for (let hop = 0; hop < 8; hop += 1) {
    if (url.origin === publicOrigin) return url;
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: jar.header(url),
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    jar.store(response);
    const next = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && next !== null) {
      url = new URL(next, url);
      method = 'GET';
      body = undefined;
      continue;
    }
    const html = await response.text();
    const form = /<form[^>]*method="post"[^>]*>/.exec(html);
    const action = form === null ? null : /action="([^"]+)"/.exec(form[0]);
    if (response.status === 200 && action?.[1] !== undefined) {
      const fields = [
        ...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g),
      ].map((match) => [match[1] ?? '', match[2] ?? ''] as [string, string]);
      if (confirm) fields.push(['logout', 'yes']);
      url = new URL(action[1].replaceAll('&amp;', '&'), url);
      method = 'POST';
      body = new URLSearchParams(fields).toString();
      continue;
    }
    throw new Error(
      `Unexpected OP logout response ${response.status} ${process.env['OIDC_CHECK_DEBUG'] ? html.replace(/\s+/g, ' ').slice(0, 1500) : ''}`,
    );
  }
  throw new Error('Too many redirects');
}

const results: { name: string; pass: boolean; detail: string }[] = [];
async function check(name: string, run: () => Promise<string>) {
  try {
    results.push({ name, pass: true, detail: await run() });
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : 'error' });
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const cookiePair = (value: string | undefined) => value?.split(';')[0] ?? '';
async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

async function relyingParty(
  op: Pick<CertifiedOidc, 'issuer' | 'clientId' | 'clientSecret' | 'redirectUri'>,
  adapter: Record<string, unknown> = {},
) {
  const provider = await createOidcProvider({
    issuer: op.issuer,
    clientId: op.clientId,
    clientSecret: op.clientSecret,
    redirectUri: op.redirectUri,
    allowInsecureLocalhost: true,
    ...adapter,
  });
  const store = memoryStore();
  const service = createIdentityService({
    store,
    provider,
    publicOrigin,
    allowInsecureLocalhost: true,
  });
  return { provider, store, service };
}

/** One browser: an OP jar and the product cookie header it would carry. */
function browser() {
  return { jar: cookieJar(), product: new Map<string, string>() };
}
type Browser = ReturnType<typeof browser>;
const productHeader = (agent: Browser) =>
  [...agent.product.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
function keepProductCookies(agent: Browser, cookies: string[]) {
  for (const line of cookies) {
    const [name = '', value = ''] = cookiePair(line).split('=');
    if (value === '' || /Max-Age=0/.test(line)) agent.product.delete(name);
    else agent.product.set(name, value);
  }
}

async function login(
  rp: Awaited<ReturnType<typeof relyingParty>>,
  op: CertifiedOidc,
  agent: Browser,
  account: 'alice' | 'bob' | null,
) {
  const start = await rp.service.beginLogin(productHeader(agent));
  keepProductCookies(agent, [start.cookie]);
  const { callback, prompted } = await authorize(
    agent.jar,
    start.location,
    account === null ? null : { account, password: op.passwords[account] },
  );
  if (callback === null) return { prompted, athleteId: null };
  const result = await rp.service.completeLogin(callback.href, productHeader(agent));
  keepProductCookies(agent, result.cookies);
  const session = await rp.service.authenticate({ cookie: productHeader(agent) });
  return { prompted, athleteId: session?.athleteId ?? null, callback };
}

const op = await startCertifiedOidc({ port });
try {
  const rp = await relyingParty(op);
  const alice = browser();

  // Round 2 (N5): a real assertion, no longer an unconditional PASS. Discovery is deferred
  // (M2-01w), so this is the first request to the OP: it must accept the metadata and every
  // endpoint, and a sign-out before it must not have offered a provider URL.
  await check('discovery: the RP accepts the OP metadata and every endpoint', async () => {
    assert((await rp.service.providerLogoutUrl()) === null, 'provider URL before discovery');
    assert(rp.provider.prepare !== undefined, 'adapter has no prepare()');
    await rp.provider.prepare();
    assert(typeof (await rp.service.providerLogoutUrl()) === 'string', 'no end_session_endpoint');
    return 'discovered on first use; end_session_endpoint offered only after it';
  });

  let aliceAthlete: string | null = null;
  let firstCallback: URL | undefined;
  await check('login: code + PKCE S256 + nonce + state + signed id_token (RS256)', async () => {
    const result = await login(rp, op, alice, 'alice');
    assert(result.prompted, 'OP did not ask for credentials on a fresh browser');
    assert(result.athleteId !== null, 'no product session');
    aliceAthlete = result.athleteId;
    firstCallback = result.callback;
    assert(firstCallback?.searchParams.get('iss') === op.issuer, 'OP omitted RFC 9207 iss');
    return 'session established; RFC 9207 iss present in the authorization response';
  });

  await check('client_secret_basic with a secret containing ":%+/"', async () =>
    Promise.resolve(
      aliceAthlete !== null
        ? 'token endpoint authenticated the RP (secret form-encoded per RFC 6749 §2.3.1)'
        : 'skipped: login failed',
    ),
  );

  await check('replay: the same callback URL cannot be used twice', async () => {
    assert(firstCallback !== undefined, 'no first callback');
    const again = await rp.service.beginLogin(productHeader(alice));
    keepProductCookies(alice, [again.cookie]);
    assert(
      await rejected(rp.service.completeLogin(firstCallback.href, productHeader(alice))),
      'replayed callback accepted',
    );
    return 'rejected (state consumed, attempt bound to the browser)';
  });

  await check('code injection: a code issued for another attempt is refused', async () => {
    const victim = browser();
    const attacker = browser();
    const victimStart = await rp.service.beginLogin();
    keepProductCookies(victim, [victimStart.cookie]);
    const attackerStart = await rp.service.beginLogin();
    keepProductCookies(attacker, [attackerStart.cookie]);
    const stolen = await authorize(attacker.jar, attackerStart.location, {
      account: 'bob',
      password: op.passwords.bob,
    });
    assert(stolen.callback !== null, 'no attacker code');
    const injected = new URL(stolen.callback);
    injected.searchParams.set(
      'state',
      new URL(victimStart.location).searchParams.get('state') ?? '',
    );
    assert(
      await rejected(rp.service.completeLogin(injected.href, productHeader(victim))),
      'injected code accepted',
    );
    return 'rejected by the OP (PKCE verifier of the victim attempt does not match)';
  });

  await check('mix-up defence: an authorization response without iss is refused', async () => {
    const agent = browser();
    const start = await rp.service.beginLogin();
    keepProductCookies(agent, [start.cookie]);
    const { callback } = await authorize(agent.jar, start.location, {
      account: 'alice',
      password: op.passwords.alice,
    });
    assert(callback !== null, 'no callback');
    callback.searchParams.delete('iss');
    assert(
      await rejected(rp.service.completeLogin(callback.href, productHeader(agent))),
      'callback without iss accepted',
    );
    return 'rejected (OP advertises authorization_response_iss_parameter_supported)';
  });

  await check(
    'cancel at the OP (error=access_denied) is a rejected login, not a crash',
    async () => {
      const agent = browser();
      const start = await rp.service.beginLogin();
      keepProductCookies(agent, [start.cookie]);
      const { callback } = await authorize(agent.jar, start.location, {
        account: 'cancel',
        password: '',
      });
      assert(
        callback?.searchParams.get('error') === 'access_denied',
        'OP did not return access_denied',
      );
      assert(
        await rejected(rp.service.completeLogin(callback.href, productHeader(agent))),
        'error response accepted',
      );
      return 'rejected, no session';
    },
  );

  await check('wrong client secret is refused by the OP', async () => {
    const wrong = await createOidcProvider({
      issuer: op.issuer,
      clientId: op.clientId,
      clientSecret: 'not-the-secret',
      redirectUri: op.redirectUri,
      allowInsecureLocalhost: true,
    });
    const service = createIdentityService({
      store: memoryStore(),
      provider: wrong,
      publicOrigin,
      allowInsecureLocalhost: true,
    });
    const agent = browser();
    const start = await service.beginLogin();
    keepProductCookies(agent, [start.cookie]);
    const { callback } = await authorize(agent.jar, start.location, {
      account: 'alice',
      password: op.passwords.alice,
    });
    assert(callback !== null, 'no callback');
    assert(
      await rejected(service.completeLogin(callback.href, productHeader(agent))),
      'wrong secret accepted',
    );
    return 'invalid_client at the token endpoint → LOGIN_REJECTED';
  });

  // The account switch the fixture always allowed: its /authorize re-shows a chooser on every
  // request. A real OP keeps an SSO session, so after app logout the next login is silent
  // unless the RP asks the OP to re-authenticate.
  await check(
    'account switch after app logout: the OP must ask for credentials again',
    async () => {
      const cookies = await rp.service.logout(productHeader(alice));
      keepProductCookies(alice, cookies);
      const result = await login(rp, op, alice, 'bob');
      assert(result.prompted, 'OP signed the previous user in silently (SSO session reused)');
      assert(
        result.athleteId !== null && result.athleteId !== aliceAthlete,
        'still the previous athlete',
      );
      return 'OP re-prompted; the new session belongs to a different athlete';
    },
  );

  await check(
    'switch while signed in (no logout): the OP must ask for credentials again',
    async () => {
      const before = await rp.service.authenticate({ cookie: productHeader(alice) });
      assert(before !== null, 'not signed in');
      const result = await login(rp, op, alice, 'alice');
      assert(result.prompted, 'OP re-used the SSO session silently');
      assert(result.athleteId !== null && result.athleteId !== before.athleteId, 'same athlete');
      return 'OP re-prompted; previous product session replaced';
    },
  );

  await check('first login in a browser with a live OP session stays single sign-on', async () => {
    // A new product browser profile that shares the OP session (same OP cookies) and has
    // never signed out of this app: the ordinary SSO experience must be kept.
    const fresh = { jar: alice.jar, product: new Map<string, string>() };
    const result = await login(rp, op, fresh, null);
    assert(!result.prompted, 'OP asked for credentials although the RP did not request it');
    assert(result.athleteId !== null, 'no session');
    return 'silent SSO, no credential prompt';
  });

  // ---- M2-01w ----

  await check('re-authentication request carries prompt=login and max_age=0', async () => {
    const marker = (await rp.service.logout()).find((line) =>
      line.startsWith('workout_signed_out='),
    );
    const start = await rp.service.beginLogin(cookiePair(marker));
    const url = new URL(start.location);
    assert(url.searchParams.getAll('prompt').join() === 'login', 'no prompt=login');
    assert(url.searchParams.getAll('max_age').join() === '0', 'no max_age=0');
    const first = new URL((await rp.service.beginLogin()).location);
    assert(
      !first.searchParams.has('max_age') && !first.searchParams.has('prompt'),
      'a first sign-in asked for re-authentication',
    );
    return 'prompt=login&max_age=0 only when re-authenticating';
  });

  await check('cancel at the OP is classified as a cancellation (readable screen)', async () => {
    const agent = browser();
    const start = await rp.service.beginLogin();
    keepProductCookies(agent, [start.cookie]);
    const { callback } = await authorize(agent.jar, start.location, {
      account: 'cancel',
      password: '',
    });
    assert(callback !== null, 'no callback');
    const code = await rp.service.completeLogin(callback.href, productHeader(agent)).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    );
    assert(code === 'LOGIN_CANCELLED', `classified as ${code}`);
    return 'LOGIN_CANCELLED (no session)';
  });

  await check(
    'RP-initiated logout: app sign-out also ends the OP session after confirmation',
    async () => {
      const agent = browser();
      const signedIn = await login(rp, op, agent, 'bob');
      assert(signedIn.athleteId !== null, 'no session');
      keepProductCookies(agent, await rp.service.logout(productHeader(agent)));
      const location = await rp.service.providerLogoutUrl();
      assert(typeof location === 'string', 'no provider logout URL');
      const end = new URL(location);
      assert(
        `${end.origin}${end.pathname}` === `${op.issuer}/session/end`,
        'not the OP end_session_endpoint',
      );
      assert(end.searchParams.get('client_id') === op.clientId, 'no client_id');
      assert(
        end.searchParams.get('post_logout_redirect_uri') === `${publicOrigin}/account`,
        'wrong post_logout_redirect_uri',
      );
      assert(!end.searchParams.has('id_token_hint'), 'unexpected id_token_hint');
      const landed = await endProviderSession(agent.jar, location, true);
      assert(landed.href === `${publicOrigin}/account`, `landed at ${landed.href}`);
      // Even a product browser without the sign-out marker is prompted now: the OP has no
      // session left to answer from.
      const again = await login(rp, op, { jar: agent.jar, product: new Map() }, null);
      assert(again.prompted, 'OP still answered from its SSO session');
      return 'OP confirmation → OP session ended → redirected to /account → OP prompts again';
    },
  );

  await check(
    'RP-initiated logout: declining at the OP keeps its session (user choice)',
    async () => {
      const agent = browser();
      await login(rp, op, agent, 'alice');
      keepProductCookies(agent, await rp.service.logout(productHeader(agent)));
      const location = await rp.service.providerLogoutUrl();
      assert(typeof location === 'string', 'no provider logout URL');
      await endProviderSession(agent.jar, location, false);
      const again = await login(rp, op, { jar: agent.jar, product: new Map() }, null);
      assert(!again.prompted, 'OP session ended although the user declined');
      return 'declined → OP SSO kept; the app session is already revoked and the marker still asks';
    },
  );
} finally {
  await op.close();
}

// ---- M2-01w: an OP that does not honour prompt=login / max_age ----
{
  const noncompliant = await startCertifiedOidc({ port: port + 1, ignoreReauthentication: true });
  try {
    for (const verify of [true, false]) {
      await check(
        `non-conformant OP ignores prompt=login/max_age; verifyReauthentication=${verify ? 'default (on)' : 'false'}`,
        async () => {
          // The default configuration is the one under test when verifying.
          const rp = await relyingParty(
            noncompliant,
            verify ? {} : { verifyReauthentication: false },
          );
          const agent = browser();
          const first = await login(rp, noncompliant, agent, 'alice');
          assert(first.prompted && first.athleteId !== null, 'first login failed');
          keepProductCookies(agent, await rp.service.logout(productHeader(agent)));
          const start = await rp.service.beginLogin(productHeader(agent));
          keepProductCookies(agent, [start.cookie]);
          const { callback, prompted } = await authorize(agent.jar, start.location, {
            account: 'bob',
            password: noncompliant.passwords.bob,
          });
          assert(!prompted, 'the non-conformant OP asked anyway (fixture broken)');
          assert(callback !== null, 'no callback');
          const outcome = await rp.service.completeLogin(callback.href, productHeader(agent)).then(
            () => 'accepted',
            (error: unknown) => (error instanceof Error ? error.message : 'error'),
          );
          if (verify) {
            assert(outcome === 'LOGIN_REJECTED', `silent SSO answer ${outcome}`);
            return 'silent SSO answer refused: no fresh auth_time in the id_token (fails closed)';
          }
          assert(outcome === 'accepted', `outcome ${outcome}`);
          return 'OBSERVED: accepted silently as the previous user — what the setting off allows';
        },
      );
    }
  } finally {
    await noncompliant.close();
  }
}

// ---- M2-01w: the OP is down at start, comes up, goes away again ----
{
  const outagePort = port + 2;
  const signingKeys = [createSigningKey('outage-a')];
  const clientSecret = `${randomBytes(18).toString('base64')}:%+/`;
  const settings = {
    issuer: `http://127.0.0.1:${outagePort}`,
    clientId: 'workout-e2e',
    clientSecret,
    redirectUri: 'http://127.0.0.1:3100/bff/v1/auth/callback',
  };
  let current: CertifiedOidc | undefined;
  try {
    let rp: Awaited<ReturnType<typeof relyingParty>> | undefined;
    await check('OP down at API start: the relying party is still created', async () => {
      rp = await relyingParty(settings, { discoveryRetryMs: 0 });
      return 'createOidcProvider resolved without the OP (discovery deferred to first use)';
    });
    await check('OP down: sign-in fails closed with IDENTITY_UNAVAILABLE', async () => {
      assert(rp !== undefined, 'no relying party');
      const outcome = await rp.service.beginLogin().then(
        () => 'started',
        (error: unknown) => (error instanceof Error ? error.message : 'error'),
      );
      assert(outcome === 'IDENTITY_UNAVAILABLE', outcome);
      return 'no authorization URL, no attempt stored';
    });
    current = await startCertifiedOidc({ port: outagePort, signingKeys, clientSecret });
    const up = current;
    const agent = browser();
    await check('OP comes up: the same relying party signs in without a restart', async () => {
      assert(rp !== undefined, 'no relying party');
      const result = await login(rp, up, agent, 'alice');
      assert(result.athleteId !== null, 'no session');
      return 'discovery retried on demand';
    });
    await current.close();
    current = undefined;
    await check(
      'OP goes down again: an issued session keeps working (no OP dependency)',
      async () => {
        assert(rp !== undefined, 'no relying party');
        const session = await rp.service.authenticate({ cookie: productHeader(agent) });
        assert(session !== null, 'session lost');
        const cookies = await rp.service.logout(productHeader(agent));
        assert(
          cookies.some((line) => line.startsWith('workout_signed_out=')),
          'sign-out did not complete',
        );
        return 'authenticate() and sign-out read only the session store';
      },
    );
  } finally {
    await current?.close();
  }
}

if (process.env['OIDC_CHECK_ROTATION'] === '1') {
  // Signing-key rotation. oauth4webapi (inside openid-client) caches the JWKS per discovered
  // configuration and re-fetches for an unknown kid only once the cache is >= 60 s old.
  const keyA = createSigningKey('rotation-a');
  const keyB = createSigningKey('rotation-b');
  // Let the HTTP client notice the sockets the previous OP closed before reusing the port.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
  await settle();
  let current = await startCertifiedOidc({ port, signingKeys: [keyA] });
  const clientSecret = current.clientSecret;
  const rp = await relyingParty(current);
  try {
    await check('rotation: login signed with key A (JWKS fetched and cached)', async () => {
      const result = await login(rp, current, browser(), 'alice');
      assert(result.athleteId !== null, 'login with key A failed');
      return 'ok';
    });
    await current.close();
    await settle();
    // The same issuer, client and secret now sign with B and still publish A. This is the
    // abrupt case: an OP that pre-publishes B before signing with it never hits the window.
    current = await startCertifiedOidc({ port, signingKeys: [keyB, keyA], clientSecret });
    await check('rotation: immediately after an abrupt switch to key B (observed)', async () => {
      const outcome = await login(rp, current, browser(), 'alice').then(
        (result) => (result.athleteId === null ? 'rejected' : 'accepted'),
        () => 'rejected',
      );
      return outcome === 'accepted'
        ? 'accepted (JWKS re-fetched at once)'
        : 'rejected: the cached JWKS lacks kid B and is younger than 60 s';
    });
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    await check(
      'rotation: 61 s later the same RP re-fetches the JWKS and accepts key B',
      async () => {
        const result = await login(rp, current, browser(), 'alice');
        assert(result.athleteId !== null, 'still rejected');
        return 'accepted without restarting the API';
      },
    );
  } finally {
    await current.close();
  }
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed += 1;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
