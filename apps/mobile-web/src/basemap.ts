/**
 * The Vite shell resolves the self-hosted background map at runtime.
 *
 * The Next shell reads the deployment pointer on the server; this shell has no server, so
 * it reads the same two public files over its own origin. Both are public static assets of
 * the background deployment — there is nothing private on this path — and both requests
 * refuse redirects so they cannot leave the origin.
 *
 * `null` means "no background map configured", which is a supported state on screen.
 */
export interface ShellBasemap {
  readonly styleUrl: string;
  readonly attribution: string;
  readonly localIdeographFontFamily: string;
}

const localIdeographFontFamily = "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";
const deploymentIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sanitizeAttribution(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replaceAll('<', '(')
    .replaceAll('>', ')')
    .slice(0, 400);
}

/**
 * `cache` is explicit per resource. The deployment pointer is mutable — it changes on
 * every publish and on a rollback — so it is read with `no-store`; reading it from cache
 * would leave this shell on a deployment that may already have been pruned. Everything
 * under a deployment directory is immutable and may be cached normally.
 */
async function readText(path: string, signal: AbortSignal, cache: RequestCache): Promise<string> {
  const response = await fetch(path, { credentials: 'omit', cache, redirect: 'error', signal });
  if (!response.ok) throw new Error('BASEMAP_POINTER_UNAVAILABLE');
  return response.text();
}

export async function loadShellBasemap(signal: AbortSignal): Promise<ShellBasemap | null> {
  try {
    const pointer: unknown = JSON.parse(
      await readText('/map/basemap/current.json', signal, 'no-store'),
    );
    const deploymentId =
      pointer !== null && typeof pointer === 'object' && 'deploymentId' in pointer
        ? pointer.deploymentId
        : null;
    if (typeof deploymentId !== 'string' || !deploymentIdPattern.test(deploymentId)) return null;
    const attribution = sanitizeAttribution(
      await readText(`/map/basemap/${deploymentId}/ATTRIBUTION.txt`, signal, 'default'),
    );
    if (attribution === '') return null;
    return {
      styleUrl: `/map/basemap/${deploymentId}/style.json`,
      attribution,
      localIdeographFontFamily,
    };
  } catch {
    return null;
  }
}
