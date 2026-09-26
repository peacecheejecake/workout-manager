import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { graphhopperToolJavaArguments } from '../../../scripts/geo/graphhopper-launch.mjs';

/**
 * M2-01ay: `scripts/geo/MilitaryPerimeterBarriers.java`, which closes every place where a walkable
 * way crosses a military perimeter by inserting a `foot=no` barrier node there, on synthetic
 * OSM-shaped input (GeoJSON areas, OPL ways with node locations).
 *
 * It runs on the pinned GraphHopper jar's classpath (JTS), which lives in the shared `.geo-build`
 * cache and not in the repository. Where the jar is absent (CI) these cases are SKIPPED, and the
 * skip is visible in the test name; a skip is not a pass.
 */
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const jarPath = join(repositoryRoot, '.geo-build', 'graphhopper', 'graphhopper-web.jar');
const sourcePath = join(repositoryRoot, 'scripts', 'geo', 'MilitaryPerimeterBarriers.java');
const haveJar = existsSync(jarPath);
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const square = (x0, y0, x1, y1) => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ],
];
const area = (properties, rings) =>
  `\u001e${JSON.stringify({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: rings } })}\n`;
/** One OPL way line as `osmium add-locations-to-ways` writes it. */
const way = (id, tags, nodes) =>
  `w${id} v3 dV c0 t2026-01-01T00:00:00Z i0 u T${tags} N${nodes
    .map(([ref, x, y]) => `n${ref}x${x}y${y}`)
    .join(',')}\n`;

