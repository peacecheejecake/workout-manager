import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GarminError, type GarminService } from '@workout/server-identity/garmin-service';
import { principalSchema, type AuthenticationPort, type Principal } from './ports.js';
import { ProductRequestError } from './product-routes.js';
const empty = z.strictObject({});
function validate(request: FastifyRequest) {
  if (!empty.safeParse(request.query).success || request.body !== undefined)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
}
export function registerGarminRoutes(
  app: FastifyInstance,
  service: GarminService | undefined,
  principal: (request: FastifyRequest) => Principal,
) {
  app.get('/integrations/garmin/status', async (request) => {
    validate(request);
    return service
      ? service.status(principal(request).athleteId)
      : { configured: false, state: 'not_connected', permissions: [], connectedAt: null };
  });
  app.post('/integrations/garmin/connect', async (request) => {
    validate(request);
    if (!service) throw new GarminError('GARMIN_NOT_CONFIGURED');
    const user = principal(request);
    if (user.method !== 'cookie') throw new ProductRequestError(403, 'COOKIE_SESSION_REQUIRED');
    return service.begin(user.athleteId, user.sessionId);
  });
  app.delete('/integrations/garmin/connection', async (request) => {
    validate(request);
    if (!service) throw new GarminError('GARMIN_NOT_CONFIGURED');
    return service.disconnect(principal(request).athleteId);
  });
}
export function registerGarminCallback(
  app: FastifyInstance,
  service: GarminService | undefined,
  auth: AuthenticationPort,
) {
  app.get('/bff/v1/integrations/garmin/callback', async (request, reply) => {
    reply.header('referrer-policy', 'no-referrer');
    let result: 'connected' | 'denied' | 'failed' = 'failed';
    try {
      if (
        !service ||
        request.headers.authorization !== undefined ||
        typeof request.headers.cookie !== 'string' ||
        request.headers.cookie.length > 8192
      )
        throw new GarminError('GARMIN_CALLBACK_REJECTED');
      const principal = principalSchema.safeParse(
        await auth.authenticate({ cookie: request.headers.cookie }),
      );
      if (!principal.success || principal.data.method !== 'cookie')
        throw new GarminError('GARMIN_CALLBACK_REJECTED');
      result = await service.callback(
        principal.data.athleteId,
        principal.data.sessionId,
        request.query,
      );
    } catch {
      /* Provider details and authorization codes are never rendered or logged. */
    }
    return reply.redirect(`/account?garmin=${result}`);
  });
}
