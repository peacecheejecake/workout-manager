import {
  mapDataLicenceReadPath,
  mapDataScriptReadPath,
  mapDataLicenceResponseSchema,
  type GeoDatasetsLicenceState,
  type MapDataLicenceResponse,
  type RoutingDataDisclosure,
} from '@workout/contracts/map-data-licence';
import type { FastifyInstance } from 'fastify';
import { readPinnedMapDataScript } from './map-data-script-read.js';

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
  scriptArtifacts?: {
    readonly routing?: () => {
      readonly directory: string;
      readonly disclosure: RoutingDataDisclosure;
    };
    readonly geoDatasets?: string;
  },
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
  app.get(`${mapDataScriptReadPath}/:kind/:identity/:index`, async (request, reply) => {
    const params = request.params as { kind?: string; identity?: string; index?: string };
    let directory: string | undefined;
    let scripts: Readonly<Record<string, string>> | undefined;
    if (params.kind === 'routing') {
      const artifact = scriptArtifacts?.routing?.();
      const active = artifact?.disclosure;
      if (
        active !== undefined &&
        active.graph.graphBuildId === params.identity &&
        active.derivation?.scripts !== undefined
      ) {
        directory = artifact?.directory;
        scripts = active.derivation.scripts;
      }
    } else if (params.kind === 'geo' && geoDatasets.kind === 'disclosed') {
      const active = geoDatasets.disclosure;
      if (
        `${active.datasets.placesDatasetId}-${active.datasets.elevationDatasetId}` ===
        params.identity
      ) {
        directory = scriptArtifacts?.geoDatasets;
        scripts = active.alterationMethod.scripts;
      }
    }
    const bytes =
      directory === undefined || scripts === undefined || params.index === undefined
        ? null
        : await readPinnedMapDataScript(directory, scripts, params.index);
    if (bytes === null) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return reply
      .code(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="odbl-script-${params.index}.txt"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });
}
