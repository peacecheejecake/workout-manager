import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FOOT_GRAPH_WAY_EXPRESSIONS,
  deriveTimeConditionalWays,
} from '../../../scripts/build-routing-graph.mts';

/**
 * M2-01ay, Codex phase review r1: the time-conditional way list selects the ways the foot graph
 * can hold with the same filter as the military perimeter barriers. GraphHopper 10.0's foot parser
 * also routes over `man_made=pier` and `railway=platform` ways that carry no `highway` tag; one of
 * them with `opening_hours` must still make a route say so.
 *
 * Runs `osmium` on a synthetic OPL extract. Where `osmium` is not installed (CI) the case is
 * SKIPPED, and the skip is visible in its name; a skip is not a pass.
 */
const haveOsmium = spawnSync('osmium', ['--version']).status === 0;
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const node = (id, x, y) => `n${id} v1 dV c0 t2026-01-01T00:00:00Z i0 u T x${x} y${y}`;
const way = (id, tags, refs) =>
  `w${id} v1 dV c0 t2026-01-01T00:00:00Z i0 u T${tags} N${refs.map((ref) => `n${ref}`).join(',')}`;

describe.skipIf(!haveOsmium)(
  `time-conditional way list (M2-01ay r1)${haveOsmium ? '' : ' - SKIPPED: no osmium'}`,
  () => {
    it('lists every way the foot graph can hold, piers and platforms included', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'time-conditional-'));
      scratch.push(directory);
      const extract = join(directory, 'extract.opl');
      await writeFile(
        extract,
        `${[
          node(1, 127, 37),
          node(2, 127.001, 37),
          way(10, 'highway=footway,access:conditional=yes%20%@%20%6:00-24:00', [1, 2]),
          way(11, 'man_made=pier,area=yes,opening_hours=Mo-Su%20%09:00-20:00', [1, 2]),
          way(12, 'railway=platform,opening_hours=24/7', [1, 2]),
          way(13, 'route=ferry,opening_hours=Mo-Su%20%10:00-20:27', [1, 2]),
          way(14, 'highway=footway', [1, 2]),
          way(15, 'building=yes,opening_hours=24/7', [1, 2]),
          way(16, 'highway=motorway,opening_hours=24/7', [1, 2]),
          way(17, 'man_made=pier', [1, 2]),
        ].join('\n')}\n`,
      );
      const graphDirectory = join(directory, 'graph');
      const work = join(directory, 'work');
      await mkdir(work);
      const list = await deriveTimeConditionalWays({
        extractPath: extract,
        graphDirectory,
        scratch: work,
      });
      // A footway, a pier and a platform with a time condition, and the ferry; not a building,
      // not a motorway the profile ignores, nothing without a time condition.
      expect(list.wayIds).toEqual([10, 11, 12, 13]);
      const written = JSON.parse(
        await readFile(join(graphDirectory, 'edge-facts', 'time-conditional-ways.json'), 'utf8'),
      );
      expect(written.wayIds).toEqual([10, 11, 12, 13]);
    });
  },
);

describe('the foot graph way filter (M2-01ay r1)', () => {
  it("names everything GraphHopper 10.0's foot parser takes as a way", () => {
    expect([...FOOT_GRAPH_WAY_EXPRESSIONS]).toEqual([
      'w/highway',
      'w/route=ferry,shuttle_train',
      'w/railway=platform',
      'w/man_made=pier',
    ]);
  });
});
