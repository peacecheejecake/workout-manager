import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const origin = 'http://127.0.0.1:4500';
export const fixtureGarmin = {
  clientId: 'workout-garmin-fixture',
  clientSecret: 'local-garmin-fixture-only',
  redirectUri: 'http://127.0.0.1:3100/bff/v1/integrations/garmin/callback',
  origin,
};
interface Attempt {
  state: string;
  challenge: string;
  expires: number;
}
const random = () => randomBytes(32).toString('base64url');

/** Local synthetic OAuth protocol fixture, never a Garmin connection or production server. */
export async function startFixtureGarmin() {
  const attempts = new Map<string, Attempt>();
  const codes = new Map<string, Attempt>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const json = (reply: ServerResponse, status: number, value: unknown) => {
    reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    reply.end(JSON.stringify(value));
  };
  const redirect = (reply: ServerResponse, attempt: Attempt, values: Record<string, string>) => {
    const url = new URL(fixtureGarmin.redirectUri);
    url.searchParams.set('state', attempt.state);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    reply.writeHead(302, { location: url.href, 'cache-control': 'no-store' });
    reply.end();
  };
  async function body(request: IncomingMessage) {
    let value = '';
    for await (const chunk of request) {
      value += String(chunk);
      if (value.length > 16384) throw new Error('FIXTURE_BODY_LIMIT');
    }
    return new URLSearchParams(value);
  }
  function tokens(reply: ServerResponse) {
    const accessToken = random();
    const refreshToken = random();
    access.add(accessToken);
    refresh.add(refreshToken);
    return json(reply, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: 'PARTNER_READ CONNECT_READ',
    });
  }
  async function route(request: IncomingMessage, reply: ServerResponse) {
    const url = new URL(request.url ?? '/', origin);
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const input = url.searchParams;
      if (
        input.get('client_id') !== fixtureGarmin.clientId ||
        input.get('redirect_uri') !== fixtureGarmin.redirectUri ||
        input.get('response_type') !== 'code' ||
        input.get('code_challenge_method') !== 'S256' ||
        !/^[\w-]{43}$/.test(input.get('code_challenge') ?? '') ||
        !/^[\w-]{43}$/.test(input.get('state') ?? '')
      )
        return json(reply, 400, { error: 'invalid_request' });
      const id = random();
      attempts.set(id, {
        state: input.get('state') ?? '',
        challenge: input.get('code_challenge') ?? '',
        expires: Date.now() + 60000,
      });
      reply.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      reply.end(
        `<!doctype html><html lang="ko"><head><title>로컬 Garmin OAuth 검증</title></head><body><main><h1>로컬 Garmin OAuth 검증</h1><p>실제 Garmin 로그인이나 데이터 연결이 아닌 합성 테스트 공급자입니다.</p><p><a href="/consent?id=${id}&amp;decision=allow">테스트 활동 공유 허용</a></p><p><a href="/consent?id=${id}&amp;decision=deny">테스트 연결 거절</a></p></main></body></html>`,
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/consent') {
      const id = url.searchParams.get('id') ?? '';
      const attempt = attempts.get(id);
      attempts.delete(id);
      const decision = url.searchParams.get('decision');
      if (!attempt || attempt.expires <= Date.now() || !['allow', 'deny'].includes(decision ?? ''))
        return json(reply, 400, { error: 'invalid_request' });
      if (decision === 'deny') return redirect(reply, attempt, { error: 'access_denied' });
      const code = random();
      codes.set(code, attempt);
      return redirect(reply, attempt, { code });
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const input = await body(request);
      if (
        input.get('client_id') !== fixtureGarmin.clientId ||
        input.get('client_secret') !== fixtureGarmin.clientSecret
      )
        return json(reply, 401, { error: 'invalid_client' });
      if (input.get('grant_type') === 'refresh_token') {
        const token = input.get('refresh_token') ?? '';
        if (!refresh.delete(token)) return json(reply, 400, { error: 'invalid_grant' });
        return tokens(reply);
      }
      const code = input.get('code') ?? '';
      const attempt = codes.get(code);
      codes.delete(code);
      if (
        input.get('grant_type') !== 'authorization_code' ||
        input.get('redirect_uri') !== fixtureGarmin.redirectUri ||
        !attempt ||
        attempt.expires <= Date.now() ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge
      )
        return json(reply, 400, { error: 'invalid_grant' });
      return tokens(reply);
    }
    if (!access.has(request.headers.authorization?.replace(/^Bearer /, '') ?? ''))
      return json(reply, 401, { error: 'invalid_token' });
    if (request.method === 'GET' && url.pathname === '/user/id')
      return json(reply, 200, { userId: 'synthetic-garmin-user' });
    if (request.method === 'GET' && url.pathname === '/user/permissions')
      return json(reply, 200, ['ACTIVITY_EXPORT']);
    if (request.method === 'DELETE' && url.pathname === '/user/registration') {
      access.clear();
      refresh.clear();
      reply.writeHead(204, { 'cache-control': 'no-store' });
      reply.end();
      return;
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
    server.listen(4500, '127.0.0.1', resolve);
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
