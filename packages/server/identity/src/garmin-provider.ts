import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GarminProvider, GarminTokens } from './garmin-ports.js';
export class GarminProviderError extends Error {
  constructor(readonly reconnectRequired = false) {
    super('GARMIN_PROVIDER_UNAVAILABLE');
  }
}
const secret = z.string().min(1).max(16384);
const tokensSchema = z.object({
  access_token: secret,
  refresh_token: secret,
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(31536000),
  refresh_token_expires_in: z.number().int().positive().max(315360000),
});
export interface GarminProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fixtureOrigin?: string;
  allowInsecureLocalhost?: boolean;
}
export function createGarminProvider(input: GarminProviderOptions): GarminProvider {
  const options = z
    .strictObject({
      clientId: secret,
      clientSecret: secret,
      redirectUri: z.url(),
      fixtureOrigin: z.url().optional(),
      allowInsecureLocalhost: z.boolean().optional(),
    })
    .parse(input);
  const redirect = new URL(options.redirectUri);
  const local = (url: URL) =>
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== '/bff/v1/integrations/garmin/callback' ||
    (redirect.protocol !== 'https:' && !(options.allowInsecureLocalhost && local(redirect)))
  )
    throw new Error('INVALID_GARMIN_CONFIG');
  let authorize = 'https://connect.garmin.com/oauth2Confirm',
    token = 'https://connectapi.garmin.com/di-oauth2-service/oauth/token',
    base = 'https://apis.garmin.com/wellness-api/rest';
  if (options.fixtureOrigin !== undefined) {
    const fixture = new URL(options.fixtureOrigin);
    if (
      !options.allowInsecureLocalhost ||
      !local(fixture) ||
      fixture.origin !== options.fixtureOrigin
    )
      throw new Error('INVALID_GARMIN_FIXTURE');
    authorize = `${fixture.origin}/authorize`;
    token = `${fixture.origin}/token`;
    base = fixture.origin;
  }
  async function request(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GarminProviderError(response.status === 401 || response.status === 400);
      }
      if (response.status === 204) return null;
      const reader = response.body?.getReader();
      if (!reader) throw new GarminProviderError();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new GarminProviderError();
        }
        chunks.push(next.value);
      }
      if (size === 0) return null;
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof GarminProviderError) throw error;
      throw new GarminProviderError();
    }
  }
  async function grant(parameters: Record<string, string>): Promise<GarminTokens> {
    const response = await request(token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...parameters,
      }),
    });
    const result = tokensSchema.safeParse(response);
    if (!result.success) throw new GarminProviderError();
    return {
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresIn: result.data.expires_in,
      refreshTokenExpiresIn: result.data.refresh_token_expires_in,
    };
  }
  const bearer = (accessToken: string) => ({
    authorization: `Bearer ${secret.parse(accessToken)}`,
  });
  return {
    authorizationUrl({ state, verifier }) {
      const url = new URL(authorize);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: redirect.href,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return url.href;
    },
    exchange: ({ code, verifier }) =>
      grant({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirect.href,
      }),
    refresh: (refreshToken) => grant({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async identity(accessToken) {
      const [identity, permissions] = await Promise.all([
        request(`${base}/user/id`, { headers: bearer(accessToken) }),
        request(`${base}/user/permissions`, { headers: bearer(accessToken) }),
      ]);
      const user = z.object({ userId: z.string().min(1).max(255) }).safeParse(identity);
      const rights = z
        .array(z.string().regex(/^[A-Z0-9_]{1,80}$/))
        .max(32)
        .safeParse(permissions);
      if (!user.success || !rights.success) throw new GarminProviderError();
      return { userId: user.data.userId, permissions: [...new Set(rights.data)].sort() };
    },
    async revoke(accessToken) {
      await request(`${base}/user/registration`, {
        method: 'DELETE',
        headers: bearer(accessToken),
      });
    },
  };
}
