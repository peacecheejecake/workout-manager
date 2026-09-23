import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoursePosition } from '@workout/contracts/courses';

import { courseThumbnailStrokeColor } from '@workout/contracts/courses';

import {
  CourseThumbnail,
  courseThumbnailDownloadPath,
  StoredCourseThumbnail,
  THUMBNAIL_VERTEX_BUDGET,
} from '../src/course-thumbnail';

/**
 * The drawn course thumbnail (M2-01j).
 *
 * It stores nothing, so what can go wrong with it is arithmetic: a line with no width or
 * no height, a line with more vertices than the budget, and the projection. None of that
 * was fixed by a test before.
 */
function draw(coordinates: readonly CoursePosition[]) {
  render(<CourseThumbnail coordinates={coordinates} label="코스 미리보기" />);
  return screen.getByTestId('course-thumbnail');
}

function extent(path: string) {
  const numbers = path
    .split(/[ML]/u)
    .filter((part) => part.trim() !== '')
    .map((part) => part.trim().split(/\s+/u).map(Number));
  const xs = numbers.map(([x]) => x ?? Number.NaN);
  const ys = numbers.map(([, y]) => y ?? Number.NaN);
  return {
    count: numbers.length,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    finite: [...xs, ...ys].every((value) => Number.isFinite(value)),
  };
}

const pathOf = (element: HTMLElement) => element.querySelector('path')?.getAttribute('d') ?? '';

describe('the drawn course thumbnail', () => {
  it('draws nothing at all for a line of fewer than two vertices', () => {
    render(<CourseThumbnail coordinates={[[127.02, 37.5]]} label="코스 미리보기" />);
    expect(screen.queryByTestId('course-thumbnail')).not.toBeInTheDocument();
  });

  it('draws the line with the same stroke the stored picture uses', () => {
    // Both pictures occupy the same box and replace one another, so every stroke property
    // has to match or the swap is visible. The server side asserts the same four values on
    // the document it writes.
    const path = draw([
      [127.0, 37.5],
      [127.01, 37.51],
    ]).querySelector('path');
    expect(path).toHaveAttribute('stroke', courseThumbnailStrokeColor);
    expect(path).toHaveAttribute('stroke-width', '2');
    expect(path).toHaveAttribute('stroke-linejoin', 'round');
    expect(path).toHaveAttribute('stroke-linecap', 'round');
  });

  it('draws a due-north-south line without dividing by a zero width', () => {
    const element = draw([
      [127.02, 37.5],
      [127.02, 37.51],
      [127.02, 37.52],
    ]);
    const drawn = extent(pathOf(element));
    expect(drawn.finite).toBe(true);
    expect(drawn.count).toBe(3);
    // It fills the height and has no width, rather than becoming NaN.
    expect(drawn.height).toBeCloseTo(96, 5);
    expect(drawn.width).toBeCloseTo(0, 5);
  });

  it('draws a due-east-west line without dividing by a zero height', () => {
    const element = draw([
      [127.0, 37.5],
      [127.01, 37.5],
      [127.02, 37.5],
    ]);
    const drawn = extent(pathOf(element));
    expect(drawn.finite).toBe(true);
    expect(drawn.width).toBeCloseTo(96, 5);
    expect(drawn.height).toBeCloseTo(0, 5);
  });

  it('draws a line whose vertices are all the same point without producing NaN', () => {
    // Both spans zero at once is the case the `|| 1e-6` guards exist for: 0 * Infinity is
    // NaN, and an SVG path of NaN draws nothing while still claiming to be a picture. A
    // file with two identical points produces exactly this.
    const element = draw([
      [127.02, 37.5],
      [127.02, 37.5],
    ]);
    const drawn = extent(pathOf(element));
    expect(drawn.finite).toBe(true);
    expect(pathOf(element)).not.toContain('NaN');
    expect(drawn.width).toBeCloseTo(0, 5);
    expect(drawn.height).toBeCloseTo(0, 5);
  });

  it('draws the proportions of the real route, not of the raw degrees', () => {
    // Equal spans in degrees are not equal distances: at this latitude a degree of
    // longitude is cos(37.5) of a degree of latitude. Drawn without that, this square of
    // degrees came out about 27% wider than it is tall.
    const south = 37.5;
    const north = 37.51;
    const element = draw([
      [127.0, south],
      [127.01, south],
      [127.01, north],
      [127.0, north],
    ]);
    const drawn = extent(pathOf(element));
    const expected = Math.cos((((north + south) / 2) * Math.PI) / 180);
    expect(drawn.height).toBeCloseTo(96, 4);
    expect(drawn.width / drawn.height).toBeCloseTo(expected, 4);
    expect(drawn.width / drawn.height).toBeLessThan(1);
  });

  it('samples a long line down to the budget and says how many vertices it stands for', () => {
    const coordinates: CoursePosition[] = Array.from(
      { length: THUMBNAIL_VERTEX_BUDGET * 3 },
      (_value, index) => [127.0 + index * 1e-5, 37.5 + index * 1e-5],
    );
    const element = draw(coordinates);
    expect(element).toHaveAttribute('data-vertices', String(THUMBNAIL_VERTEX_BUDGET));
    expect(extent(pathOf(element)).count).toBe(THUMBNAIL_VERTEX_BUDGET);
    // The last vertex is still drawn: a sample that dropped the end would show a route
    // that stops before it does.
    expect(pathOf(element).endsWith('96.00')).toBe(false);
    expect(extent(pathOf(element)).finite).toBe(true);
  });

  it('draws every vertex when the line is within the budget', () => {
    const coordinates: CoursePosition[] = Array.from(
      { length: THUMBNAIL_VERTEX_BUDGET },
      (_value, index) => [127.0 + index * 1e-5, 37.5 + index * 1e-5],
    );
    const element = draw(coordinates);
    expect(extent(pathOf(element)).count).toBe(THUMBNAIL_VERTEX_BUDGET);
  });
});

