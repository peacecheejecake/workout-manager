import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  courseReadResultSchema,
  courseRouteProposalResultSchema,
  courseRoutePreviewResultSchema,
  type CoursePosition,
} from '../../packages/contracts/src/courses';
import {
  courseElevationResultSchema,
  placeSearchResultSchema,
  type CourseElevationResult,
} from '../../packages/contracts/src/geo-data';
import { login, overflow, place, shells, type Headers } from './course-editor-support';

/**
 * M2-01k-b · S14 "검색→시작/경유/도착 지점→foot profile routing→고도/거리 확인→저장", in that
 * order, in both shells, against the real OIDC session, API, PostgreSQL, our own place and
 * elevation datasets and the routing port the harness is configured with (the deterministic
 * fixture unless `IDENTITY_E2E_ROUTING=graphhopper`).
 *
 * What is asserted is the content, not that a panel exists:
 *
 * - the elevation asked about is the unsaved line on screen — the preview, then a stored
 *   proposal — and what the screen draws is exactly what our dataset answered, known values
 *   as values and unknown ones as marked gaps, never as zero;
 * - the distance on the review is the engine's, and differs from the length of the drawn
 *   line (the fixture keeps the two apart, as a real engine does);
 * - while the elevation check is out, the review cannot be confirmed and nothing is saved;
 * - the elevation dataset must actually be deployed: `no_dataset` fails this test rather
 *   than passing it. The "not deployed" wording has its own test, with the answer stated.
 */
const ELEVATION = '/bff/v1/courses/elevation-profiles';

/** 진달래길 in our place data sits on an elevation fact (106.83 m); F has none within 150 m. */
const PLACE = '진달래길';
const F: CoursePosition = [127.01, 37.66];

const fixtureRouting = (process.env['IDENTITY_E2E_ROUTING'] ?? 'fixture') === 'fixture';

/** The review's own formatting of a distance. */
function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

/** The length of the drawn line, which is what a client-side estimate would measure. */
function lineMeters(coordinates: readonly CoursePosition[]): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    if (!from || !to) continue;
    const dLat = radians(to[1] - from[1]);
    const dLon = radians(to[0] - from[0]);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(from[1])) * Math.cos(radians(to[1])) * Math.sin(dLon / 2) ** 2;
    total += 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

async function readCourse(page: Page, headers: Headers, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  const read = courseReadResultSchema.parse(await response.json());
  if (read.status !== 'available') throw new Error('expected an available course');
  return read;
}

/**
 * The screen shows exactly what the dataset answered: every known sample drawn at its value,
 * every unknown one listed as "모름" and covered by a gap band, none of them at zero.
 */
