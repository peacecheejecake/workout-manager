import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { courseReadResultSchema } from '../../packages/contracts/src/courses';
import {
  draftRevision,
  importCourse,
  login,
  place,
  printed,
  shells,
  waypointRows,
  type Headers,
} from './course-editor-support';

/**
 * M2-01k-i · S14 "왼쪽 waypoint list의 drag와 이동 버튼은 같은 상태를 편집한다" and V2-F19
 * "waypoint/menu+drag", against the real OIDC session, API, PostgreSQL and routing port (the
 * deterministic fixture unless `IDENTITY_E2E_ROUTING=graphhopper`), in both shells:
 *
 * - The same stored course, reordered to the same order three ways — pointer drag, keyboard
 *   drag and the "앞으로/뒤로" buttons — and saved. What the engine was asked (order and
 *   roles) and what the API reads back as saved are identical all three times, and are the
 *   order the owner asked for. A drag that only moved rows on screen, or did nothing, cannot
 *   produce that: the request and the stored revision come from the draft.
 * - A drag that would carry a waypoint over a locked one, or carry a locked one, is refused
 *   with words, and nothing in the draft moves. Undo takes a drag back as one change and
 *   redo re-applies it; the engine is then asked about what redo left.
 * - The buttons alone still complete the task (the third way above is buttons only).
 */
const S = [126.978, 37.566] as const;
const F = [126.986, 37.567] as const;
const V1 = [126.9801, 37.5668] as const;
const V2 = [126.9832, 37.5671] as const;

type Way = 'pointer' | 'keyboard' | 'buttons';

interface Asked {
  readonly role: string;
  readonly position: [number, number];
}

async function openEditor(page: Page, origin: string, courseId: string) {
  await page.goto(`${origin}/courses/${courseId}/edit`);
  const workbench = page.getByRole('region', { name: '내 코스' });
  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    2,
  );
  return { workbench, editor };
}

const rowsOf = (editor: Locator) =>
  editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem');

/**
 * Drag row `from` (1-based) with the mouse so it lands at `to` (1-based) — pressed on its
 * handle, moved in steps over the other rows, released there. Only real pointer events.
 */
async function pointerDrag(page: Page, editor: Locator, from: number, to: number) {
  const handle = editor.getByRole('button', { name: `${from}번 끌어 옮기기` });
  await handle.scrollIntoViewIfNeeded();
  const grip = await handle.boundingBox();
  if (!grip) throw new Error('no handle box');
  const boxes = await rowsOf(editor).evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  const others = boxes.filter((_, index) => index !== from - 1);
  const target = others[to - 1];
  const last = others.at(-1);
  if (!last) throw new Error('no other rows');
  // Just inside the top of the row it should land before, or below the last row.
  const y = target ? target.top + 4 : last.bottom + 12;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, y, { steps: 8 });
  await page.mouse.up();
}

/** Pick up row `from` with the keyboard, move it to `to`, drop it. */
async function keyboardDrag(page: Page, editor: Locator, from: number, to: number) {
  const handle = editor.getByRole('button', { name: `${from}번 끌어 옮기기` });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  const key = to < from ? 'ArrowUp' : 'ArrowDown';
  for (let step = 0; step < Math.abs(to - from); step += 1) await page.keyboard.press(key);
  await page.keyboard.press('Space');
}

/** Reorder [S, V1, V2, F] into [V2, F, S, V1], one way. */
async function reorder(page: Page, editor: Locator, way: Way) {
  const announcement = editor.getByTestId('waypoint-move-announcement');
  if (way === 'buttons') {
    for (const name of ['3번 앞으로', '2번 앞으로', '4번 앞으로', '3번 앞으로'])
      await editor.getByRole('button', { name }).click();
    return;
  }
  const drag = way === 'pointer' ? pointerDrag : keyboardDrag;
  await drag(page, editor, 3, 1);
  await expect(announcement).toHaveText(
    '3번 경유점을 1번 위치로 옮겼습니다. 이제 시작입니다. 전체 4개.',
  );
  await drag(page, editor, 4, 2);
  await expect(announcement).toHaveText(
    '4번 경유점을 2번 위치로 옮겼습니다. 이제 경유입니다. 전체 4개.',
  );
}