/**
 * The stored thumbnail (M2-01l).
 *
 * What matters here is not the picture — the server drew that — but that the private bytes
 * cannot outlive the thing that asked for them, and that there is always something to show.
 */
describe('the stored course thumbnail', () => {
  const courseId = '22222222-2222-4222-8222-222222222222';
  const coordinates: readonly CoursePosition[] = [
    [127.0, 37.5],
    [127.01, 37.51],
  ];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';

  function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const spy = vi.fn(handler);
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws the line while the stored picture is still on its way, then swaps', async () => {
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch(async () => {
      await arrived;
      return new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    });
    render(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    // Falling back costs nothing: the screen already holds the head revision's coordinates.
    expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'drawn');
    release?.();
    await waitFor(() =>
      expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'stored'),
    );
    expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('alt', '코스 미리보기');
  });

  it('carries the session header and asks for its own course', async () => {
    const fetched = mockFetch(async () => new Response(svg, { status: 200 }));
    render(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    const [path, init] = fetched.mock.calls[0] ?? [];
    expect(path).toBe(courseThumbnailDownloadPath(courseId));
    expect((init as RequestInit).headers).toEqual({ 'x-workout-session-id': 'session-1' });
    expect((init as RequestInit).credentials).toBe('same-origin');
    expect((init as RequestInit).cache).toBe('no-store');
    expect((init as RequestInit).redirect).toBe('error');
  });

  it('keeps drawing the line when there is no stored picture to read', async () => {
    const fetched = mockFetch(async () => new Response('', { status: 404 }));
    render(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'drawn');
  });

  it('shows the drawn line, never the previous revision picture, while the new one loads', async () => {
    // What is displayed always belongs to the revision being asked for. The stored bytes
    // are held together with the hash they are, so there is no state in which the element
    // could be showing one revision's picture while the props name another — which after a
    // privacy trim would be the untrimmed line.
    //
    // Note what this test can and cannot establish: React Testing Library flushes effects
    // inside `act`, so the single pre-cleanup frame a real browser can paint is not
    // observable here, and reverting the identity check does NOT make this test fail. The
    // fix is a restructuring rather than a guard — the state carries the identity of what
    // it holds — and that is why it needs no check to be correct.
    const bodies = new Map([
      ['a'.repeat(64), '<svg data-which="first"></svg>'],
      ['b'.repeat(64), '<svg data-which="second"></svg>'],
    ]);
    let serve = 'a'.repeat(64);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = false;
    mockFetch(async () => {
      if (holdNext) await held;
      return new Response(bodies.get(serve), { status: 200 });
    });
    const sources: (string | null)[] = [];
    function record() {
      const element = screen.getByTestId('course-thumbnail');
      sources.push(element.getAttribute('data-source'));
    }
    const view = render(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'stored'),
    );
    // The second revision's picture is not ready yet: its fetch is held open.
    holdNext = true;
    serve = 'b'.repeat(64);
    view.rerender(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'b'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    record();
    // The very first painted frame after the revision changed must already be the drawn
    // line, not the stored picture of the line that was replaced.
    expect(sources).toEqual(['drawn']);
    release?.();
    await waitFor(() =>
      expect(screen.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'stored'),
    );
  });

  it('cannot leave private bytes behind when the course or session changes', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    let next = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => {
        next += 1;
        const value = `blob:thumbnail-${next}`;
        created.push(value);
        return value;
      }),
      revokeObjectURL: vi.fn((value: string) => revoked.push(value)),
    });
    const aborted: boolean[] = [];
    mockFetch(async (_input, init) => {
      init?.signal?.addEventListener('abort', () => aborted.push(true));
      return new Response(svg, { status: 200 });
    });
    const view = render(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-1"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    await waitFor(() => expect(created).toHaveLength(1));
    // A different session is a different owner. The object URL of the previous one is
    // revoked by the effect run that created it, not by a check somewhere else.
    view.rerender(
      <StoredCourseThumbnail
        courseId={courseId}
        sessionId="session-2"
        contentHash={'a'.repeat(64)}
        coordinates={coordinates}
        label="코스 미리보기"
      />,
    );
    await waitFor(() => expect(created).toHaveLength(2));
    expect(revoked).toContain(created[0]);
    view.unmount();
    await waitFor(() => expect(revoked).toEqual(expect.arrayContaining(created)));
    expect(aborted.length).toBeGreaterThan(0);
  });
});