async function expectProfileOnScreen(check: Locator, answer: CourseElevationResult) {
  if (answer.outcome !== 'profile') throw new Error(`expected a profile, got ${answer.outcome}`);
  await expect(check).toHaveAttribute('data-outcome', 'profile');
  const known = answer.points.filter((point) => point.elevationMeters !== null);
  const unknown = answer.points.filter((point) => point.elevationMeters === null);
  // A profile with nothing known or nothing missing could not show either half of the rule.
  expect(known.length).toBeGreaterThan(0);
  expect(unknown.length).toBeGreaterThan(0);
  await expect(check.getByTestId('route-elevation-known')).toHaveText(
    `${answer.knownCount} / ${answer.points.length}`,
  );
  await expect(check.getByTestId('route-elevation-unknown')).toHaveText(String(unknown.length));
  const drawn = await check
    .getByTestId('route-elevation-point')
    .evaluateAll((points) => points.map((point) => Number(point.getAttribute('data-elevation'))));
  expect(drawn).toEqual(known.map((point) => point.elevationMeters));
  const samples = check.getByTestId('route-elevation-sample');
  await expect(samples).toHaveCount(answer.points.length);
  expect(
    await samples.evaluateAll((items) => items.map((item) => item.getAttribute('data-known'))),
  ).toEqual(answer.points.map((point) => (point.elevationMeters === null ? 'false' : 'true')));
  const texts = await samples.allTextContents();
  answer.points.forEach((point, index) => {
    const text = texts[index] ?? '';
    if (point.elevationMeters === null) {
      expect(text).toContain('모름');
      expect(text).not.toMatch(/: -?\d+(\.\d+)?m \(/);
    } else expect(text).toContain(`: ${point.elevationMeters}m (`);
  });
  expect(await check.getByTestId('route-elevation-gap').count()).toBeGreaterThan(0);
  await expect(check.getByTestId('route-elevation-gaps')).toHaveText(
    String(await check.getByTestId('route-elevation-gap').count()),
  );
}

for (const shell of shells) {
  test(`${shell.name}: search → points → compute → elevation/distance check → save`, async ({
    page,
  }) => {
    const alice = await login(page);
    const name = `고도 확인 코스 ${randomUUID().slice(0, 8)}`;
    const sequence: string[] = [];
    let recording = true;
    const tracked = new Set([
      'POST /bff/v1/courses/place-search',
      'POST /bff/v1/courses/route-previews',
      `POST ${ELEVATION}`,
      'POST /bff/v1/courses',
    ]);
    page.on('request', (request) => {
      const step = `${request.method()} ${new URL(request.url()).pathname}`;
      if (recording && tracked.has(step)) sequence.push(step);
    });

    await page.goto(`${shell.origin}/courses/new`);
    const screen = page.getByRole('region', { name: '새 코스' });
    const editor = screen.getByRole('region', { name: '경유지 편집' });

    // ── 1. Search, in our own place data.
    const search = screen.getByRole('region', { name: '장소 검색' });
    const searched = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/bff/v1/courses/place-search',
    );
    await search.getByLabel('장소 이름').fill(PLACE);
    await search.getByRole('button', { name: '검색' }).click();
    const places = placeSearchResultSchema.parse(await (await searched).json());
    // The place dataset must be deployed for this flow; its absence fails here.
    expect(places.outcome).toBe('results');
    if (places.outcome !== 'results') throw new Error('unreachable');
    const found = places.places.find((entry) => entry.name === PLACE);
    if (!found) throw new Error(`expected ${PLACE} in the deployed place data`);
    await search
      .getByRole('list', { name: '검색 결과' })
      .getByRole('button', {
        name: `${found.name}${found.localName ? ` (${found.localName})` : ''} · ${found.kind}`,
        exact: true,
      })
      .first()
      .click();

    // ── 2. Start, and finish, points.
    await editor.getByRole('button', { name: '선택한 위치를 경유점으로 추가' }).click();
    await place(editor, F[0], F[1]);
    await expect(editor.getByTestId('draft-route-status')).toHaveAttribute(
      'data-status',
      'uncomputed',
    );

    // ── 3. Compute. The elevation check is held so "before it answered" can be observed.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${ELEVATION}`, async (route) => {
      await gate;
      await route.continue();
    });
    const previewed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/bff/v1/courses/route-previews',
    );
    const elevationAsked = page.waitForRequest(
      (request) => new URL(request.url()).pathname === ELEVATION,
    );
    await editor.getByRole('button', { name: '경로 계산' }).click();
    const previewAnswer = courseRoutePreviewResultSchema.parse(await (await previewed).json());
    if (previewAnswer.outcome !== 'route_computed')
      throw new Error(`expected a route, got ${previewAnswer.outcome}`);
    const preview = previewAnswer.preview;
    expect(preview.waypoints[0]?.position).toEqual(found.position);

    // ── 4. The elevation/distance check, of the line that is not saved yet.
    const review = editor.getByRole('group', { name: '계산된 경로 검토' });
    // Distance: the engine's own value, and not the length of the line on screen.
    const engineText = metres(preview.engineDistanceMeters);
    const lineText = metres(lineMeters(preview.geometry.coordinates));
    // Without this the assertion below could not tell the two apart. The fixture keeps them
    // apart by construction. A real engine's line is detailed enough that its length rounds
    // to the same metre as its distance (seen: 684 m both), so there the assertion below is
    // "the engine's value is shown" and cannot by itself tell it from a measured line; the
    // two numbers are recorded rather than required to differ.
    if (fixtureRouting) expect(lineText).not.toBe(engineText);
    else
      test.info().annotations.push({
        type: 'engine-vs-line',
        description: `engine ${preview.engineDistanceMeters} m, drawn line ${lineMeters(preview.geometry.coordinates).toFixed(1)} m`,
      });
    await expect(review.getByTestId('route-engine-distance')).toHaveText(engineText);
    await expect(review.getByTestId('route-graph')).toHaveText(
      preview.computation.graph.graphBuildId,
    );
    const asked = (await elevationAsked).postDataJSON() as unknown;
    expect(asked).toEqual({ geometry: preview.geometry });

    const check = review.getByRole('region', { name: '고도 확인' });
    await expect(check).toHaveAttribute('data-outcome', 'pending');
    await review.getByLabel('새 코스 이름').fill(name);
    const confirm = review.getByLabel('위 내용을 검토했습니다.');
    const save = review.getByRole('button', { name: '검토한 경로로 새 코스 저장' });
    // The check has not answered: the review cannot be finished and nothing can be saved.
    await expect(confirm).toBeDisabled();
    await expect(save).toBeDisabled();
    await confirm.click({ force: true });
    await save.click({ force: true });
    await expect(confirm).not.toBeChecked();
    expect(sequence).not.toContain('POST /bff/v1/courses');

    const elevationAnswered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === ELEVATION,
    );
    release();
    const elevationResponse = await elevationAnswered;
    expect(elevationResponse.status()).toBe(200);
    const elevation = courseElevationResultSchema.parse(await elevationResponse.json());
    // Our own dataset must be deployed. "No dataset" is a failure of this test, not a pass.
    expect(elevation.outcome).toBe('profile');
    if (elevation.outcome !== 'profile') throw new Error('unreachable');
    expect(elevation.vertexCount).toBe(preview.geometry.coordinates.length);
    await expectProfileOnScreen(check, elevation);
    if (fixtureRouting)
      // The fixture line is start, one bend and finish: the start sits on 진달래길's fact,
      // and neither the bend nor F has one within 150 m.
      expect(elevation.points.map((point) => point.elevationMeters)).toEqual([106.83, null, null]);

    // ── 5. Save, only now.
    await expect(confirm).toBeEnabled();
    await confirm.check();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/bff/v1/courses',
    );
    await save.click();
    expect((await createdResponse).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`^${shell.origin}/courses/[0-9a-f-]{36}/edit$`));
    recording = false;
    expect(sequence).toEqual([
      'POST /bff/v1/courses/place-search',
      'POST /bff/v1/courses/route-previews',
      `POST ${ELEVATION}`,
      'POST /bff/v1/courses',
    ]);
    const courseId = new URL(page.url()).pathname.split('/')[2] ?? '';
    const saved = await readCourse(page, alice, courseId);
    expect(saved.course.name).toBe(name);
    expect(saved.revision.geometry.coordinates).toEqual(preview.geometry.coordinates);
    if (saved.revision.generation.kind !== 'routed-waypoints') throw new Error('unexpected kind');
    expect(saved.revision.generation.engineDistanceMeters).toBe(preview.engineDistanceMeters);
    expect(saved.revision.generation.computation.graph.graphBuildId).toBe(
      preview.computation.graph.graphBuildId,
    );

    // ── The same check for a stored proposal on the course's edit screen.
    await page.unroute(`**${ELEVATION}`);
    const workbench = page.getByRole('region', { name: '내 코스' });
    const stored = workbench.getByRole('region', { name: '경유지 편집' });
    await place(stored, 127.007, 37.6575);
    const proposed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
    );
    const proposalElevation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === ELEVATION,
    );
    await stored.getByRole('button', { name: '경로 계산' }).click();
    const proposal = courseRouteProposalResultSchema.parse(await (await proposed).json());
    if (proposal.outcome !== 'route_computed')
      throw new Error(`expected a route, got ${proposal.outcome}`);
    const proposalAnswer = await proposalElevation;
    expect(proposalAnswer.request().postDataJSON()).toEqual({
      geometry: proposal.proposal.geometry,
    });
    const proposalReview = stored.getByRole('group', { name: '계산된 경로 검토' });
    await expect(proposalReview.getByTestId('route-engine-distance')).toHaveText(
      metres(proposal.proposal.engineDistanceMeters),
    );
    await expectProfileOnScreen(
      proposalReview.getByRole('region', { name: '고도 확인' }),
      courseElevationResultSchema.parse(await proposalAnswer.json()),
    );
    await proposalReview.getByLabel('위 내용을 검토했습니다.').check();
    await proposalReview.getByRole('button', { name: '검토한 경로 저장' }).click();
    await expect(workbench.getByTestId('course-revision')).toHaveText('2');
    const rerouted = await readCourse(page, alice, courseId);
    expect(rerouted.revision.geometry.coordinates).toEqual(proposal.proposal.geometry.coordinates);
  });

  test(`${shell.name}: says in words when no elevation data is deployed`, async ({ page }) => {
    await login(page);
    await page.goto(`${shell.origin}/courses/new`);
    const editor = page.getByRole('region', { name: '새 코스' }).getByRole('region', {
      name: '경유지 편집',
    });
    // This case is about the words on screen for that answer, so the answer is stated here;
    // the flow test above is the one that requires the dataset to be deployed.
    await page.route(`**${ELEVATION}`, (route) =>
      route.fulfill({ status: 200, json: { outcome: 'no_dataset' } }),
    );
    await place(editor, 127.004267, 37.6589312);
    await place(editor, F[0], F[1]);
    await editor.getByRole('button', { name: '경로 계산' }).click();
    const check = editor
      .getByRole('group', { name: '계산된 경로 검토' })
      .getByRole('region', { name: '고도 확인' });
    await expect(check).toHaveAttribute('data-outcome', 'no_dataset');
    await expect(check.getByTestId('route-elevation-unavailable')).toContainText(
      '이 서버에는 고도 데이터가 배포되어 있지 않습니다',
    );
    await expect(check.getByTestId('route-elevation-unavailable')).toContainText('확인되지 않음');
    // Nothing drawn: an empty or flat chart would read as "flat".
    await expect(check.getByRole('img')).toHaveCount(0);
    await expect(check.getByTestId('route-elevation-point')).toHaveCount(0);
  });
}

