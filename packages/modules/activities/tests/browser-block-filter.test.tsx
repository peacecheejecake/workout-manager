import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BrowserBlockFilter } from '../src/browser-block-filter';
import { readActivitySearch } from '../src/browser-search';
const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const old = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const plan = {
  head: {
    id: version,
    version: 2,
    createdAt: '2026-09-16T00:00:00Z',
    draft: {
      title: '계획',
      timezone: 'UTC',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
        id: level === 'block' ? '한글_%' : level,
        parentId: index ? levels[index - 1] : null,
        level,
        title: level,
        startDate: '2026-09-01',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [],
    },
  },
  history: [],
};
function setup(fail = false) {
  const changed = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    const [search, setSearch] = useState(
      `linkedPlanVersionId=${old}&linkedBlockId=old&selected=cccccccc-cccc-4ccc-8ccc-cccccccccccc&offset=20&kind=running`,
    );
    return (
      <QueryClientProvider client={client}>
        <BrowserBlockFilter
          search={search}
          onSearchChange={(value) => {
            changed(value);
            setSearch(value);
          }}
          scope={['scope']}
          transport={{
            request: async () => ({
              status: fail ? 503 : 200,
              body: fail ? null : z.json().parse(plan),
              traceId: null,
            }),
          }}
        />
      </QueryClientProvider>
    );
  }
  render(<Host />);
  return { changed };
}
it('requires a complete version/Block pair without trimming meaningful literal IDs', () => {
  expect(readActivitySearch(`linkedPlanVersionId=${version}`).invalid).toBe(true);
  expect(readActivitySearch('linkedBlockId=block').invalid).toBe(true);
  expect(
    readActivitySearch(
      `linkedPlanVersionId=${version}&linkedBlockId=${encodeURIComponent('한글_%')}`,
    ).query?.linkedBlockId,
  ).toBe('한글_%');
});
it('never rewrites an old condition when options arrive and applies current Block atomically', async () => {
  const { changed } = setup();
  await screen.findByRole('option', { name: 'block · 2026-09-01 ~ 2026-10-01' });
  expect(changed).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.selectOptions(
    screen.getByLabelText('연결된 계획 Block'),
    JSON.stringify([version, '한글_%']),
  );
  const params = new URLSearchParams(String(changed.mock.lastCall?.[0]));
  expect(params.get('linkedPlanVersionId')).toBe(version);
  expect(params.get('linkedBlockId')).toBe('한글_%');
  expect(params.get('selected')).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  expect(params.has('offset')).toBe(false);
  expect(params.get('kind')).toBe('running');
});
it('allows clearing a historical condition even when current plan lookup fails', async () => {
  const { changed } = setup(true);
  await screen.findByText(/현재 계획 선택 목록을 불러오지 못했습니다/);
  expect(changed).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '계획 Block 조건 지우기' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const params = new URLSearchParams(String(changed.mock.lastCall?.[0]));
  expect(params.has('linkedPlanVersionId')).toBe(false);
  expect(params.has('linkedBlockId')).toBe(false);
  expect(params.get('selected')).not.toBeNull();
});
