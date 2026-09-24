'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CoursePosition } from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import {
  draftRouteStatus,
  type DraftProblem,
  type DraftRouteStatus,
  type DraftWaypoint,
} from './course-draft';
import { useCourseDraft, useCourseDraftStore } from './course-draft-context';
import { useLayoutModeFromViewport } from './course-layout';
import styles from './courses.module.css';

/**
 * The waypoint list of one draft, shared by the course editor and the new-course screen
 * (M2-01r). One component, so `/courses/new` and `/courses/:id/edit` cannot drift apart in
 * how a waypoint is selected, reordered, locked, moved, removed or typed in.
 *
 * Everything essential here is a button or a field. Reordering is two move buttons — and,
 * since M2-01k-i, also a drag handle that works with a pointer or the keyboard and goes
 * through the same draft action — placing is either a map pick or two number fields, and
 * selecting, removing, locking and renaming are controls of their own. The buttons are not
 * a fallback for the map or the drag — they are the primary way the list works, and they
 * keep the screen usable by keyboard, with a single pointer and when the renderer is
 * unavailable (plan section 5).
 */
export const draftRefusals: Record<DraftProblem, string> = {
  WAYPOINT_LOCKED: '잠긴 경유점입니다. 잠금을 풀어야 옮기거나 지울 수 있습니다.',
  WAYPOINT_LIMIT_REACHED: '경유점을 더 추가할 수 없습니다.',
  WAYPOINT_MINIMUM_REACHED: '시작과 끝은 지울 수 없습니다.',
  WAYPOINT_POSITION_INVALID: '좌표 값이 올바르지 않습니다. 경도 -180~180, 위도 -90~90.',
  WAYPOINT_NOT_FOUND: '해당 경유점을 찾지 못했습니다.',
  DRAFT_LIMIT_REACHED: '이 편집 세션의 변경 횟수 상한에 도달했습니다.',
};

/**
 * The uncomputed draft, in words (S14 "미계산 초안", plan section 5).
 *
 * Each state is a different fact and is said differently; none of them is an error. The
 * uncomputed and stale states say what the dashed line on the map is — waypoints joined
 * straight, not a walkable course and not a distance — because the map alone cannot tell a
 * screen-reader user or anyone else that, and a line with no words beside it reads as a
 * route. There is deliberately no number in any of them: the straight line is never
 * measured, so no distance can be mistaken for the course's.
 */
const straightLine =
  '지도의 회색 점선은 경유점을 순서대로 이은 직선일 뿐이며, 걸을 수 있는 경로도 실제 거리도 아닙니다.';

export function draftStatusText(status: DraftRouteStatus): { label: string; detail: string } {
  switch (status) {
    case 'stored':
      return {
        label: '저장된 경유점',
        detail: '경유점이 저장된 코스와 같습니다. 바꾸면 미계산 초안이 됩니다.',
      };
    case 'incomplete':
      return {
        label: '시작·끝 지점 없음',
        detail:
          '지도에서 위치를 고르거나 좌표를 입력해 시작 지점과 끝 지점을 놓으세요. 두 지점이 있어야 경로를 계산할 수 있습니다.',
      };
    case 'uncomputed':
      return {
        label: '미계산 초안',
        detail: `경유점을 바꿨지만 아직 경로를 계산하지 않았습니다. ${straightLine} 경로를 계산해야 저장할 수 있습니다.`,
      };
    case 'stale':
      return {
        label: '미계산 초안',
        detail: `계산한 결과는 이전 초안의 것입니다. 초안이 바뀌었으므로 다시 계산해야 저장할 수 있습니다. ${straightLine}`,
      };
    case 'computing':
      return {
        label: '계산 중',
        detail: '보행 경로를 계산하고 있습니다. 결과가 오기 전까지 이 초안은 미계산 초안입니다.',
      };
    case 'computed':
      return {
        label: '계산된 제안',
        detail:
          '이 초안에 대해 계산된 결과가 있습니다. 아직 저장되지 않았으며, 검토한 뒤 저장해야 합니다.',
      };
  }
}

