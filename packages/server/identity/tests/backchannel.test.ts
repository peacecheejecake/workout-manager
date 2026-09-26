import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcProvider } from '../src/oidc.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fixture() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let issuer = '';
  const server = createServer((request, response) => {
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
        }),
      );
    } else if (request.url === '/jwks') {
      response.end(
        JSON.stringify({
          keys: [
            {
              ...key.publicKey.export({ format: 'jwk' }),
              kid: 'key-a',
              alg: 'RS256',
              use: 'sig',
            },
          ],
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
  if (address === null || typeof address === 'string') throw new Error('No listener');
  issuer = `http://127.0.0.1:${address.port}`;
  const provider = await createOidcProvider({
    issuer,
    clientId: 'workout-client',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:4301/bff/v1/auth/callback',
    allowInsecureLocalhost: true,
  });
  const verify = provider.verifyLogoutToken;
  if (verify === undefined) throw new Error('Missing logout verifier');
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: issuer,
    aud: 'workout-client',
    iat: now,
    exp: now + 300,
    jti: 'logout-1',
    sub: 'athlete-subject',
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  };
  function jwt(claims: Record<string, unknown> = base, incorrectSignature = false) {
    const message = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-a' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(message),
      incorrectSignature ? wrongKey.privateKey : key.privateKey,
    );
    return `${message}.${signature.toString('base64url')}`;
  }
  return { verify, issuer, now, base, jwt };
}

describe('OIDC Back-Channel Logout Token verification', () => {
  it('accepts a signed subject token and hashes jti before storage', async () => {
    const data = await fixture();
    expect(await data.verify(data.jwt())).toEqual({
      issuer: data.issuer,
      subject: 'athlete-subject',
      jtiHash: createHash('sha256').update('logout-1').digest('hex'),
      issuedAt: new Date(data.now * 1000),
    });
    const { sub: _sub, ...sidOnly } = data.base;
    expect(await data.verify(data.jwt({ ...sidOnly, sid: 'op-session' }))).toMatchObject({
      providerSessionId: 'op-session',
    });
  });

  it('rejects wrong signature, issuer, audience, age, nonce, event, and missing target', async () => {
    const data = await fixture();
    const bad = [
      data.jwt(data.base, true),
      data.jwt({ ...data.base, iss: 'https://other.example' }),
      data.jwt({ ...data.base, aud: 'other-client' }),
      data.jwt({ ...data.base, iat: data.now - 360 }),
      data.jwt({ ...data.base, nonce: 'unexpected' }),
      data.jwt({
        ...data.base,
        events: { 'http://schemas.openid.net/event/backchannel-logout': { extra: true } },
      }),
      data.jwt({ ...data.base, events: {} }),
      data.jwt({ ...data.base, sub: undefined }),
      data.jwt({ ...data.base, jti: undefined }),
    ];
    for (const token of bad) await expect(data.verify(token)).rejects.toThrow();
  });
});
