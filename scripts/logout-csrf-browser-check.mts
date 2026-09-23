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
 * Uses ports 47831/47832 only (not the shared harness ports). The identity provider is a
 * stub that redirects straight to the callback: this checks the cookie/CSRF boundary of the
 * real createApi + createIdentityService, not OIDC.
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
const attacker = createServer((request, reply) => {
  reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url === '/popup')
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
    const status = (await logout).status();
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
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed += 1;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
