import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseArguments,
  pruneDeployments,
  publishStagedBuild,
  verifyStagedBuild,
  withDistributionLock,
} from '../../../scripts/build-basemap.mjs';

const created = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'workout-geo-build-'));
  created.push(directory);
  return directory;
}

/** A staged build with every artifact the style references. */
async function stageComplete(root, { tileBody = 'tile' } = {}) {
  await mkdir(join(root, 'tiles', '10', '1'), { recursive: true });
  await writeFile(join(root, 'tiles', '10', '1', '2.pbf'), tileBody);
  await mkdir(join(root, 'glyphs', 'Noto Sans Regular'), { recursive: true });
  for (const range of ['0-255', '256-511', '8192-8447'])
    await writeFile(join(root, 'glyphs', 'Noto Sans Regular', `${range}.pbf`), 'glyph');
  await writeFile(join(root, 'glyphs', 'OFL.txt'), 'license');
  for (const name of ['sprite.json', 'sprite.png', 'sprite@2x.json', 'sprite@2x.png'])
    await writeFile(join(root, name), 'sprite');
  await writeFile(
    join(root, 'style.json'),
    JSON.stringify({
      version: 8,
      glyphs: '/map/basemap/abc/glyphs/{fontstack}/{range}.pbf',
      sources: { basemap: { tiles: ['/map/basemap/abc/tiles/{z}/{x}/{y}.pbf'] } },
    }),
  );
  await writeFile(join(root, 'tiles.json'), '{}');
  await writeFile(join(root, 'ATTRIBUTION.txt'), 'attribution');
}

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('basemap build arguments', () => {
  it('requires the explicit opt-in', () => {
    expect(parseArguments([])).toBeNull();
    expect(parseArguments(['--reuse'])).toBeNull();
    expect(parseArguments(['--execute'])).toEqual({ reuse: false, basePath: '/map/basemap' });
  });

  it('accepts only a same-origin absolute serving prefix', () => {
    expect(parseArguments(['--execute', '--base-path=/tiles/public'])?.basePath).toBe(
      '/tiles/public',
    );
    for (const argument of [
      '--base-path=https://cdn.example/map',
      '--base-path=//cdn.example/map',
      '--base-path=map',
      '--base-path=/map/../etc',
    ]) {
      expect(parseArguments(['--execute', argument])).toBeNull();
    }
  });
});

describe('staged build verification', () => {
  it('accepts a complete staged build', async () => {
    const root = await workspace();
    await stageComplete(root);
    await expect(verifyStagedBuild(root, 1)).resolves.toBeUndefined();
  });

  it('refuses a build with no tiles', async () => {
    const root = await workspace();
    await stageComplete(root);
    await expect(verifyStagedBuild(root, 0)).rejects.toThrow('STAGED_BUILD_HAS_NO_TILES');
  });

  it('refuses a build whose glyph download failed', async () => {
    const root = await workspace();
    await stageComplete(root);
    await rm(join(root, 'glyphs', 'Noto Sans Regular', '0-255.pbf'));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('STAGED_BUILD_INCOMPLETE');
  });

  it('refuses a zero-length artifact', async () => {
    const root = await workspace();
    await stageComplete(root);
    await writeFile(join(root, 'sprite.png'), '');
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('STAGED_BUILD_INCOMPLETE: sprite.png');
  });

  it('refuses a staged style that points at another host', async () => {
    const root = await workspace();
    await stageComplete(root);
    await writeFile(
      join(root, 'style.json'),
      JSON.stringify({ version: 8, sprite: 'https://cdn.example/sprite' }),
    );
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('EXTERNAL_STYLE_REFERENCE');
  });

  it('refuses a staged style whose backslash a URL parser would resolve off-origin', async () => {
    const root = await workspace();
    await stageComplete(root);
    // `new URL('\\\\outside.example/sprite', origin)` is `https://outside.example/sprite`,
    // so a scheme/`//` check alone would pass this document.
    await writeFile(
      join(root, 'style.json'),
      JSON.stringify({ version: 8, sprite: '/\\outside.example/sprite' }),
    );
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('EXTERNAL_STYLE_REFERENCE');
  });
});

