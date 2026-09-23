import * as client from 'openid-client';
import { z } from 'zod';
import type { OidcProvider } from './service.js';

const configSchema = z.strictObject({
  issuer: z.url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(4096),
  redirectUri: z.url(),
  allowInsecureLocalhost: z.boolean().default(false),
});

/** Only operator-configured issuers are accepted; no user supplied discovery URLs. */
export async function createOidcProvider(input: unknown): Promise<OidcProvider> {
  const options = configSchema.parse(input);
  const issuer = new URL(options.issuer);
  const redirect = new URL(options.redirectUri);
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
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
  ]) {
    if (typeof endpoint !== 'string') throw new Error('Missing OIDC endpoint');
    checkUrl(new URL(endpoint));
  }
  return {
    async authorizationUrl({ state, nonce, verifier, reauthenticate }) {
      return client.buildAuthorizationUrl(config, {
        ...(reauthenticate ? { prompt: 'login' } : {}),
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
      const tokens = await client.authorizationCodeGrant(config, url, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.verifier,
        idTokenExpected: true,
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
      return { issuer: claims.iss, subject: claims.sub };
    },
  };
}
