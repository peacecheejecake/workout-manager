import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createGarminCipher } from '../src/garmin-crypto.js';
import { createGarminProvider } from '../src/garmin-provider.js';
import {
  createGarminService,
  createUnconfiguredGarminService,
  processGarminRevocations,
  type GarminRevocationStore,
  type GarminStore,
  type GarminProvider,
} from '../src/garmin-service.js';
const cipher = createGarminCipher({
  activeKeyId: 'v1',
  keys: { v1: randomBytes(32).toString('base64') },
});
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
const grant = {
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresIn: 86400,
  refreshTokenExpiresIn: 7775998,
};
function fixture() {
  let attempt: Parameters<GarminStore['createAttempt']>[0] | null = null;
  const commit = vi.fn<GarminStore['commitConnection']>(async () => true);
  const queue = vi.fn<GarminStore['queueRevoke']>(async () => {});
  const store: GarminStore = {
    async createAttempt(input) {
      attempt = input;
      return { generation: 1 };
    },
    async consumeAttempt(input) {
      if (
        !attempt ||
        attempt.athleteId !== input.athleteId ||
        attempt.sessionId !== input.sessionId ||
        attempt.stateHash !== input.stateHash ||
        attempt.expiresAt <= input.now
      )
        return null;
      const result = { generation: 1, encryptedVerifier: attempt.encryptedVerifier };
      attempt = null;
      return result;
    },
    failAttempt: vi.fn(async () => {}),
    commitConnection: commit,
    status: async () => ({
      state: 'disconnected',
      generation: 0,
      userId: null,
      permissions: [],
      connectedAt: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    }),
    disconnect: vi.fn(async () => {}),
    queueRevoke: queue,
    leaseRefresh: async () => null,
    commitRefresh: async () => false,
    failRefresh: async () => {},
  };
  const provider: GarminProvider = {
    authorizationUrl: ({ state }) => `https://connect.garmin.com/oauth2Confirm?state=${state}`,
    exchange: vi.fn(async () => grant),
    refresh: vi.fn(async () => grant),
    identity: vi.fn(async () => ({ userId: 'garmin-user', permissions: ['ACTIVITY_EXPORT'] })),
    revoke: vi.fn(async () => {}),
  };
  let time = new Date('2026-09-16T00:00:00Z');
  const service = createGarminService({ store, provider, cipher, now: () => time });
  async function begin() {
    const result = await service.begin('athlete-a', 'session-a');
    return { state: new URL(result.authorizationUrl).searchParams.get('state'), code: 'code' };
  }
  return {
    service,
    store,
    provider,
    commit,
    queue,
    begin,
    expire() {
      time = new Date('2026-09-17T00:00:00Z');
    },
  };
}

