import { randomUUID } from 'node:crypto';
import { expect, test, type Route } from '@playwright/test';
import { courseRoutePreviewResultSchema } from '../../packages/contracts/src/courses';
import {
  draftRevision,
  importCourse,
  login,
  mapCoordinates,
  place,
  printed,
  settle,
  shells,
  waypointRows,
  type WaypointRow,
} from './course-editor-support';
import { mapRegion } from './map-evidence';

/**
 * M2-01k-c1 against the real OIDC session, API, PostgreSQL and routing port (the
 * deterministic fixture unless `IDENTITY_E2E_ROUTING=graphhopper`), in both shells:
 *
 * - S14 undo/redo: undo restores the previous waypoint CONTENT — positions, order, roles,
 *   names, locks — and redo re-applies it; the engine is asked about what undo restored.
 * - S14 "지도에서 보인 경로가 안전·통행 허가를 보장하지 않는다": said on both editors, and
 *   still on screen beside the computed route the owner reviews.
 * - V2-A35 / FUT-07-2 / P6: a late answer to an older request does not replace what is on
 *   screen — neither the newer waypoints of an edited draft nor a newer computed route.
 */
const S = [126.978, 37.566] as const;
const F = [126.982, 37.569] as const;
const V = [126.9801, 37.5676] as const;
const safety = '지도에 보이는 경로가 통행 허가나 안전을 보장하지 않습니다.';

