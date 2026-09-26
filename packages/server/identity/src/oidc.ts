import * as client from 'openid-client';
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import { z } from 'zod';
import { ProviderUnavailableError, type OidcProvider } from './service.js';

const configSchema = z.strictObject({
  issuer: z.url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(4096),
  redirectUri: z.url(),
  allowInsecureLocalhost: z.boolean().default(false),
  /**
   * When re-authenticating (after an app sign-out or for an account switch), also send
   * `max_age=0` and refuse an ID Token without an `auth_time` from the last 30 s. This is how
   * the relying party knows the provider really asked for credentials instead of answering
   * from its SSO session. A provider that ignores `max_age` then fails those sign-ins, so the
   * operator can turn it off (M2-01w; the production provider is decided under EXT-OIDC).
   */
  verifyReauthentication: z.boolean().default(true),
  /** Offer the provider's `end_session_endpoint` (RP-initiated logout) after an app sign-out. */
  providerLogout: z.boolean().default(true),
  /** Minimum wait before another discovery attempt after a failed one. */
  discoveryRetryMs: z.number().int().min(0).max(300_000).default(5_000),
});

/**
 * Why discovery failed, as a fixed category — never the provider's response, URL or error
 * text. `network` includes a non-200 discovery answer (the provider is not serving it).
 */
export type DiscoveryFailureReason = 'issuer_mismatch' | 'insecure_endpoint' | 'network' | 'other';
export type OidcEvent =
  | { event: 'oidc_discovery_failed'; reason: DiscoveryFailureReason }
  | { event: 'oidc_provider_logout_disabled'; reason: 'insecure_endpoint' };
export interface OidcHooks {
  /** Called once per discovery attempt (not per request) with a fixed, non-secret event. */
  onEvent?(event: OidcEvent): void;
}

class DiscoveryFailure extends Error {
  constructor(readonly reason: DiscoveryFailureReason) {
    super(reason);
  }
}

function classify(error: unknown): DiscoveryFailureReason {
  if (error instanceof DiscoveryFailure) return error.reason;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED') return 'issuer_mismatch';
  if (code === 'OAUTH_HTTP_REQUEST_FORBIDDEN') return 'insecure_endpoint';
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') return 'network';
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      (error instanceof TypeError && error.message === 'fetch failed'))
  )
    return 'network';
  return 'other';
}

/**
 * Only operator-configured issuers are accepted; no user supplied discovery URLs.
 *
 * Discovery is deferred to first use and retried on demand (M2-01w): the API starts, and
 * already-issued sessions keep working, while the provider is unreachable. Every sign-in step
 * needs the discovered configuration, so without it sign-in fails closed
 * (`ProviderUnavailableError`) — there is no path that signs anyone in without it.
 * Configured values (issuer/redirect URL shape, HTTPS, callback path) are still refused at
 * startup; what only discovery can reveal (issuer mismatch, non-HTTPS endpoints) fails
 * sign-in closed and is reported through `hooks.onEvent` with a fixed reason.
 */