describe('Garmin encrypted credentials and connection handshake', () => {
  it('binds authenticated ciphertext to key version, athlete and purpose', () => {
    const encrypted = cipher.encrypt('athlete-a', 'tokens', grant);
    expect(JSON.stringify(encrypted)).not.toContain('access-secret');
    expect(cipher.decrypt('athlete-a', 'tokens', encrypted)).toEqual(grant);
    expect(() => cipher.decrypt('athlete-b', 'tokens', encrypted)).toThrow();
    expect(() => cipher.decrypt('athlete-a', 'verifier', encrypted)).toThrow();
    expect(() =>
      cipher.decrypt('athlete-a', 'tokens', {
        ...encrypted,
        tag: randomBytes(16).toString('base64'),
      }),
    ).toThrow();
    expect(() => createGarminCipher({ activeKeyId: 'missing', keys: {} })).toThrow();
  });
  it('binds opaque state to the exact logged-in athlete/session, consumes once and stores only encrypted tokens', async () => {
    const data = fixture(),
      query = await data.begin();
    await expect(data.service.callback('athlete-a', 'switched-session', query)).rejects.toThrow(
      'GARMIN_CALLBACK_REJECTED',
    );
    expect(data.provider.exchange).not.toHaveBeenCalled();
    expect(await data.service.callback('athlete-a', 'session-a', query)).toBe('connected');
    const stored = data.commit.mock.calls[0]?.[0];
    expect(stored?.sessionId).toBe('session-a');
    expect(JSON.stringify(stored)).not.toContain('access-secret');
    await expect(data.service.callback('athlete-a', 'session-a', query)).rejects.toThrow(
      'GARMIN_CALLBACK_REJECTED',
    );
  });
  it('rejects expired/duplicate parameters and handles denial without exchanging a token', async () => {
    const data = fixture(),
      query = await data.begin();
    await expect(
      data.service.callback('athlete-a', 'session-a', {
        ...query,
        state: [query.state, query.state],
      }),
    ).rejects.toThrow();
    expect(
      await data.service.callback('athlete-a', 'session-a', {
        state: query.state,
        error: 'access_denied',
      }),
    ).toBe('denied');
    expect(data.provider.exchange).not.toHaveBeenCalled();
    const expired = await data.begin();
    data.expire();
    await expect(data.service.callback('athlete-a', 'session-a', expired)).rejects.toThrow();
  });
  it('quarantines an acquired grant without claiming connection when user lookup fails', async () => {
    const data = fixture(),
      query = await data.begin();
    vi.mocked(data.provider.identity).mockRejectedValue(new Error('lookup unavailable'));
    expect(await data.service.callback('athlete-a', 'session-a', query)).toBe('failed');
    expect(data.commit).not.toHaveBeenCalled();
    expect(data.queue).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect(data.provider.revoke).not.toHaveBeenCalled();
  });
  it('queues rotated credentials when disconnect wins the refresh commit race', async () => {
    const data = fixture();
    data.store.leaseRefresh = async () => ({
      generation: 1,
      userId: 'garmin-user',
      encryptedTokens: cipher.encrypt('athlete-a', 'tokens', {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
      }),
      accessExpiresAt: new Date('2026-09-16T00:00:00Z'),
      refreshExpiresAt: new Date('2026-09-17T00:00:00Z'),
    });
    await data.service.refresh('athlete-a');
    expect(data.provider.refresh).toHaveBeenCalledWith('refresh-secret');
    expect(data.queue).toHaveBeenCalledWith(expect.objectContaining({ userId: 'garmin-user' }));
    expect(data.provider.revoke).not.toHaveBeenCalled();
  });
  it('queues acquired credentials for durable revocation when logout/deletion fences the final commit', async () => {
    const data = fixture(),
      query = await data.begin();
    data.commit.mockResolvedValue(false);
    expect(await data.service.callback('athlete-a', 'session-a', query)).toBe('failed');
    expect(data.queue).toHaveBeenCalledTimes(1);
    expect(data.queue.mock.calls[0]?.[0].userId).toBe('garmin-user');
  });
});

it('uses the actual form PKCE/refresh/API protocol against a bounded local fixture without arbitrary scopes or redirects', async () => {
  const requests: { path: string; body: URLSearchParams; authorization: string | undefined }[] = [];
  let tokenMode: 'valid' | 'redirect' | 'large' = 'valid';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({
      path: request.url ?? '',
      body: new URLSearchParams(body),
      authorization: request.headers.authorization,
    });
    if (request.url === '/token') {
      if (tokenMode === 'redirect') {
        response.writeHead(302, { location: '/unexpected' });
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        tokenMode === 'large'
          ? 'x'.repeat(70000)
          : JSON.stringify({
              access_token: 'access-secret',
              refresh_token: 'rotated-secret',
              token_type: 'bearer',
              expires_in: 86400,
              refresh_token_expires_in: 7775998,
            }),
      );
    } else if (request.url === '/user/id') response.end(JSON.stringify({ userId: 'garmin-user' }));
    else if (request.url === '/user/permissions') response.end(JSON.stringify(['ACTIVITY_EXPORT']));
    else if (request.url === '/user/registration') {
      response.statusCode = 204;
      response.end();
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const options = {
    clientId: 'client',
    clientSecret: 'client-secret',
    redirectUri: 'http://127.0.0.1:3100/bff/v1/integrations/garmin/callback',
    allowInsecureLocalhost: true,
    fixtureOrigin: `http://127.0.0.1:${address.port}`,
  };
  const provider = createGarminProvider(options);
  const verifier = 'a'.repeat(43);
  const url = new URL(provider.authorizationUrl({ state: 'state', verifier }));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.has('scope')).toBe(false);
  expect((await provider.exchange({ code: 'code', verifier })).refreshToken).toBe('rotated-secret');
  expect(requests[0]?.body.get('client_secret')).toBe('client-secret');
  expect(requests[0]?.body.get('code_verifier')).toBe(verifier);
  expect(await provider.identity('access-secret')).toEqual({
    userId: 'garmin-user',
    permissions: ['ACTIVITY_EXPORT'],
  });
  await provider.refresh('refresh-secret');
  expect(
    [...requests]
      .reverse()
      .find((request) => request.path === '/token')
      ?.body.get('grant_type'),
  ).toBe('refresh_token');
  await provider.revoke('access-secret');
  expect(requests.at(-1)?.authorization).toBe('Bearer access-secret');
  tokenMode = 'redirect';
  await expect(provider.refresh('refresh-secret')).rejects.toThrow('GARMIN_PROVIDER_UNAVAILABLE');
  expect(requests.some((request) => request.path === '/unexpected')).toBe(false);
  tokenMode = 'large';
  await expect(provider.refresh('refresh-secret')).rejects.toThrow('GARMIN_PROVIDER_UNAVAILABLE');
  expect(() =>
    createGarminProvider({ ...options, fixtureOrigin: 'http://evil.example' }),
  ).toThrow();
  expect(() => createGarminProvider({ ...options, allowInsecureLocalhost: false })).toThrow();
});

