/**
 * Where the shell finds the self-hosted background map.
 *
 * Server-side only: it reads the deployment pointer that `scripts/build-basemap.mjs`
 * wrote and turns it into the same-origin descriptor the map kit accepts. With
 * `BASEMAP_DIST_DIR` unset this returns `null` and the route is drawn with no background,
 * which is a supported state on screen rather than a failure.
 *
 * The descriptor carries a path, never an absolute URL: the kit resolves it against the
 * page origin with a real URL parser and refuses anything that leaves this origin.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ShellBasemap {
  readonly styleUrl: string;
  readonly attribution: string;
  readonly localIdeographFontFamily: string;
}

/** Hangul/CJK labels are rasterised on the device, so they never become a glyph request. */
const localIdeographFontFamily = "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";

const deploymentIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Attribution is rendered as plain text by the kit, so markup there is never wanted. */
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

export async function resolveShellBasemap(): Promise<ShellBasemap | null> {
  const configured = process.env['BASEMAP_DIST_DIR'];
  if (configured === undefined || configured === '') return null;
  const root = resolve(configured);
  try {
    const pointer: unknown = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
    const deploymentId =
      pointer !== null && typeof pointer === 'object' && 'deploymentId' in pointer
        ? pointer.deploymentId
        : null;
    if (typeof deploymentId !== 'string' || !deploymentIdPattern.test(deploymentId)) return null;
    const attribution = sanitizeAttribution(
      await readFile(join(root, deploymentId, 'ATTRIBUTION.txt'), 'utf8'),
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
