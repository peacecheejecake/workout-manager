/**
 * M2-01u (review B1): cross-site forced sign-out, in a real Chromium.
 *
 * The session cookie is SameSite=Lax, so a cross-site POST arrives WITHOUT it and the API
 * sees a signed-in victim as "no session". Whatever the 401 on /bff/v1/auth/logout sets is
 * then applied by the browser, because a top-level navigation response may set Lax cookies.
 * This drives that exact shape with two sites (localhost vs 127.0.0.1): an attacker page
 * auto-submits a `text/plain` form (the one enctype Fastify accepts without a 415) at the
 * victim's logout, top-level and through a popup.
 *
 *   node --import tsx scripts/logout-csrf-browser-check.mts
 *
 * Uses ports 47831/47832/47833 only (not the shared harness ports). The identity provider is
 * a stub that redirects straight to the callback: this checks the cookie/CSRF boundary of the
 * real createApi + createIdentityService, not OIDC.
 *
 * M2-01w adds: the stub advertises an RP-initiated logout URL on 47833, which records every
 * request. A cross-site sign-out attempt must neither reach it (no forced provider sign-out
 * through this app) nor learn it; a forged callback navigation carrying a hostile
 * `error_description` must end on the fixed account-screen code and leave every cookie alone.
 */
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { chromium, type BrowserContext } from '@playwright/test';
import { createApi } from '../apps/api/src/app.ts';
import {
  createIdentityService,
  type IdentityStore,
} from '../packages/server/identity/src/service.ts';

const appPort = 47831;
const attackerPort = 47832;
const appOrigin = `http://localhost:${appPort}`;
const attackerOrigin = `http://127.0.0.1:${attackerPort}`;
const providerPort = 47833;
const providerLogout = `http://127.0.0.1:${providerPort}/session/end?client_id=stub`;
const providerHits: string[] = [];
const providerServer = createServer((request, reply) => {
  providerHits.push(request.url ?? '');
  reply.writeHead(200, { 'content-type': 'text/plain' });
  reply.end('provider');
});
await new Promise<void>((resolve) => providerServer.listen(providerPort, '127.0.0.1', resolve));

const attempts = new Map<string, { browserHash: string; nonce: string; verifier: string }>();
const sessions = new Map<string, { csrfToken: string; expiresAt: Date }>();
const store: IdentityStore = {
  async createAttempt({ stateHash, browserHash, nonce, verifier }) {
    attempts.set(stateHash, { browserHash, nonce, verifier });
  },
  async consumeAttempt(stateHash, browserHash) {
    const attempt = attempts.get(stateHash);
    attempts.delete(stateHash);
    return attempt && attempt.browserHash === browserHash ? attempt : null;
  },
  async createSession({ tokenHash, csrfToken, expiresAt, previousTokenHash }) {
    if (previousTokenHash !== undefined) sessions.delete(previousTokenHash);
    sessions.set(tokenHash, { csrfToken, expiresAt });
    return { athleteId: 'victim-athlete', sessionId: tokenHash.slice(0, 36) };
  },
  async findSession(tokenHash, now) {
    const session = sessions.get(tokenHash);
    return session && session.expiresAt > now
      ? { athleteId: 'victim-athlete', sessionId: tokenHash.slice(0, 36), ...session }
      : null;
  },
  async revokeSession(tokenHash) {
    sessions.delete(tokenHash);
  },
};
const identity = createIdentityService({
  store,
  provider: {
    async authorizationUrl({ state }) {
      return `${appOrigin}/bff/v1/auth/callback?state=${state}&code=stub`;
    },
    async exchange() {
      return { issuer: appOrigin, subject: 'victim' };
    },
    async logoutUrl() {
      return providerLogout;
    },
  },
  publicOrigin: appOrigin,
  allowInsecureLocalhost: true,
});
const app = createApi({
  auth: identity,
  identity,
  allowedOrigins: [appOrigin],
  logStream: new Writable({ write: (_chunk, _encoding, done) => done() }),
  consent: {
    getConsent: async (_athlete, kind) => ({ kind, granted: false, revision: 0 }),
    setConsent: async (_athlete, input) => ({
      kind: input.kind,
      granted: input.granted,
      revision: 1,
    }),
  },
});
await app.listen({ port: appPort, host: 'localhost' });

const form = `<form method="post" action="${appOrigin}/bff/v1/auth/logout" enctype="text/plain"><input name="x" value="y"></form>`;
const hostile = encodeURIComponent('<img src=x onerror=alert(1)>');
const forgedCallback = `${appOrigin}/bff/v1/auth/callback?state=forged&error=access_denied&error_description=${hostile}`;
const attacker = createServer((request, reply) => {
  reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url === '/callback')
    reply.end(
      `<!doctype html><title>attacker</title><script>location.href=${JSON.stringify(forgedCallback)}</script>`,
    );
  else if (request.url === '/popup')
    reply.end(
      `<!doctype html><title>attacker</title>${form.replace('<form ', '<form target="victim" ')}<script>window.open('about:blank','victim');document.forms[0].submit()</script>`,
    );
  else
    reply.end(
      `<!doctype html><title>attacker</title>${form}<script>document.forms[0].submit()</script>`,
    );
});
await new Promise<void>((resolve) => attacker.listen(attackerPort, '127.0.0.1', resolve));

