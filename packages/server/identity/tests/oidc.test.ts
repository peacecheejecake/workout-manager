import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcProvider, type OidcEvent } from '../src/oidc.js';
import { ProviderUnavailableError } from '../src/service.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

interface FixtureOptions {
  /** Discovery answers 503 while true. */
  down?: boolean;
  /** The `issuer` the discovery document claims, when not the real one. */
  claimedIssuer?: string;
  /** An advertised end_session_endpoint (relative to the issuer, or absolute). */
  endSession?: string;
  /** Advertise this authorization_endpoint instead of the real one. */
  authorizationEndpoint?: string;
  /** Do not sign in once while building the fixture (so nothing is discovered yet). */
  lazy?: boolean;
  adapter?: Record<string, unknown>;
}

async function providerFixture(fixtureOptions: FixtureOptions = {}) {
  let down = fixtureOptions.down ?? false;
  let discoveries = 0;
  let authTime: 'absent' | 'stale' | 'fresh' = 'absent';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
  let issuer = '';
  let expectedChallenge = '';
  let nonce = '';
  let invalid: 'nonce' | 'issuer' | 'audience' | 'expired' | 'signature' | null = null;
  let used = false;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') {
      discoveries += 1;
      if (down) {
        response.statusCode = 503;
        response.end('{}');
        return;
      }
      const endSession = fixtureOptions.endSession;
      response.end(
        JSON.stringify({
          issuer: fixtureOptions.claimedIssuer ?? issuer,
          ...(endSession === undefined
            ? {}
            : { end_session_endpoint: new URL(endSession, issuer).href }),
          authorization_endpoint: fixtureOptions.authorizationEndpoint ?? `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    } else if (request.url === '/jwks') response.end(JSON.stringify({ keys: [jwk] }));
    else if (request.url === '/token') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const parameters = new URLSearchParams(body);
      const challenge = createHash('sha256')
        .update(parameters.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        used ||
        parameters.get('code') !== 'valid-code' ||
        challenge !== expectedChallenge ||
        request.headers.authorization !==
          `Basic ${Buffer.from('client:secret').toString('base64')}` ||
        parameters.get('redirect_uri') !== 'http://127.0.0.1:4301/bff/v1/auth/callback'
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      used = true;
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: invalid === 'issuer' ? 'https://attacker.example' : issuer,
        sub: 'athlete-subject',
        aud: invalid === 'audience' ? 'other-client' : 'client',
        iat: now,
        exp: invalid === 'expired' ? now - 600 : now + 300,
        nonce: invalid === 'nonce' ? 'incorrect' : nonce,
        ...(authTime === 'absent' ? {} : { auth_time: authTime === 'fresh' ? now : now - 3600 }),
      };
      const encoded = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const signature = sign(
        'RSA-SHA256',
        Buffer.from(encoded),
        invalid === 'signature' ? otherKeys.privateKey : keys.privateKey,
      ).toString('base64url');
      response.end(
        JSON.stringify({
          access_token: 'provider-secret',
          token_type: 'Bearer',
          id_token: `${encoded}.${signature}`,
        }),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test address');
  issuer = `http://127.0.0.1:${address.port}`;
  const config = {
    issuer,
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:4301/bff/v1/auth/callback',
    allowInsecureLocalhost: true,
  };
  const events: OidcEvent[] = [];
  const provider = await createOidcProvider(
    { ...config, ...fixtureOptions.adapter },
    { onEvent: (event) => events.push(event) },
  );
  const checks = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    reauthenticate: false,
  };
  let authorize = new URL('about:blank');
  if (
    !down &&
    fixtureOptions.claimedIssuer === undefined &&
    fixtureOptions.authorizationEndpoint === undefined &&
    fixtureOptions.lazy !== true
  ) {
    authorize = new URL(await provider.authorizationUrl(checks));
    expectedChallenge = authorize.searchParams.get('code_challenge') ?? '';
  } else expectedChallenge = createHash('sha256').update(checks.verifier).digest('base64url');
  nonce = checks.nonce;
  return {
    setDown(value: boolean) {
      down = value;
    },
    discoveries: () => discoveries,
    events,
    setAuthTime(value: typeof authTime) {
      authTime = value;
    },
    provider,
    checks,
    authorize,
    issuer,
    config,
    callback: new URL(`${config.redirectUri}?code=valid-code&state=${checks.state}`),
    invalidate(value: typeof invalid) {
      invalid = value;
    },
  };
}

describe('standard OIDC adapter using a real local signed provider protocol', () => {
  it('discovers metadata, sends S256 PKCE and verifies signed claims without leaking provider tokens', async () => {
    const fixture = await providerFixture();
    expect(fixture.authorize.searchParams.get('scope')).toBe('openid');
    expect(fixture.authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(fixture.authorize.searchParams.get('nonce')).toBe(fixture.checks.nonce);
    expect(await fixture.provider.exchange(fixture.callback, fixture.checks)).toEqual({
      issuer: fixture.issuer,
      subject: 'athlete-subject',
    });
    await expect(fixture.provider.exchange(fixture.callback, fixture.checks)).rejects.toThrow();
  });
  it.each(['nonce', 'issuer', 'audience', 'expired', 'signature'] as const)(
    'rejects invalid %s claims',
    async (invalid) => {
      const fixture = await providerFixture();
      fixture.invalidate(invalid);
      await expect(fixture.provider.exchange(fixture.callback, fixture.checks)).rejects.toThrow();
    },
  );
  it('asks the provider to re-authenticate only when requested', async () => {
    const fixture = await providerFixture();
    expect(fixture.authorize.searchParams.has('prompt')).toBe(false);
    expect(fixture.authorize.searchParams.has('max_age')).toBe(false);
    const again = new URL(
      await fixture.provider.authorizationUrl({ ...fixture.checks, reauthenticate: true }),
    );
    expect(again.searchParams.getAll('prompt')).toEqual(['login']);
    expect(again.searchParams.getAll('max_age')).toEqual(['0']);
  });
  describe('M2-01w: proof that the provider re-authenticated (auth_time)', () => {
    it.each([
      ['absent', false],
      ['stale', false],
      ['fresh', true],
    ] as const)(
      'a re-authentication answer with %s auth_time is accepted: %s',
      async (time, ok) => {
        const fixture = await providerFixture();
        fixture.setAuthTime(time);
        const result = fixture.provider.exchange(fixture.callback, {
          ...fixture.checks,
          reauthenticate: true,
        });
        if (ok) await expect(result).resolves.toMatchObject({ subject: 'athlete-subject' });
        else await expect(result).rejects.toThrow();
      },
    );
    it('does not demand auth_time of a first sign-in', async () => {
      const fixture = await providerFixture();
      await expect(fixture.provider.exchange(fixture.callback, fixture.checks)).resolves.toEqual({
        issuer: fixture.issuer,
        subject: 'athlete-subject',
      });
    });
    it('can be turned off: no max_age, and a missing auth_time is accepted', async () => {
      const fixture = await providerFixture({ adapter: { verifyReauthentication: false } });
      const again = new URL(
        await fixture.provider.authorizationUrl({ ...fixture.checks, reauthenticate: true }),
      );
      expect(again.searchParams.getAll('prompt')).toEqual(['login']);
      expect(again.searchParams.has('max_age')).toBe(false);
      await expect(
        fixture.provider.exchange(fixture.callback, { ...fixture.checks, reauthenticate: true }),
      ).resolves.toMatchObject({ subject: 'athlete-subject' });
    });
  });
  describe('M2-01w: deferred discovery', () => {
    it('starts without the provider, fails sign-in closed, and waits before asking again', async () => {
      const fixture = await providerFixture({ down: true, adapter: { discoveryRetryMs: 60_000 } });
      await expect(fixture.provider.authorizationUrl(fixture.checks)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      await expect(
        fixture.provider.exchange(fixture.callback, fixture.checks),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(await fixture.provider.logoutUrl?.()).toBeNull();
      // Within the retry wait the provider is not asked again, and the failure is reported
      // once — for the attempt, not for each refused request.
      expect(fixture.discoveries()).toBe(1);
      expect(fixture.events).toEqual([{ event: 'oidc_discovery_failed', reason: 'network' }]);
    });
    it('retries after the wait, then signs in, and keeps a successful discovery', async () => {
      const fixture = await providerFixture({ down: true, adapter: { discoveryRetryMs: 0 } });
      await expect(fixture.provider.authorizationUrl(fixture.checks)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      fixture.setDown(false);
      const url = new URL(await fixture.provider.authorizationUrl(fixture.checks));
      expect(url.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(fixture.checks.verifier).digest('base64url'),
      );
      await expect(fixture.provider.exchange(fixture.callback, fixture.checks)).resolves.toEqual({
        issuer: fixture.issuer,
        subject: 'athlete-subject',
      });
      fixture.setDown(true);
      await expect(fixture.provider.authorizationUrl(fixture.checks)).resolves.toContain(
        '/authorize?',
      );
      expect(fixture.discoveries()).toBe(2);
    });
    it('shares one discovery between concurrent sign-ins', async () => {
      const fixture = await providerFixture({ down: true, adapter: { discoveryRetryMs: 0 } });
      fixture.setDown(false);
      await Promise.all([1, 2, 3].map(() => fixture.provider.authorizationUrl(fixture.checks)));
      expect(fixture.discoveries()).toBe(1);
    });
    it('never accepts a discovery document for another issuer, however often it retries', async () => {
      const fixture = await providerFixture({
        claimedIssuer: 'https://attacker.example',
        adapter: { discoveryRetryMs: 0 },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(fixture.provider.authorizationUrl(fixture.checks)).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
        await expect(
          fixture.provider.exchange(fixture.callback, fixture.checks),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
      }
      expect(fixture.discoveries()).toBe(6);
      expect(fixture.events).toEqual(
        Array.from({ length: 6 }, () => ({
          event: 'oidc_discovery_failed',
          reason: 'issuer_mismatch',
        })),
      );
    });
    it('reports why discovery failed as a fixed category', async () => {
      const insecure = await providerFixture({
        authorizationEndpoint: 'http://provider.example/authorize',
      });
      await expect(insecure.provider.authorizationUrl(insecure.checks)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(insecure.events).toEqual([
        { event: 'oidc_discovery_failed', reason: 'insecure_endpoint' },
      ]);
      const events: OidcEvent[] = [];
      const unreachable = await createOidcProvider(
        {
          issuer: 'http://127.0.0.1:1',
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://127.0.0.1:4301/bff/v1/auth/callback',
          allowInsecureLocalhost: true,
        },
        { onEvent: (event) => events.push(event) },
      );
      await expect(unreachable.prepare?.()).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(events).toEqual([{ event: 'oidc_discovery_failed', reason: 'network' }]);
      expect(JSON.stringify([...insecure.events, ...events])).not.toMatch(
        /provider\.example|127\.0\.0\.1/,
      );
    });
    it('still refuses a misconfigured issuer or callback at startup', async () => {
      const base = {
        clientId: 'client',
        clientSecret: 'secret',
        allowInsecureLocalhost: true,
      };
      await expect(
        createOidcProvider({
          ...base,
          issuer: 'http://provider.example',
          redirectUri: 'http://127.0.0.1:4301/bff/v1/auth/callback',
        }),
      ).rejects.toThrow();
      await expect(
        createOidcProvider({
          ...base,
          issuer: 'http://127.0.0.1:1',
          redirectUri: 'http://127.0.0.1:4301/elsewhere',
        }),
      ).rejects.toThrow();
    });
  });
  describe('M2-01w: RP-initiated logout', () => {
    it('offers the advertised end_session_endpoint with client_id and the account page', async () => {
      const fixture = await providerFixture({ endSession: '/logout' });
      const url = new URL((await fixture.provider.logoutUrl?.()) ?? 'about:blank');
      expect(`${url.origin}${url.pathname}`).toBe(`${fixture.issuer}/logout`);
      expect([...url.searchParams.keys()].sort()).toEqual([
        'client_id',
        'post_logout_redirect_uri',
      ]);
      expect(url.searchParams.get('client_id')).toBe('client');
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
        'http://127.0.0.1:4301/account',
      );
    });
    it('offers nothing when not advertised or turned off', async () => {
      expect(await (await providerFixture()).provider.logoutUrl?.()).toBeNull();
      const off = await providerFixture({
        endSession: '/logout',
        adapter: { providerLogout: false },
      });
      expect(await off.provider.logoutUrl?.()).toBeNull();
    });
    it('ignores a non-HTTPS end_session_endpoint: no provider logout, sign-in unaffected', async () => {
      const fixture = await providerFixture({ endSession: 'http://provider.example/logout' });
      await expect(fixture.provider.exchange(fixture.callback, fixture.checks)).resolves.toEqual({
        issuer: fixture.issuer,
        subject: 'athlete-subject',
      });
      expect(await fixture.provider.logoutUrl?.()).toBeNull();
      expect(fixture.events).toEqual([
        { event: 'oidc_provider_logout_disabled', reason: 'insecure_endpoint' },
      ]);
    });
    it('reads only cached metadata: sign-out never starts or waits for a discovery', async () => {
      const fixture = await providerFixture({ endSession: '/logout', lazy: true });
      expect(await fixture.provider.logoutUrl?.()).toBeNull();
      expect(fixture.discoveries()).toBe(0);
      await fixture.provider.authorizationUrl(fixture.checks);
      expect(await fixture.provider.logoutUrl?.()).toContain('/logout?');
      expect(fixture.discoveries()).toBe(1);
    });
  });
  it('rejects incorrect state and PKCE verifier', async () => {
    const fixture = await providerFixture();
    await expect(
      fixture.provider.exchange(fixture.callback, { ...fixture.checks, state: 'wrong-state' }),
    ).rejects.toThrow();
    await expect(
      fixture.provider.exchange(fixture.callback, { ...fixture.checks, verifier: 'a'.repeat(43) }),
    ).rejects.toThrow();
  });
  it('rejects plain HTTP unless explicitly loopback and rejects callback substitution', async () => {
    const fixture = await providerFixture();
    await expect(
      createOidcProvider({ ...fixture.config, allowInsecureLocalhost: false }),
    ).rejects.toThrow();
    await expect(
      createOidcProvider({ ...fixture.config, issuer: 'http://provider.example' }),
    ).rejects.toThrow();
    await expect(
      fixture.provider.exchange(
        new URL('https://attacker.example/bff/v1/auth/callback'),
        fixture.checks,
      ),
    ).rejects.toThrow();
  });
});
