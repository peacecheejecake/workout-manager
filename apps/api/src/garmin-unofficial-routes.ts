import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  activityCollectionProvenanceSchema,
  garminUnofficialLoginResultSchema,
  garminUnofficialLoginSchema,
  garminUnofficialMfaSchema,
  garminUnofficialRunRequestResultSchema,
  garminUnofficialScheduleSchema,
  garminUnofficialStatusSchema,
} from '@workout/contracts/garmin-unofficial';
import {
  GarminUnofficialError,
  type GarminUnofficialService,
} from '@workout/server-integrations/garmin-unofficial-service';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Reads the collection provenance of the caller's own activity; independent of the adapter. */
export interface GarminCollectionProvenancePort {
  provenance(
    athleteId: string,
    activityId: string,
  ): Promise<z.infer<typeof activityCollectionProvenanceSchema>['provenance']>;
}

/**
 * The temporary unofficial collector's routes (M1-06b-tmp). Registered only when the
 * adapter is configured; otherwise every path below is the ordinary 404. Every handler asks
 * the service, which refuses any account but the configured owner with one fixed 403 code.
 *
 * The login body carries the Garmin password. It is validated and handed to the service,
 * never logged: the API logs no request bodies, headers or URLs (app.ts), and every error
 * becomes a fixed code.
 */
export function registerGarminUnofficialRoutes(
  routes: FastifyInstance,
  service: GarminUnofficialService | undefined,
  provenance: GarminCollectionProvenancePort | undefined,
  principal: (request: FastifyRequest) => Principal,
) {
  if (provenance !== undefined)
    routes.get('/activities/:id/collection-provenance', async (request) => {
      input(emptyQuery, request.query);
      const { id } = input(z.strictObject({ id: z.uuid() }), request.params);
      return activityCollectionProvenanceSchema.parse({
        provenance: await provenance.provenance(principal(request).athleteId, id),
      });
    });
  if (service === undefined) return;
  // Owner first, on every path: any other account gets this one 403 and learns nothing else
  // (not whether a query or body was valid, not whether a session was a cookie).
  const owner = (request: FastifyRequest) => {
    const user = principal(request);
    if (!service.isOwner(user.athleteId))
      throw new GarminUnofficialError('GARMIN_UNOFFICIAL_OWNER_ONLY');
    return user;
  };
  // MFA state is bound to the app session that started the login, so only a cookie session
  // (which has one) may log in.
  const cookieOwner = (request: FastifyRequest) => {
    const user = owner(request);
    if (user.method !== 'cookie') throw new GarminUnofficialError('COOKIE_SESSION_REQUIRED');
    return user;
  };
  /**
   * The body is parsed here, after the owner check. The scope below replaces Fastify's
   * content-type parsers with one that only collects the raw text, so a malformed JSON body
   * or an unknown content type reaches the handler instead of being answered 400/415 before
   * authentication. Only the byte bound (bodyLimit, 413) still answers before the owner
   * check, as it does for every route (documented in the progress record).
   */
  const jsonBody = <T>(request: FastifyRequest, schema: z.ZodType<T>): T => {
    const type = request.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json(\s*;.*)?$/i.test(type))
      throw new ProductRequestError(415, 'UNSUPPORTED_MEDIA_TYPE');
    let value: unknown;
    try {
      value = JSON.parse(typeof request.body === 'string' ? request.body : '');
    } catch {
      throw new ProductRequestError(400, 'INVALID_REQUEST');
    }
    return input(schema, value);
  };
  const noBody = (request: FastifyRequest) => {
    input(emptyQuery, request.query);
    if (request.body !== undefined && request.body !== '')
      throw new ProductRequestError(400, 'INVALID_REQUEST');
  };
  const base = '/integrations/garmin-unofficial';
  routes.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
    scoped.get(`${base}/status`, async (request) => {
      const user = owner(request);
      input(emptyQuery, request.query);
      return garminUnofficialStatusSchema.parse(
        await service.status(user.athleteId, user.method === 'cookie' ? user.sessionId : null),
      );
    });
    scoped.post(`${base}/login`, async (request) => {
      const user = cookieOwner(request);
      input(emptyQuery, request.query);
      const credentials = jsonBody(request, garminUnofficialLoginSchema);
      return garminUnofficialLoginResultSchema.parse(
        await service.login(user.athleteId, user.sessionId, credentials),
      );
    });
    scoped.post(`${base}/login/mfa`, async (request) => {
      const user = cookieOwner(request);
      input(emptyQuery, request.query);
      const body = jsonBody(request, garminUnofficialMfaSchema);
      return garminUnofficialLoginResultSchema.parse(
        await service.submitMfa(user.athleteId, user.sessionId, body),
      );
    });
    scoped.delete(`${base}/login`, async (request, reply) => {
      const user = cookieOwner(request);
      noBody(request);
      await service.cancelLogin(user.athleteId, user.sessionId);
      return reply.code(204).send();
    });
    scoped.delete(`${base}/connection`, async (request, reply) => {
      const user = owner(request);
      noBody(request);
      await service.disconnect(user.athleteId);
      return reply.code(204).send();
    });
    scoped.put(`${base}/schedule`, async (request, reply) => {
      const user = owner(request);
      input(emptyQuery, request.query);
      const { enabled } = jsonBody(request, garminUnofficialScheduleSchema);
      await service.setSchedule(user.athleteId, enabled);
      return reply.code(204).send();
    });
    scoped.post(`${base}/runs`, async (request, reply) => {
      const user = owner(request);
      noBody(request);
      return reply
        .code(202)
        .send(
          garminUnofficialRunRequestResultSchema.parse(await service.requestRun(user.athleteId)),
        );
    });
  });
}

export function classifyGarminUnofficialError(
  error: unknown,
): { statusCode: number; code: string } | null {
  if (!(error instanceof GarminUnofficialError)) return null;
  switch (error.code) {
    case 'GARMIN_UNOFFICIAL_OWNER_ONLY':
    case 'COOKIE_SESSION_REQUIRED':
      return { statusCode: 403, code: error.code };
    case 'GARMIN_UNOFFICIAL_LOGIN_LOCKED':
    case 'GARMIN_UNOFFICIAL_PROVIDER_RATE_LIMITED':
      return { statusCode: 429, code: error.code };
    case 'GARMIN_UNOFFICIAL_LOGIN_REJECTED':
    case 'GARMIN_UNOFFICIAL_MFA_REJECTED':
      // Not 401: that status means "your app session ended" to every screen.
      return { statusCode: 422, code: error.code };
    case 'GARMIN_UNOFFICIAL_UNAVAILABLE':
      return { statusCode: 503, code: error.code };
    case 'GARMIN_UNOFFICIAL_LOGIN_BUSY':
    case 'GARMIN_UNOFFICIAL_ALREADY_CONNECTED':
    case 'GARMIN_UNOFFICIAL_PROFILE_MISMATCH':
    case 'GARMIN_UNOFFICIAL_MFA_EXPIRED':
    case 'GARMIN_UNOFFICIAL_NOT_CONNECTED':
    case 'GARMIN_UNOFFICIAL_RUN_BLOCKED':
    case 'GARMIN_UNOFFICIAL_RUN_BUSY':
      return { statusCode: 409, code: error.code };
  }
}
