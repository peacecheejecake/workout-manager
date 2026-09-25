import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { importCourse, login, settle, shells, type Headers } from './course-editor-support';

/**
 * M2-01ag · S13 at tablet width (07 §4): the course list runs across the top in a pane of
 * bounded height that scrolls inside (M2-01k-c1). Two things were missing there:
 *
 * (a) a course opened by its address (`/courses/:id/edit`) sat below the pane's first screen,
 *     so the owner saw a list with nothing open in it. It is now revealed inside the pane —
 *     without taking focus, and without moving the page.
 * (b) the fold and order controls scrolled away with the rows. They now stay stuck to the
 *     top of the pane, and a row reached with the keyboard stops below them, not under them.
 *
 * Every check is made on rendered boxes in a real browser, in both shells, at 768, 1024 and
 * 1279 px (the tablet range's edges and middle). At 1280 px (desktop) the list is not a
 * scroll container, so opening a course by address must leave the page where it was. Two
 * more cases hold the page still (review of M2-01ag, finding 1): a short tablet viewport
 * (844x320, a landscape phone) and a layout change while the page is scrolled down.
 */
const seoul = [
  [126.978, 37.566],
  [126.982, 37.568],
  [126.986, 37.567],
] as const;
const courseCount = 12;
/** Rounding between two boxes laid out on the same line. */
const slack = 1;
/** Room the foundation focus ring takes outside a control: 2px outline at a 3px offset. */
const focusRing = 5;

type Rect = { top: number; bottom: number };

const rectOf = (locator: Locator): Promise<Rect> =>
  locator.evaluate((element) => {
    const { top, bottom } = element.getBoundingClientRect();
    return { top, bottom };
  });

/** The pane's visible band: from its top edge to the bottom of its client area. */
const paneBand = (pane: Locator): Promise<Rect & { scrollTop: number }> =>
  pane.evaluate((element) => {
    const { top } = element.getBoundingClientRect();
    return {
      top,
      bottom: top + element.clientTop + element.clientHeight,
      scrollTop: element.scrollTop,
    };
  });

/** Wait until the rows above the target have their final height (card facts, preferences). */
async function rowsSettled(row: Locator, page: Page) {
  await expect(row.getByTestId('course-card')).toHaveAttribute('data-card-status', 'ready');
  await expect(row.getByTestId('course-card-last-used')).not.toHaveText('마지막 사용 확인 중');
  await settle(page);
}

/** The controls are visible and on top at their own centre: nothing scrolled over them. */
async function expectControlOnTop(control: Locator, what: string) {
  await expect(control, what).toBeVisible();
  const onTop = await control.evaluate((element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    return hit !== null && element.contains(hit);
  });
  expect(onTop, `${what} is not covered`).toBe(true);
}

/**
 * `courseCount` stored courses made through the API. "힣" is the last Hangul syllable, so they
 * sort after every other course the owner has (all named in Korean or Latin script) and the
 * last of them — the target — is far down the list.
 */
