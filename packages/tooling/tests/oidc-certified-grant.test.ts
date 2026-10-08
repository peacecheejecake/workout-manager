import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import type * as Http from 'node:http';
import { Socket } from 'node:net';
import { beforeEach, expect, it, vi } from 'vitest';
import { startCertifiedOidc } from '../../../scripts/fixtures/oidc-certified-provider.js';

// Exercise the actual interaction handler without binding a socket or fetching an OP.
const ports = vi.hoisted(() => ({
  handler: undefined as ((request: IncomingMessage, reply: ServerResponse) => void) | undefined,
  find: vi.fn(),
  constructor: vi.fn(),
  scope: vi.fn(),
  save: vi.fn(),
  details: vi.fn(),
  finished: vi.fn(),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof Http>()),
  createServer: (handler: (request: IncomingMessage, reply: ServerResponse) => void) => {
    ports.handler = handler;
    return {
      once: vi.fn(),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      closeAllConnections: vi.fn(),
      close: (closed: () => void) => closed(),
    };
  },
}));
vi.mock('oidc-provider', () => ({
  default: class {
    Grant = class {
      static find = ports.find;
      constructor(input: unknown) {
        ports.constructor(input);
      }
      addOIDCScope = ports.scope;
      save = ports.save;
    };
    interactionDetails = ports.details;
    interactionFinished = ports.finished;
    callback() {
      return vi.fn();
    }
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  ports.handler = undefined;
  ports.details.mockResolvedValue({
    uid: 'synthetic',
    prompt: { name: 'consent' },
    params: { client_id: 'workout-e2e' },
    session: { accountId: 'alice' },
    grantId: 'original-grant',
  });
  ports.save.mockResolvedValue('saved-grant');
});
async function scenario() {
  const provider = await startCertifiedOidc({ signingKeys: [] });
  const request = new IncomingMessage(new Socket());
  request.url = '/interaction/synthetic';
  request.method = 'GET';
  const reply = new ServerResponse(request);
  const head = vi.spyOn(reply, 'writeHead');
  const end = vi.spyOn(reply, 'end');
  assert.ok(ports.handler);
  ports.handler(request, reply);
  return { provider, request, head, end };
}
it('missing referenced grant ends with sanitized unavailable interaction, without minting consent', async () => {
  ports.find.mockResolvedValue(undefined);
  const { provider, request, head, end } = await scenario();
  try {
    await vi.waitFor(() => expect(end).toHaveBeenCalled());
    expect(head).toHaveBeenCalledWith(400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    expect(end).toHaveBeenCalledWith(
      '<!doctype html><title>Interaction error</title><p>Interaction expired or invalid.</p>',
    );
    expect(ports.find).toHaveBeenCalledWith('original-grant');
    expect(ports.constructor).not.toHaveBeenCalled();
    expect(ports.scope).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
    expect(ports.finished).not.toHaveBeenCalled();
  } finally {
    request.destroy();
    await provider.close();
  }
});
it('retains an existing valid grant and the original openid submission semantics', async () => {
  ports.find.mockResolvedValue({ addOIDCScope: ports.scope, save: ports.save });
  const { provider, request, head } = await scenario();
  try {
    await vi.waitFor(() => expect(ports.finished).toHaveBeenCalled());
    expect(ports.constructor).not.toHaveBeenCalled();
    expect(ports.scope).toHaveBeenCalledWith('openid');
    expect(ports.finished).toHaveBeenCalledWith(
      request,
      expect.any(ServerResponse),
      { consent: { grantId: 'saved-grant' } },
      { mergeWithLastSubmission: true },
    );
    expect(head).not.toHaveBeenCalled();
  } finally {
    request.destroy();
    await provider.close();
  }
});
it('creates a first grant only when interaction has no referenced grant ID', async () => {
  ports.details.mockResolvedValue({
    uid: 'synthetic',
    prompt: { name: 'consent' },
    params: { client_id: 'workout-e2e' },
    session: { accountId: 'alice' },
  });
  const { provider, request } = await scenario();
  try {
    await vi.waitFor(() => expect(ports.finished).toHaveBeenCalled());
    expect(ports.find).not.toHaveBeenCalled();
    expect(ports.constructor).toHaveBeenCalledWith({ accountId: 'alice', clientId: 'workout-e2e' });
    expect(ports.scope).toHaveBeenCalledWith('openid');
    expect(ports.save).toHaveBeenCalledTimes(1);
  } finally {
    request.destroy();
    await provider.close();
  }
});
