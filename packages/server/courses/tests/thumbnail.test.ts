import { createHash } from 'node:crypto';

import {
  courseThumbnailLimits,
  courseThumbnailPath,
  courseThumbnailStrokeColor,
  type CoursePosition,
} from '@workout/contracts/courses';
import { describe, expect, it } from 'vitest';

import { CourseThumbnailRenderError, renderCourseThumbnail } from '../src/thumbnail.js';

const line: readonly CoursePosition[] = [
  [126.92, 37.52],
  [126.93, 37.53],
  [126.94, 37.525],
];

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('stored course thumbnail renderer', () => {
  it('draws the same bytes for the same line, every time', () => {
    const first = renderCourseThumbnail(line);
    const second = renderCourseThumbnail([...line]);
    expect(text(second.bytes)).toBe(text(first.bytes));
    expect(second.sha256).toBe(first.sha256);
    // The hash is over the bytes it ships, which is what makes the stored key
    // content-addressed rather than merely unique.
    expect(first.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
  });

  it('draws a different picture for a different line', () => {
    const moved = renderCourseThumbnail([
      line[0] as CoursePosition,
      [126.95, 37.56],
      [126.96, 37.5],
    ]);
    expect(moved.sha256).not.toBe(renderCourseThumbnail(line).sha256);
  });

  it('agrees with the projection the browser draws', () => {
    // One definition, two renderers. If these ever diverge, the stored picture and the
    // fallback the screen draws would disagree about the shape of the owner's line.
    const drawn = courseThumbnailPath(line);
    if (drawn === null) throw new Error('the fixture line must be drawable');
    const document = text(renderCourseThumbnail(line).bytes);
    expect(document).toContain(`d="${drawn.path}"`);
    expect(renderCourseThumbnail(line).vertexCount).toBe(drawn.vertexCount);
    // The stroke has to agree as well, or the picture visibly changes the moment the stored
    // one replaces the drawn one. The component test asserts the same four values on the
    // element it renders.
    expect(document).toContain(`stroke="${courseThumbnailStrokeColor}"`);
    expect(document).toContain('stroke-width="2"');
    expect(document).toContain('stroke-linejoin="round"');
    expect(document).toContain('stroke-linecap="round"');
  });

  it('writes no user text, no identity and no timestamp into the stored document', () => {
    const document = text(renderCourseThumbnail(line).bytes);
    // What makes serving this as image/svg+xml safe is that there is no string in it a
    // user could have authored. Everything outside the path data is fixed markup.
    expect(document).not.toMatch(/<(script|foreignObject|text|title|desc|image|a)\b/);
    expect(document.replace(/ d="[^"]*"/, '')).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    expect(document).toContain('role="img"');
  });

  it('refuses a line that is not a line instead of inventing a shape', () => {
    expect(() => renderCourseThumbnail([[126.92, 37.52]])).toThrow(CourseThumbnailRenderError);
    try {
      renderCourseThumbnail([]);
    } catch (error) {
      expect((error as CourseThumbnailRenderError).code).toBe('line_too_short_to_draw');
    }
  });

  it('stays inside its own bounds for the longest course this product allows', () => {
    const long: CoursePosition[] = [];
    for (let index = 0; index < 20_000; index += 1)
      long.push([126.9 + index * 0.000001, 37.5 + index * 0.0000005]);
    const drawn = renderCourseThumbnail(long);
    expect(drawn.vertexCount).toBe(courseThumbnailLimits.vertexBudget);
    expect(drawn.byteSize).toBeLessThanOrEqual(courseThumbnailLimits.maxBytes);
    expect(drawn.viewport).toBe(courseThumbnailLimits.viewport);
  });
});

describe('stored course thumbnail renderer input validation', () => {
  it('refuses a coordinate it cannot draw instead of publishing an empty picture', () => {
    // Without this the path becomes `d="MNaN NaN"`: a valid SVG that draws nothing, with a
    // perfectly good hash and byte size, published as `ready`.
    for (const broken of [
      [Number.NaN, 37.5],
      [126.9, Number.POSITIVE_INFINITY],
      [200, 37.5],
      [126.9, 100],
    ] as unknown as CoursePosition[])
      expect(() => renderCourseThumbnail([broken, [126.91, 37.51]])).toThrow();
    // And nothing that does get through can contain NaN.
    expect(text(renderCourseThumbnail(line).bytes)).not.toContain('NaN');
  });
});
