import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';

import { CourseDisclosure, CourseSharePanel } from '../src/course-disclosure';
import { createCourseExtrasApi } from '../src/course-extras-api';
import { createCourseSharingApi } from '../src/course-sharing-api';

/**
 * The privacy confirmation screen and the owner's link panel (M2-01k-o §5, T2, T17, T18,
 * T20, T21, T24). Transport replies are fixtures shaped by the contract; the server's own
 * decisions are covered by the API integration tests.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const shareId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const token = 'T'.repeat(43);
const line = [
  [127.02227, 37.5],
  [127.03, 37.51],
  [127.04, 37.52],
];
const option = (exposure: string, extra: Record<string, unknown> = {}) => ({
  exposure,
  coordinates: line,
  start: line[0],
  finish: line[2],
  startShiftMeters: 196,
  finishShiftMeters: 0,
  vertexCount: 3,
  distanceMeters: 2600,
  removedWaypointCount: 1,
  coordinateDigits: 5,
  requiresAcknowledgement: false,
  appendsRevision: false,
  ...extra,
});
const preview = (purpose: 'export' | 'share', overrides: Record<string, unknown> = {}) => ({
  purpose,
  courseId,
  courseRevision: 4,
  zoneSetDigest: 'd'.repeat(64),
  zoneCount: 1,
  outcome: 'ends-inside',
  blockedReason: null,
  zones: [{ name: '집', removedVertexCount: 12 }],
  options:
    purpose === 'export'
      ? [
          option('trimmed', { appendsRevision: true }),
          option('owner-exact', {
            requiresAcknowledgement: true,
            coordinateDigits: 7,
            startShiftMeters: 0,
          }),
        ]
      : [option('trimmed')],
  defaultExposure: 'trimmed',
  includeNamesDefault: purpose === 'export',
  ...overrides,
});
const receipt = (purpose: 'export' | 'share', exposure: string) => ({
  receiptId,
  purpose,
  courseId,
  courseRevision: 5,
  zoneSetDigest: 'd'.repeat(64),
  exposure,
  includeNames: false,
  confirmedAt: '2026-09-25T00:00:00.000Z',
  expiresAt: '2026-09-25T01:00:00.000Z',
});
const share = (state = 'active') => ({
  shareId,
  courseId,
  courseRevision: 4,
  state,
  revokeReason: state === 'revoked' ? 'owner' : null,
  includeNames: false,
  createdAt: '2026-09-25T00:00:00.000Z',
  expiresAt: '2026-10-02T00:00:00.000Z',
  revokedAt: state === 'revoked' ? '2026-09-25T02:00:00.000Z' : null,
});

function transport(handle: (input: TransportRequest) => Reply | null) {
  const request = vi.fn(async (input: TransportRequest) => {
    const answer = handle(input);
    if (answer) return answer;
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  return { request };
}

function renderDisclosure(
  purpose: 'export' | 'share',
  handle: (input: TransportRequest) => Reply | null,
  extra: { onExport?: () => Promise<void> } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wire = transport(handle);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const onAddZone = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CourseDisclosure
        api={createCourseSharingApi(wire)}
        scope={['users', 'a', 'sessions', 's', 'courses']}
        courseId={courseId}
        purpose={purpose}
        onChanged={onChanged}
        onClose={onClose}
        onAddZone={onAddZone}
        {...(extra.onExport ? { onExport: extra.onExport } : {})}
      />
    </QueryClientProvider>,
  );
  return { client, request: wire.request, onClose, onChanged, onAddZone };
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('the confirmation screen (§5, T2)', () => {
  it('explains the GPX: what leaves, both ends, the areas, the risk, what never leaves, no recall', async () => {
    renderDisclosure('export', (input) =>
      input.path.includes('disclosure-preview') ? reply(preview('export')) : null,
    );
    await screen.findByText(/선 전체/);
    const region = screen.getByRole('region', { name: 'GPX 내보내기 전 확인' });
    const text = region.textContent ?? '';
    expect(text).toContain('선 전체(정점 3개, 약 2.6km)');
    expect(text).toContain('코스 이름과 경유점 이름은 기본으로 포함되며');
    expect(within(region).getByRole('list', { name: '나갈 시작점과 끝점' })).toHaveTextContent(
      '원래 시작에서 약 196m 떨어진 곳',
    );
    expect(within(region).getByRole('list', { name: '적용된 보호 구역' })).toHaveTextContent(
      '집 · 이 구역에서 제거되는 정점 12개',
    );
    expect(text).toContain('보호 구역의 중심 좌표는 어디로도 나가지 않습니다.');
    expect(text).toContain(
      '같은 곳에서 출발한 코스를 여러 번 공유하면 구역 중심을 추정할 수 있습니다.',
    );
    expect(text).toContain('반복해서 달리는 경로는 시작·끝을 지워도 동네를 드러낼 수 있습니다.');
    // D10: the GPX-only notice about three or more trimmed files.
    expect(text).toContain(
      '내보낸 제거본 파일 3개 이상이면 집 위치를 몇 m 안으로 계산할 수 있습니다.',
    );
    expect(text).toContain(
      '시각, 활동 연결, 코스 id, 기기 정보, 소유자 이름·계정은 나가지 않습니다.',
    );
    expect(text).toContain('내보낸 파일은 철회할 수 없습니다.');
    // R-10: the trimmed GPX appends a revision, and the screen says so.
    expect(text).toContain('새로 추가됩니다. 원래 수정본은 그대로');
    // The line is drawn and the same facts are listed beside it.
    expect(within(region).getByRole('img', { name: '내보낼 선 미리보기' })).toBeInTheDocument();
    // D6: names are in by default for the owner's GPX.
    expect(within(region).getByLabelText('코스 이름과 경유점 이름 포함')).toBeChecked();
  });

  it('explains the link: fixed revision, expiry, no download, names out by default, never the exact line', async () => {
    renderDisclosure('share', (input) =>
      input.path.includes('disclosure-preview') ? reply(preview('share')) : null,
    );
    await screen.findByText(/선 전체/);
    const region = screen.getByRole('region', { name: '링크 공유 전 확인' });
    const text = region.textContent ?? '';
    expect(text).toContain('링크는 항상 보호 구역을 제거한 선을 보여 줍니다.');
    expect(text).toContain('코스를 고쳐도 링크의 내용은 바뀌지 않습니다.');
    expect(text).toContain('7일 안에 만료되지만');
    expect(text).toContain('날짜 경계인 오전 9시로 맞춥니다');
    // R-5: the owner is told that links cut against one area can be tied together.
    expect(text).toContain('같은 보호 구역 근처의 코스로 만든 링크들은 같은 방식으로 잘립니다.');
    expect(text).toContain('받은 사람은 파일을 받을 수 없습니다.');
    expect(text).toContain('브라우저 기록에 링크가 남을 수 있습니다.');
    expect(text).not.toContain('3개 이상이면');
    // D6: names are out by default for a link.
    expect(within(region).getByLabelText('코스 이름과 경유점 이름 포함')).not.toBeChecked();
    // D3b / V18b: no way to pick the exact line in the link flow.
    expect(within(region).queryByRole('radio')).toBeNull();
    expect(text).not.toContain('정확한 선');
  });
});

describe('what must be ticked, and what cannot be confirmed at all', () => {
  it('T20(1): the exact GPX line needs its own warning ticked first', async () => {
    const { request } = renderDisclosure('export', (input) =>
      input.path.includes('disclosure-preview')
        ? reply(preview('export'))
        : input.path.includes('disclosure-confirmations')
          ? reply(receipt('export', 'owner-exact'))
          : null,
    );
    await userEvent.click(
      await screen.findByRole('radio', { name: '정확한 선 (내 GPX 파일에만)' }),
    );
    const confirm = screen.getByRole('button', { name: '확인하고 GPX 내보내기' });
    expect(confirm).toBeDisabled();
    expect(
      screen.getByText('보호 구역 안의 좌표가 파일에 포함됩니다. 이 파일은 철회할 수 없습니다.'),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByLabelText('보호 구역 안의 좌표가 포함된다는 것을 확인했습니다.'),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.path.endsWith('/disclosure-confirmations') &&
            JSON.stringify(input.body).includes('"exposure":"owner-exact"') &&
            JSON.stringify(input.body).includes('"acknowledgedRisk":true'),
        ),
      ).toBe(true),
    );
  });

  it('T21: with no protected area the GPX needs the D3a warning and the link is refused', async () => {
    const noZones = {
      outcome: 'no-zones',
      zoneCount: 0,
      zones: [],
      options: [option('no-zones-exact', { requiresAcknowledgement: true, startShiftMeters: 0 })],
      defaultExposure: 'no-zones-exact',
    };
    const exporting = renderDisclosure('export', (input) =>
      input.path.includes('disclosure-preview') ? reply(preview('export', noZones)) : null,
    );
    expect(
      await screen.findByText('보호 구역이 없어 정확한 시작·끝이 포함됩니다.'),
    ).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: '확인하고 GPX 내보내기' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      screen.getByLabelText('보호 구역이 없어 정확한 시작·끝이 포함된다는 것을 확인했습니다.'),
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '보호 구역 추가하러 가기' }));
    expect(exporting.onAddZone).toHaveBeenCalled();
  });

  it('T21: a link with no protected area is not offered at all', async () => {
    renderDisclosure('share', (input) =>
      input.path.includes('disclosure-preview')
        ? reply(
            preview('share', {
              outcome: 'no-zones',
              zoneCount: 0,
              zones: [],
              options: [],
              defaultExposure: null,
            }),
          )
        : null,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('보호 구역을 먼저 추가하세요.');
    expect(screen.queryByRole('button', { name: /확인하고/ })).toBeNull();
  });

  it('T17: a refused trim says why and offers no way to confirm', async () => {
    renderDisclosure('export', (input) =>
      input.path.includes('disclosure-preview')
        ? reply(
            preview('export', {
              outcome: 'blocked',
              blockedReason: 'COURSE_TRIM_SPLITS_THE_LINE',
              options: [],
              defaultExposure: null,
            }),
          )
        : null,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('보호 구역에 다시 들어옵니다');
    expect(alert).toHaveTextContent('보호 구역을 지나지 않게 코스를 고치세요');
    expect(screen.queryByRole('button', { name: /확인하고/ })).toBeNull();
  });
});

describe('the link is shown once and kept nowhere (B-7, T24)', () => {
  it('shows the link with the token in the fragment, and stores it in no cache or storage', async () => {
    const { client } = renderDisclosure('share', (input) => {
      if (input.path.includes('disclosure-preview')) return reply(preview('share'));
      if (input.path.includes('disclosure-confirmations'))
        return reply(receipt('share', 'trimmed'));
      if (input.path.endsWith('/shares') && input.method === 'POST')
        return reply({ share: share(), token }, 201);
      return null;
    });
    await userEvent.click(await screen.findByRole('button', { name: '확인하고 링크 만들기' }));
    const field = await screen.findByLabelText('공유 링크');
    expect(field).toHaveValue(`${window.location.origin}/shared/course#${token}`);
    expect(screen.getByRole('button', { name: '링크 복사' })).toBeInTheDocument();
    const cached = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
    ]);
    expect(cached).not.toContain(token);
    for (const storage of [window.localStorage, window.sessionStorage])
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        expect(`${key}${storage.getItem(key)}`).not.toContain(token);
      }
    expect(window.location.href).not.toContain(token);
  });
});

describe('the owner link panel', () => {
  function renderPanel(handle: (input: TransportRequest) => Reply | null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wire = transport(handle);
    const onShare = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <CourseSharePanel
          api={createCourseSharingApi(wire)}
          extrasApi={createCourseExtrasApi(wire)}
          scope={['users', 'a', 'sessions', 's', 'courses']}
          courseId={courseId}
          onShare={onShare}
          onAddZone={() => undefined}
        />
      </QueryClientProvider>,
    );
    return { ...view, request: wire.request, onShare };
  }
  const zones = (count: number) =>
    reply({
      zones: Array.from({ length: count }, (_, index) => ({
        zoneId: `4444444${index}-4444-4444-8444-444444444444`,
        name: '집',
        center: [127.02, 37.5],
        radiusMeters: 200,
        createdAt: '2026-09-25T00:00:00.000Z',
        updatedAt: '2026-09-25T00:00:00.000Z',
      })),
      total: count,
      zoneSetDigest: 'd'.repeat(64),
    });

  it('T9: renders nothing at all when the server has no link route (the flag is off)', async () => {
    const { container, request } = renderPanel((input) =>
      input.path === '/bff/v1/courses/shares'
        ? reply({ error: { code: 'NOT_FOUND' } }, 404)
        : input.path === '/bff/v1/courses/privacy-zones'
          ? zones(1)
          : null,
    );
    await waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    for (const forbidden of ['공유', '링크 복사', '공개'])
      expect(screen.queryByRole('button', { name: new RegExp(forbidden) })).toBeNull();
  });

  it('T21: without a protected area there is no share button, only the way to add one', async () => {
    renderPanel((input) =>
      input.path === '/bff/v1/courses/shares'
        ? reply({ shares: [], total: 0, activeTotal: 0 })
        : input.path === '/bff/v1/courses/privacy-zones'
          ? zones(0)
          : null,
    );
    expect(await screen.findByText(/보호 구역을 먼저 추가하세요/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '링크로 공유' })).toBeNull();
    expect(screen.getByRole('button', { name: '보호 구역 추가하러 가기' })).toBeInTheDocument();
  });

  it('lists this course links, turns one off and turns them all off (R-6)', async () => {
    let listed = [share('active')];
    const { request } = renderPanel((input) => {
      if (input.path === '/bff/v1/courses/shares')
        return reply({
          shares: listed,
          total: listed.length,
          activeTotal: listed.filter((item) => item.state === 'active').length,
        });
      if (input.path === '/bff/v1/courses/privacy-zones') return zones(1);
      if (input.path === `/bff/v1/courses/shares/${shareId}/revoke`) {
        listed = [share('revoked')];
        return reply(share('revoked'));
      }
      if (input.path === '/bff/v1/courses/shares/revoke-all') return reply({ revokedCount: 0 });
      return null;
    });
    const list = await screen.findByRole('list', { name: '이 코스의 링크' });
    expect(list).toHaveTextContent('켜짐 · 2026-10-02까지');
    expect(screen.getByRole('button', { name: '모든 링크 끄기' })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: '링크 끄기' }));
    expect(await screen.findByText('링크를 껐습니다.')).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveTextContent('꺼짐'));
    expect(
      request.mock.calls.some(
        ([input]) => input.path === `/bff/v1/courses/shares/${shareId}/revoke`,
      ),
    ).toBe(true);
  });
});