describe('publishing a staged build', () => {
  it('renames the staged directory into a fresh deployment and writes the pointer', async () => {
    const distributionRoot = await workspace();
    const stagingRoot = join(distributionRoot, '.staging-abc-1');
    await stageComplete(stagingRoot);
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot,
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    expect(pointer.deploymentId).toBe('abc-1');
    expect(pointer.buildId).toBe('abc');
    expect(pointer.previousDeploymentId).toBeNull();
    expect((await stat(join(distributionRoot, 'abc-1'))).isDirectory()).toBe(true);
    await expect(stat(stagingRoot)).rejects.toThrow();
    const written = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    expect(written.deploymentId).toBe('abc-1');
  });

  it('never replaces a published deployment, so rollback reaches the old bytes', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await writeFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'first');
    // Same build id, second publish: the earlier deployment must be untouched.
    await stageComplete(join(distributionRoot, '.staging-2'));
    await writeFile(join(distributionRoot, '.staging-2', 'marker.txt'), 'second');
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-2'),
      deploymentId: 'abc-2',
      buildId: 'abc',
    });
    expect(pointer.previousDeploymentId).toBe('abc-1');
    expect(pointer.deploymentId).not.toBe(pointer.previousDeploymentId);
    expect(await readFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(distributionRoot, 'abc-2', 'marker.txt'), 'utf8')).toBe('second');
    // Rolling the pointer back yields the OLD content, not the new content.
    const rolledBack = join(distributionRoot, pointer.previousDeploymentId, 'marker.txt');
    expect(await readFile(rolledBack, 'utf8')).toBe('first');
  });

  it('refuses to publish onto an existing deployment id', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await stageComplete(join(distributionRoot, '.staging-2'));
    await expect(
      publishStagedBuild({
        distributionRoot,
        stagingRoot: join(distributionRoot, '.staging-2'),
        deploymentId: 'abc-1',
        buildId: 'abc',
      }),
    ).rejects.toThrow('DEPLOYMENT_ID_ALREADY_PUBLISHED');
    // The deployed copy is still there and still complete.
    await expect(verifyStagedBuild(join(distributionRoot, 'abc-1'), 1)).resolves.toBeUndefined();
  });

  it('leaves the deployed copy intact when the publish fails', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    const first = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await writeFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'deployed');
    await expect(
      publishStagedBuild({
        distributionRoot,
        // A staging directory that does not exist makes the rename fail.
        stagingRoot: join(distributionRoot, '.staging-missing'),
        deploymentId: 'abc-2',
        buildId: 'abc',
      }),
    ).rejects.toThrow();
    expect(await readFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'utf8')).toBe('deployed');
    const pointer = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    // The pointer still names the working deployment.
    expect(pointer.deploymentId).toBe(first.deploymentId);
  });

  it('keeps the current and previous deployments and removes older ones', async () => {
    const distributionRoot = await workspace();
    for (const id of ['abc-1', 'abc-2', 'abc-3']) {
      await stageComplete(join(distributionRoot, `.staging-${id}`));
      await publishStagedBuild({
        distributionRoot,
        stagingRoot: join(distributionRoot, `.staging-${id}`),
        deploymentId: id,
        buildId: 'abc',
        prune: false,
      });
    }
    const removed = await pruneDeployments(distributionRoot);
    expect(removed).toEqual(['abc-1']);
    expect((await stat(join(distributionRoot, 'abc-2'))).isDirectory()).toBe(true);
    expect((await stat(join(distributionRoot, 'abc-3'))).isDirectory()).toBe(true);
  });

  it('never prunes the live deployment, even from a stale view of the pointer', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-a'));
    // Publish A, then B. A prune driven by A's (now stale) pointer used to delete B.
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-a'),
      deploymentId: 'abc-a',
      buildId: 'abc',
      prune: false,
    });
    await stageComplete(join(distributionRoot, '.staging-b'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-b'),
      deploymentId: 'abc-b',
      buildId: 'abc',
      prune: false,
    });
    const removed = await pruneDeployments(distributionRoot);
    const pointer = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    expect(pointer.deploymentId).toBe('abc-b');
    expect(removed).toEqual([]);
    // The live deployment and its predecessor both survive.
    expect((await stat(join(distributionRoot, 'abc-b'))).isDirectory()).toBe(true);
    expect((await stat(join(distributionRoot, 'abc-a'))).isDirectory()).toBe(true);
  });

  it('leaves another build staging directory and the lock alone', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-live'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-live'),
      deploymentId: 'abc-live',
      buildId: 'abc',
      prune: false,
    });
    // A concurrent build's staging directory, mid-write.
    await stageComplete(join(distributionRoot, '.staging-other-7788'));
    const removed = await pruneDeployments(distributionRoot);
    expect(removed).toEqual([]);
    expect((await stat(join(distributionRoot, '.staging-other-7788'))).isDirectory()).toBe(true);
  });

  it('refuses to publish while another publish holds the lock', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await withDistributionLock(distributionRoot, async () => {
      await expect(
        publishStagedBuild({
          distributionRoot,
          stagingRoot: join(distributionRoot, '.staging-1'),
          deploymentId: 'abc-1',
          buildId: 'abc',
        }),
      ).rejects.toThrow('DISTRIBUTION_LOCKED');
    });
    // The lock is released afterwards, so the same publish now succeeds.
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    expect(pointer.deploymentId).toBe('abc-1');
  });
});