async function manyCourses(page: Page, headers: Headers, shellName: string) {
  const prefix = `힣 목록 스크롤 ${shellName} ${randomUUID().slice(0, 8)}`;
  let target = '';
  for (let index = 0; index < courseCount; index += 1)
    target = await importCourse(
      page,
      headers,
      `${prefix} ${String(index).padStart(2, '0')}`,
      seoul,
    );
  return { prefix, target, targetName: `${prefix} ${String(courseCount - 1).padStart(2, '0')}` };
}

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('reveals the course opened by address inside the bounded list, keeps its controls stuck on top, and does not take focus', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page);
      const { prefix, target, targetName } = await manyCourses(page, headers, shell.name);

      for (const width of [768, 1024, 1279]) {
        const at = `${width}px`;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${shell.origin}/courses/${target}/edit`);
        const workbench = page.getByRole('region', { name: '내 코스' });
        await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
          'data-layout',
          'tablet',
        );
        const pane = workbench.locator('[data-pane="list"]');
        const list = workbench.getByRole('list', { name: '코스 목록' });
        await expect(list.getByRole('listitem').filter({ hasText: prefix })).toHaveCount(
          courseCount,
        );
        const openButton = list.getByRole('button', { name: targetName, exact: true });
        await expect(openButton).toHaveAttribute('aria-pressed', 'true');
        const row = list
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: targetName, exact: true }) });
        await rowsSettled(row, page);

        // Non-vacuity: at the pane's first screen the open course would be out of sight.
        const offset = await row.evaluate((element) => {
          const scroller = element.closest('[data-pane="list"]');
          if (!(scroller instanceof HTMLElement)) throw new Error('no list pane');
          return (
            element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop
          );
        });
        const band = await paneBand(pane);
        expect(offset, `open course below the pane's first screen at ${at}`).toBeGreaterThan(
          band.bottom - band.top,
        );

        // (a) The open course is in view inside the pane, below the stuck controls.
        const controls = pane.locator('[data-list-controls]');
        await expect
          .poll(async () => (await paneBand(pane)).scrollTop, `pane scrolled at ${at}`)
          .toBeGreaterThan(0);
        const button = await rectOf(openButton);
        const stuck = await rectOf(controls);
        const visible = await paneBand(pane);
        expect(button.top, `open course below the controls at ${at}`).toBeGreaterThanOrEqual(
          stuck.bottom - slack,
        );
        expect(button.bottom, `open course inside the pane at ${at}`).toBeLessThanOrEqual(
          visible.bottom + slack,
        );
        // …by scrolling the pane, not the page, and without moving focus into the list.
        expect(await page.evaluate(() => window.scrollY), `page not scrolled at ${at}`).toBe(0);
        const focusInList = await pane.evaluate((element) =>
          element.contains(document.activeElement),
        );
        expect(focusInList, `focus not taken at ${at}`).toBe(false);

        // (b) With the pane scrolled, the fold and order controls are still at its top.
        expect(
          Math.abs(stuck.top - visible.top),
          `controls at the pane top at ${at}`,
        ).toBeLessThanOrEqual(slack);
        const fold = workbench.getByRole('button', { name: '코스 목록 접기' });
        const order = workbench.getByRole('button', { name: '최근 사용순으로 보기' });
        await expectControlOnTop(fold, `fold control at ${at}`);
        await expectControlOnTop(order, `order control at ${at}`);
        // …and at the very bottom of the pane too.
        await pane.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await settle(page);
        const bottomBand = await paneBand(pane);
        expect(bottomBand.scrollTop, `pane scrolled to its end at ${at}`).toBeGreaterThan(0);
        expect(
          Math.abs((await rectOf(controls)).top - bottomBand.top),
          `controls at the pane top, scrolled to the end, at ${at}`,
        ).toBeLessThanOrEqual(slack);
        await expectControlOnTop(fold, `fold control at the end at ${at}`);
        await expectControlOnTop(order, `order control at the end at ${at}`);

        // A row reached by keyboard is not hidden under the stuck controls: from the order
        // control, Tab moves to the first course, which is above the pane's scrolled view.
        // (Chromium centres a focused element it scrolls to, so this holds in Chromium even
        // without the scroll padding; the upward reveal below is what needs the padding.)
        const first = list.getByRole('listitem').first().getByRole('button').first();
        expect((await rectOf(first)).bottom, `first course out of view at ${at}`).toBeLessThan(
          (await rectOf(controls)).bottom,
        );
        await order.focus();
        await page.keyboard.press('Tab');
        await expect(first).toBeFocused();
        await settle(page);
        const focused = await rectOf(first);
        expect(focused.top, `focused course below the controls at ${at}`).toBeGreaterThanOrEqual(
          (await rectOf(controls)).bottom - slack,
        );
        expect(focused.bottom, `focused course inside the pane at ${at}`).toBeLessThanOrEqual(
          (await paneBand(pane)).bottom + slack,
        );

        // An upward reveal stops below the stuck controls. The import panel sits at the end
        // of the pane; a course imported there opens at once and, named to sort first, lands
        // above the pane's scrolled view. `nearest` then aligns its top with the pane's top,
        // which is under the controls unless the scroll padding keeps it clear of them.
        const importedName = `0000 위로 ${shell.name} ${width} ${randomUUID().slice(0, 8)}`;
        const panel = workbench.getByRole('region', { name: 'GPX 가져오기' });
        await panel.getByLabel(/새 코스의 이름/).fill(importedName);
        await panel.getByLabel('가져올 GPX 파일').setInputFiles({
          name: 'upward.gpx',
          mimeType: 'application/gpx+xml',
          buffer: Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
              `<rte><name>${importedName}</name>` +
              seoul
                .map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`)
                .join('') +
              `</rte></gpx>\n`,
            'utf8',
          ),
        });
        const importButton = panel.getByRole('button', { name: '가져오기' });
        await importButton.scrollIntoViewIfNeeded();
        const beforeReveal = (await paneBand(pane)).scrollTop;
        await importButton.click();
        const imported = list.getByRole('button', { name: importedName, exact: true });
        await expect(imported).toHaveAttribute('aria-pressed', 'true');
        await expect
          .poll(async () => (await paneBand(pane)).scrollTop, `pane scrolled up at ${at}`)
          .toBeLessThan(beforeReveal);
        await settle(page);
        // …with room left above it for its focus ring (2px outline at a 3px offset).
        expect(
          (await rectOf(imported)).top,
          `imported course below the controls with room for its focus ring at ${at}`,
        ).toBeGreaterThanOrEqual((await rectOf(controls)).bottom + focusRing - slack);
        expect(
          (await rectOf(imported)).bottom,
          `imported course inside the pane at ${at}`,
        ).toBeLessThanOrEqual((await paneBand(pane)).bottom + slack);
        // The imported course sorts first in every list of this owner: remove it again.
        const importedId = (await imported.getAttribute('id'))?.replace('course-name-', '');
        expect(importedId, `imported course id at ${at}`).toBeTruthy();
        const removed = await page.request.delete(
          `/bff/v1/courses/${importedId}?expectedRevision=1`,
          { headers },
        );
        expect(removed.status(), `imported course removed at ${at}`).toBe(200);
      }
    });

    /**
     * Review finding 1: the reveal scrolls the pane only. Anything that brought the open
     * course into view by scrolling the page (as `scrollIntoView` does, for every scrollable
     * ancestor) would move the window wherever the pane is not wholly on screen.
     */
    // The three "page did not move" checks are soft, so a regression reports every case it
    // breaks rather than stopping at the first.
    test('reveals the open course without moving the page: desktop, a short tablet viewport and a layout change', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page);
      const { target, targetName } = await manyCourses(page, headers, shell.name);

      // Desktop: the list grows with the page instead of scrolling inside, so the reveal
      // stays out of it — scrolling the open course into view there would move the page.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses/${target}/edit`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
        'data-layout',
        'desktop',
      );
      const list = workbench.getByRole('list', { name: '코스 목록' });
      const openButton = list.getByRole('button', { name: targetName, exact: true });
      await expect(openButton).toHaveAttribute('aria-pressed', 'true');
      await rowsSettled(
        list
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: targetName, exact: true }) }),
        page,
      );
      // Non-vacuity: the open course is below the first screen of the page (measured in page
      // coordinates, so the check holds whether or not the page has been scrolled).
      const pageTop = await openButton.evaluate(
        (element) => element.getBoundingClientRect().top + window.scrollY,
      );
      expect(pageTop, 'open course below the fold at 1280px').toBeGreaterThan(900);
      expect.soft(await page.evaluate(() => window.scrollY), 'page not scrolled at 1280px').toBe(0);
      await expect(workbench.locator('[data-list-controls]')).toHaveCSS('position', 'static');

      // A short tablet viewport (a landscape phone with the browser's bars showing): the
      // pane is not wholly on the first screen. The reveal scrolls the pane only; the page stays where it was.
      await page.setViewportSize({ width: 844, height: 320 });
      await page.goto(`${shell.origin}/courses/${target}/edit`);
      await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
        'data-layout',
        'tablet',
      );
      await expect(openButton).toHaveAttribute('aria-pressed', 'true');
      const shortPane = workbench.locator('[data-pane="list"]');
      await expect
        .poll(async () => (await paneBand(shortPane)).scrollTop, 'pane scrolled at 844x320')
        .toBeGreaterThan(0);
      await rowsSettled(
        list
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: targetName, exact: true }) }),
        page,
      );
      // Non-vacuity: the pane runs past the first screen of the page, so anything that
      // brought the open course into view by scrolling the page would have to move it.
      expect(
        await shortPane.evaluate(
          (element) => element.getBoundingClientRect().bottom + window.scrollY,
        ),
        'list pane runs past the first screen at 844x320',
      ).toBeGreaterThan(320);
      expect
        .soft(await page.evaluate(() => window.scrollY), 'page not scrolled at 844x320')
        .toBe(0);

      // A layout change while the owner is further down the page (a desktop window narrowed
      // into the tablet range while editing): the reveal runs again, in the pane only, and
      // does not pull the page back up to the list.
      await page.setViewportSize({ width: 1280, height: 600 });
      await page.goto(`${shell.origin}/courses/${target}/edit`);
      await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
        'data-layout',
        'desktop',
      );
      await expect(openButton).toHaveAttribute('aria-pressed', 'true');
      await rowsSettled(
        list
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: targetName, exact: true }) }),
        page,
      );
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await settle(page);
      await page.setViewportSize({ width: 1024, height: 600 });
      await expect(workbench.locator('[data-layout][data-sheet]')).toHaveAttribute(
        'data-layout',
        'tablet',
      );
      await expect
        .poll(async () => (await paneBand(shortPane)).scrollTop, 'pane scrolled after resize')
        .toBeGreaterThan(0);
      await settle(page);
      const resized = await page.evaluate(() => window.scrollY);
      expect.soft(resized, 'page still scrolled down after resize').toBeGreaterThan(0);
      expect
        .soft((await rectOf(shortPane)).bottom, 'list pane still above the screen after resize')
        .toBeLessThanOrEqual(0);
    });
  });
}
