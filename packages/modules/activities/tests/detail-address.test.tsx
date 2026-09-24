import { describe, expect, it } from 'vitest';
import { activityDetailAliasTarget } from '../src/detail-address';
import { readActivitySearch } from '../src/browser-search';

const id = '5f0c6f4e-7d0a-4b8e-9a51-3c2d1e0f9a8b';
const target = (pathId: string, search: string) =>
  activityDetailAliasTarget(pathId, new URLSearchParams(search));
const read = (address: string) => readActivitySearch(new URL(address, 'http://x').search);

describe('S09 alias /activities/:id?tab= (M2-01k-k)', () => {
  it.each(['overview', 'intervals', 'route', 'impact', 'media', 'source'] as const)(
    'forwards tab=%s to the same detail tab',
    (tab) => {
      const address = target(id, `tab=${tab}`);
      expect(address).toBe(`/activities?selected=${id}&detailTab=${tab}`);
      expect(read(address)).toMatchObject({ selected: id, detailTab: tab, invalid: false });
    },
  );

  it('opens the default tab when no tab is given', () => {
    expect(target(id, '')).toBe(`/activities?selected=${id}`);
    expect(read(target(id, ''))).toMatchObject({ selected: id, detailTab: 'overview' });
  });

  it('carries unknown tabs and malformed ids to the screen verbatim, which rejects them', () => {
    expect(read(target(id, 'tab=map'))).toMatchObject({ selected: id, detailTab: null });
    expect(read(target('not-an-activity', 'tab=overview'))).toMatchObject({ invalid: true });
    expect(read(target('a&selected=' + id, ''))).toMatchObject({ invalid: true });
  });

  it('keeps other parameters and lets the path and tab win over selected/detailTab', () => {
    const other = '0b8f3e8a-1111-4222-8333-944455556666';
    const address = target(id, `view=table&selected=${other}&detailTab=source&tab=route`);
    expect(new URL(address, 'http://x').searchParams.getAll('selected')).toEqual([id]);
    expect(read(address)).toMatchObject({ selected: id, detailTab: 'route', view: 'table' });
    expect(read(target(id, 'detailTab=source'))).toMatchObject({ detailTab: 'overview' });
  });
});