function workerFixture() {
  const { provider } = fixture();
  const now = new Date('2026-09-16T00:00:00Z');
  const job = {
    id: 'job',
    athleteId: 'athlete-a',
    encryptedTokens: cipher.encrypt('athlete-a', 'tokens', {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
    }),
    accessExpiresAt: new Date(now.getTime() + 3600000),
    refreshExpiresAt: new Date(now.getTime() + 7200000),
    expiresAt: new Date(now.getTime() + 86400000),
  };
  const store: GarminRevocationStore = {
    leaseRevocation: vi.fn(async () => job),
    prepareRevocation: vi.fn(async () => true),
    updateRevocationTokens: vi.fn(async () => true),
    finishRevocation: vi.fn(async () => {}),
  };
  const run = () => processGarminRevocations({ store, provider, cipher, now: () => now, limit: 1 });
  return { store, provider, job, now, run };
}

describe('durable Garmin revocation safety', () => {
  it('does not revoke an unidentified orphan registration and retains it for bounded retry', async () => {
    const data = workerFixture();
    vi.mocked(data.provider.identity).mockRejectedValue(new Error('unavailable'));
    await data.run();
    expect(data.store.prepareRevocation).not.toHaveBeenCalled();
    expect(data.provider.revoke).not.toHaveBeenCalled();
    expect(data.store.finishRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });
  it('does not revoke another active owner when preparation rejects the orphan', async () => {
    const data = workerFixture();
    vi.mocked(data.store.prepareRevocation).mockResolvedValue(false);
    await data.run();
    expect(data.store.prepareRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'garmin-user' }),
    );
    expect(data.provider.revoke).not.toHaveBeenCalled();
    expect(data.store.finishRevocation).not.toHaveBeenCalled();
  });
  it('persists a rotated refresh token before preparing and revoking the registration', async () => {
    const data = workerFixture();
    data.job.accessExpiresAt = data.now;
    const events: string[] = [];
    vi.mocked(data.store.updateRevocationTokens).mockImplementation(async (input) => {
      events.push('persist');
      expect(cipher.decrypt('athlete-a', 'tokens', input.encryptedTokens)).toEqual({
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
      });
      return true;
    });
    vi.mocked(data.store.prepareRevocation).mockImplementation(async () => {
      events.push('prepare');
      return true;
    });
    vi.mocked(data.provider.revoke).mockImplementation(async () => {
      events.push('revoke');
    });
    await data.run();
    expect(events).toEqual(['persist', 'prepare', 'revoke']);
    expect(data.store.finishRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
  it('does not revoke after a refresh lease is lost', async () => {
    const data = workerFixture();
    data.job.accessExpiresAt = data.now;
    vi.mocked(data.store.updateRevocationTokens).mockResolvedValue(false);
    await data.run();
    expect(data.provider.revoke).not.toHaveBeenCalled();
    expect(data.store.finishRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });
});

it('preserves durable connection status and allows local disconnect without provider configuration', async () => {
  const { store } = fixture();
  store.status = async () => ({
    state: 'connected',
    generation: 1,
    userId: 'garmin-user',
    permissions: ['ACTIVITY_EXPORT'],
    connectedAt: new Date('2026-09-16T00:00:00Z'),
    accessExpiresAt: null,
    refreshExpiresAt: null,
  });
  const service = createUnconfiguredGarminService(store);
  expect(await service.status('athlete-a')).toMatchObject({
    configured: false,
    state: 'connected',
  });
  await expect(service.begin('athlete-a', 'session-a')).rejects.toThrow('GARMIN_NOT_CONFIGURED');
  await service.disconnect('athlete-a');
  expect(store.disconnect).toHaveBeenCalledWith(
    expect.objectContaining({ athleteId: 'athlete-a' }),
  );
});
