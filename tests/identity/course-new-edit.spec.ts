import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  courseAccessibilityNoteListSchema,
  courseReadResultSchema,
  courseRoutePreviewResultSchema,
  type CourseReadResult,
} from '../../packages/contracts/src/courses';
import { parseCurrentAccountExport } from './account-export';

/**
 * M2-01r against the real OIDC session (fixture provider), API, PostgreSQL and the routing
 * port the harness is configured with (the deterministic fixture unless
 * `IDENTITY_E2E_ROUTING=graphhopper`), in both shells:
 *
 * - S14 `/courses/new`: a course started on an empty map — placed, previewed, reviewed and
 *   saved — lands on `/courses/:id/edit`, and what was saved is the line that was reviewed.
 * - S14 "미계산 초안": a draft nobody computed says so, on screen and to a screen reader.
 * - Plan section 5 list alternative: select, reorder and delete from the list, asserted by
 *   what the SAVED course is afterwards, not by a counter moving.
 * - S13 "접근성 메모": stored, on the card, exported, CSRF-protected and owner-only.
 */
type Headers = Record<string, string>;

async function login(page: Page, name: 'Alice' | 'Bob'): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

async function readCourse(page: Page, headers: Headers, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  const read: CourseReadResult = courseReadResultSchema.parse(await response.json());
  if (read.status !== 'available') throw new Error('expected an available course');
  return read;
}

/** Coordinates in the order the list shows them, as the list prints them. */
async function listed(editor: Locator): Promise<string[]> {
  return editor
    .getByRole('list', { name: '경유점 목록' })
    .getByRole('listitem')
    .evaluateAll((items) =>
      items.map((item) => item.querySelector('[class*="coordinate"]')?.textContent ?? ''),
    );
}

async function place(editor: Locator, longitude: string, latitude: string) {
  await editor.getByLabel('경유점 경도').fill(longitude);
  await editor.getByLabel('경유점 위도').fill(latitude);
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
}

