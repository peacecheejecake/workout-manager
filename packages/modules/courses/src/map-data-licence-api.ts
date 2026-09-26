import {
  basemapDataDisclosureSchema,
  basemapDisclosureFile,
  basemapPointerPath,
  mapDataLicenceReadPath,
  mapDataLicenceResponseSchema,
  type BasemapDataDisclosure,
  type RoutingDataDisclosure,
} from '@workout/contracts/map-data-licence';

/**
 * Reads what the public map-data licence page shows (M0-06b-odbl): the background tile
 * deployment the shell serves right now and the routing graph the API serves right now.
 *
 * Both are public: the tile deployment's files are public static assets, and the routing
 * disclosure is the API's unauthenticated read. Nothing here sends a cookie
 * (`credentials: 'omit'`), follows a redirect, or keeps what it read.
 *
 * Every state is kept apart, because each means something different to a reader:
 * no background deployment, a deployment built before it carried a disclosure (it cannot be
 * distributed as it is), a disclosure that describes another deployment, and a failed read.
 */
export type BasemapLicenceState =
  | { readonly kind: 'none' }
  | { readonly kind: 'undisclosed'; readonly deploymentId: string }
  | { readonly kind: 'disclosed'; readonly disclosure: BasemapDataDisclosure }
  | { readonly kind: 'unavailable' };

export type RoutingLicenceState =
  | { readonly kind: 'none' }
  | { readonly kind: 'disclosed'; readonly disclosure: RoutingDataDisclosure }
  | { readonly kind: 'unavailable' };

export interface MapDataLicenceState {
  readonly basemap: BasemapLicenceState;
  readonly routing: RoutingLicenceState;
}

const deploymentIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function publicRead(fetcher: typeof fetch, path: string, signal?: AbortSignal) {
  return fetcher(path, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    ...(signal ? { signal } : {}),
  });
}

export async function readBasemapLicence(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BasemapLicenceState> {
  try {
    const pointerResponse = await publicRead(fetcher, basemapPointerPath, signal);
    if (pointerResponse.status === 404) return { kind: 'none' };
    if (!pointerResponse.ok) return { kind: 'unavailable' };
    // A static host with a single-page fallback answers an unserved path with its HTML page:
    // no pointer is served there, which is "no background deployment", not a broken one.
    if (!(pointerResponse.headers.get('content-type') ?? '').includes('json'))
      return { kind: 'none' };
    const pointer: unknown = await pointerResponse.json();
    const deploymentId =
      pointer !== null && typeof pointer === 'object' && 'deploymentId' in pointer
        ? pointer.deploymentId
        : null;
    if (typeof deploymentId !== 'string' || !deploymentIdPattern.test(deploymentId))
      return { kind: 'unavailable' };
    const response = await publicRead(
      fetcher,
      `/map/basemap/${deploymentId}/${basemapDisclosureFile}`,
      signal,
    );
    if (response.status === 404) return { kind: 'undisclosed', deploymentId };
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = basemapDataDisclosureSchema.safeParse(await response.json());
    // A record that names another deployment is not this deployment's record.
    if (!parsed.success || parsed.data.deploymentId !== deploymentId)
      return { kind: 'unavailable' };
    return { kind: 'disclosed', disclosure: parsed.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function readRoutingLicence(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RoutingLicenceState> {
  try {
    const response = await publicRead(fetcher, mapDataLicenceReadPath, signal);
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = mapDataLicenceResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: 'unavailable' };
    return parsed.data.routing === null
      ? { kind: 'none' }
      : { kind: 'disclosed', disclosure: parsed.data.routing };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Both reads at once; neither waits for the other. */
export async function readMapDataLicence(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<MapDataLicenceState> {
  const [basemap, routing] = await Promise.all([
    readBasemapLicence(fetcher, signal),
    readRoutingLicence(fetcher, signal),
  ]);
  return { basemap, routing };
}
