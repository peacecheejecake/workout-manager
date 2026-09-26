import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import {
  courseSharingLimits,
  sharedCourseNotFoundBody,
  sharedCourseReadPath,
  sharedCourseSchema,
  type SharedCourse,
} from '@workout/contracts/course-sharing';
import type { SharedCourseReader } from '@workout/server-persistence/course-sharing';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * The view-only unlisted link (M2-01k-o B): its token, its one unauthenticated read and the
 * server flag that keeps it off by default.
 *
 * **Off by default.** A deployment that sets nothing has sharing off: no link can be made,
 * and the read answers every request with the same 404 without touching the database.
 * Turning it on requires the share epoch, the rate key and the trusted proxies; missing any
 * refuses to start rather than guessing (B-5, B-4).
 */
export interface CourseSharingConfiguration {
  readonly enabled: boolean;
  /** The share epoch every restore raises (B-5). Required when enabled. */
  readonly epoch: number;
  /** The HMAC key of the client-address counters (B-4). Required when enabled. */
  readonly rateKey: Buffer;
  /** Addresses of proxies whose `X-Forwarded-For` is believed (B-4). Empty: the socket. */
  readonly trustedProxies: readonly string[];
}

export const courseSharingOff: CourseSharingConfiguration = {
  enabled: false,
  epoch: 1,
  rateKey: Buffer.alloc(32),
  trustedProxies: [],
};

const flagSchema = z.enum(['on', 'off']).default('off');

/**
 * Read the flag and its settings from the environment. `COURSE_SHARING` unset or `off` is
 * off; `on` needs `COURSE_SHARE_EPOCH` (a positive integer), `COURSE_SHARE_RATE_KEY` (at
 * least 32 bytes, base64) and `COURSE_SHARE_TRUSTED_PROXIES` (a comma list of addresses).
 *
 * The proxies are required, not optional. Every shell reaches this API through a proxy (the
 * web shell's `/bff` rewrite, the mobile shell's preview proxy, the deployment's front
 * proxy), so without them every recipient would be counted as that proxy's one address: one
 * client's failures would shut every recipient out (B-4). Only a proxy that sets
 * `X-Forwarded-For` itself from the connection it received — never passing on a value the
 * client sent — may be listed; see the operations runbook.
 */
export function courseSharingFromEnvironment(
  environment: Readonly<Record<string, unknown>>,
): CourseSharingConfiguration {
  const flag = flagSchema.parse(environment['COURSE_SHARING']);
  if (flag === 'off') return courseSharingOff;
  const epoch = z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_646)
    .safeParse(environment['COURSE_SHARE_EPOCH']);
  if (environment['COURSE_SHARE_EPOCH'] === undefined || !epoch.success)
    throw new Error('COURSE_SHARE_EPOCH_REQUIRED');
  const rawKey = z.string().safeParse(environment['COURSE_SHARE_RATE_KEY']);
  const rateKey = rawKey.success ? Buffer.from(rawKey.data, 'base64') : Buffer.alloc(0);
  if (rateKey.byteLength < 32) throw new Error('COURSE_SHARE_RATE_KEY_REQUIRED');
  const proxies = z.string().optional().parse(environment['COURSE_SHARE_TRUSTED_PROXIES']);
  const trustedProxies = (proxies ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (trustedProxies.length === 0) throw new Error('COURSE_SHARE_TRUSTED_PROXIES_REQUIRED');
  if (trustedProxies.some((value) => isIP(value) === 0))
    throw new Error('COURSE_SHARE_TRUSTED_PROXIES_INVALID');
  return { enabled: true, epoch: epoch.data, rateKey, trustedProxies };
}

/** A new link token: 256 bits from the CSPRNG, base64url without padding. */
export function createShareToken(): string {
  return randomBytes(courseSharingLimits.shareTokenBytes).toString('base64url');
}

/** What the server keeps of a token: its SHA-256, hex. Computed for any input at all. */
export function shareTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  // An IPv4 address seen through an IPv6 socket is the same client.
  return trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

/**
 * The client a request came from (B-4).
 *
 * Only a proxy in the configured allowlist is believed about who it forwarded: its
 * `X-Forwarded-For` is read from the right, skipping further trusted hops, and the first
 * address that is not a trusted proxy is the client. A header from anyone else is ignored,
 * so a caller cannot rename itself to escape its own limit.
 */