const label = (longitude: number, latitude: number) =>
  `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const S = [126.978, 37.566] as const;
const F = [126.982, 37.569] as const;
const V = [126.9801, 37.5676] as const;

/**
 * Start a course on an empty map in whichever shell `origin` serves, and save it. Returns
 * the id it was created with and the preview the owner reviewed.
 */
async function createOnEmptyMap(page: Page, headers: Headers, origin: string, name: string) {
  await page.goto(`${origin}/courses/new`);
  const screen = page.getByRole('region', { name: '새 코스' });
  const editor = screen.getByRole('region', { name: '경유지 편집' });
  const status = editor.getByTestId('draft-route-status');
  await expect(status).toHaveAttribute('data-status', 'incomplete');
  await expect(editor.getByRole('button', { name: '경로 계산' })).toBeDisabled();
  await place(editor, String(S[0]), String(S[1]));
  await place(editor, String(F[0]), String(F[1]));
  expect(await listed(editor)).toEqual([label(...S), label(...F)]);

  // The uncomputed draft: said in words to everyone, read with the list by a screen reader.
  await expect(status).toHaveAttribute('data-status', 'uncomputed');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toContainText('미계산 초안');
  await expect(status).toContainText('걸을 수 있는 경로도 실제 거리도 아닙니다');
  await expect(editor.getByRole('list', { name: '경유점 목록' })).toHaveAccessibleDescription(
    /미계산 초안/,
  );
  await expect(editor.getByRole('group', { name: '계산된 경로 검토' })).toHaveCount(0);

  const previewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/bff/v1/courses/route-previews',
  );
  await editor.getByRole('button', { name: '경로 계산' }).click();
  const previewAnswer = await previewResponse;
  const preview = courseRoutePreviewResultSchema.parse(await previewAnswer.json());
  expect({ status: previewAnswer.status(), outcome: preview.outcome }).toEqual({
    status: 200,
    outcome: 'route_computed',
  });
  if (preview.outcome !== 'route_computed') throw new Error('unreachable');
  await expect(status).toHaveAttribute('data-status', 'computed');
  const review = editor.getByRole('group', { name: '계산된 경로 검토' });
  await expect(review.getByTestId('route-graph')).toHaveText(
    preview.preview.computation.graph.graphBuildId,
  );
  // A preview is not a course: nothing by this name exists after computing it.
  const listing = await page.request.get('/bff/v1/courses', { headers });
  expect(listing.status()).toBe(200);
  expect(JSON.stringify(await listing.json())).not.toContain(name);

  const save = review.getByRole('button', { name: '검토한 경로로 새 코스 저장' });
  await expect(save).toBeDisabled();
  await review.getByLabel('새 코스 이름').fill(name);
  await review.getByLabel('위 내용을 검토했습니다.').check();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/bff/v1/courses',
  );
  await save.click();
  expect((await createResponse).status()).toBe(200);
  // The screen navigates as soon as the course exists, which discards the response body in
  // the browser, so the id is read from the address the screen went to and then confirmed
  // against the API rather than from the body.
  await expect(page).toHaveURL(new RegExp(`^${origin}/courses/[0-9a-f-]{36}/edit$`));
  const courseId = new URL(page.url()).pathname.split('/')[2] ?? '';
  const created = await readCourse(page, headers, courseId);
  expect(created.course.name).toBe(name);
  expect(created.course.headRevision).toBe(1);
  return { courseId, preview: preview.preview };
}

test('starts a course on an empty map and edits it by address, from the list alone', async ({
  page,
}) => {
  const alice = await login(page, 'Alice');
  const origin = new URL(page.url()).origin;
  const name = `빈 지도 코스 ${randomUUID().slice(0, 8)}`;
  const { courseId, preview } = await createOnEmptyMap(page, alice, origin, name);

  // ── /courses/:id/edit opened on the course, and what was saved is what was reviewed.
  const workbench = page.getByRole('region', { name: '내 코스' });
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  await expect(workbench.getByTestId('course-generation')).toContainText('경유지 경로 계산');
  await expect(workbench.getByLabel('코스 이름')).toHaveValue(name);
  const saved = await readCourse(page, alice, courseId);
  expect(saved.revision.geometry.coordinates).toEqual(preview.geometry.coordinates);
  expect(saved.revision.lineage).toEqual([]);
  expect(saved.revision.edit).toEqual({ kind: 'created' });
  expect(saved.revision.waypoints.map((waypoint) => waypoint.sourceSampleId)).toEqual([null, null]);
  if (saved.revision.generation.kind !== 'routed-waypoints') throw new Error('unexpected kind');
  expect(saved.revision.generation.computation.graph.graphBuildId).toBe(
    preview.computation.graph.graphBuildId,
  );

  // ── The list as the whole editor: add by coordinates, reorder, select, save.
  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  const status = editor.getByTestId('draft-route-status');
  await expect(status).toHaveAttribute('data-status', 'stored');
  await place(editor, String(V[0]), String(V[1]));
  expect(await listed(editor)).toEqual([label(...S), label(...V), label(...F)]);
  await expect(status).toHaveAttribute('data-status', 'uncomputed');
  await editor.getByRole('button', { name: '2번 앞으로' }).click();
  expect(await listed(editor)).toEqual([label(...V), label(...S), label(...F)]);
  await editor.getByRole('button', { name: '1번 뒤로' }).click();
  expect(await listed(editor)).toEqual([label(...S), label(...V), label(...F)]);
  await editor.getByRole('button', { name: '3번 앞으로' }).click();
  expect(await listed(editor)).toEqual([label(...S), label(...F), label(...V)]);
  // Selecting from the list selects on the map: the renderer's own coordinate list marks
  // exactly that one vertex.
  await editor.getByRole('button', { name: '3번 선택' }).click();
  await expect(editor.getByRole('button', { name: '3번 선택' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const mapSelected = workbench
    .getByRole('list', { name: '코스 지도 좌표 목록' })
    .locator('button[aria-pressed="true"]');
  await expect(mapSelected).toHaveCount(1);
  await expect(mapSelected).toHaveText(label(...V));

  const reorderProposal = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
  );
  await editor.getByRole('button', { name: '경로 계산' }).click();
  const asked = (await reorderProposal).postDataJSON() as {
    waypoints: { role: string; position: [number, number] }[];
  };
  expect(asked.waypoints.map((waypoint) => [waypoint.role, waypoint.position])).toEqual([
    ['start', [...S]],
    ['via', [...F]],
    ['finish', [...V]],
  ]);
  const reorderReview = editor.getByRole('group', { name: '계산된 경로 검토' });
  await reorderReview.getByLabel('위 내용을 검토했습니다.').check();
  await reorderReview.getByRole('button', { name: '검토한 경로 저장' }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('2');
  const reordered = await readCourse(page, alice, courseId);
  expect(reordered.revision.waypoints.map((waypoint) => waypoint.position)).toEqual([
    [...S],
    [...F],
    [...V],
  ]);

  // ── Delete from the list: the middle one, and only it, is gone from what is saved.
  await expect(status).toHaveAttribute('data-status', 'stored');
  await editor.getByRole('button', { name: '2번 삭제' }).click();
  expect(await listed(editor)).toEqual([label(...S), label(...V)]);
  await expect(status).toHaveAttribute('data-status', 'uncomputed');
  await editor.getByRole('button', { name: '경로 계산' }).click();
  const deleteReview = editor.getByRole('group', { name: '계산된 경로 검토' });
  await deleteReview.getByLabel('위 내용을 검토했습니다.').check();
  await deleteReview.getByRole('button', { name: '검토한 경로 저장' }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('3');
  const trimmedDown = await readCourse(page, alice, courseId);
  expect(trimmedDown.revision.waypoints.map((waypoint) => waypoint.position)).toEqual([
    [...S],
    [...V],
  ]);

  // ── S13 accessibility note: stored against the head on screen, shown on the card.
  const notePanel = workbench.getByRole('region', { name: '접근성 메모' });
  await notePanel.getByLabel('접근성 메모').fill('계단 12개, 난간 있음');
  await notePanel.getByRole('button', { name: '메모 저장' }).click();
  await expect(notePanel.getByText(/수정 번호 3 기준입니다/)).toBeVisible();
  const card = workbench
    .getByRole('list', { name: '코스 목록' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(card).toContainText('접근성 메모: 계단 12개, 난간 있음');
  await page.reload();
  await expect(card).toContainText('접근성 메모: 계단 12개, 난간 있음');
  const notes = courseAccessibilityNoteListSchema.parse(
    await (
      await page.request.get('/bff/v1/courses/accessibility-notes', { headers: alice })
    ).json(),
  );
  expect(notes.notes.filter((note) => note.courseId === courseId)).toEqual([
    expect.objectContaining({ note: '계단 12개, 난간 있음', writtenAtRevision: 3 }),
  ]);
  // The note is not course content: the head did not move for it.
  expect((await readCourse(page, alice, courseId)).course.headRevision).toBe(3);

  // Measured, not assumed: a cookie session without the CSRF token cannot write a note.
  const { 'x-csrf-token': _csrf, ...withoutToken } = alice;
  const forged = await page.request.put(`/bff/v1/courses/${courseId}/accessibility-note`, {
    headers: withoutToken,
    data: { expectedRevision: 3, note: '위조된 메모' },
  });
  expect(forged.status()).toBe(403);
  // A note written against a head that is not the head is refused, not attached to it.
  const stale = await page.request.put(`/bff/v1/courses/${courseId}/accessibility-note`, {
    headers: alice,
    data: { expectedRevision: 2, note: '옛 수정본 기준 메모' },
  });
  expect(stale.status()).toBe(409);

  const exported = parseCurrentAccountExport(
    await (await page.request.post('/bff/v1/operations/export', { headers: alice })).json(),
  );
  expect(
    exported.data.courseAccessibilityNotes.filter((row) => row['course_id'] === courseId),
  ).toEqual([expect.objectContaining({ note: '계단 12개, 난간 있음', written_at_revision: 3 })]);

  // ── Bob: the address of Alice's course shows him nothing, and he can write nothing to it.
  await page.goto('/account');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  const bob = await login(page, 'Bob');
  await page.goto(`/courses/${courseId}/edit`);
  const bobBench = page.getByRole('region', { name: '내 코스' });
  await expect(bobBench.getByRole('alert')).toContainText('코스를 찾을 수 없습니다.');
  await expect(bobBench.getByRole('region', { name: '경유지 편집' })).toHaveCount(0);
  await expect(page.getByText('계단 12개, 난간 있음')).toHaveCount(0);
  const bobNotes = courseAccessibilityNoteListSchema.parse(
    await (await page.request.get('/bff/v1/courses/accessibility-notes', { headers: bob })).json(),
  );
  expect(bobNotes.notes.some((note) => note.courseId === courseId)).toBe(false);
  const bobWrite = await page.request.put(`/bff/v1/courses/${courseId}/accessibility-note`, {
    headers: bob,
    data: { expectedRevision: 3, note: '남의 코스에 쓰기' },
  });
  expect(bobWrite.status()).toBe(404);
  const bobRead = await page.request.get(`/bff/v1/courses/${courseId}`, { headers: bob });
  expect(bobRead.status()).toBe(404);
});

test('starts and edits a course in the Vite shell too', async ({ page }) => {
  const alice = await login(page, 'Alice');
  const vite = 'http://127.0.0.1:4200';
  const name = `Vite 빈 지도 코스 ${randomUUID().slice(0, 8)}`;
  const { courseId, preview } = await createOnEmptyMap(page, alice, vite, name);
  const workbench = page.getByRole('region', { name: '내 코스' });
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const saved = await readCourse(page, alice, courseId);
  expect(saved.revision.geometry.coordinates).toEqual(preview.geometry.coordinates);

  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  await place(editor, String(V[0]), String(V[1]));
  await editor.getByRole('button', { name: '3번 앞으로' }).click();
  expect(await listed(editor)).toEqual([label(...S), label(...F), label(...V)]);
  await editor.getByRole('button', { name: '경로 계산' }).click();
  const review = editor.getByRole('group', { name: '계산된 경로 검토' });
  await review.getByLabel('위 내용을 검토했습니다.').check();
  await review.getByRole('button', { name: '검토한 경로 저장' }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('2');
  expect(
    (await readCourse(page, alice, courseId)).revision.waypoints.map((w) => w.position),
  ).toEqual([[...S], [...F], [...V]]);

  const notePanel = workbench.getByRole('region', { name: '접근성 메모' });
  await notePanel.getByLabel('접근성 메모').fill('경사로 1곳');
  await notePanel.getByRole('button', { name: '메모 저장' }).click();
  await expect(notePanel.getByText(/수정 번호 2 기준입니다/)).toBeVisible();
  await expect(
    workbench
      .getByRole('list', { name: '코스 목록' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name, exact: true }) }),
  ).toContainText('접근성 메모: 경사로 1곳');

  // An address that is not a course id is refused by the shell itself.
  await page.goto(`${vite}/courses/not-a-course/edit`);
  await expect(page.getByRole('alert')).toContainText('코스 주소가 올바르지 않습니다.');
});

test('starts a new course from a place found in our own place data', async ({ page }) => {
  await login(page, 'Alice');
  await page.goto('/courses/new');
  const screen = page.getByRole('region', { name: '새 코스' });
  const search = screen.getByRole('region', { name: '장소 검색' });
  const searched = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/bff/v1/courses/place-search',
  );
  await search.getByLabel('장소 이름').fill('한성대입구');
  await search.getByRole('button', { name: '검색' }).click();
  const answer = (await (await searched).json()) as {
    outcome: string;
    places?: {
      name: string;
      localName: string | null;
      kind: string;
      position: [number, number];
    }[];
  };
  // The harness deploys the place dataset only when it has been built on this machine; this
  // test needs it, so its absence is a failure here, never a silent pass.
  expect(answer.outcome).toBe('results');
  const found = answer.places?.find((entry) => entry.name === '한성대입구');
  if (!found) throw new Error('expected 한성대입구 in the deployed place data');
  // The button for exactly the first result of that name, as the screen labels it.
  await search
    .getByRole('list', { name: '검색 결과' })
    .getByRole('button', {
      name: `${found.name}${found.localName ? ` (${found.localName})` : ''} · ${found.kind}`,
      exact: true,
    })
    .first()
    .click();
  const editor = screen.getByRole('region', { name: '경유지 편집' });
  await editor.getByRole('button', { name: '선택한 위치를 경유점으로 추가' }).click();
  await place(editor, '127.0100', '37.5900');
  expect(await listed(editor)).toEqual([label(...found.position), label(127.01, 37.59)]);
  await expect(editor.getByTestId('draft-route-status')).toHaveAttribute(
    'data-status',
    'uncomputed',
  );
  const asked = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/bff/v1/courses/route-previews',
  );
  await editor.getByRole('button', { name: '경로 계산' }).click();
  const body = (await asked).postDataJSON() as { waypoints: { position: [number, number] }[] };
  expect(body.waypoints[0]?.position).toEqual(found.position);
});
