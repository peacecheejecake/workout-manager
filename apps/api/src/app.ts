import {
  registerProductRoutes,
  ProductRequestError,
  type ProductRepositories,
} from './product-routes.js';
import { IdentityError, type IdentityService } from '@workout/server-identity/service';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { TenantErasedError } from '@workout/server-persistence/database';
import {
  consentKindSchema,
  consentSchema,
  consentWriteSchema,
  principalSchema,
  type AuthenticationPort,
  type ConsentPort,
  type Principal,
} from './ports.js';

export interface ApiOptions extends ProductRepositories {
  auth: AuthenticationPort;
  identity?: IdentityService;
  consent: ConsentPort;
  allowedOrigins: readonly string[];
  logStream?: Writable;
  close?: () => Promise<void>;
}

class BoundaryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const emptyQuerySchema = z.strictObject({});
const kindParamsSchema = z.strictObject({ kind: consentKindSchema });
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BoundaryError(400, 'INVALID_REQUEST');
  return result.data;
}

function credentials(request: FastifyRequest) {
  const { authorization, cookie } = request.headers;
  if (
    authorization !== undefined &&
    (authorization.length > 8192 || !/^Bearer \S+$/.test(authorization))
  ) {
    throw new BoundaryError(401, 'UNAUTHENTICATED');
  }
  if (cookie !== undefined && cookie.length > 8192) throw new BoundaryError(401, 'UNAUTHENTICATED');
  return {
    ...(authorization === undefined ? {} : { authorization }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

function requireCsrf(request: FastifyRequest, principal: Principal, origins: ReadonlySet<string>) {
  if (principal.method !== 'cookie') return;
  const origin = request.headers.origin;
  const token = request.headers['x-csrf-token'];
  if (typeof origin !== 'string' || !origins.has(origin) || typeof token !== 'string') {
    throw new BoundaryError(403, 'CSRF_REJECTED');
  }
  const expected = Buffer.from(principal.csrfToken);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new BoundaryError(403, 'CSRF_REJECTED');
  }
}

function classifyError(error: unknown): { statusCode: number; code: string } {
  if (error instanceof TenantErasedError) return { statusCode: 401, code: 'UNAUTHENTICATED' };
  if (error instanceof IdentityError)
    return { statusCode: error.code === 'LOGIN_REJECTED' ? 401 : 503, code: error.code };
  if (error instanceof BoundaryError || error instanceof ProductRequestError) return error;
  if (error instanceof PersistenceConflict) return { statusCode: 409, code: 'CONSENT_CONFLICT' };
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return { statusCode: 413, code: 'BODY_TOO_LARGE' };
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' };
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return { statusCode: 400, code: 'INVALID_REQUEST' };
    }
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR' };
}

/** Composition factory only: production identity and connection ownership are injected. */
export function createApi(options: ApiOptions): FastifyInstance {
  const origins = new Set(
    options.allowedOrigins.map((origin) => {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) {
        throw new Error('Expected an exact HTTP origin');
      }
      return origin;
    }),
  );
  const app = Fastify({
    bodyLimit: 16 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: 'info',
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
      serializers: {
        req: () => ({}),
        res: () => ({}),
        err: () => ({ type: 'Error', message: 'redacted', stack: '' }),
      },
    },
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'request_completed',
      method: request.method,
      statusCode: reply.statusCode,
    });
  });
  if (options.close !== undefined) app.addHook('onClose', options.close);
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND' } }),
  );
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, code } = classifyError(error);
    request.log.warn({ event: 'request_failed', code });
    return reply.code(statusCode).send({ error: { code }, requestId: request.id });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  if (options.identity !== undefined) {
    const identity = options.identity;
    app.get('/bff/v1/auth/login', async (request, reply) => {
      parseInput(emptyQuerySchema, request.query);
      const result = await identity.beginLogin();
      return reply.header('set-cookie', result.cookie).redirect(result.location);
    });
    app.get('/bff/v1/auth/callback', async (request, reply) => {
      const result = await identity.completeLogin(request.url, request.headers.cookie);
      return reply.header('set-cookie', result.cookies).redirect(result.location);
    });
  }

  app.register(
    async (routes) => {
      const authenticated = new WeakMap<FastifyRequest, Principal>();
      routes.addHook('preValidation', async (request) => {
        if (
          ['/bff/v1/session', '/bff/v1/auth/logout', '/bff/v1/consents/:kind'].includes(
            request.routeOptions.url ?? '',
          )
        )
          parseInput(emptyQuerySchema, request.query);
        const result = principalSchema.safeParse(
          await options.auth.authenticate(credentials(request)),
        );
        if (!result.success) throw new BoundaryError(401, 'UNAUTHENTICATED');
        authenticated.set(request, result.data);
        if (
          result.data.method === 'cookie' &&
          request.routeOptions.url !== '/bff/v1/session' &&
          request.headers['x-workout-session-id'] !== result.data.sessionId
        )
          throw new BoundaryError(409, 'SESSION_CHANGED');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
          requireCsrf(request, result.data, origins);
      });
      function principal(request: FastifyRequest) {
        const value = authenticated.get(request);
        if (value === undefined) throw new BoundaryError(401, 'UNAUTHENTICATED');
        return value;
      }
      registerProductRoutes(routes, options, principal);
      routes.get('/session', async (request) => {
        const value = principal(request);
        return value.method === 'cookie'
          ? {
              athleteId: value.athleteId,
              sessionId: value.sessionId,
              csrfToken: value.csrfToken,
              ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
            }
          : { athleteId: value.athleteId };
      });
      if (options.identity !== undefined) {
        const identity = options.identity;
        routes.post('/auth/logout', async (request, reply) => {
          if (request.body !== undefined) throw new BoundaryError(400, 'INVALID_REQUEST');
          const cookies = await identity.logout(request.headers.cookie);
          return reply.header('set-cookie', cookies).code(204).send();
        });
      }
      routes.get('/consents/:kind', async (request) => {
        const { kind } = parseInput(kindParamsSchema, request.params);
        const result = await options.consent.getConsent(principal(request).athleteId, kind);
        return consentSchema.parse(result);
      });
      routes.put('/consents/:kind', async (request) => {
        const { kind } = parseInput(kindParamsSchema, request.params);
        const input = parseInput(consentWriteSchema, request.body);
        const idempotencyKey = parseInput(idempotencyKeySchema, request.headers['idempotency-key']);
        const result = await options.consent.setConsent(principal(request).athleteId, {
          ...input,
          kind,
          idempotencyKey,
        });
        return consentSchema.parse(result);
      });
    },
    { prefix: '/bff/v1' },
  );
  return app;
}
