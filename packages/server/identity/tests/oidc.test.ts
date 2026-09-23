import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcProvider } from '../src/oidc.js';

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

async function providerFixture() {
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
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
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
  const provider = await createOidcProvider(config);
  const checks = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
  };
  const authorize = new URL(await provider.authorizationUrl({ ...checks, reauthenticate: false }));
  expectedChallenge = authorize.searchParams.get('code_challenge') ?? '';
  nonce = checks.nonce;
  return {
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
