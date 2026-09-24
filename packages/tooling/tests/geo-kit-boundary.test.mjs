import path from 'node:path';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../eslint/index.mjs';

/**
 * P5-geokit-boundary (map plan §5): "`experience/geo-kit` takes an SDK-free MapPath and a
 * selected position/events". This runs the repository's own ESLint config against the real
 * workspace manifests — not a synthetic workspace — so it proves what `pnpm lint` enforces
 * on the actual geo-kit, module and app paths.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const linter = new Linter({ cwd: root });
const config = createConfig(root);

function boundaryMessages(file, source) {
  return linter
    .verify(source, config, { filename: path.join(root, file) })
    .filter((message) => message.ruleId === 'architecture/boundaries');
}

describe('geo-kit boundary in the repository lint config', () => {
  it.each([
    // The kit knows nothing of the modules that own recorded/planned use cases.
    [
      'packages/experience/geo-kit/src/map-path.ts',
      "import { ActivityBrowser } from '@workout/modules-activities/activity-browser';",
      'UI and experience kits cannot depend on modules or apps',
    ],
    [
      'packages/experience/geo-kit/src/map-view.tsx',
      "import { CourseWorkbench } from '@workout/modules-courses/course-workbench';",
      'UI and experience kits cannot depend on modules or apps',
    ],
    // ...nor of FIT/GPX sources...
    [
      'packages/experience/geo-kit/src/map-path.ts',
      "import { parseTrackFile } from '@workout/track-parsing';",
      'Experience kits receive display paths, never FIT/GPX parsers',
    ],
    [
      'packages/experience/geo-kit/src/maplibre-adapter.ts',
      "import { buildMapPath } from '../../../track-parsing/src/path';",
      'Experience kits receive display paths, never FIT/GPX parsers',
    ],
    // ...nor of server policy.
    [
      'packages/experience/geo-kit/src/map-view.tsx',
      "import { createCourseRepository } from '@workout/server-persistence/courses';",
      'Browser packages cannot import server implementation',
    ],
    // The SDK stays behind the adapter module: not in the kit's SDK-free files...
    [
      'packages/experience/geo-kit/src/map-path.ts',
      "import type { LngLat } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    [
      'packages/experience/geo-kit/src/map-view.tsx',
      "import { Map } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // ...not in a domain module, in any import form...
    [
      'packages/modules/activities/src/activity-track-panel.tsx',
      "import { Map } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    [
      'packages/modules/courses/src/course-workbench.tsx',
      "const sdk = await import('maplibre-gl');",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    [
      'packages/modules/courses/src/course-new.tsx',
      "import 'maplibre-gl/dist/maplibre-gl.css';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // ...and not in an app shell.
    [
      'apps/web/app/activities/activities-page.tsx',
      "import { setWorkerUrl } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // A path into the installed package is the SDK by another spelling.
    [
      'packages/modules/activities/src/map-leaf.tsx',
      "import { Map } from '../../../../node_modules/.pnpm/maplibre-gl@6.9.1/node_modules/maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    [
      'packages/experience/geo-kit/src/map-view.tsx',
      "import { Map } from '../node_modules/maplibre-gl/dist/maplibre-gl.js';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // Even the adapter never hands the SDK on under its own name.
    [
      'packages/experience/geo-kit/src/maplibre-adapter.ts',
      "export { Map } from 'maplibre-gl';",
      'The map SDK is never re-exported',
    ],
    [
      'packages/experience/geo-kit/src/maplibre-adapter.ts',
      "export * from 'maplibre-gl';",
      'The map SDK is never re-exported',
    ],
    [
      'packages/experience/geo-kit/src/maplibre-adapter.ts',
      "export type { LngLat } from '../node_modules/maplibre-gl';",
      'The map SDK is never re-exported',
    ],
    // The spike's owner is its one map panel, not the whole package...
    [
      'packages/experience/ui-spike/src/workspace.tsx',
      "import { Map } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // ...and the kit's tests may name SDK types, never SDK values.
    [
      'packages/experience/geo-kit/tests/geo-kit.test.tsx',
      "import { Map } from 'maplibre-gl';",
      'Only the geo-kit MapLibre adapter may import the map SDK',
    ],
    // Consumers reach the kit only through its declared exports.
    [
      'packages/modules/activities/src/map-leaf.tsx',
      "import { createMapLibreAdapter } from '@workout/geo-kit/src/maplibre-adapter';",
      'Import only declared public package exports',
    ],
    [
      'packages/modules/activities/src/map-leaf.tsx',
      "import { createMapLibreAdapter } from '../../../experience/geo-kit/src/maplibre-adapter';",
      'Cross-package paths must use a public package export',
    ],
  ])('rejects %s: %s', (file, source, reason) => {
    const messages = boundaryMessages(file, source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ messageId: 'boundary', severity: 2 });
    expect(messages[0]?.message).toContain(reason);
  });

  it.each([
    [
      'packages/experience/geo-kit/src/maplibre-adapter.ts',
      "import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';",
    ],
    [
      'packages/experience/geo-kit/src/map-view.tsx',
      "const m = await import('./maplibre-adapter');",
    ],
    ['packages/experience/ui-spike/src/map-panel.tsx', "import { Map } from 'maplibre-gl';"],
    [
      'packages/experience/geo-kit/tests/maplibre-adapter.test.tsx',
      "import type { Map as MapLibreMap } from 'maplibre-gl';",
    ],
    [
      'packages/modules/activities/src/map-leaf.tsx',
      "import type { MapPath } from '@workout/geo-kit/map-path';",
    ],
    [
      'packages/modules/courses/src/course-workbench.tsx',
      "const m = await import('@workout/geo-kit/maplibre-adapter');",
    ],
    [
      'packages/modules/activities/src/track-preview-worker.ts',
      "import { parseTrackFile } from '@workout/track-parsing';",
    ],
  ])('allows %s: %s', (file, source) => {
    expect(boundaryMessages(file, source)).toEqual([]);
  });
});
