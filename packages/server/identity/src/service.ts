import { createHash, randomBytes } from 'node:crypto';

export interface IdentityStore {
  createAttempt(input: {
    stateHash: string;
    browserHash: string;
    nonce: string;
    verifier: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeAttempt(
    stateHash: string,
    browserHash: string,
    now: Date,
  ): Promise<{ nonce: string; verifier: string } | null>;
  createSession(input: {
    tokenHash: string;
    csrfToken: string;
    issuer: string;
    subject: string;
    expiresAt: Date;
    now: Date;
    previousTokenHash?: string;
  }): Promise<{ athleteId: string; sessionId: string }>;
  findSession(
    tokenHash: string,
    now: Date,
  ): Promise<{ athleteId: string; sessionId: string; csrfToken: string; expiresAt: Date } | null>;
  revokeSession(tokenHash: string): Promise<void>;
}

export interface OidcProvider {
  /**
   * `reauthenticate` asks the provider to authenticate the End-User again (`prompt=login`)
   * instead of answering from its own single sign-on session.
   */
  authorizationUrl(input: {
    state: string;
    nonce: string;
    verifier: string;
    reauthenticate: boolean;
  }): Promise<string>;
  /** `reauthenticate` is what the attempt asked for, read back from the stored attempt. */
  exchange(
    url: URL,
    checks: { state: string; nonce: string; verifier: string; reauthenticate: boolean },
  ): Promise<{ issuer: string; subject: string }>;
  /** Start provider discovery ahead of the first sign-in; failure is not fatal. */
  prepare?(): Promise<void>;
  /** The provider's RP-initiated logout URL, or null (none advertised, disabled, unreachable). */
  logoutUrl?(): Promise<string | null>;
}

/** The provider's configuration is not available (discovery failed): sign-in fails closed. */
export class ProviderUnavailableError extends Error {
  constructor() {
    super('IDENTITY_PROVIDER_UNAVAILABLE');
  }
}

export class IdentityError extends Error {
  constructor(readonly code: 'LOGIN_REJECTED' | 'LOGIN_CANCELLED' | 'IDENTITY_UNAVAILABLE') {
    super(code);
  }
}

/**
 * Marks, inside the nonce stored with the attempt, that this attempt asked the provider to
 * re-authenticate. The attempt row is server-side and the nonce is generated here, so the
 * callback learns what was asked without trusting the browser — and without a migration.
 */
const reauthenticationNonce = 'reauth.';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Reject ambiguous duplicate cookies rather than selecting a proxy/parser-dependent value. */
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length > 8192) return null;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const value = values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
  return value !== undefined && tokenPattern.test(value) ? value : null;
}

/**
 * Presence only, deliberately lenient: any copy of the cookie, valid or not, counts. A header
 * too large to read (the same bound `readCookie` refuses) cannot show that the cookie is
 * absent, so it counts as present — undecidable means asking the provider again.
 */
