import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { CourseFromSegment } from '../src/course-from-segment';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const activityId = '33333333-3333-4333-8333-333333333333';
const courseId = '11111111-1111-4111-8111-111111111111';
const trackId = '44444444-4444-4444-8444-444444444444';
const createdAt = '2026-03-01T00:00:00.000Z';

const created = {
  status: 'available',
  course: {
    status: 'available',
    courseId,
    name: '한강 구간',
    visibility: 'private',
    headRevision: 1,
    revisionId: '55555555-5555-4555-8555-555555555555',
    createdAt,
    updatedAt: createdAt,
  },
  revision: {
    courseId,
    courseRevision: 1,
    revisionId: '55555555-5555-4555-8555-555555555555',
    name: '한강 구간',
    geometry: {
      type: 'LineString',
      coordinates: [
        [126.9779, 37.5665],
        [126.9799, 37.5671],
      ],
    },
    waypoints: [
      { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: '0:1' },
      { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: '0:3' },
    ],
    generation: {
      kind: 'recorded-segment',
      activityId,
      trackId,
      trackRevision: 2,
      lineIndex: 0,
      segmentIndex: 0,
      startSampleId: '0:1',
      endSampleId: '0:3',
      vertexCount: 2,
      mapPathContentSha256: 'a'.repeat(64),
      simplificationVersion: 1,
      toleranceMeters: 2.5,
    },
    edit: { kind: 'created' },
    lineage: [{ activityId, trackId, trackRevision: 2 }],
    distanceMeters: 180.25,
    contentDigest: 'b'.repeat(64),
    createdAt,
  },
};

function setup(options: { reply?: Reply; selectedSampleId?: string | null; drawn?: boolean } = {}) {
  const request = vi.fn(
    async (_input: TransportRequest): Promise<Reply> => options.reply ?? reply(created),
  );
  const view = render(
    <CourseFromSegment
      transport={{ request }}
      activityId={activityId}
      trackRevision={2}
      selectedSampleId={options.selectedSampleId === undefined ? '0:1' : options.selectedSampleId}
      selectedIsDrawn={options.drawn ?? true}
    />,
  );
  return { request, view };
}

describe('creating a course from a selected segment', () => {
  it('needs an explicit start, end and name before it can save', async () => {
    const { request } = setup();
    const save = screen.getByRole('button', { name: '이 구간을 코스로 저장' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    expect(screen.getByTestId('course-range')).toHaveTextContent('시작 0:1 · 끝 미지정');
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('코스 이름'), '한강 구간');
    expect(save).toBeEnabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('sends only the two sample ids and the name, never a geometry', async () => {
    const { request, view } = setup();
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    view.rerender(
      <CourseFromSegment
        transport={{ request }}
        activityId={activityId}
        trackRevision={2}
        selectedSampleId="0:3"
        selectedIsDrawn
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '한강 구간');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [input] = request.mock.calls[0] ?? [];
    expect(input?.path).toBe('/bff/v1/courses');
    expect(input?.method).toBe('POST');
    expect(input?.body).toEqual({
      name: '한강 구간',
      from: {
        kind: 'recorded-segment',
        activityId,
        trackRevision: 2,
        startSampleId: '0:1',
        endSampleId: '0:3',
      },
    });
    expect(JSON.stringify(input?.body)).not.toContain('coordinates');
    expect(input?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole('status')).toHaveTextContent('코스를 저장했습니다');
  });

  it('cannot bound a course with a sample that was never drawn', () => {
    setup({ drawn: false });
    expect(screen.getByRole('button', { name: '이 지점을 구간 시작으로' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '이 지점을 구간 끝으로' })).toBeDisabled();
  });

  it('explains a selection that would jump a gap instead of saving one', async () => {
    const { request } = setup({ reply: reply({ error: { code: 'SEGMENT_SPANS_A_GAP' } }, 422) });
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '끊긴 구간');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent(
      /끊긴 구간은 직선으로 잇지 않으므로/,
    );
  });

  it('retries a lost response under the same key instead of creating a second course', async () => {
    let calls = 0;
    const request = vi.fn(async (_input: TransportRequest): Promise<Reply> => {
      calls += 1;
      if (calls === 1) throw new Error('lost response');
      return reply(created);
    });
    render(
      <CourseFromSegment
        transport={{ request }}
        activityId={activityId}
        trackRevision={2}
        selectedSampleId="0:1"
        selectedIsDrawn
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '한강 구간');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/확인하지 못했습니다/);
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const first = request.mock.calls[0]?.[0];
    const second = request.mock.calls[1]?.[0];
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(await screen.findByRole('status')).toHaveTextContent('코스를 저장했습니다');
  });

  it.each([502, 503, 504, 429])(
    'keeps the key when a %s leaves the outcome unknown',
    async (status) => {
      let calls = 0;
      const request = vi.fn(async (_input: TransportRequest): Promise<Reply> => {
        calls += 1;
        // An intermediate proxy answers while the server has already stored the course.
        return calls === 1 ? reply({ error: { code: 'GATEWAY' } }, status) : reply(created);
      });
      render(
        <CourseFromSegment
          transport={{ request }}
          activityId={activityId}
          trackRevision={2}
          selectedSampleId="0:1"
          selectedIsDrawn
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
      await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
      await userEvent.type(screen.getByLabelText('코스 이름'), '한강 구간');
      await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]?.[0].idempotencyKey).toBe(
        request.mock.calls[0]?.[0].idempotencyKey,
      );
      expect(request.mock.calls[1]?.[0].body).toEqual(request.mock.calls[0]?.[0].body);
    },
  );

  it('issues a new key after a refusal that stored nothing', async () => {
    let calls = 0;
    const request = vi.fn(async (_input: TransportRequest): Promise<Reply> => {
      calls += 1;
      return calls === 1 ? reply({ error: { code: 'SEGMENT_SPANS_A_GAP' } }, 422) : reply(created);
    });
    render(
      <CourseFromSegment
        transport={{ request }}
        activityId={activityId}
        trackRevision={2}
        selectedSampleId="0:1"
        selectedIsDrawn
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '한강 구간');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0].idempotencyKey).not.toBe(
      request.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it('issues a new key once the command changed', async () => {
    const { request } = setup();
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '첫 이름');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '두 번째 이름');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0].idempotencyKey).not.toBe(
      request.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it('says the stored recording moved on instead of applying the old selection', async () => {
    setup({ reply: reply({ error: { code: 'TRACK_REVISION_CHANGED' } }, 409) });
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 시작으로' }));
    await userEvent.click(screen.getByRole('button', { name: '이 지점을 구간 끝으로' }));
    await userEvent.type(screen.getByLabelText('코스 이름'), '옛 선택');
    await userEvent.click(screen.getByRole('button', { name: '이 구간을 코스로 저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /저장된 경로가 그 사이에 바뀌었습니다/,
    );
  });
});