/**
 * M2-01k-b review item 1: the elevation check at the mobile, tablet and desktop widths in both
 * shells (07 §4 boundaries 320 / 768 / 1280). Rendered boxes, not class names:
 *
 * - the page, the review group, the check and the chart do not overflow horizontally and lie
 *   inside the viewport;
 * - the chart has a drawable size; the sample list opens, stays inside, and its text is at
 *   least 12 px;
 * - the retry button, the sample list summary and the review checkbox are reached with Tab,
 *   show a focus indicator, and work from the keyboard (Enter retries, Enter opens the list,
 *   Space ticks the checkbox).
 */
async function tabTo(page: Page, target: Locator, limit = 150): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) throw new Error('tab target not found');
  for (let step = 0; step < limit; step += 1) {
    if (await handle.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`not reached with Tab in ${limit} steps`);
}

async function focusIndicated(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
    );
  });
}

async function withinViewport(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${label} has no box`);
  const width = page.viewportSize()?.width ?? 0;
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(width + 0.5);
  const scroll = await target.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(scroll, `${label} horizontal overflow`).toBeLessThanOrEqual(0);
  return box;
}

for (const shell of shells) {
  for (const width of [320, 768, 1280]) {
    test(`${shell.name} ${width}px: the elevation check fits, reads and works by keyboard`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      let failNext = true;
      // The first answer is a failure so the retry button exists; the retry reaches the server.
      await page.route(`**${ELEVATION}`, async (route) => {
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 500, json: { error: { code: 'ELEVATION_BROKEN' } } });
        } else await route.continue();
      });
      await page.goto(`${shell.origin}/courses/new`);
      const editor = page.getByRole('region', { name: '새 코스' }).getByRole('region', {
        name: '경유지 편집',
      });
      await place(editor, 127.004267, 37.6589312);
      await place(editor, F[0], F[1]);
      await editor.getByRole('button', { name: '경로 계산' }).click();
      const review = editor.getByRole('group', { name: '계산된 경로 검토' });
      const check = review.getByRole('region', { name: '고도 확인' });
      await expect(check).toHaveAttribute('data-outcome', 'failed');

      // Retry, from the keyboard.
      const retry = check.getByRole('button', { name: '고도 다시 확인' });
      await tabTo(page, retry);
      expect(await focusIndicated(retry), 'retry focus indicator').toBe(true);
      const again = page.waitForResponse(
        (response) => new URL(response.url()).pathname === ELEVATION,
      );
      await page.keyboard.press('Enter');
      expect((await again).status()).toBe(200);
      await expect(check).toHaveAttribute('data-outcome', 'profile');

      // Boxes.
      expect(await overflow(page), `page overflow at ${width}`).toBeLessThanOrEqual(0);
      await withinViewport(page, review, 'review group');
      await withinViewport(page, check, 'elevation check');
      const chartBox = await withinViewport(page, check.getByRole('img'), 'chart');
      expect(chartBox.width).toBeGreaterThan(200);
      expect(chartBox.height).toBeGreaterThan(60);

      // The sample list, opened from the keyboard, readable and inside the check.
      const summary = check.locator('details > summary');
      await tabTo(page, summary);
      expect(await focusIndicated(summary), 'summary focus indicator').toBe(true);
      await page.keyboard.press('Enter');
      const samples = check.getByRole('list', { name: '고도 표본' });
      await expect(samples).toBeVisible();
      await withinViewport(page, samples, 'sample list');
      const fontSize = await samples.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(12);
      await expect(check.getByTestId('route-elevation-sample').first()).toBeVisible();

      // The review checkbox, ticked from the keyboard.
      const confirm = review.getByLabel('위 내용을 검토했습니다.');
      await tabTo(page, confirm);
      expect(await focusIndicated(confirm), 'checkbox focus indicator').toBe(true);
      await page.keyboard.press('Space');
      await expect(confirm).toBeChecked();

      await check.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`elevation-${shell.name}-${width}.png`) });
    });
  }
}