function hasCookie(header: string | undefined, name: string): boolean {
  if (header === undefined) return false;
  if (header.length > 8192) return true;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

export interface IdentityOptions {
  store: IdentityStore;
  provider: OidcProvider;
  publicOrigin: string;
  /** Explicit local development only; both this origin and the OIDC adapter enforce loopback. */
  allowInsecureLocalhost?: boolean;
  now?: () => Date;
}

export function createIdentityService(options: IdentityOptions) {
  const origin = new URL(options.publicOrigin);
  const insecure =
    origin.protocol === 'http:' &&
    options.allowInsecureLocalhost === true &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== options.publicOrigin || (origin.protocol !== 'https:' && !insecure))
    throw new Error('Invalid identity public origin');
  const secure = !insecure;
  const sessionName = secure ? '__Host-workout_session' : 'workout_session';
  const attemptName = secure ? '__Host-workout_login' : 'workout_login';
  // Set by an app sign-out, cleared by the next completed sign-in. The provider keeps its
  // own SSO session after an app sign-out, so without this the next "sign in" would silently
  // return the previous account — on a shared browser, to the next person.
  const signedOutName = secure ? '__Host-workout_signed_out' : 'workout_signed_out';
  const now = options.now ?? (() => new Date());
  const cookie = (name: string, value: string, seconds: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;

  const signedOutMarker = () => cookie(signedOutName, token(), 2_592_000);

  return {
    /**
     * A sign-in from a browser that is already signed in (an account switch) or that signed
     * out of this app asks the provider to authenticate again. A first sign-in keeps the
     * provider's single sign-on.
     */
    async beginLogin(header?: string) {
      const state = token();
      const browser = token();
      const verifier = token();
      const reauthenticate = hasCookie(header, sessionName) || hasCookie(header, signedOutName);
      const nonce = `${reauthenticate ? reauthenticationNonce : ''}${token()}`;
      let location: string;
      try {
        location = await options.provider.authorizationUrl({
          state,
          nonce,
          verifier,
          reauthenticate,
        });
      } catch {
        // Without the provider's configuration nothing can be asked of it: no attempt.
        throw new IdentityError('IDENTITY_UNAVAILABLE');
      }
      await options.store.createAttempt({
        stateHash: hash(state),
        browserHash: hash(browser),
        nonce,
        verifier,
        expiresAt: new Date(now().getTime() + 600_000),
      });
      return { location, cookie: cookie(attemptName, browser, 600) };
    },
    async completeLogin(requestUrl: string, header?: string) {
      const url = new URL(requestUrl, origin);
      const state = url.searchParams.get('state');
      const browser = readCookie(header, attemptName);
      if (
        url.origin !== origin.origin ||
        url.pathname !== '/bff/v1/auth/callback' ||
        state === null ||
        !tokenPattern.test(state) ||
        browser === null ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
      )
        throw new IdentityError('LOGIN_REJECTED');
      const attempt = await options.store.consumeAttempt(hash(state), hash(browser), now());
      if (attempt === null) throw new IdentityError('LOGIN_REJECTED');
      // An error response for this browser's own attempt (the attempt is consumed either
      // way). Only the fixed code is looked at — never error_description or error_uri — and
      // it only chooses between two fixed messages.
      const error = url.searchParams.get('error');
      if (error !== null)
        throw new IdentityError(error === 'access_denied' ? 'LOGIN_CANCELLED' : 'LOGIN_REJECTED');
      let identity: { issuer: string; subject: string };
      try {
        identity = await options.provider.exchange(url, {
          state,
          ...attempt,
          reauthenticate: attempt.nonce.startsWith(reauthenticationNonce),
        });
      } catch (reason) {
        throw new IdentityError(
          reason instanceof ProviderUnavailableError ? 'IDENTITY_UNAVAILABLE' : 'LOGIN_REJECTED',
        );
      }
      const sessionToken = token();
      const previous = readCookie(header, sessionName);
      await options.store.createSession({
        ...(previous === null ? {} : { previousTokenHash: hash(previous) }),
        tokenHash: hash(sessionToken),
        csrfToken: token(),
        ...identity,
        now: now(),
        expiresAt: new Date(now().getTime() + 28_800_000),
      });
      return {
        location: '/account',
        cookies: [
          cookie(sessionName, sessionToken, 28_800),
          cookie(attemptName, '', 0),
          cookie(signedOutName, '', 0),
        ],
      };
    },
    async authenticate(credentials: { cookie?: string; authorization?: string }) {
      if (credentials.authorization !== undefined) return null;
      const value = readCookie(credentials.cookie, sessionName);
      if (value === null) return null;
      const session = await options.store.findSession(hash(value), now());
      return session === null
        ? null
        : { ...session, expiresAt: session.expiresAt.toISOString(), method: 'cookie' as const };
    },
    async logout(header?: string) {
      const value = readCookie(header, sessionName);
      if (value !== null) await options.store.revokeSession(hash(value));
      return [cookie(sessionName, '', 0), cookie(attemptName, '', 0), signedOutMarker()];
    },
    /**
     * Where to send the browser after an app sign-out so the provider can end its own
     * session too (RP-initiated logout), or null. Never needed for the app sign-out itself,
     * which is complete (server-side revocation + marker) before this is asked.
     */
    async providerLogoutUrl(): Promise<string | null> {
      return (await options.provider.logoutUrl?.()) ?? null;
    },
    /**
     * Only the sign-out marker — never a session or attempt cookie deletion. For a sign-out
     * the API could not authenticate: a SameSite=Lax session cookie is withheld from a
     * cross-site POST, so "no session" there can be a signed-in user whose cookies must not
     * be touched. A leftover invalid session cookie already makes the next sign-in ask again.
     */
    signedOutMarker,
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
