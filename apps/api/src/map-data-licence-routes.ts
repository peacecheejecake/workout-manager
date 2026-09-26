import {
  mapDataLicenceReadPath,
  mapDataLicenceResponseSchema,
  type GeoDatasetsLicenceState,
  type MapDataLicenceResponse,
  type RoutingDataDisclosure,
} from '@workout/contracts/map-data-licence';
import type { FastifyInstance } from 'fastify';

/**
 * `GET /bff/v1/map-data/licence` — the ODbL §4.6 disclosure of the routing graph this API is
 * serving right now (M0-06b-odbl). Public on purpose: the licence obliges us to tell anyone
 * who receives the derived data how it was made, so the page that shows it needs no sign-in.
 *
 * It reads no cookie, no session and no query, and answers the same document to everyone. The
 * document holds hashes, versions, counts and public URLs — no path, host or engine address.
 * `disclosure` is read per request so a blue/green switch shows the new graph immediately.
 */
export function registerMapDataLicenceRead(
  app: FastifyInstance,
  disclosure: (() => RoutingDataDisclosure) | undefined,
  geoDatasets: GeoDatasetsLicenceState = { kind: 'none' },
) {
  app.get(mapDataLicenceReadPath, async (_request, reply) => {
    const body: MapDataLicenceResponse = mapDataLicenceResponseSchema.parse({
      schemaVersion: 1,
      routing: disclosure === undefined ? null : disclosure(),
      geoDatasets,
    });
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