const previewPath = '/bff/v1/courses/route-previews';

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('undo restores the previous waypoints and redo re-applies them, content and all', async ({
      page,
    }) => {
      await login(page);
      await page.goto(`${shell.origin}/courses/new`);
      const screen = page.getByRole('region', { name: '새 코스' });
      const editor = screen.getByRole('region', { name: '경유지 편집' });
      const undo = editor.getByRole('button', { name: '되돌리기' });
      const redo = editor.getByRole('button', { name: '다시 실행' });

      // The drafts really differ, so a restore that restored the wrong one cannot pass.
      const expected: WaypointRow[][] = [
        [
          { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
          { label: '2. 끝', coordinate: printed(F), name: '', locked: false },
        ],
        [
          { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
          { label: '2. 경유', coordinate: printed(V), name: '', locked: false },
          { label: '3. 끝', coordinate: printed(F), name: '', locked: false },
        ],
        [
          { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
          { label: '2. 경유', coordinate: printed(V), name: '약수터', locked: false },
          { label: '3. 끝', coordinate: printed(F), name: '', locked: false },
        ],
        [
          { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
          { label: '2. 경유', coordinate: printed(F), name: '', locked: false },
          { label: '3. 끝', coordinate: printed(V), name: '약수터', locked: false },
        ],
        [
          { label: '1. 시작 · 잠김', coordinate: printed(S), name: '', locked: true },
          { label: '2. 경유', coordinate: printed(F), name: '', locked: false },
          { label: '3. 끝', coordinate: printed(V), name: '약수터', locked: false },
        ],
      ];
      // Five drafts, each a different content: add, add, add, rename, reorder, lock. Each is
      // read once the list shows it, never straight after the action.
      const reached = async (index: number) => {
        const content = expected[index];
        if (!content) throw new Error(`no expected draft ${index}`);
        await expect.poll(() => waypointRows(editor)).toEqual(content);
        return content;
      };
      await place(editor, ...S);
      await place(editor, ...F);
      await reached(0);
      await place(editor, ...V);
      const added = await reached(1);
      await editor.getByLabel('2번 경유점 이름').fill('약수터');
      const renamed = await reached(2);
      await editor.getByRole('button', { name: '2번 뒤로' }).click();
      const reordered = await reached(3);
      await editor.getByRole('button', { name: '1번 잠그기' }).click();
      await reached(4);

      // Undo walks back through exactly those contents; every step is a new draft revision.
      let revision = await draftRevision(editor);
      for (const previous of [reordered, renamed, added]) {
        await undo.click();
        await expect.poll(() => waypointRows(editor)).toEqual(previous);
        const next = await draftRevision(editor);
        expect(next).toBeGreaterThan(revision);
        revision = next;
      }
      // Redo re-applies them, in order.
      for (const following of [renamed, reordered]) {
        await redo.click();
        await expect.poll(() => waypointRows(editor)).toEqual(following);
        const next = await draftRevision(editor);
        expect(next).toBeGreaterThan(revision);
        revision = next;
      }
      await expect(redo).toBeEnabled();

      // What the engine is asked about is what undo/redo left on screen, not the latest edit.
      const asked = page.waitForRequest(
        (request) => new URL(request.url()).pathname === previewPath && request.method() === 'POST',
      );
      await editor.getByRole('button', { name: '경로 계산' }).click();
      const body = (await asked).postDataJSON() as {
        draftRevision: number;
        waypoints: {
          role: string;
          position: [number, number];
          name: string | null;
          locked: boolean;
        }[];
      };
      expect(body.draftRevision).toBe(revision);
      expect(body.waypoints).toEqual([
        { role: 'start', position: [...S], name: null, sourceSampleId: null, locked: false },
        { role: 'via', position: [...F], name: null, sourceSampleId: null, locked: false },
        { role: 'finish', position: [...V], name: '약수터', sourceSampleId: null, locked: false },
      ]);
      await expect(editor.getByTestId('draft-route-status')).toHaveAttribute(
        'data-status',
        'computed',
      );

      // An edit after an undo is a new branch: redo has nothing left to re-apply.
      await undo.click();
      await expect.poll(() => waypointRows(editor)).toEqual(renamed);
      await editor.getByLabel('1번 경유점 이름').fill('출발');
      await expect(redo).toBeDisabled();
    });

    test('says the route shown is no guarantee of access or safety, on both editors', async ({
      page,
    }) => {
      const headers = await login(page);
      // New course: before anything is computed, and beside the computed route under review.
      await page.goto(`${shell.origin}/courses/new`);
      const screen = page.getByRole('region', { name: '새 코스' });
      const draft = screen.getByRole('region', { name: '경유지 편집' });
      await expect(draft.getByText(safety, { exact: false })).toBeVisible();
      await place(draft, ...S);
      await place(draft, ...F);
      await draft.getByRole('button', { name: '경로 계산' }).click();
      const newReview = draft.getByRole('group', { name: '계산된 경로 검토' });
      await expect(newReview).toBeVisible();
      await expect(draft.getByText(safety, { exact: false })).toBeVisible();
      expect(await draft.textContent()).toContain(safety);

      // A stored course opened by address.
      const courseId = await importCourse(page, headers, `안전 문구 ${randomUUID().slice(0, 8)}`, [
        [...S],
        [...V],
        [...F],
      ]);
      await page.goto(`${shell.origin}/courses/${courseId}/edit`);
      const editor = page
        .getByRole('region', { name: '내 코스' })
        .getByRole('region', { name: '경유지 편집' });
      await expect(editor.getByText(safety, { exact: false })).toBeVisible();
      await place(editor, 126.9805, 37.5672);
      await editor.getByRole('button', { name: '경로 계산' }).click();
      await expect(editor.getByRole('group', { name: '계산된 경로 검토' })).toBeVisible();
      await expect(editor.getByText(safety, { exact: false })).toBeVisible();
      expect(await editor.textContent()).toContain(safety);
    });

    /**
     * Two late answers, on the real stack. The engine really computes each request; only
     * WHEN its answer reaches the page is held, by holding the real response in the browser.
     *
     * 1. Fast edits: the draft moves on while its computation is out. The newer draft — its
     *    waypoints and the straight uncomputed line through them — is what the map has; the
     *    late answer for the previous draft must not land on it.
     * 2. A newer route first: the owner cancels a slow computation and computes again; the
     *    new route is applied and reviewed. The cancelled request's answer then arrives, and
     *    what is on screen must still be the newer route, still reviewed.
     */
    test('a late answer to an older request never replaces what is on screen', async ({ page }) => {
      test.setTimeout(60_000);
      await login(page);
      await page.goto(`${shell.origin}/courses/new`);
      const screen = page.getByRole('region', { name: '새 코스' });
      const editor = screen.getByRole('region', { name: '경유지 편집' });
      const status = editor.getByTestId('draft-route-status');
      const map = mapRegion(screen, '코스 지도');

      // Every preview answer is held until the test releases it, one by one.
      const held: { route: Route; body: string; release: () => void; done: Promise<void> }[] = [];
      let passThrough = false;
      await page.route(
        (url) => url.pathname === previewPath,
        async (route) => {
          if (passThrough) {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          const body = await response.text();
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entry = { route, body, release, done: Promise.resolve() };
          entry.done = gate.then(() =>
            route.fulfill({ response, body }).catch(() => {
              // The page abandoned the request; there is nobody to answer.
            }),
          );
          held.push(entry);
        },
      );
      const heldCount = () => held.length;

      // ── 1. The draft moves on while its computation is out.
      await place(editor, ...S);
      await place(editor, ...F);
      const askedAt = await draftRevision(editor);
      await editor.getByRole('button', { name: '경로 계산' }).click();
      await expect.poll(heldCount).toBe(1);
      await expect(status).toHaveAttribute('data-status', 'computing');
      await place(editor, ...V);
      expect(await draftRevision(editor)).toBeGreaterThan(askedAt);
      const newer = [printed(S), printed(V), printed(F)];
      const first = held[0];
      if (!first) throw new Error('no held answer');
      const oldAnswer = courseRoutePreviewResultSchema.parse(JSON.parse(first.body));
      if (oldAnswer.outcome !== 'route_computed') throw new Error('expected a computed route');
      expect(oldAnswer.preview.draftRevision).toBe(askedAt);
      // The older answer's own vertices, other than the waypoints it shares with the draft.
      const oldVertices = oldAnswer.preview.geometry.coordinates
        .map((position) => printed([position[0], position[1]]))
        .filter((vertex) => !newer.includes(vertex));
      expect(oldVertices.length).toBeGreaterThan(0);

      first.release();
      await first.done;
      await expect(
        editor.getByText(
          '계산하는 사이 초안이 바뀌어 이 결과를 적용하지 않았습니다. 현재 초안으로 다시 계산하세요.',
        ),
      ).toBeVisible();
      await settle(page);
      // Still the newer draft, still uncomputed: the old line is not applied, not even as
      // a stale route, and there is nothing to review or save.
      await expect(status).toHaveAttribute('data-status', 'uncomputed');
      await expect(editor.getByRole('group', { name: '계산된 경로 검토' })).toHaveCount(0);
      expect((await waypointRows(editor)).map((row) => row.coordinate)).toEqual(newer);
      const drawn = await mapCoordinates(map);
      expect(drawn).toEqual([...newer, ...newer]);
      for (const vertex of oldVertices) expect(drawn).not.toContain(vertex);

      // ── 2. A newer route is applied first; the cancelled request answers afterwards.
      await editor.getByRole('button', { name: '경로 계산' }).click();
      await expect.poll(heldCount).toBe(2);
      const cancelled = held[1];
      if (!cancelled) throw new Error('no held answer');
      const cancelledRequest = cancelled.route.request();
      const gaveUp = new Promise<'failed' | 'finished'>((resolve) => {
        page.on('requestfailed', (request) => {
          if (request === cancelledRequest) resolve('failed');
        });
        page.on('requestfinished', (request) => {
          if (request === cancelledRequest) resolve('finished');
        });
      });
      await editor.getByRole('button', { name: '계산 취소' }).click();
      await expect(
        editor.getByText('경로 계산을 취소했습니다. 초안은 그대로입니다.'),
      ).toBeVisible();
      passThrough = true;
      const newerAnswer = page.waitForResponse(
        (response) => new URL(response.url()).pathname === previewPath,
      );
      await editor.getByRole('button', { name: '경로 계산' }).click();
      const newerRoute = courseRoutePreviewResultSchema.parse(await (await newerAnswer).json());
      if (newerRoute.outcome !== 'route_computed') throw new Error('expected a computed route');
      const review = editor.getByRole('group', { name: '계산된 경로 검토' });
      await expect(status).toHaveAttribute('data-status', 'computed');
      await expect(review.getByText(newerRoute.preview.computation.computedAt)).toBeVisible();
      await review.getByLabel('위 내용을 검토했습니다.').check();
      const cancelledAnswer = courseRoutePreviewResultSchema.parse(JSON.parse(cancelled.body));
      if (cancelledAnswer.outcome !== 'route_computed') throw new Error('expected a route');
      // Two different answers: the late one would be visible if it were applied.
      expect(cancelledAnswer.preview.requestId).not.toBe(newerRoute.preview.requestId);
      expect(cancelledAnswer.preview.computation.computedAt).not.toBe(
        newerRoute.preview.computation.computedAt,
      );

      cancelled.release();
      await cancelled.done;
      await gaveUp;
      await settle(page);
      await expect(status).toHaveAttribute('data-status', 'computed');
      await expect(review.getByText(newerRoute.preview.computation.computedAt)).toBeVisible();
      await expect(review.getByText(cancelledAnswer.preview.computation.computedAt)).toHaveCount(0);
      await expect(review.getByLabel('위 내용을 검토했습니다.')).toBeChecked();
      await expect(editor.getByText('경로 계산을 취소했습니다. 초안은 그대로입니다.')).toHaveCount(
        0,
      );
      const onMap = await mapCoordinates(map);
      for (const position of newerRoute.preview.geometry.coordinates)
        expect(onMap).toContain(printed([position[0], position[1]]));
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
  });
}