export function WaypointListEditor({
  pickedPosition,
  computing,
}: {
  /** The last position the owner pointed at on the map or picked from a search, or `null`. */
  readonly pickedPosition: CoursePosition | null;
  /** A computation or a search for this draft is in flight. */
  readonly computing: boolean;
}) {
  const store = useCourseDraftStore();
  const state = useCourseDraft((value) => value);
  const [manual, setManual] = useState({ longitude: '', latitude: '' });
  const statusId = useId();
  const status = draftRouteStatus(state, { computing });
  const text = draftStatusText(status);

  return (
    <>
      {/*
        One live region for the state of the draft. Screen readers hear "미계산 초안" when a
        waypoint moves and hear it end when a route arrives, and the list below points here
        so the state is read with the list rather than only when it changes.
      */}
      <p
        id={statusId}
        role="status"
        className={styles.note}
        data-testid="draft-route-status"
        data-status={status}
      >
        <strong>{text.label}</strong> · {text.detail}
      </p>
      {state.refusal ? <p role="alert">{draftRefusals[state.refusal]}</p> : null}

      <div className={styles.actions}>
        <Button
          variant="secondary"
          onClick={() => store.getState().undo()}
          disabled={state.past.length === 0}
        >
          되돌리기
        </Button>
        <Button
          variant="secondary"
          onClick={() => store.getState().redo()}
          disabled={state.future.length === 0}
        >
          다시 실행
        </Button>
        <span data-testid="draft-revision">초안 변경 번호 {state.revision}</span>
      </div>

      {/*
        Collapsible at tablet width (07 §4, S13/S14 tablet: "지도+접히는 경유점 목록"). The
        entries fold away and the control that brings them back stays; the status above, the
        undo/redo controls and the add controls below stay usable while it is folded.
      */}
      <CollapsibleWaypointList count={state.waypoints.length}>
        <WaypointEntries pickedPosition={pickedPosition} describedBy={statusId} />
      </CollapsibleWaypointList>

      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={pickedPosition === null}
          onClick={() => pickedPosition && store.getState().addVia(pickedPosition)}
        >
          선택한 위치를 경유점으로 추가
        </Button>
      </div>

      {/*
        The list is complete without the map: a waypoint can be placed by typing its
        coordinates, so neither a drag nor a pointer on a rendered map is ever required.
      */}
      <form
        className={styles.actions}
        onSubmit={(event) => {
          event.preventDefault();
          const longitude = Number(manual.longitude);
          const latitude = Number(manual.latitude);
          if (manual.longitude.trim() === '' || manual.latitude.trim() === '') return;
          store.getState().addVia([longitude, latitude]);
          setManual({ longitude: '', latitude: '' });
        }}
      >
        <TextField
          label="경유점 경도"
          value={manual.longitude}
          inputMode="decimal"
          onChange={(event) => setManual((value) => ({ ...value, longitude: event.target.value }))}
        />
        <TextField
          label="경유점 위도"
          value={manual.latitude}
          inputMode="decimal"
          onChange={(event) => setManual((value) => ({ ...value, latitude: event.target.value }))}
        />
        <Button type="submit" variant="secondary">
          좌표로 경유점 추가
        </Button>
      </form>
    </>
  );
}

/** A waypoint being carried to a new place in the list, and where it would land. */
interface Carry {
  readonly id: string;
  /** Where it was picked up. */
  readonly from: number;
  /** Where it lands if dropped now, as an index of the list after the move. */
  readonly to: number;
  readonly via: 'pointer' | 'keyboard';
  /** The one pointer that drives a pointer carry; any other pointer is ignored. */
  readonly pointerId: number | null;
}

const roleName = (role: DraftWaypoint['role']) =>
  role === 'start' ? '시작' : role === 'finish' ? '끝' : '경유';

/**
 * The entries of the waypoint list, one row per waypoint with its own controls.
 *
 * Its own component so the list can grow new ways to act on a row without touching how the
 * list is composed, collapsed or described.
 *
 * **Reordering has two ways in and one way through (M2-01k-i).** Each row has "앞으로/뒤로"
 * buttons and a drag handle. The handle drags with a pointer (mouse, pen, touch) or picks up,
 * moves and drops with the keyboard. Both of them call `commit`, which calls the draft's one
 * `moveWaypoint` action: the order on screen is always the draft's order, a drag is one
 * undoable change like a button press, and the lock rule is the draft's, not this list's.
 * Nothing here reorders the rows itself — while a waypoint is carried the rows stay where
 * they are and a marker shows where it would land, so a refused drop leaves nothing to undo.
 *
 * The buttons stay: they are the way to reorder without a drag, and the whole list remains
 * usable with them alone.
 */
