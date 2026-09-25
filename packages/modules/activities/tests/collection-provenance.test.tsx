import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { CollectionProvenance } from '../src/collection-provenance';

const activityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
function setup(reply: Reply) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
  render(
    <QueryClientProvider client={client}>
      <div data-testid="host">
        <CollectionProvenance
          athleteId="alice"
          sessionId="session-a"
          activityId={activityId}
          transport={{ request }}
        />
      </div>
    </QueryClientProvider>,
  );
  return { client, request };
}
const key = [
  'users',
  'alice',
  'sessions',
  'session-a',
  'activity-browser',
  'collection-provenance',
  activityId,
];
const provenance = (provider: string, official: boolean) => ({
  status: 200,
  body: {
    provenance: {
      provider,
      official,
      garminActivityId: '12345678901',
      collectedAt: '2026-09-25T00:00:00Z',
    },
  },
  traceId: null,
});

it('labels an activity collected through the unofficial path with its risk', async () => {
  const { request } = setup(provenance('garmin-connect-unofficial', false));
  const note = await screen.findByRole('note');
  expect(note).toHaveTextContent('비공식 임시 Garmin 연결로 가져온 활동');
  expect(note).toHaveTextContent(
    '공식 Garmin 연동이 아닙니다. Garmin 내부 endpoint를 쓰는 임시 경로로 수집되었습니다.',
  );
  expect(note).not.toHaveTextContent('Garmin 공식 연동으로 가져온 활동');
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: `/bff/v1/activities/${activityId}/collection-provenance`,
      method: 'GET',
    }),
  );
});

it('labels an official collection as official', async () => {
  setup(provenance('garmin-official', true));
  expect(await screen.findByText('Garmin 공식 연동으로 가져온 활동')).toBeVisible();
  expect(screen.queryByText(/비공식/)).not.toBeInTheDocument();
});

it.each([
  ['no Garmin collector', { status: 200, body: { provenance: null }, traceId: null }],
  ['an older server', { status: 404, body: null, traceId: null }],
  ['a contradictory label', { ...provenance('garmin-connect-unofficial', true) }],
])('shows no label for %s', async (_, reply) => {
  const { client } = setup(reply);
  await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'));
  await waitFor(() => expect(client.getQueryState(key)?.status).not.toBe('pending'));
  expect(screen.getByTestId('host')).toBeEmptyDOMElement();
});
