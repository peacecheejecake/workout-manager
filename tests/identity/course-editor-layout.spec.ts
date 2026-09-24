import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  importCourse,
  login,
  overflow,
  place,
  shells,
  waypointRows,
} from './course-editor-support';

/**
 * M2-01k-c1 · R-S13-S14 (07 §4): "Courses S13/S14 | 지도+경유점 sheet, 전체 목록 대안 |
 * 지도+접히는 경유점 목록 | 지도+list+세부 정보; 각 최소 폭 검증".
 *
 * Both S14 screens — a stored course opened by address (`/courses/:id/edit`) and a course
 * started on an empty map (`/courses/new`) — at the five generated boundaries, in both
 * shells, each at a fresh document. Every check is about the rendered boxes:
 *
 * - mobile (320, 767): one column, the waypoint editor UNDER the map, no fold control;
 * - tablet (768, 1279): the waypoint editor BESIDE the map, top-aligned with it, and the
 *   waypoint list folds and unfolds with the same rows back;
 * - desktop (1280): the composition of the screen (map and course list side by side with the
 *   detail under both; map and draft side by side on a new course), no fold control;
 * - at every width each visible pane and the waypoint rows are at least `minimumPaneWidth`
 *   wide and the page has no horizontal overflow.
 *
 * The side-by-side and stacked checks are what makes the minimum widths non-vacuous: a pane
 * rule that moves, squeezes or overlaps a pane at one boundary fails here at that boundary.
 */
const boundaries = [
  { width: 320, layout: 'mobile' },
  { width: 767, layout: 'mobile' },
  { width: 768, layout: 'tablet' },
  { width: 1279, layout: 'tablet' },
  { width: 1280, layout: 'desktop' },
] as const;

/** Same number as map-render.spec (07 §2: 320 − 2 × 16 px margins leaves 288 px). */
const minimumPaneWidth = 240;
/** Rounding between two boxes laid out on the same grid line. */
const slack = 2;

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator, what: string): Promise<Box> {
  const value = await locator.boundingBox();
  assert.ok(value, `${what} has no box`);
  return value;
}

const right = (value: Box) => value.x + value.width;
const bottom = (value: Box) => value.y + value.height;

async function expectComposition(
  page: Page,
  input: {
    readonly width: number;
    readonly layout: 'mobile' | 'tablet' | 'desktop';
    readonly map: Locator;
    /** The pane that holds the waypoint editor: the open course's sheet, or the new draft. */
    readonly editorPane: Locator;
    readonly editor: Locator;
  },
) {
  const at = `${input.width}px`;
  const rows = input.editor.getByRole('list', { name: '경유점 목록' });
  const map = await box(input.map, `map pane at ${at}`);
  const pane = await box(input.editorPane, `editor pane at ${at}`);
  const list = await box(rows, `waypoint rows at ${at}`);
  expect(map.width, `map pane at ${at}`).toBeGreaterThanOrEqual(minimumPaneWidth);
  expect(pane.width, `editor pane at ${at}`).toBeGreaterThanOrEqual(minimumPaneWidth);
  expect(list.width, `waypoint rows at ${at}`).toBeGreaterThanOrEqual(minimumPaneWidth);
  const fold = input.editor.getByRole('button', { name: /^경유점 목록 (접기|펼치기)$/ });

  if (input.layout === 'mobile') {
    // One column: the editor is under the map, starting at the same left edge.
    expect(pane.y, `editor under the map at ${at}`).toBeGreaterThanOrEqual(bottom(map) - slack);
    expect(Math.abs(pane.x - map.x), `one column at ${at}`).toBeLessThanOrEqual(slack);
    await expect(fold).toHaveCount(0);
  } else if (input.layout === 'tablet') {
    // The waypoint editor beside the map, both starting on the same row.
    expect(pane.x, `editor beside the map at ${at}`).toBeGreaterThanOrEqual(right(map) - slack);
    expect(list.x, `waypoint rows beside the map at ${at}`).toBeGreaterThanOrEqual(
      right(map) - slack,
    );
    expect(Math.abs(pane.y - map.y), `same row at ${at}`).toBeLessThanOrEqual(slack);
    // …and the waypoint list folds, keeping its content.
    const before = await waypointRows(input.editor);
    const unfolded = await box(input.editor, `editor at ${at}`);
    await expect(fold).toHaveText('경유점 목록 접기');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await fold.click();
    await expect(fold).toHaveText('경유점 목록 펼치기');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(rows).toBeHidden();
    await expect(input.editor.getByRole('button', { name: '1번 선택' })).toBeHidden();
    await expect(input.editor.getByTestId('waypoint-list-folded')).toContainText(
      `경유점 ${before.length}개`,
    );
    // Folded, the editor is shorter; the map beside it keeps its width.
    const folded = await box(input.editor, `folded editor at ${at}`);
    expect(folded.height, `folded editor at ${at}`).toBeLessThan(unfolded.height);
    expect((await box(input.map, `map pane folded at ${at}`)).width).toBeGreaterThanOrEqual(
      minimumPaneWidth,
    );
    await fold.click();
    await expect(rows).toBeVisible();
    expect(await waypointRows(input.editor)).toEqual(before);
  } else {
    await expect(fold).toHaveCount(0);
  }
  expect(await overflow(page), `horizontal overflow at ${at}`).toBeLessThanOrEqual(0);
}