async function readSaved(page: Page, headers: Headers, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  const read = courseReadResultSchema.parse(await response.json());
  if (read.status !== 'available') throw new Error('expected an available course');
  return read;
}

const reordered = [
  { label: '1. 시작', coordinate: printed(V2), name: '', locked: false },
  { label: '2. 경유', coordinate: printed(F), name: '', locked: false },
  { label: '3. 경유', coordinate: printed(S), name: '', locked: false },
  { label: '4. 끝', coordinate: printed(V1), name: '', locked: false },
];
const reorderedAsked: Asked[] = [
  { role: 'start', position: [...V2] },
  { role: 'via', position: [...F] },
  { role: 'via', position: [...S] },
  { role: 'finish', position: [...V1] },
];

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('drag (pointer and keyboard) and the move buttons save the same order and roles', async ({
      page,
    }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 1440, height: 1100 });
      const headers = await login(page);
      const outcomes: Record<Way, { asked: Asked[]; saved: Asked[] }> = {
        pointer: { asked: [], saved: [] },
        keyboard: { asked: [], saved: [] },
        buttons: { asked: [], saved: [] },
      };

      for (const way of ['pointer', 'keyboard', 'buttons'] as const) {
        // The same initial course each time: imported from the same file, same two added
        // waypoints, in the same order.
        const courseId = await importCourse(
          page,
          headers,
          `끌기 ${shell.name} ${way} ${randomUUID().slice(0, 8)}`,
          [S, [126.982, 37.568], F],
        );
        const { workbench, editor } = await openEditor(page, shell.origin, courseId);
        await place(editor, ...V1);
        await place(editor, ...V2);
        await expect
          .poll(() => waypointRows(editor))
          .toEqual([
            { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
            { label: '2. 경유', coordinate: printed(V1), name: '', locked: false },
            { label: '3. 경유', coordinate: printed(V2), name: '', locked: false },
            { label: '4. 끝', coordinate: printed(F), name: '', locked: false },
          ]);
        const before = await draftRevision(editor);

        await reorder(page, editor, way);
        await expect.poll(() => waypointRows(editor)).toEqual(reordered);
        // Two drags are two changes; four button presses are four.
        expect(await draftRevision(editor)).toBe(before + (way === 'buttons' ? 4 : 2));

        const proposal = page.waitForRequest(
          (request) =>
            request.method() === 'POST' &&
            new URL(request.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
        );
        await editor.getByRole('button', { name: '경로 계산' }).click();
        const body = (await proposal).postDataJSON() as { waypoints: Asked[] };
        outcomes[way].asked = body.waypoints.map(({ role, position }) => ({ role, position }));
        const review = editor.getByRole('group', { name: '계산된 경로 검토' });
        await review.getByLabel('위 내용을 검토했습니다.').check();
        await review.getByRole('button', { name: '검토한 경로 저장' }).click();
        await expect(workbench.getByTestId('course-revision')).toHaveText('2');
        const saved = await readSaved(page, headers, courseId);
        outcomes[way].saved = saved.revision.waypoints.map(({ role, position }) => ({
          role,
          position: [position[0], position[1]],
        }));
      }

      // Each is the order asked for, so the three are also identical to one another.
      for (const way of ['pointer', 'keyboard', 'buttons'] as const) {
        expect(outcomes[way].asked, `${way}: engine request`).toEqual(reorderedAsked);
        expect(outcomes[way].saved, `${way}: saved revision`).toEqual(reorderedAsked);
      }
      expect(outcomes.pointer).toEqual(outcomes.buttons);
      expect(outcomes.keyboard).toEqual(outcomes.buttons);
    });

    test('a drag is refused over a lock, and undo and redo take it back and re-apply it', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 1100 });
      const headers = await login(page);
      const courseId = await importCourse(
        page,
        headers,
        `끌기 잠금 ${shell.name} ${randomUUID().slice(0, 8)}`,
        [S, [126.982, 37.568], F],
      );
      const { editor } = await openEditor(page, shell.origin, courseId);
      await place(editor, ...V1);
      await place(editor, ...V2);
      const initial = [
        { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
        { label: '2. 경유', coordinate: printed(V1), name: '', locked: false },
        { label: '3. 경유', coordinate: printed(V2), name: '', locked: false },
        { label: '4. 끝', coordinate: printed(F), name: '', locked: false },
      ];
      await expect.poll(() => waypointRows(editor)).toEqual(initial);
      const announcement = editor.getByTestId('waypoint-move-announcement');

      // ── Lock row 2. Carrying row 3 over it is refused, by pointer and by keyboard.
      await editor.getByRole('button', { name: '2번 잠그기' }).click();
      const locked = initial.map((row, index) =>
        index === 1 ? { ...row, label: '2. 경유 · 잠김', locked: true } : row,
      );
      await expect.poll(() => waypointRows(editor)).toEqual(locked);
      const lockedRevision = await draftRevision(editor);
      await pointerDrag(page, editor, 3, 1);
      await expect(editor.getByRole('alert')).toHaveText(
        '잠긴 경유점입니다. 잠금을 풀어야 옮기거나 지울 수 있습니다.',
      );
      await expect(announcement).toHaveText(
        '잠긴 경유점이 있어 옮기지 않았습니다. 3번 경유점은 그대로 3번입니다.',
      );
      expect(await waypointRows(editor)).toEqual(locked);
      await keyboardDrag(page, editor, 3, 1);
      await expect(announcement).toHaveText(
        '잠긴 경유점이 있어 옮기지 않았습니다. 3번 경유점은 그대로 3번입니다.',
      );
      // The locked waypoint itself is not carried either.
      await pointerDrag(page, editor, 2, 4);
      await expect(announcement).toHaveText(
        '잠긴 경유점이 있어 옮기지 않았습니다. 2번 경유점은 그대로 2번입니다.',
      );
      expect(await waypointRows(editor)).toEqual(locked);
      expect(await draftRevision(editor)).toBe(lockedRevision);
      // The buttons obey the same rule: the same refusal.
      await editor.getByRole('button', { name: '3번 앞으로' }).click();
      expect(await waypointRows(editor)).toEqual(locked);
      expect(await draftRevision(editor)).toBe(lockedRevision);

      // ── Past no lock the same drag works: row 4 over row 3 only.
      await pointerDrag(page, editor, 4, 3);
      const dragged = [
        { label: '1. 시작', coordinate: printed(S), name: '', locked: false },
        { label: '2. 경유 · 잠김', coordinate: printed(V1), name: '', locked: true },
        { label: '3. 경유', coordinate: printed(F), name: '', locked: false },
        { label: '4. 끝', coordinate: printed(V2), name: '', locked: false },
      ];
      await expect.poll(() => waypointRows(editor)).toEqual(dragged);
      await expect(announcement).toHaveText(
        '4번 경유점을 3번 위치로 옮겼습니다. 이제 경유입니다. 전체 4개.',
      );

      // ── Undo takes the drag back as one change; redo re-applies it.
      const undo = editor.getByRole('button', { name: '되돌리기' });
      const redo = editor.getByRole('button', { name: '다시 실행' });
      await undo.click();
      await expect.poll(() => waypointRows(editor)).toEqual(locked);
      await redo.click();
      await expect.poll(() => waypointRows(editor)).toEqual(dragged);
      const revision = await draftRevision(editor);

      // What the engine is asked about is what redo left on screen.
      const proposal = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
      );
      await editor.getByRole('button', { name: '경로 계산' }).click();
      const body = (await proposal).postDataJSON() as {
        draftRevision: number;
        waypoints: (Asked & { locked: boolean })[];
      };
      expect(body.draftRevision).toBe(revision);
      expect(
        body.waypoints.map(({ role, position, locked }) => ({ role, position, locked })),
      ).toEqual([
        { role: 'start', position: [...S], locked: false },
        { role: 'via', position: [...V1], locked: true },
        { role: 'via', position: [...F], locked: false },
        { role: 'finish', position: [...V2], locked: false },
      ]);
    });
  });
}
