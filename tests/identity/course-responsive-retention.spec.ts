import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { courseReadResultSchema } from '../../packages/contracts/src/courses';
import { responsiveSpec } from '../../packages/ui/foundation/src/responsive';
import {
  draftRevision,
  importCourse,
  login,
  place,
  printed,
  shells,
  waypointRows,
} from './course-editor-support';

/**
 * R-state-retention: one live draft and one list/map selection cross both responsive
 * boundaries. Each shell has its own test; a fresh document at each width would miss a
 * provider remount that discards the draft during the transition.
 */
const start = [126.978, 37.566] as const;
const finish = [126.986, 37.567] as const;
const via = [126.982, 37.568] as const;
const tabletStart = responsiveSpec.modes[1].minInclusive;
const desktopStart = responsiveSpec.modes[2].minInclusive;
const mobileEnd = tabletStart - 1;
const tabletEnd = desktopStart - 1;

async function savedCourse(page: Page, courseId: string, headers: Record<string, string>) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  const read = courseReadResultSchema.parse(await response.json());
  if (read.status !== 'available') throw new Error('expected an available course');
  return read;
}

for (const shell of shells) {
  test(`${shell.name} preserves an unsaved course draft, selection and focus across both layout boundaries`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const headers = await login(page);
    const courseId = await importCourse(
      page,
      headers,
      `반응형 초안 ${shell.name} ${randomUUID().slice(0, 8)}`,
      [start, finish],
    );
    await page.setViewportSize({ width: mobileEnd, height: 900 });
    await page.goto(`${shell.origin}/courses/${courseId}/edit`);

    const workbench = page.getByRole('region', { name: '내 코스' });
    const editor = workbench.getByRole('region', { name: '경유지 편집' });
    const layout = workbench.locator('[data-layout][data-sheet]');
    await expect(layout).toHaveAttribute('data-layout', 'mobile');
    await place(editor, ...via);
    const name = editor.getByRole('textbox', { name: '2번 경유점 이름' });
    await name.fill('아직 저장하지 않은 경유지');
    await editor.getByRole('button', { name: '2번 선택' }).click();
    await name.focus();

    const draft = await waypointRows(editor);
    expect(draft).toEqual([
      { label: '1. 시작', coordinate: printed(start), name: '', locked: false },
      {
        label: '2. 경유',
        coordinate: printed(via),
        name: '아직 저장하지 않은 경유지',
        locked: false,
      },
      { label: '3. 끝', coordinate: printed(finish), name: '', locked: false },
    ]);
    const revision = await draftRevision(editor);
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith('/bff/v1/courses') &&
        // Opening an addressed course updates its last-used preference by design.
        path !== '/bff/v1/courses/preferences' &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
      ) {
        writes.push(`${request.method()} ${path}`);
      }
    });

    for (const [width, mode] of [
      [tabletStart, 'tablet'],
      [tabletEnd, 'tablet'],
      [desktopStart, 'desktop'],
      [tabletEnd, 'tablet'],
      [mobileEnd, 'mobile'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(layout).toHaveAttribute('data-layout', mode);
      expect(await waypointRows(editor), `draft content at ${width}px`).toEqual(draft);
      expect(await draftRevision(editor), `draft revision at ${width}px`).toBe(revision);
      await expect(editor.getByRole('button', { name: '2번 선택' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(
        workbench
          .getByRole('list', { name: '코스 지도 좌표 목록' })
          .locator('button[aria-pressed="true"]'),
      ).toHaveText(printed(via));
      await expect(name, `input focus at ${width}px`).toBeFocused();
      expect(writes, `unexpected course write at ${width}px`).toEqual([]);
    }

    const stored = await savedCourse(page, courseId, headers);
    expect(stored.course.headRevision).toBe(1);
    expect(stored.revision.waypoints.map((waypoint) => waypoint.position)).toEqual([
      [...start],
      [...finish],
    ]);
    expect(writes).toEqual([]);

    // In-memory work is not silently persisted to a new document.
    await page.reload();
    await expect(
      editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(editor.getByRole('button', { name: '2번 선택' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
}
