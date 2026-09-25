import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { CourseWorkbench } from '../src/course-workbench';

/**
 * The S13 card as the workbench wires it (M2-01k-a review N1, N2): what the card says when
 * the owner's preference read fails, and that a stored picture made after the cards were
 * read reaches the card once the open course's own read knows about it.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
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
const coordinates = [
  [126.9779, 37.5665],
  [126.9799, 37.5671],
];
const revision = {
  courseId,
  courseRevision: 2,
  revisionId: head.revisionId,
  name: 'Seoul loop',
  geometry: { type: 'LineString', coordinates },
  waypoints: [
    { role: 'start', position: coordinates[0], name: null, sourceSampleId: null },
    { role: 'finish', position: coordinates[1], name: null, sourceSampleId: null },
  ],
  generation: {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: 'gpx-rte',
    itemIndex: 0,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    fileSha256: 'a'.repeat(64),
    fileByteLength: 200,
    originalFilename: null,
    fileCreator: null,
    vertexCount: 2,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 0,
  },
  edit: { kind: 'imported' },
  lineage: [],
  distanceMeters: 1830.5,
  contentDigest: 'b'.repeat(64),
  createdAt,
};
const ready = {
  status: 'ready',
  courseRevision: 2,
  revisionId: head.revisionId,
  mediaType: 'image/svg+xml',
  contentHash: 'c'.repeat(64),
  byteSize: 300,
  viewport: 100,
  vertexCount: 2,
  rendererId: 'course-thumbnail-svg-v1',
  rendererVersion: 1,
  createdAt,
};
const card = (thumbnail: unknown) => ({
  status: 'available',
  course: head,
  distance: {
    plannedLineMeters: 1830.5,
    basis: { kind: 'imported-file', sourceKind: 'gpx-rte' },
    privacyTrimmed: false,
  },
  thumbnail: { state: thumbnail, drawnVertices: coordinates },
  elevation: { status: 'not_deployed' },
  surface: { confirmation: 'unknown' },
});

function setup(options: { preferencesFail?: boolean; detailThumbnail?: unknown } = {}) {
  let cardReads = 0;
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [head], total: 1 });
    if (input.path === '/bff/v1/courses/cards' && input.method === 'GET') {
      cardReads += 1;
      // The first read predates the stored picture; any later one sees it.
      return reply({ cards: [card(cardReads === 1 ? { status: 'none' } : ready)], total: 1 });
    }
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({
        status: 'available',
        course: head,
        revision,
        thumbnail: options.detailThumbnail ?? { status: 'none' },
      });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
      return options.preferencesFail
        ? reply({ error: { code: 'INTERNAL' } }, 500)
        : reply({ preferences: [], total: 0 });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'PUT')
      return reply({ courseId, favourite: false, lastUsedAt: createdAt });
    if (input.path === '/bff/v1/courses/privacy-zones' && input.method === 'GET')
      return reply({ zones: [], total: 0, zoneSetDigest: 'c'.repeat(64) });
    if (input.path === '/bff/v1/courses/accessibility-notes' && input.method === 'GET')
      return reply({ notes: [], total: 0 });
    if (input.path.endsWith('/elevation') && input.method === 'GET')
      return reply({ outcome: 'no_dataset' });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  render(<CourseWorkbench athleteId="athlete-1" sessionId="session-1" transport={{ request }} />);
  return { request, cardReads: () => cardReads };
}

function row() {
  return screen
    .getByRole('list', { name: '코스 목록' })
    .querySelector(`li:has(#course-name-${courseId})`) as HTMLElement;
}

describe('course list card in the workbench', () => {
  it('says the last use could not be read when the preference read fails, not "never used"', async () => {
    setup({ preferencesFail: true });
    await screen.findByRole('button', { name: 'Seoul loop' });
    await waitFor(() =>
      expect(within(row()).getByTestId('course-card-last-used')).toHaveTextContent(
        '마지막 사용 확인하지 못함',
      ),
    );
    expect(within(row()).queryByText(/사용 기록 없음/)).toBeNull();
    // The rest of the card still stands on its own read.
    expect(within(row()).getByTestId('course-card-surface')).toHaveTextContent('확인되지 않음');
  });

  it('says "never used" only when the preference read answered with no use', async () => {
    setup();
    await screen.findByRole('button', { name: 'Seoul loop' });
    await waitFor(() =>
      expect(within(row()).getByTestId('course-card-last-used')).toHaveTextContent(
        '사용 기록 없음',
      ),
    );
  });

  it('re-reads the cards once the open course reports a stored picture its card lacks', async () => {
    const { cardReads } = setup({ detailThumbnail: ready });
    await screen.findByRole('button', { name: 'Seoul loop' });
    await waitFor(() => expect(cardReads()).toBe(1));
    expect(within(row()).getByTestId('course-card-thumbnail')).toHaveAttribute(
      'data-source',
      'drawn',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await waitFor(() => expect(cardReads()).toBe(2));
    // Once the card agrees, nothing asks again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cardReads()).toBe(2);
  });

  it('does not re-read the cards when the detail has nothing newer', async () => {
    const { cardReads } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByTestId('course-revision');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cardReads()).toBe(1);
  });
});
