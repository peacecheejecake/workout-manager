import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CoursePosition } from '@workout/contracts/courses';

import { CourseThumbnail, THUMBNAIL_VERTEX_BUDGET } from '../src/course-thumbnail';

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
