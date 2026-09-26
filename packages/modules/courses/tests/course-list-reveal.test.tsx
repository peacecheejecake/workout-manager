import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { CourseWorkbench } from '../src/course-workbench';

/**
 * M2-01ag (a) at unit level: the course opened by its address is brought into view inside the
 * height-bounded list pane — by the pane's own scroll position, without moving focus — and
 * again when the list is unfolded or the layout changes. A pane that grows with its content is
 * left alone. jsdom lays nothing out, so the boxes are stubbed: the pane is a 200px band at the top
 * of the page, and row `i` starts at `60 + 100·i` inside its content.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const createdAt = '2026-03-01T00:00:00.000Z';
const count = 10;
const idOf = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const headOf = (index: number) => ({
  status: 'available',
  courseId: idOf(index),
  name: `Course ${String(index).padStart(2, '0')}`,
  visibility: 'private',
  headRevision: 1,
  revisionId: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
  createdAt,
  updatedAt: createdAt,
});
const coordinates = [
  [126.9779, 37.5665],
  [126.9799, 37.5671],
];
const revisionOf = (index: number) => ({
  courseId: idOf(index),
  courseRevision: 1,
  revisionId: headOf(index).revisionId,
  name: headOf(index).name,
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
});

const target = count - 1;
const paneBand = 200;
const rowTop = (index: number) => 60 + 100 * index;
const rowHeight = 80;

/** The stubbed layout. `overflowing: false` makes the pane as tall as its content. */
function stubLayout(overflowing: boolean) {
  const scrollTops = new WeakMap<Element, number>();
  const isPane = (element: Element) => element.getAttribute('data-pane') === 'list';
  const paneOf = (element: Element) => element.closest('[data-pane="list"]');
  const rowIndex = (element: Element) => {
    if (element.tagName !== 'LI') return -1;
    const button = element.querySelector('[id^="course-name-"]');
    if (button === null) return -1;
    return Number(button.id.slice(-12));
  };
  const content = rowTop(count);
  const box = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 600,
      width: 600,
      height,
      x: 0,
      y: top,
    }) as DOMRect;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (isPane(this)) return box(0, overflowing ? paneBand : content);
      const index = rowIndex(this);
      const pane = paneOf(this);
      if (index >= 0 && pane !== null)
        return box(rowTop(index) - (scrollTops.get(pane) ?? 0), rowHeight);
      return box(0, 0);
    }),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return isPane(this) ? (overflowing ? paneBand : content) : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return isPane(this) ? content : 0;
    }),
  ];
  // In a browser `scrollIntoView` scrolls every scrollable ancestor, the page included; jsdom
  // has none. Stubbed as "the page moved", so the reveal is shown to scroll the pane only.
  const pageMoves = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: pageMoves,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const limit = Math.max(0, content - (overflowing ? paneBand : content));
      scrollTops.set(this, Math.min(Math.max(0, value), limit));
    },
  });
  const restore = () => {
    for (const spy of spies) spy.mockRestore();
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  };
  return { restore, pageMoves };
}

function setup() {
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: Array.from({ length: count }, (_, i) => headOf(i)), total: count });
    if (input.path === '/bff/v1/courses/cards?surface=graph-v1' && input.method === 'GET')
      return reply({ cards: [], total: 0 });
    const detail = /^\/bff\/v1\/courses\/([0-9a-f-]{36})$/.exec(input.path);
    if (detail && input.method === 'GET') {
      const index = Number(detail[1]?.slice(-12));
      return reply({
        status: 'available',
        course: headOf(index),
        revision: revisionOf(index),
        thumbnail: { status: 'none' },
      });
    }
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
      return reply({ preferences: [], total: 0 });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'PUT')
      return reply({ courseId: idOf(target), favourite: false, lastUsedAt: createdAt });
    if (input.path === '/bff/v1/courses/privacy-zones' && input.method === 'GET')
      return reply({ zones: [], total: 0, zoneSetDigest: 'c'.repeat(64) });
    if (input.path === '/bff/v1/courses/accessibility-notes' && input.method === 'GET')
      return reply({ notes: [], total: 0 });
    if (input.path.endsWith('/elevation') && input.method === 'GET')
      return reply({ outcome: 'no_dataset' });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const { container } = render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      initialCourseId={idOf(target)}
    />,
  );
  const pane = container.querySelector('[data-pane="list"]') as HTMLElement;
  return { pane };
}

/** The target row lies inside the pane's visible band. */
function expectTargetInView(pane: HTMLElement) {
  const top = rowTop(target) - pane.scrollTop;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top + rowHeight).toBeLessThanOrEqual(paneBand);
}

function setViewportWidth(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  });
}

describe('course list reveal (M2-01ag)', () => {
  let restore: () => void = () => undefined;
  const width = window.innerWidth;
  beforeEach(() => setViewportWidth(1024));
  afterEach(() => {
    restore();
    setViewportWidth(width);
  });

  it('scrolls the pane to the course opened by address, leaving focus where it was', async () => {
    const layout = stubLayout(true);
    restore = layout.restore;
    const { pane } = setup();
    await screen.findByRole('button', { name: 'Course 09' });
    expect(pane.closest('[data-layout]')).toHaveAttribute('data-layout', 'tablet');
    await waitFor(() => expect(pane.scrollTop).toBeGreaterThan(0));
    expectTargetInView(pane);
    // Aligned by its bottom ("nearest"), not jumped to the top of the band.
    expect(rowTop(target) + rowHeight - pane.scrollTop).toBe(paneBand);
    expect(document.activeElement).toBe(document.body);
    // Only the pane scrolled: nothing asked the browser to scroll the page.
    expect(layout.pageMoves).not.toHaveBeenCalled();
  });

  it('leaves a pane that grows with its content alone', async () => {
    restore = stubLayout(false).restore;
    const { pane } = setup();
    await screen.findByRole('button', { name: 'Course 09' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Course 09' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(pane.scrollTop).toBe(0);
  });

  it('reveals the open course again when the folded list is unfolded', async () => {
    restore = stubLayout(true).restore;
    const user = userEvent.setup();
    const { pane } = setup();
    await waitFor(() => expect(pane.scrollTop).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: '코스 목록 접기' }));
    pane.scrollTop = 0;
    await user.click(screen.getByRole('button', { name: '코스 목록 펼치기' }));
    await waitFor(() => expect(pane.scrollTop).toBeGreaterThan(0));
    expectTargetInView(pane);
  });

  it('reveals the open course again when the layout changes', async () => {
    restore = stubLayout(true).restore;
    const { pane } = setup();
    await waitFor(() => expect(pane.scrollTop).toBeGreaterThan(0));
    setViewportWidth(1400);
    expect(pane.closest('[data-layout]')).toHaveAttribute('data-layout', 'desktop');
    pane.scrollTop = 0;
    setViewportWidth(1024);
    expect(pane.closest('[data-layout]')).toHaveAttribute('data-layout', 'tablet');
    await waitFor(() => expect(pane.scrollTop).toBeGreaterThan(0));
    expectTargetInView(pane);
  });
});