function WaypointEntries({
  pickedPosition,
  describedBy,
}: {
  readonly pickedPosition: CoursePosition | null;
  /** The element that says what state the draft is in, read with the list. */
  readonly describedBy: string;
}) {
  const store = useCourseDraftStore();
  const state = useCourseDraft((value) => value);
  const hintId = useId();
  // The carry lives in a ref as well as in state: pointer and focus events for one gesture
  // can arrive before React has rendered the previous one, and they must see the latest.
  const carrying = useRef<Carry | null>(null);
  const [carry, setCarryState] = useState<Carry | null>(null);
  const setCarry = (next: Carry | null) => {
    carrying.current = next;
    setCarryState(next);
  };
  // What a screen reader hears about the carry: picked up, where it would land, where it
  // landed (read back from the draft, not from the gesture), or why it did not move.
  const [announcement, setAnnouncement] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  const total = state.waypoints.length;

  // A keyboard drop keeps focus on the handle of the waypoint that moved, wherever it went.
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const handle = handles.current.get(id);
    if (handle && document.activeElement !== handle) handle.focus();
  }, [state.waypoints]);

  /**
   * Ask the draft to move one waypoint, then say what the draft did. Returns whether the
   * draft actually moved it.
   *
   * The reason for a refusal is the refusal THIS call produced: `refusal` is the draft's last
   * refusal and survives until the next change, so a drop in place after an earlier refusal
   * must not repeat that earlier reason. A drop in place asks for no change and is said as
   * such; any other unmoved drop says the draft's own refusal, whatever its code.
   */
  const commit = (id: string, to: number): boolean => {
    const from = store.getState().waypoints.findIndex((waypoint) => waypoint.id === id);
    store.getState().moveWaypoint(id, to);
    const after = store.getState();
    const now = after.waypoints.findIndex((waypoint) => waypoint.id === id);
    const moved = after.waypoints[now];
    if (now < 0 || !moved) {
      setAnnouncement('옮기려던 경유점을 찾지 못했습니다.');
      return false;
    }
    if (now !== from) {
      setAnnouncement(
        `${from + 1}번 경유점을 ${now + 1}번 위치로 옮겼습니다. 이제 ${roleName(moved.role)}입니다. 전체 ${after.waypoints.length}개.`,
      );
      return true;
    }
    const still = `${from + 1}번 경유점은 그대로 ${now + 1}번입니다.`;
    if (to === from) {
      setAnnouncement(`${from + 1}번 경유점을 제자리에 놓았습니다. 순서는 그대로입니다.`);
    } else if (after.refusal === 'WAYPOINT_LOCKED') {
      setAnnouncement(`잠긴 경유점이 있어 옮기지 않았습니다. ${still}`);
    } else if (after.refusal !== null) {
      setAnnouncement(`옮기지 않았습니다. ${draftRefusals[after.refusal]} ${still}`);
    } else {
      setAnnouncement(`옮기지 않았습니다. ${still}`);
    }
    return false;
  };

  const preview = (next: Carry) => {
    setCarry(next);
    setAnnouncement(
      next.to === next.from
        ? `${next.from + 1}번 경유점: 제자리입니다.`
        : `${next.from + 1}번 경유점을 ${next.to + 1}번 위치에 놓으려 합니다. 전체 ${total}개.`,
    );
  };

  const cancel = () => {
    const current = carrying.current;
    if (!current) return;
    setCarry(null);
    setAnnouncement(`옮기기를 취소했습니다. ${current.from + 1}번 경유점은 그대로입니다.`);
  };

  const drop = (current: Carry) => {
    setCarry(null);
    // Focus follows the waypoint only when the draft moved it. A refused or in-place drop
    // changes no waypoint, so nothing would consume the request here and it would stay armed
    // until some unrelated edit — a keystroke in a name field — and then steal focus.
    if (current.via === 'keyboard') refocus.current = current.id;
    if (!commit(current.id, current.to)) refocus.current = null;
  };

  const ownPointer = (current: Carry | null, id: string, pointerId: number): current is Carry =>
    current !== null &&
    current.via === 'pointer' &&
    current.id === id &&
    current.pointerId === pointerId;

  /** Where a pointer at `clientY` would put the carried waypoint, from the other rows. */
  const pointerTarget = (id: string, clientY: number) => {
    let to = 0;
    for (const waypoint of store.getState().waypoints) {
      if (waypoint.id === id) continue;
      const row = rows.current.get(waypoint.id);
      if (!row) continue;
      const box = row.getBoundingClientRect();
      if (clientY > box.top + box.height / 2) to += 1;
    }
    return to;
  };

  return (
    <>
      {total > 0 ? (
        <p id={hintId} className={styles.note}>
          끌어 옮기기: 손잡이를 끌어 놓거나, 손잡이에서 Space·Enter로 들고 위·아래 방향키로 위치를
          고른 뒤 Space·Enter로 놓습니다. Escape는 취소합니다. 화면 낭독기의 탐색 모드에서는
          방향키가 손잡이에 닿지 않으므로 포커스(양식) 모드로 바꾸세요. 앞으로·뒤로 버튼도 같은
          순서를 바꾸며, 끌기 없이 쓸 수 있습니다.
        </p>
      ) : null}
      <p
        role="status"
        aria-live="polite"
        className={styles.note}
        data-testid="waypoint-move-announcement"
      >
        {announcement}
      </p>
      <ol className={styles.waypoints} aria-label="경유점 목록" aria-describedby={describedBy}>
        {state.waypoints.map((waypoint, index) => {
          const selected = state.selectedWaypointId === waypoint.id;
          const carried = carry?.id === waypoint.id;
          const dropMarker =
            carry && carry.to !== carry.from && carry.to === index
              ? carry.to < carry.from
                ? 'before'
                : 'after'
              : undefined;
          return (
            <li
              key={waypoint.id}
              ref={(element) => {
                if (element) rows.current.set(waypoint.id, element);
                else rows.current.delete(waypoint.id);
              }}
              data-role={waypoint.role}
              data-selected={selected ? 'true' : undefined}
              data-carried={carried ? 'true' : undefined}
              data-drop={dropMarker}
            >
              <Button
                variant="secondary"
                className={styles.dragHandle}
                ref={(element) => {
                  if (element) handles.current.set(waypoint.id, element);
                  else handles.current.delete(waypoint.id);
                }}
                aria-pressed={carried}
                aria-describedby={hintId}
                onPointerDown={(event) => {
                  if (event.button !== 0 || carrying.current) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setCarry({
                    id: waypoint.id,
                    from: index,
                    to: index,
                    via: 'pointer',
                    pointerId: event.pointerId,
                  });
                  setAnnouncement(`${index + 1}번 경유점을 끌고 있습니다. 놓을 위치로 옮기세요.`);
                }}
                // Only the pointer that picked the waypoint up moves, drops or cancels it: a
                // second finger or pen on the handle is not part of this gesture.
                onPointerMove={(event) => {
                  const current = carrying.current;
                  if (!ownPointer(current, waypoint.id, event.pointerId)) return;
                  const to = pointerTarget(waypoint.id, event.clientY);
                  if (to !== current.to) preview({ ...current, to });
                }}
                onPointerUp={(event) => {
                  const current = carrying.current;
                  if (!ownPointer(current, waypoint.id, event.pointerId)) return;
                  drop(current);
                }}
                onPointerCancel={(event) => {
                  if (ownPointer(carrying.current, waypoint.id, event.pointerId)) cancel();
                }}
                onLostPointerCapture={(event) => {
                  if (ownPointer(carrying.current, waypoint.id, event.pointerId)) cancel();
                }}
                onClick={(event) => {
                  // A pointer's click ends a pointer drag, handled above. What arrives here
                  // with no pointer is Space, Enter or an assistive technology's activation.
                  if (event.detail !== 0) return;
                  const current = carrying.current;
                  if (current?.via === 'keyboard' && current.id === waypoint.id) {
                    drop(current);
                    return;
                  }
                  if (current) return;
                  setCarry({
                    id: waypoint.id,
                    from: index,
                    to: index,
                    via: 'keyboard',
                    pointerId: null,
                  });
                  setAnnouncement(
                    `${index + 1}번 경유점을 들었습니다. 위·아래 방향키로 위치를 고르고 Space나 Enter로 놓으세요. Escape는 취소합니다.`,
                  );
                }}
                onKeyDown={(event) => {
                  // Never take a key that belongs to an IME composition.
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  const current = carrying.current;
                  if (!current || current.via !== 'keyboard' || current.id !== waypoint.id) return;
                  const last = total - 1;
                  const to =
                    event.key === 'ArrowUp'
                      ? Math.max(0, current.to - 1)
                      : event.key === 'ArrowDown'
                        ? Math.min(last, current.to + 1)
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? last
                            : null;
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancel();
                  } else if (to !== null) {
                    event.preventDefault();
                    preview({ ...current, to });
                  }
                }}
                onBlur={() => {
                  if (carrying.current?.via === 'keyboard') cancel();
                }}
              >
                {`${index + 1}번 끌어 옮기기`}
              </Button>
              <span>
                {index + 1}. {roleName(waypoint.role)}
                {waypoint.locked ? ' · 잠김' : ''}
              </span>
              <span className={styles.coordinate}>
                {waypoint.position[1].toFixed(5)}, {waypoint.position[0].toFixed(5)}
              </span>
              {/*
                Selecting from the list is selecting on the map: the draft holds one
                selection and the map marks the same waypoint.
              */}
              <Button
                variant="secondary"
                aria-pressed={selected}
                onClick={() => store.getState().selectWaypoint(selected ? null : waypoint.id)}
              >
                {`${index + 1}번 선택`}
              </Button>
              <TextField
                label={`${index + 1}번 경유점 이름`}
                value={waypoint.name ?? ''}
                maxLength={120}
                onChange={(event) => store.getState().rename(waypoint.id, event.target.value)}
              />
              <Button
                variant="secondary"
                aria-pressed={waypoint.locked}
                onClick={() => store.getState().setLocked(waypoint.id, !waypoint.locked)}
              >
                {waypoint.locked ? `${index + 1}번 잠금 해제` : `${index + 1}번 잠그기`}
              </Button>
              <Button
                variant="secondary"
                disabled={index === 0}
                onClick={() => commit(waypoint.id, index - 1)}
              >
                {index + 1}번 앞으로
              </Button>
              <Button
                variant="secondary"
                disabled={index === total - 1}
                onClick={() => commit(waypoint.id, index + 1)}
              >
                {index + 1}번 뒤로
              </Button>
              <Button
                variant="secondary"
                disabled={pickedPosition === null}
                onClick={() =>
                  pickedPosition && store.getState().movePosition(waypoint.id, pickedPosition)
                }
              >
                {index + 1}번을 선택한 위치로 이동
              </Button>
              <Button variant="danger" onClick={() => store.getState().remove(waypoint.id)}>
                {index + 1}번 삭제
              </Button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * The waypoint list's fold, offered at tablet width only.
 *
 * On a phone the list is the sheet under the map and on a desktop there is room for it, so
 * neither folds. The fold is this list's own presentation state: it is not part of the
 * draft, it survives a layout change (a list folded at tablet width is open again at
 * desktop width and folded again back at tablet width), and folding hides the rows with
 * `hidden`, so nothing folded away can take focus.
 */
function CollapsibleWaypointList({
  count,
  children,
}: {
  readonly count: number;
  readonly children: ReactNode;
}) {
  const layout = useLayoutModeFromViewport();
  const [folded, setFolded] = useState(false);
  const rowsId = useId();
  const collapsible = layout === 'tablet';
  const collapsed = collapsible && folded;
  return (
    <div className={styles.waypointList} data-waypoint-list={collapsed ? 'collapsed' : 'expanded'}>
      {collapsible ? (
        <Button
          variant="secondary"
          aria-expanded={!collapsed}
          aria-controls={rowsId}
          onClick={() => setFolded((value) => !value)}
        >
          {collapsed ? '경유점 목록 펼치기' : '경유점 목록 접기'}
        </Button>
      ) : null}
      {collapsed ? (
        <p className={styles.note} data-testid="waypoint-list-folded">
          경유점 {count}개 · 목록을 접었습니다. 펼치면 경유점마다 선택·순서·잠금·삭제를 할 수
          있습니다.
        </p>
      ) : null}
      <div id={rowsId} className={styles.waypointRows} hidden={collapsed}>
        {children}
      </div>
    </div>
  );
}
