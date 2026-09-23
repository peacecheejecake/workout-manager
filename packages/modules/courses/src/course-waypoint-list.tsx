'use client';

import { useId, useState } from 'react';
import type { CoursePosition } from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { draftRouteStatus, type DraftProblem, type DraftRouteStatus } from './course-draft';
import { useCourseDraft, useCourseDraftStore } from './course-draft-context';
import styles from './courses.module.css';

/**
 * The waypoint list of one draft, shared by the course editor and the new-course screen
 * (M2-01r). One component, so `/courses/new` and `/courses/:id/edit` cannot drift apart in
 * how a waypoint is selected, reordered, locked, moved, removed or typed in.
 *
 * Everything essential here is a button or a field. There is no drag: reordering is two
 * move buttons, placing is either a map pick or two number fields, and selecting, removing,
 * locking and renaming are controls of their own. That is not a fallback for the map — it is
 * the primary way the list works, and it keeps the screen usable by keyboard, with a single
 * pointer and when the renderer is unavailable (plan section 5).
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

      <ol className={styles.waypoints} aria-label="경유점 목록" aria-describedby={statusId}>
        {state.waypoints.map((waypoint, index) => {
          const selected = state.selectedWaypointId === waypoint.id;
          return (
            <li
              key={waypoint.id}
              data-role={waypoint.role}
              data-selected={selected ? 'true' : undefined}
            >
              <span>
                {index + 1}.{' '}
                {waypoint.role === 'start' ? '시작' : waypoint.role === 'finish' ? '끝' : '경유'}
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
                onClick={() => store.getState().moveEarlier(waypoint.id)}
              >
                {index + 1}번 앞으로
              </Button>
              <Button
                variant="secondary"
                disabled={index === state.waypoints.length - 1}
                onClick={() => store.getState().moveLater(waypoint.id)}
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