const seoul = [
  [126.978, 37.566],
  [126.982, 37.568],
  [126.986, 37.567],
] as const;

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('composes the stored-course editor at the five boundaries and folds its waypoint list at tablet width', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const name = `배치 ${shell.name} ${randomUUID().slice(0, 8)}`;
      const courseId = await importCourse(page, headers, name, seoul);

      for (const { width, layout } of boundaries) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${shell.origin}/courses/${courseId}/edit`);
        const workbench = page.getByRole('region', { name: '내 코스' });
        await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
          'data-layout',
          layout,
        );
        const editor = workbench.getByRole('region', { name: '경유지 편집' });
        await expect(
          editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
        ).toHaveCount(2);
        await expectComposition(page, {
          width,
          layout,
          map: workbench.locator('[data-pane="map"]'),
          editorPane: workbench.locator('[data-pane="sheet"]'),
          editor,
        });
        if (layout === 'desktop') {
          // Map and course list share the first row; the course detail and editor under both.
          const map = await box(workbench.locator('[data-pane="map"]'), 'map');
          const list = await box(workbench.locator('[data-pane="list"]'), 'course list');
          const sheet = await box(workbench.locator('[data-pane="sheet"]'), 'sheet');
          expect(Math.abs(map.y - list.y)).toBeLessThanOrEqual(slack);
          expect(list.x).toBeGreaterThanOrEqual(right(map) - slack);
          expect(list.width).toBeGreaterThanOrEqual(minimumPaneWidth);
          expect(sheet.y).toBeGreaterThanOrEqual(bottom(map) - slack);
        }
        if (layout === 'tablet') {
          // The course list folds too, and runs across the top, above the map.
          const list = await box(workbench.locator('[data-pane="list"]'), 'course list');
          const map = await box(workbench.locator('[data-pane="map"]'), 'map');
          expect(bottom(list)).toBeLessThanOrEqual(map.y + slack);
        }
      }
    });

    /**
     * Review N1: at tablet width the course list runs across the top, open. With many courses
     * it must not push the map off the first screen — the list scrolls inside a bounded pane.
     */
    test('keeps the map on the first screen at tablet width with many courses and the list open', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const prefix = `목록 높이 ${shell.name} ${randomUUID().slice(0, 8)}`;
      let courseId = '';
      for (let index = 0; index < 12; index += 1)
        courseId = await importCourse(
          page,
          headers,
          `${prefix} ${String(index).padStart(2, '0')}`,
          seoul,
        );

      for (const width of [768, 1024]) {
        const height = 900;
        await page.setViewportSize({ width, height });
        await page.goto(`${shell.origin}/courses/${courseId}/edit`);
        const workbench = page.getByRole('region', { name: '내 코스' });
        const panes = workbench.locator('[data-layout][data-sheet]');
        await expect(panes).toHaveAttribute('data-layout', 'tablet');
        await expect(panes).toHaveAttribute('data-list', 'expanded');
        const list = workbench.getByRole('list', { name: '코스 목록' });
        await expect(list.getByRole('listitem').filter({ hasText: prefix })).toHaveCount(12);
        await expect(list).toBeVisible();
        await expect(workbench.getByRole('button', { name: '코스 목록 접기' })).toBeVisible();
        await expect(page.locator('[data-pane="map"]')).toBeVisible();
        const scrollTop = await page.evaluate(() => window.scrollY);
        expect(scrollTop, `page not scrolled at ${width}px`).toBe(0);
        const map = await box(page.locator('[data-pane="map"]'), `map at ${width}px`);
        // The map starts on the first screen, with room left for it to be seen.
        expect(map.y, `map top at ${width}x${height}`).toBeGreaterThanOrEqual(0);
        expect(map.y + 160, `map top at ${width}x${height}`).toBeLessThanOrEqual(height);
        // …because the list scrolls inside its pane rather than growing the page.
        const pane = page.locator('[data-pane="list"]');
        const scrolls = await pane.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        );
        expect(scrolls, `list pane scrolls inside at ${width}px`).toBe(true);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      }
    });

    test('composes a new course at the five boundaries and folds its waypoint list at tablet width', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await login(page);
      for (const { width, layout } of boundaries) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${shell.origin}/courses/new`);
        const screen = page.getByRole('region', { name: '새 코스' });
        await expect(screen.locator('[data-layout]').first()).toHaveAttribute(
          'data-layout',
          layout,
        );
        const editor = screen.getByRole('region', { name: '경유지 편집' });
        await place(editor, 126.978, 37.566);
        await place(editor, 126.982, 37.569);
        await expect(
          editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
        ).toHaveCount(2);
        await expectComposition(page, {
          width,
          layout,
          map: screen.locator('[data-pane="map"]'),
          editorPane: screen.locator('[data-pane="draft"]'),
          editor,
        });
        if (layout === 'desktop') {
          const map = await box(screen.locator('[data-pane="map"]'), 'map');
          const draft = await box(screen.locator('[data-pane="draft"]'), 'draft');
          expect(draft.x).toBeGreaterThanOrEqual(right(map) - slack);
          expect(Math.abs(draft.y - map.y)).toBeLessThanOrEqual(slack);
        }
      }
    });
  });
}
