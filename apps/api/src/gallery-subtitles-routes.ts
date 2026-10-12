import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { principalSchema, type Principal } from './ports.js';
import { command, input, ProductRequestError } from './product-boundary.js';
import {
  GallerySubtitlesServiceError,
  type GallerySubtitlesReadService,
} from './gallery-subtitles-service.js';

const params = z.strictObject({ mediaItemId: z.uuid().transform((value) => value.toLowerCase()) });
const query = z.strictObject({
  accessRevision: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().positive().safe()),
});
function translate(error: unknown) {
  if (!(error instanceof GallerySubtitlesServiceError)) return undefined;
  return new ProductRequestError(
    error.code === 'INVALID_REQUEST'
      ? 400
      : error.code === 'INVALID_REPLY'
        ? 502
        : error.code === 'MEDIA_NOT_FOUND'
          ? 404
          : error.code === 'MEDIA_ACCESS_CONFLICT'
            ? 409
            : 503,
    error.code,
  );
}

/** Register only inside the existing authenticated /bff/v1 product plugin.
 * Cookie session fencing is inherited; GET is read-only under existing CSRF rules.
 */
export function registerGallerySubtitlesRoutes(
  routes: FastifyInstance,
  service: GallerySubtitlesReadService | undefined,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (subtitleRoutes) => {
    subtitleRoutes.get('/gallery/media/:mediaItemId/subtitles', async (request, reply) => {
      const athleteId = principalSchema.parse(principal(request)).athleteId;
      const { mediaItemId } = input(params, request.params);
      const { accessRevision } = input(query, request.query);
      if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
      if (!service) throw new ProductRequestError(503, 'GALLERY_SUBTITLES_UNAVAILABLE');
      const result = await command(
        () => service.read(athleteId, { mediaItemId, accessRevision }),
        translate,
      );
      return reply.header('cache-control', 'private, no-store').send(result);
    });
  });
}
