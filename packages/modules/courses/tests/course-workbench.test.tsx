import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { CourseWorkbench } from '../src/course-workbench';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const reclaimedId = '22222222-2222-4222-8222-222222222222';
const activityId = '33333333-3333-4333-8333-333333333333';
const trackId = '44444444-4444-4444-8444-444444444444';
const createdAt = '2026-03-01T00:00:00.000Z';

const head = {
  status: 'available',
  courseId,
  name: 'Seoul loop',
  visibility: 'private',
  headRevision: 2,
  revisionId: '55555555-5555-4555-8555-555555555555',
  createdAt,
  updatedAt: createdAt,
};
const reclaimedHead = {
  status: 'unavailable',
  courseId: reclaimedId,
  name: 'Deleted recording loop',
  visibility: 'private',
  reason: 'source_activity_deleted',
  reclaimedAt: createdAt,
  createdAt,
  updatedAt: createdAt,
};
const revision = {
  courseId,
  courseRevision: 2,
  revisionId: head.revisionId,
  name: 'Seoul loop',
  geometry: {
    type: 'LineString',
    coordinates: [
      [126.9779, 37.5665],
      [126.9799, 37.5671],
    ],
  },
  waypoints: [
    { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: '0:0' },
    { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: '0:3' },
  ],
  generation: {
    kind: 'recorded-segment',
    activityId,
    trackId,
    trackRevision: 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: '0:3',
    vertexCount: 2,
    mapPathContentSha256: 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  },
  edit: { kind: 'created' },
  lineage: [{ activityId, trackId, trackRevision: 1 }],
  distanceMeters: 1830.5,
  contentDigest: 'b'.repeat(64),
  createdAt,
};

function setup(overrides: (input: TransportRequest) => Reply | null = () => null) {
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const override = overrides(input);
    if (override) return override;
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [head, reclaimedHead], total: 2 });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({ status: 'available', course: head, revision });
    if (input.path === `/bff/v1/courses/${reclaimedId}` && input.method === 'GET')
      return reply({ status: 'unavailable', course: reclaimedHead });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
      return reply({
        status: 'available',
        course: { ...head, headRevision: 3 },
        revision: { ...revision, courseRevision: 3, name: 'Renamed loop' },
      });
    if (input.method === 'DELETE') return reply({ deleted: true });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const view = render(
    <CourseWorkbench athleteId="athlete-1" sessionId="session-1" transport={{ request }} />,
  );
  return { request, unmount: view.unmount };
}

describe('course workbench', () => {
  it('lists private courses and offers no way to share one', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'Seoul loop' })).toBeInTheDocument();
    expect(screen.getByText(/공개 공유 기능은 없으며/)).toBeInTheDocument();
    for (const forbidden of ['공유', '공개', '링크 복사'])
      expect(screen.queryByRole('button', { name: new RegExp(forbidden) })).toBeNull();
  });

  it('shows the planned line length as its own number', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    expect(await screen.findByText('1.83km')).toBeInTheDocument();
    expect(
      screen.getByText(/기기 보고 거리·GPS 재계산 거리·경로 계산 예상 거리와 다른 값/),
    ).toBeInTheDocument();
  });

  it('sends the revision it was showing with a rename', async () => {
    const { request } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    const field = await screen.findByLabelText('코스 이름');
    await userEvent.clear(field);
    await userEvent.type(field, 'Renamed loop');
    await userEvent.click(screen.getByRole('button', { name: '이름 저장' }));
    await waitFor(() => {
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.method === 'PATCH' &&
            JSON.stringify(input.body) ===
              JSON.stringify({
                expectedRevision: 2,
                change: { kind: 'rename', name: 'Renamed loop' },
              }),
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/현재 수정 번호 3/)).toBeInTheDocument();
  });

  it('reports a conflict instead of overwriting a course changed elsewhere', async () => {
    setup((input) =>
      input.method === 'PATCH' ? reply({ error: { code: 'COURSE_REVISION_CONFLICT' } }, 409) : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await userEvent.click(await screen.findByRole('button', { name: '이름 저장' }));
    expect(await screen.findByText(/다른 변경이 먼저 저장되었습니다/)).toBeInTheDocument();
  });

  it('says a reclaimed course is unavailable and shows no geometry for it', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Deleted recording loop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /활동 기록이 삭제되어 경로를 더 이상 사용할 수 없습니다/,
    );
    expect(screen.queryByTestId('course-export')).toBeNull();
    expect(screen.queryByLabelText('코스 이름')).toBeNull();
  });

  it('links the GPX export to the owner authenticated path, not an object key', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    const link = await screen.findByTestId('course-export');
    expect(link).toHaveAttribute('href', `/bff/v1/courses/${courseId}/export.gpx`);
    expect(link.getAttribute('href')).not.toContain('private/v1/tenants');
  });

  it('downloads the export with the session header a plain navigation cannot send', async () => {
    const fetchMock = vi.fn(
      async (_path: string, _init: RequestInit) =>
        new Response('<gpx></gpx>', {
          status: 200,
          headers: { 'content-type': 'application/gpx+xml' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:course');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL }));
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
      await userEvent.click(await screen.findByTestId('course-export'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [path, init] = fetchMock.mock.calls[0] ?? [];
      expect(path).toBe(`/bff/v1/courses/${courseId}/export.gpx`);
      expect(init).toMatchObject({
        headers: { 'x-workout-session-id': 'session-1' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      // The object URL lives only for the click that created it.
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:course'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never hands a download to a session that has ended', async () => {
    let release: ((value: Response) => void) | undefined;
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:course');
    vi.stubGlobal(
      'URL',
      Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL: vi.fn() }),
    );
    const clicks: string[] = [];
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = createElement(tag);
      if (tag === 'a') node.click = () => clicks.push('a');
      return node;
    });
    try {
      const view = setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
      await userEvent.click(await screen.findByTestId('course-export'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      // The session ends while the body is still on its way.
      view.unmount();
      release?.(new Response('<gpx></gpx>', { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signals[0]?.aborted).toBe(true);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(clicks).toEqual([]);
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('reports a failed export instead of silently doing nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
      await userEvent.click(await screen.findByTestId('course-export'));
      expect(
        await screen.findByText(/입력을 확인한 뒤 다시 시도하세요|요청을 완료하지 못했습니다/),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deletes with the revision it was showing', async () => {
    const { request } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await userEvent.click(await screen.findByRole('button', { name: '코스 삭제' }));
    await waitFor(() => {
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.method === 'DELETE' &&
            input.path === `/bff/v1/courses/${courseId}?expectedRevision=2`,
        ),
      ).toBe(true);
    });
  });

  it('keeps the screen usable when the list request fails', async () => {
    const { request } = setup((input) =>
      input.method === 'GET' && input.path === '/bff/v1/courses'
        ? reply({ error: { code: 'REQUEST_FAILED' } }, 503)
        : null,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('코스 목록을 불러오지 못했습니다.');
    const before = request.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  });
});