const results: { name: string; pass: boolean; detail: string }[] = [];
const names = async (context: BrowserContext) =>
  (await context.cookies(appOrigin)).map((cookie) => cookie.name).sort();
const browser = await chromium.launch();
try {
  for (const variant of ['top-level', 'popup'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${appOrigin}/bff/v1/auth/login`);
    const before = (await page.request.get(`${appOrigin}/bff/v1/session`)).status();
    const logout = context.waitForEvent('response', {
      predicate: (response) => response.url() === `${appOrigin}/bff/v1/auth/logout`,
    });
    await page.goto(`${attackerOrigin}/${variant === 'popup' ? 'popup' : ''}`);
    const response = await logout;
    const status = response.status();
    const body = await response.text().catch(() => '');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cookies = await names(context);
    const after = (await page.request.get(`${appOrigin}/bff/v1/session`)).status();
    const pass =
      before === 200 &&
      after === 200 &&
      cookies.includes('workout_session') &&
      !cookies.includes('workout_signed_out');
    results.push({
      name: `cross-site text/plain form (${variant}) cannot sign the victim out or set the marker`,
      pass,
      detail: `session before ${before}, logout ${status}, cookies after [${cookies.join(', ')}], session after ${after}`,
    });
    results.push({
      name: `cross-site text/plain form (${variant}) cannot send the victim to the provider sign-out`,
      pass: providerHits.length === 0 && !body.includes('providerLogoutUrl') && status !== 200,
      detail: `logout ${status}, provider requests ${providerHits.length}, body mentions provider URL: ${body.includes('providerLogoutUrl')}`,
    });
    await context.close();
  }

  // A forged callback navigation (top-level, cross-site, hostile error_description) while the
  // victim is signed in: it ends on the fixed code and touches no cookie.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${appOrigin}/bff/v1/auth/login`);
    const cookiesBefore = (await context.cookies(appOrigin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .sort()
      .join('; ');
    const callback = context.waitForEvent('response', {
      predicate: (response) => response.url().startsWith(`${appOrigin}/bff/v1/auth/callback`),
    });
    await page.goto(`${attackerOrigin}/callback`);
    const response = await callback;
    const location = response.headers()['location'] ?? '';
    const setCookie = response.headers()['set-cookie'] ?? '';
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cookiesAfter = (await context.cookies(appOrigin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .sort()
      .join('; ');
    const session = (await page.request.get(`${appOrigin}/bff/v1/session`)).status();
    results.push({
      name: 'forged cross-site callback with a hostile error_description: fixed code, no cookie change',
      pass:
        response.status() === 302 &&
        location === '/account?login_error=failed' &&
        setCookie === '' &&
        cookiesAfter === cookiesBefore &&
        session === 200,
      detail: `callback ${response.status()} → ${location}, set-cookie ${setCookie === '' ? 'none' : 'present'}, cookies ${cookiesAfter === cookiesBefore ? 'unchanged' : 'CHANGED'}, session after ${session}`,
    });
    await context.close();
  }

  // The legitimate same-origin sign-out: the app session ends, and only then is the
  // provider sign-out offered to this page.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${appOrigin}/bff/v1/auth/login`);
    const current = (await (await page.request.get(`${appOrigin}/bff/v1/session`)).json()) as {
      sessionId: string;
      csrfToken: string;
    };
    const answer = await page.evaluate(
      async (headers) => {
        const response = await fetch('/bff/v1/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers,
        });
        return { status: response.status, body: await response.text() };
      },
      { 'x-csrf-token': current.csrfToken, 'x-workout-session-id': current.sessionId },
    );
    const session = (await page.request.get(`${appOrigin}/bff/v1/session`)).status();
    const cookies = await names(context);
    results.push({
      name: 'same-origin sign-out ends the app session, then offers the provider sign-out',
      pass:
        answer.status === 200 &&
        answer.body === JSON.stringify({ providerLogoutUrl: providerLogout }) &&
        session === 401 &&
        cookies.includes('workout_signed_out') &&
        !cookies.includes('workout_session'),
      detail: `logout ${answer.status}, session after ${session}, cookies [${cookies.join(', ')}]`,
    });
    await context.close();
  }

  // The legitimate R1 path must keep working: the app's own same-origin sign-out after the
  // session expired still leaves the marker.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${appOrigin}/bff/v1/auth/login`);
  await context.clearCookies({ name: 'workout_session' });
  const status = await page.evaluate(async () => {
    const response = await fetch('/bff/v1/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    return response.status;
  });
  const cookies = await names(context);
  results.push({
    name: 'same-origin sign-out after the session expired still leaves the marker',
    pass: status === 401 && cookies.includes('workout_signed_out'),
    detail: `logout ${status}, cookies after [${cookies.join(', ')}]`,
  });
  await context.close();
} finally {
  await browser.close();
  await app.close();
  attacker.closeAllConnections();
  await new Promise<void>((resolve) => attacker.close(() => resolve()));
  providerServer.closeAllConnections();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed += 1;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