async function derive(military, ways) {
  const directory = await mkdtemp(join(tmpdir(), 'military-barriers-'));
  scratch.push(directory);
  const militaryFile = join(directory, 'military.geojsonseq');
  const waysFile = join(directory, 'ways.opl');
  const out = join(directory, 'changes.osc');
  await writeFile(militaryFile, military.join(''));
  await writeFile(waysFile, ways.join(''));
  const run = spawnSync(
    'java',
    graphhopperToolJavaArguments({ jarPath, sourcePath, args: [militaryFile, waysFile, out] }),
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  const osc = await readFile(out, 'utf8');
  const nodes = [
    ...osc.matchAll(/<node id="(\d+)" version="1" lat="([\d.-]+)" lon="([\d.-]+)">/g),
  ].map(([, id, lat, lon]) => ({ id, lat: Number(lat), lon: Number(lon) }));
  const modified = [...osc.matchAll(/<way id="(\d+)" version="(\d+)">([\s\S]*?)<\/way>/g)].map(
    ([, id, version, body]) => ({
      id,
      version: Number(version),
      refs: [...body.matchAll(/<nd ref="(\d+)"\/>/g)].map((match) => match[1]),
      tags: Object.fromEntries(
        [...body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((match) => [match[1], match[2]]),
      ),
    }),
  );
  return { osc, nodes, modified, summary: JSON.parse(run.stdout.trim().split('\n').at(-1)) };
}

// A base of 0.01 degrees (about 900 m by 1,100 m) near Seoul.
const base = area({ landuse: 'military', name: 'base' }, square(127, 37, 127.01, 37.01));

describe.skipIf(!haveJar)(
  `military perimeter barriers (M2-01ay)${haveJar ? '' : ' - SKIPPED: no pinned jar in .geo-build'}`,
  () => {
    it('closes a way where it crosses the perimeter, and leaves ways inside and outside alone', async () => {
      const { nodes, modified, summary, osc } = await derive(
        [base],
        [
          way(10, 'highway=service,name=gate%20%road', [
            [1, 127.005, 36.995],
            [2, 127.005, 37.005],
          ]),
          way(11, 'highway=footway', [
            [3, 127.003, 37.003],
            [4, 127.007, 37.007],
          ]),
          way(12, 'highway=footway', [
            [5, 127.02, 37.02],
            [6, 127.03, 37.03],
          ]),
        ],
      );
      expect(summary).toMatchObject({ waysRead: 3, waysGivenBarriers: 1, barrierNodes: 1 });
      expect(nodes).toEqual([{ id: '20000000000', lat: 37, lon: 127.005 }]);
      expect(modified).toEqual([
        {
          id: '10',
          version: 4,
          refs: ['1', '20000000000', '2'],
          tags: { highway: 'service', name: 'gate road' },
        },
      ]);
      // What makes GraphHopper's foot parser close the barrier edge: a restricted `foot` value.
      expect(osc).toContain('<tag k="foot" v="no"/>');
      expect(osc).toContain('<tag k="barrier" v="gate"/>');
    });

    it('merges adjoining and nested areas first: no perimeter between them', async () => {
      const east = area({ military: 'range' }, square(127.01, 37, 127.02, 37.01));
      const nested = area({ landuse: 'military' }, square(127.004, 37.004, 127.006, 37.006));
      const { modified, summary } = await derive(
        [base, east, nested],
        [
          way(20, 'highway=track', [
            [1, 127.008, 37.005],
            [2, 127.012, 37.005],
          ]),
          way(21, 'highway=track', [
            [3, 127.002, 37.005],
            [4, 127.005, 37.005],
          ]),
          way(22, 'highway=track', [
            [5, 127.015, 37.009],
            [6, 127.015, 37.011],
          ]),
        ],
      );
      expect(summary).toMatchObject({ militaryFeatures: 3, militaryPolygonsAfterUnion: 1 });
      expect(modified.map((entry) => entry.id)).toEqual(['22']);
    });

    it('leaves a way the foot parser already closes, and closes one a foot value opens', async () => {
      const { modified, summary } = await derive(
        [base],
        [
          way(30, 'highway=service,foot=no', [
            [1, 127.002, 36.995],
            [2, 127.002, 37.005],
          ]),
          way(31, 'highway=service,access=military', [
            [3, 127.003, 36.995],
            [4, 127.003, 37.005],
          ]),
          way(32, 'highway=service,access=private,foot=yes', [
            [5, 127.004, 36.995],
            [6, 127.004, 37.005],
          ]),
        ],
      );
      expect(summary).toMatchObject({ waysClosedToPedestriansSkipped: 2, waysGivenBarriers: 1 });
      expect(modified.map((entry) => entry.id)).toEqual(['32']);
    });

    it('puts the barrier beside a node that lies on the perimeter, on each segment touching it', async () => {
      const { nodes, modified } = await derive(
        [base],
        [
          way(40, 'highway=footway', [
            [1, 127.005, 36.995],
            [2, 127.005, 37],
            [3, 127.005, 37.005],
          ]),
        ],
      );
      // Node 2 keeps its place and its role; the new nodes sit about 0.1 m either side of it.
      expect(modified[0]?.refs).toEqual(['1', '20000000000', '2', '20000000001', '3']);
      expect(nodes.map((node) => node.lat)).toEqual([36.999999, 37.000001]);
    });

    it('closes a stretch that runs along the perimeter at both of its ends', async () => {
      const { modified } = await derive(
        [base],
        [
          way(50, 'highway=path', [
            [1, 126.998, 37],
            [2, 127.004, 37],
          ]),
        ],
      );
      // Meets the fence at its corner (127, 37) and runs along it to its end at 127.004.
      expect(modified[0]?.refs.length).toBeGreaterThanOrEqual(3);
      expect(modified[0]?.refs[0]).toBe('1');
      expect(modified[0]?.refs.at(-1)).toBe('2');
    });

    it('changes nothing when the extract has no military area', async () => {
      const { nodes, modified, summary } = await derive(
        [],
        [
          way(60, 'highway=footway', [
            [1, 127, 37],
            [2, 127.01, 37.01],
          ]),
        ],
      );
      expect(summary).toMatchObject({ militaryFeatures: 0, barrierNodes: 0 });
      expect(nodes).toEqual([]);
      expect(modified).toEqual([]);
    });

    it('escapes tag values for the osmChange document', async () => {
      const { modified, osc } = await derive(
        [base],
        [
          way(70, 'highway=path,name=A%26%B%20%%3c%x%3e%,note=say%20%%22%hi%22%', [
            [1, 127.001, 36.995],
            [2, 127.001, 37.005],
          ]),
        ],
      );
      expect(osc).toContain('v="A&amp;B &lt;x&gt;"');
      expect(osc).toContain('v="say &quot;hi&quot;"');
      expect(modified[0]?.tags.name).toBe('A&amp;B &lt;x&gt;');
    });
  },
);
