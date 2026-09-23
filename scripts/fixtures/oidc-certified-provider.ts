import { generateKeyPairSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Provider from 'oidc-provider';

/**
 * A locally hosted, OpenID Certified authorization server (panva/oidc-provider) — test-only.
 *
 * Unlike `oidc-provider.ts` (a hand-written fixture that re-shows an account chooser on every
 * request), this one is a real OP implementation: it keeps its own single sign-on session
 * cookie, stores grants, enforces PKCE and exact redirect URIs, publishes a JWKS and signs
 * with it, honours `prompt`, and implements RP-initiated logout. Its configuration mirrors
 * what docs/implementation/oidc-setup.md asks an operator to register: one confidential
 * client, `client_secret_basic`, authorization code + PKCE S256, `openid` scope, exact
 * redirect URI. The built-in development login (`devInteractions`, which accepts any
 * username without a password) is disabled; the login page below checks generated passwords.
 *
 * What this proves and does not prove is recorded in docs/implementation/progress/M2-01u.md:
 * it is a standards-conformant OP on loopback, not the production identity provider.
 */
export interface CertifiedOidcOptions {
  port?: number;
  /** Private signing JWKs, first one signs. Defaults to one fresh RS256 key. */
  signingKeys?: JsonWebKey[];
  /** Reuse a secret across a restart (key rotation); generated when absent. */
  clientSecret?: string;
}

export interface CertifiedOidc {
  issuer: string;
  clientId: string;
  /** Generated per start; never logged or written to the repository. */
  clientSecret: string;
  redirectUri: string;
  /** Generated per start. Kept in memory and handed only to the caller. */
  passwords: Record<'alice' | 'bob', string>;
  close(): Promise<void>;
}

export function createSigningKey(kid: string): JsonWebKey {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as JsonWebKey;
}

const accounts = ['alice', 'bob'] as const;
type Account = (typeof accounts)[number];
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
const digest = (value: string) => createHash('sha256').update(value).digest();

export async function startCertifiedOidc(
  options: CertifiedOidcOptions = {},
): Promise<CertifiedOidc> {
  const port = options.port ?? 4400;
  const issuer = `http://127.0.0.1:${port}`;
  const redirectUri = 'http://127.0.0.1:3100/bff/v1/auth/callback';
  const clientId = 'workout-e2e';
  // Includes characters that RFC 6749 §2.3.1 requires to be form-encoded inside HTTP Basic,
  // so a client that sends the raw secret is caught by a real server rather than tolerated.
  const clientSecret = options.clientSecret ?? `${randomBytes(24).toString('base64')}:%+/`;
  const passwords = {
    alice: randomBytes(18).toString('base64url'),
    bob: randomBytes(18).toString('base64url'),
  };
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        post_logout_redirect_uris: ['http://127.0.0.1:3100/account'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    jwks: { keys: options.signingKeys ?? [createSigningKey('certified-rs256-a')] },
    cookies: { keys: [randomBytes(32).toString('base64url')] },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: true },
      revocation: { enabled: false },
    },
    interactions: {
      url: (_context: unknown, interaction: { uid: string }) => `/interaction/${interaction.uid}`,
    },
    findAccount: (_context: unknown, id: string) =>
      (accounts as readonly string[]).includes(id)
        ? { accountId: id, claims: () => ({ sub: id }) }
        : undefined,
    claims: { openid: ['sub'] },
    ttl: {
      Session: 3600,
      Interaction: 600,
      Grant: 3600,
      AuthorizationCode: 60,
      IdToken: 300,
      AccessToken: 300,
    },
    renderError: (context: { type: string; body: string }, output: { error: string }) => {
      context.type = 'html';
      context.body = `<!doctype html><html lang="en"><head><title>Identity provider error</title></head><body><main><h1>Identity provider error</h1><p>${escape(output.error)}</p></main></body></html>`;
    },
  });
  const callback = provider.callback();

  async function form(request: IncomingMessage) {
    let input = '';
    for await (const chunk of request) {
      input += String(chunk);
      if (input.length > 4096) throw new Error('BODY_TOO_LARGE');
    }
    return new URLSearchParams(input);
  }
  function page(reply: ServerResponse, status: number, html: string) {
    reply.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    reply.end(html);
  }
  function passwordMatches(account: string, password: string) {
    if (!(accounts as readonly string[]).includes(account)) return false;
    return timingSafeEqual(digest(passwords[account as Account]), digest(password));
  }
  async function interaction(request: IncomingMessage, reply: ServerResponse) {
    const details = await provider.interactionDetails(request, reply);
    const { uid, prompt, params } = details;
    if (prompt.name === 'consent') {
      // A first-party confidential client: grant exactly what was asked, as an operator
      // would configure for its own application, instead of rendering a consent screen.
      const grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({
            accountId: details.session?.accountId,
            clientId: String(params['client_id']),
          });
      grant.addOIDCScope('openid');
      const grantId = await grant.save();
      await provider.interactionFinished(
        request,
        reply,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    if (request.method === 'POST') {
      const input = await form(request);
      if (input.get('action') === 'cancel') {
        await provider.interactionFinished(
          request,
          reply,
          { error: 'access_denied', error_description: 'End-User cancelled the sign-in' },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      const account = input.get('username') ?? '';
      if (!passwordMatches(account, input.get('password') ?? ''))
        return page(reply, 401, loginPage(uid, 'The username or password is incorrect.'));
      await provider.interactionFinished(
        request,
        reply,
        { login: { accountId: account } },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    return page(reply, 200, loginPage(uid, null));
  }
  function loginPage(uid: string, error: string | null) {
    return `<!doctype html><html lang="en"><head><title>Certified identity provider</title></head><body><main><h1>Certified identity provider sign-in</h1>${error === null ? '' : `<p role="alert">${escape(error)}</p>`}<form method="post" action="/interaction/${escape(uid)}"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit" name="action" value="login">Sign in</button><button type="submit" name="action" value="cancel">Cancel</button></form></main></body></html>`;
  }

  const server = createServer((request, reply) => {
    const path = new URL(request.url ?? '/', issuer).pathname;
    if (/^\/interaction\/[A-Za-z0-9_-]+$/.test(path)) {
      void interaction(request, reply).catch(() => {
        if (!reply.headersSent)
          page(
            reply,
            400,
            '<!doctype html><title>Interaction error</title><p>Interaction expired or invalid.</p>',
          );
        else reply.end();
      });
      return;
    }
    callback(request, reply);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    passwords,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