export function resolveClientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: readonly string[],
): string {
  const socket = normalizeAddress(socketAddress ?? 'unknown');
  const trusted = new Set(trustedProxies.map(normalizeAddress));
  if (!trusted.has(socket)) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map(normalizeAddress)
    .filter((value) => value !== '');
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    if (hop === undefined) continue;
    if (isIP(hop) === 0) return socket;
    if (!trusted.has(hop)) return hop;
  }
  return socket;
}

/** The counter key of one client: a keyed HMAC of its address, never the address (B-4). */
export function clientRateKey(address: string, key: Buffer): string {
  return createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

/** The UTC calendar date of an instant: all the recipient learns about expiry (B-3, R3). */
function expiryDate(instant: string): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Headers every answer of the read carries, found or not (§3 B "응답 헤더"). */
function privateHeaders(reply: FastifyReply) {
  reply.header('cache-control', 'no-store, private');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
  reply.header('x-content-type-options', 'nosniff');
}

function notFound(reply: FastifyReply) {
  privateHeaders(reply);
  return reply.code(404).send(sharedCourseNotFoundBody);
}

/** The token a body carries, or the raw text itself: a malformed body is just an unknown token. */
function tokenOf(body: unknown): string {
  if (typeof body !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const token = (parsed as Record<string, unknown>)['token'];
      if (typeof token === 'string') return token;
    }
  } catch {
    // Not JSON: fall through to the same lookup as an unknown token.
  }
  return body;
}

/**
 * Build what the recipient sees from a stored snapshot. The snapshot is already the
 * allowlist; this adds the expiry date and parses the whole answer strictly (R9), so a field
 * that should not be there fails here instead of leaving.
 */
export function sharedCourseAnswer(
  snapshot: Omit<SharedCourse, 'expiresOn'>,
  includeNames: boolean,
  expiresAt: string,
): SharedCourse {
  return sharedCourseSchema.parse({
    ...(includeNames && snapshot.name !== undefined ? { name: snapshot.name } : {}),
    coordinates: snapshot.coordinates,
    waypoints: snapshot.waypoints.map((waypoint) => ({
      role: waypoint.role,
      position: waypoint.position,
      ...(includeNames && waypoint.name !== undefined ? { name: waypoint.name } : {}),
    })),
    distanceMeters: snapshot.distanceMeters,
    ...(snapshot.routeDataNotice === undefined
      ? {}
      : { routeDataNotice: snapshot.routeDataNotice }),
    expiresOn: expiryDate(expiresAt),
  });
}

/**
 * `POST /bff/v1/shared/course` — the one unauthenticated read.
 *
 * It reads no cookie and no session header. The token is in the body (the address fragment
 * never reaches a server). Every answer that is not a live link — unknown, malformed,
 * another course's, expired, revoked, restored away, rate-limited, sharing off, an
 * unreadable or oversized body — is the same 404 with the same body and headers; the
 * handler logs nothing of its own, and the request log carries only method and status.
 */
export function registerSharedCourseRead(
  app: FastifyInstance,
  sharing: CourseSharingConfiguration,
  reader: SharedCourseReader | undefined,
) {
  app.register(async (shared) => {
    shared.removeAllContentTypeParsers();
    shared.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, body),
    );
    // A body the parser refuses (too large, unreadable) and a database that cannot answer are
    // both a 404 like any other: nothing here says why.
    shared.setErrorHandler((_error, _request, reply) => notFound(reply));
    shared.post(sharedCourseReadPath, async (request, reply) => {
      if (!sharing.enabled || reader === undefined) return notFound(reply);
      const digest = shareTokenDigest(tokenOf(request.body));
      const client = resolveClientAddress(
        request.socket.remoteAddress,
        request.headers['x-forwarded-for'],
        sharing.trustedProxies,
      );
      const result = await reader.read(
        digest,
        sharing.epoch,
        clientRateKey(client, sharing.rateKey),
      );
      if (result.outcome !== 'ok') return notFound(reply);
      privateHeaders(reply);
      return reply
        .code(200)
        .send(sharedCourseAnswer(result.snapshot, result.includeNames, result.expiresAt));
    });
  });
}