export async function createOidcProvider(
  input: unknown,
  hooks: OidcHooks = {},
): Promise<OidcProvider> {
  const options = configSchema.parse(input);
  const issuer = new URL(options.issuer);
  const redirect = new URL(options.redirectUri);
  const postLogoutRedirect = new URL('/account', redirect);
  function checkUrl(url: URL) {
    const local =
      options.allowInsecureLocalhost &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !local) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error('Invalid OIDC endpoint');
  }
  checkUrl(issuer);
  checkUrl(redirect);
  if (redirect.pathname !== '/bff/v1/auth/callback') throw new Error('Invalid OIDC callback');

  async function discover() {
    const config = await client.discovery(
      issuer,
      options.clientId,
      options.clientSecret,
      client.ClientSecretBasic(options.clientSecret),
      {
        timeout: 10,
        execute: options.allowInsecureLocalhost
          ? [client.allowInsecureRequests, client.enableNonRepudiationChecks]
          : [client.enableNonRepudiationChecks],
      },
    );
    const metadata = config.serverMetadata();
    // The library already compares the discovered issuer with the configured one, but it
    // makes host-specific exceptions (Entra ID, B2C). Ours has none.
    if (new URL(metadata.issuer).href !== issuer.href)
      throw new DiscoveryFailure('issuer_mismatch');
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ]) {
      if (typeof endpoint !== 'string') throw new DiscoveryFailure('other');
      try {
        checkUrl(new URL(endpoint));
      } catch {
        throw new DiscoveryFailure('insecure_endpoint');
      }
    }
    let endSession = false;
    if (options.providerLogout && typeof metadata.end_session_endpoint === 'string') {
      // An end-session URL may carry its own query (RP-Initiated Logout §2); nothing else
      // of `checkUrl` is relaxed. An unacceptable one only turns provider logout off:
      // sign-in does not depend on it.
      try {
        const bare = new URL(metadata.end_session_endpoint);
        bare.search = '';
        checkUrl(bare);
        endSession = true;
      } catch {
        hooks.onEvent?.({ event: 'oidc_provider_logout_disabled', reason: 'insecure_endpoint' });
      }
    }
    const permittedAlgorithms = ['RS256', 'PS256', 'ES256', 'ES384', 'ES512'].filter((algorithm) =>
      metadata.id_token_signing_alg_values_supported?.includes(algorithm),
    );
    if (permittedAlgorithms.length === 0) throw new DiscoveryFailure('other');
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== 'string') throw new DiscoveryFailure('other');
    const jwks = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      [customFetch]: async (url, request) => {
        try {
          const response = await fetch(url, request);
          if (response.status !== 200) throw new ProviderUnavailableError();
          await response.clone().json();
          return response;
        } catch {
          throw new ProviderUnavailableError();
        }
      },
    });
    return { config, metadata, endSession, permittedAlgorithms, jwks };
  }

  let current: ReturnType<typeof discover> | undefined;
  /** The successful discovery, once there is one; sign-out reads only this. */
  let resolved: Awaited<ReturnType<typeof discover>> | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;
  /** Shared in-flight attempt; success is kept, failure is forgotten after the retry wait. */
  function discovered() {
    if (current !== undefined) return current;
    if (Date.now() - failedAt < options.discoveryRetryMs)
      return Promise.reject(new ProviderUnavailableError());
    current = discover().then(
      (value) => {
        resolved = value;
        return value;
      },
      (error: unknown) => {
        current = undefined;
        failedAt = Date.now();
        hooks.onEvent?.({ event: 'oidc_discovery_failed', reason: classify(error) });
        throw new ProviderUnavailableError();
      },
    );
    return current;
  }

  return {
    async prepare() {
      await discovered();
    },
    async authorizationUrl({ state, nonce, verifier, reauthenticate }) {
      const { config } = await discovered();
      return client.buildAuthorizationUrl(config, {
        ...(reauthenticate
          ? { prompt: 'login', ...(options.verifyReauthentication ? { max_age: '0' } : {}) }
          : {}),
        redirect_uri: redirect.href,
        response_type: 'code',
        scope: 'openid',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }).href;
    },
    async exchange(url, checks) {
      if (`${url.origin}${url.pathname}` !== redirect.href) throw new Error('Invalid callback URL');
      const { config, metadata } = await discovered();
      const tokens = await client.authorizationCodeGrant(config, url, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.verifier,
        idTokenExpected: true,
        // max_age=0 was requested: `auth_time` becomes required and must be within the
        // library's 30 s clock tolerance of now.
        ...(checks.reauthenticate === true && options.verifyReauthentication ? { maxAge: 0 } : {}),
      });
      const claims = tokens.claims();
      if (
        claims === undefined ||
        claims.iss !== metadata.issuer ||
        typeof claims.sub !== 'string' ||
        claims.sub.length === 0 ||
        claims.sub.length > 255
      )
        throw new Error('Invalid OIDC identity');
      if (
        claims.sid !== undefined &&
        (typeof claims.sid !== 'string' || claims.sid.length === 0 || claims.sid.length > 255)
      )
        throw new Error('Invalid OIDC session');
      return {
        issuer: claims.iss,
        subject: claims.sub,
        ...(typeof claims.sid === 'string' ? { providerSessionId: claims.sid } : {}),
      };
    },
    async verifyLogoutToken(token) {
      if (token.length === 0 || token.length > 8_192) throw new Error('Invalid logout token');
      const { metadata, permittedAlgorithms, jwks } = await discovered();
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: metadata.issuer,
          audience: options.clientId,
          algorithms: permittedAlgorithms,
          clockTolerance: 60,
          requiredClaims: ['iat', 'jti'],
        }));
      } catch (error) {
        if (error instanceof errors.JWKSInvalid) throw new ProviderUnavailableError();
        throw error;
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const eventKey = 'http://schemas.openid.net/event/backchannel-logout';
      const event: unknown =
        typeof payload.events === 'object' && payload.events !== null
          ? Reflect.get(payload.events, eventKey)
          : undefined;
      if (
        typeof payload.iat !== 'number' ||
        !Number.isInteger(payload.iat) ||
        payload.iat > nowSeconds + 60 ||
        payload.iat < nowSeconds - 300 ||
        typeof payload.jti !== 'string' ||
        payload.jti.length === 0 ||
        payload.jti.length > 256 ||
        payload.nonce !== undefined ||
        typeof payload.events !== 'object' ||
        payload.events === null ||
        Array.isArray(payload.events) ||
        Object.keys(payload.events).length !== 1 ||
        !Object.hasOwn(payload.events, eventKey) ||
        typeof event !== 'object' ||
        event === null ||
        Array.isArray(event) ||
        Object.keys(event).length !== 0 ||
        (payload.sub === undefined && payload.sid === undefined) ||
        (payload.sub !== undefined &&
          (typeof payload.sub !== 'string' ||
            payload.sub.length === 0 ||
            payload.sub.length > 255)) ||
        (payload.sid !== undefined &&
          (typeof payload.sid !== 'string' || payload.sid.length === 0 || payload.sid.length > 255))
      )
        throw new Error('Invalid logout token');
      return {
        issuer: metadata.issuer,
        jtiHash: createHash('sha256').update(payload.jti).digest('hex'),
        issuedAt: new Date(payload.iat * 1000),
        ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
        ...(typeof payload.sid === 'string' ? { providerSessionId: payload.sid } : {}),
      };
    },
    async logoutUrl() {
      // Cached metadata only: sign-out never waits on (or starts) a discovery. Without a
      // successful discovery there is simply no provider sign-out to offer.
      const value = resolved;
      if (!options.providerLogout || value === undefined || !value.endSession) return null;
      // No id_token_hint: ID Tokens are not kept after sign-in. Without it a conformant
      // provider asks the End-User to confirm, which is also the right question on a shared
      // browser. client_id lets it check the registered post-logout redirect URI.
      return client.buildEndSessionUrl(value.config, {
        client_id: options.clientId,
        post_logout_redirect_uri: postLogoutRedirect.href,
      }).href;
    },
  };
}
