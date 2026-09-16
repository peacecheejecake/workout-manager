import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const issuer = 'http://127.0.0.1:4400';
const redirectUri = 'http://127.0.0.1:3100/bff/v1/auth/callback';
export const fixtureOidc = {
  issuer,
  clientId: 'workout-e2e',
  clientSecret: 'local-fixture-only-secret',
  redirectUri,
};
interface Authorization {
  state: string;
  nonce: string;
  challenge: string;
  expires: number;
}
interface Code extends Authorization {
  subject: string;
}

/** Deliberately local test identity provider: never part of the production application. */
export async function startFixtureOidc() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fixture-rs256',
    alg: 'RS256',
    use: 'sig',
  };
  const pending = new Map<string, Authorization>();
  const codes = new Map<string, Code>();
  const random = () => randomBytes(32).toString('base64url');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const json = (reply: ServerResponse, status: number, value: unknown) => {
    reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    reply.end(JSON.stringify(value));
  };
  async function body(request: IncomingMessage) {
    let input = '';
    for await (const chunk of request) {
      input += String(chunk);
      if (input.length > 16_384) throw new Error('BODY_TOO_LARGE');
    }
    return new URLSearchParams(input);
  }
  async function route(request: IncomingMessage, reply: ServerResponse) {
    const url = new URL(request.url ?? '/', issuer);
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(reply, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (request.method === 'GET' && url.pathname === '/jwks')
      return json(reply, 200, { keys: [jwk] });
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const get = (key: string) => url.searchParams.get(key);
      const state = get('state');
      const nonce = get('nonce');
      const challenge = get('code_challenge');
      if (
        get('client_id') !== fixtureOidc.clientId ||
        get('redirect_uri') !== redirectUri ||
        get('response_type') !== 'code' ||
        get('scope') !== 'openid' ||
        get('code_challenge_method') !== 'S256' ||
        !state ||
        !nonce ||
        !challenge
      )
        return json(reply, 400, { error: 'invalid_request' });
      const id = random();
      pending.set(id, { state, nonce, challenge, expires: Date.now() + 60_000 });
      reply.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      reply.end(
        `<!doctype html><html lang="en"><head><title>Fixture identity provider</title></head><body><main><h1>Fixture identity provider</h1><p>Local synthetic accounts for automated verification.</p><p><a href="/choose?id=${id}&amp;subject=alice">Sign in as Alice</a></p><p><a href="/choose?id=${id}&amp;subject=bob">Sign in as Bob</a></p></main></body></html>`,
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/choose') {
      const id = url.searchParams.get('id') ?? '';
      const subject = url.searchParams.get('subject');
      const authorization = pending.get(id);
      pending.delete(id);
      if (
        !authorization ||
        authorization.expires <= Date.now() ||
        (subject !== 'alice' && subject !== 'bob')
      )
        return json(reply, 400, { error: 'invalid_request' });
      const code = random();
      codes.set(code, { ...authorization, subject });
      const destination = new URL(redirectUri);
      destination.searchParams.set('state', authorization.state);
      destination.searchParams.set('code', code);
      destination.searchParams.set('iss', issuer);
      reply.writeHead(302, { location: destination.href, 'cache-control': 'no-store' });
      reply.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const input = await body(request);
      const code = input.get('code') ?? '';
      const authorization = codes.get(code);
      codes.delete(code);
      const encodedCredentials = request.headers.authorization?.startsWith('Basic ')
        ? request.headers.authorization.slice(6)
        : '';
      const [encodedClient, encodedSecret] = Buffer.from(encodedCredentials, 'base64')
        .toString()
        .split(':');
      const decodeCredential = (value: string | undefined) =>
        decodeURIComponent((value ?? '').replaceAll('+', ' '));
      const authenticated =
        decodeCredential(encodedClient) === fixtureOidc.clientId &&
        decodeCredential(encodedSecret) === fixtureOidc.clientSecret;
      const failures = [
        authenticated ? null : 'client_authentication',
        input.get('grant_type') === 'authorization_code' ? null : 'grant_type',
        input.get('redirect_uri') === redirectUri ? null : 'redirect_uri',
        authorization === undefined ? 'code' : null,
        authorization !== undefined && authorization.expires > Date.now() ? null : 'expiry',
        authorization !== undefined &&
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') === authorization.challenge
          ? null
          : 'pkce',
      ].filter(Boolean);
      if (failures.length > 0 || authorization === undefined)
        return json(reply, 400, { error: 'invalid_grant', error_description: failures.join(',') });
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${encode({ iss: issuer, aud: fixtureOidc.clientId, sub: authorization.subject, nonce: authorization.nonce, iat: now, exp: now + 60 })}`;
      const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
      return json(reply, 200, {
        access_token: random(),
        token_type: 'Bearer',
        expires_in: 60,
        id_token: idToken,
      });
    }
    return json(reply, 404, { error: 'not_found' });
  }
  const server = createServer((request, reply) => {
    void route(request, reply).catch(() => {
      if (!reply.headersSent) json(reply, 500, { error: 'fixture_error' });
      else reply.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4400, '127.0.0.1', resolve);
  });
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
