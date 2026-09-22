'use client';

import { useEffect, useRef, useState } from 'react';
import type { CoursePosition } from '@workout/contracts/courses';
import { courseGenerationGraphBuildId, type CourseReadResult } from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { CourseRequestError, type CourseApi } from './course-api';
import { currentRoute, draftRequestWaypoints, type DraftProblem } from './course-draft';
import { useCourseDraft, useCourseDraftStore } from './course-draft-context';
import styles from './courses.module.css';

/**
 * S14 waypoint editing (M2-01h).
 *
 * Everything essential here is a button or a field. There is no drag: reordering is two
 * move buttons, placing is either a map pick or two number fields, and removing, locking
 * and renaming are controls of their own. That is not a fallback for the map — it is the
 * primary way the list works, and it keeps the screen usable by keyboard, with a single
 * pointer and when the renderer is unavailable.
 *
 * Three rules are enforced by this screen rather than described by it.
 *
 * 1. **A computed route belongs to one draft.** The draft revision travels with the
 *    request and comes back in the answer; if the draft moved on while the engine was
 *    working, the answer is discarded and the screen says so. It is never applied to the
 *    waypoints that are on screen now.
 * 2. **Nothing is saved without review.** A computed route is a proposal. The owner must
 *    read what it is — planned line length, the engine's own estimate, how far waypoints
 *    were moved onto the network, which graph answered, any warnings — and confirm before
 *    the save button does anything.
 * 3. **A refusal leaves the draft alone.** No route, outside coverage, an excessive snap, a
 *    timeout, an overload and a cancellation are six different facts, each said in words,
 *    and none of them changes a waypoint or draws a substitute line.
 */
const refusals: Record<DraftProblem, string> = {
  WAYPOINT_LOCKED: '잠긴 경유점입니다. 잠금을 풀어야 옮기거나 지울 수 있습니다.',
  WAYPOINT_LIMIT_REACHED: '경유점을 더 추가할 수 없습니다.',
  WAYPOINT_MINIMUM_REACHED: '시작과 끝은 지울 수 없습니다.',
  WAYPOINT_POSITION_INVALID: '좌표 값이 올바르지 않습니다. 경도 -180~180, 위도 -90~90.',
  WAYPOINT_NOT_FOUND: '해당 경유점을 찾지 못했습니다.',
  DRAFT_LIMIT_REACHED: '이 편집 세션의 변경 횟수 상한에 도달했습니다.',
};

/** Each outcome is a different fact, and none of them is "we drew a straight line". */
const outcomes: Record<string, string> = {
  no_route: '두 지점을 잇는 보행 경로를 찾지 못했습니다. 경유점을 옮기거나 추가해 보세요.',
  outside_coverage:
    '경유점 중 하나가 보행 네트워크 범위 밖입니다. 이 지역은 경로를 계산할 수 없습니다.',
  snap_too_far:
    '경유점이 보행 네트워크에서 너무 멀리 떨어져 있습니다. 길에 더 가까운 지점을 고르세요.',
  timeout:
    '제한 시간 안에 계산이 끝나지 않았습니다. 결과를 알 수 없으므로 저장된 것은 없습니다. 다시 시도하세요.',
  cancelled: '경로 계산을 취소했습니다. 초안은 그대로입니다.',
  overloaded: '지금은 계산 요청이 많습니다. 잠시 후 다시 시도하세요.',
  compute_budget_exceeded: '경로 탐색 한도를 넘었습니다. 구간을 나누어 계산해 보세요.',
  engine_unavailable: '경로 계산 엔진에 연결하지 못했습니다. 초안은 그대로입니다.',
  engine_contract_violation: '엔진 응답을 신뢰할 수 없어 사용하지 않았습니다. 초안은 그대로입니다.',
  graph_mismatch: '실행 중인 지도 데이터가 고정된 것과 달라 계산을 사용하지 않았습니다.',
};

const saveErrors: Record<string, string> = {
  COURSE_REVISION_CONFLICT:
    '이 코스가 다른 곳에서 먼저 바뀌었습니다. 다시 불러온 뒤 경로를 다시 계산하세요.',
  COURSE_GRAPH_ACKNOWLEDGEMENT_STALE:
    '검토한 지도 데이터 정보가 최신이 아닙니다. 다시 불러온 뒤 계산하세요.',
  ROUTE_PROPOSAL_NOT_FOUND:
    '검토하던 경로 제안이 만료되었거나 이미 저장되었습니다. 다시 계산하세요.',
  ROUTE_PROPOSAL_EXPIRED: '검토하던 경로 제안이 만료되었습니다. 다시 계산하세요.',
  ROUTE_PROPOSAL_ALREADY_SAVED: '이 경로 제안은 이미 저장되었습니다.',
  ROUTE_PROPOSAL_STALE_DRAFT: '그 사이 초안이 바뀌었습니다. 경로를 다시 계산한 뒤 저장하세요.',
  COURSE_UNAVAILABLE: '원본 기록이 삭제되어 이 코스는 더 이상 편집할 수 없습니다.',
  ROUTE_PROPOSAL_QUOTA_EXCEEDED:
    '저장하지 않은 경로 제안이 너무 많습니다. 잠시 후 다시 시도하세요.',
};

/**
 * Did this answer prove nothing was stored? Only our own refusals do. A gateway or overload
 * answer says nothing about whether the revision was written, so the command — body and
 * idempotency key together — is kept and the retry is the same command.
 */
function provesNothingWasStored(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)}분`;
}

export interface CourseEditorProps {
  readonly api: CourseApi;
  readonly current: Extract<CourseReadResult, { status: 'available' }>;
  /** The last position the owner pointed at on the map, or `null`. */
  readonly pickedPosition: CoursePosition | null;
  readonly onSaved: (result: CourseReadResult) => void;
  /**
   * The server refused this write because the stored course is not what the screen thinks.
   * The owner has to see what it actually is, so the screen reloads it — which is what
   * makes a stored change reach the draft at all. Without this the conflict notice would
   * be unreachable in practice: every write from this screen carries the revision it was
   * showing, so a stale one is refused, and a refused write refetches nothing on its own.
   */
  readonly onStale: () => void;
}

export function CourseEditor({
  api,
  current,
  pickedPosition,
  onSaved,
  onStale,
}: CourseEditorProps) {
  const store = useCourseDraftStore();
  const state = useCourseDraft((value) => value);
  const route = currentRoute(state);
  const [message, setMessage] = useState('');
  const [computing, setComputing] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * What the owner actually read.
   *
   * Keying this to the draft revision alone was wrong: recomputing without touching a
   * waypoint leaves the revision where it was, so the tick survived onto a **different
   * proposal** — a different line, possibly from a different graph — and the save went out
   * without anyone having read it. A review belongs to one proposal of one draft, and
   * nothing else may inherit it.
   */
  const [reviewedProposal, setReviewedProposal] = useState<{
    proposalId: string;
    draftRevision: number;
  } | null>(null);
  const [manual, setManual] = useState({ longitude: '', latitude: '' });
  const abort = useRef<AbortController | null>(null);
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  const reviewed =
    route !== null &&
    reviewedProposal !== null &&
    reviewedProposal.proposalId === route.proposalId &&
    reviewedProposal.draftRevision === route.draftRevision;

  // An unmount — a layout change that removes this pane, a logout, an account switch —
  // cancels the computation. The server turns the dropped connection into a real
  // cancellation and releases the tenant's permit rather than finishing the work.
  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
    },
    [],
  );

  const headGraph = courseGenerationGraphBuildId(current.revision.generation);

  async function compute() {
    // The compute control is disabled while one is in flight, so there is at most one at a
    // time; this abort is the belt to that braces and keeps the invariant if that changes.
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const draftRevision = store.getState().revision;
    const requestId = crypto.randomUUID();
    setComputing(true);
    setMessage('');
    // Starting a computation ends the previous review: whatever comes back is a new answer
    // that has not been read yet, even if the draft did not move.
    setReviewedProposal(null);
    try {
      const answer = await api.computeRoute(
        current.course.courseId,
        {
          requestId,
          draftRevision,
          waypoints: draftRequestWaypoints(store.getState().waypoints),
        },
        controller.signal,
      );
      // A cancelled request can still be answered: the bytes were already on the wire, and
      // a transport that resolves rather than rejects hands us a perfectly good proposal
      // for a computation the owner abandoned. Nothing after this point may act on it.
      if (controller.signal.aborted || abort.current !== controller) return;
      if (answer.outcome !== 'route_computed') {
        // A named outcome. Nothing was stored, the draft is untouched, and no geometry is
        // invented to stand in for the missing answer.
        store.getState().clearRoute();
        setMessage(outcomes[answer.outcome] ?? '경로를 계산하지 못했습니다.');
        return;
      }
      const proposal = answer.proposal;
      // The answer must be to the question that was asked. A reply for another course,
      // another request or another draft is not this computation's result, and applying it
      // would put a line on screen that nobody asked for.
      if (
        proposal.courseId !== current.course.courseId ||
        proposal.requestId !== requestId ||
        proposal.computation.requestId !== requestId ||
        proposal.draftRevision !== draftRevision
      ) {
        store.getState().clearRoute();
        setMessage(
          '이 계산 결과가 방금 보낸 요청의 것이 아니어서 사용하지 않았습니다. 다시 계산하세요.',
        );
        return;
      }
      const applied = store.getState().applyRoute({
        draftRevision: proposal.draftRevision,
        proposalId: proposal.proposalId,
        coordinates: proposal.geometry.coordinates,
        engineDistanceMeters: proposal.engineDistanceMeters,
        engineDurationSeconds: proposal.engineDurationSeconds,
        maxSnapDistanceMeters: proposal.snappedWaypoints.reduce(
          (furthest, waypoint) => Math.max(furthest, waypoint.snapDistanceMeters),
          0,
        ),
        graphBuildId: proposal.computation.graph.graphBuildId,
        engineVersion: proposal.computation.graph.engineVersion,
        computedAt: proposal.computation.computedAt,
        warnings: proposal.computation.warnings,
      });
      setMessage(
        applied
          ? '경로를 계산했습니다. 아래 내용을 검토한 뒤 저장하세요.'
          : '계산하는 사이 초안이 바뀌어 이 결과를 적용하지 않았습니다. 현재 초안으로 다시 계산하세요.',
      );
    } catch (error) {
      // The same ownership question the success path asks. A request that was cancelled or
      // superseded no longer speaks for this screen: its message would overwrite what the
      // current attempt is saying.
      if (abort.current !== controller) return;
      if (controller.signal.aborted) {
        setMessage(outcomes['cancelled'] ?? '');
        return;
      }
      if (error instanceof CourseRequestError && error.status === 404) {
        setMessage('이 서버에는 경로 계산 기능이 구성되어 있지 않습니다.');
        return;
      }
      setMessage('경로 계산 결과를 확인하지 못했습니다. 저장된 것은 없습니다.');
    } finally {
      // And the cleanup asks it too. `setComputing(false)` used to run unconditionally, so
      // an abandoned request arriving while a newer one was in flight took the newer one's
      // cancel button away and re-enabled the compute control under it.
      if (abort.current === controller) {
        abort.current = null;
        setComputing(false);
      }
    }
  }

  async function save() {
    if (!route || !reviewed) return;
    const body = {
      expectedRevision: current.course.headRevision,
      change: {
        kind: 'reroute' as const,
        proposalId: route.proposalId,
        draftRevision: route.draftRevision,
        acknowledgedGraph: { previous: headGraph, next: route.graphBuildId },
      },
    };
    const fingerprint = JSON.stringify([current.course.courseId, body]);
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, key: crypto.randomUUID() };
    const key = command.current.key;
    // The draft this save is of. An edit made while the reply is outstanding produces a
    // different draft, and the reply is then not an answer about what is on screen.
    const savedDraftRevision = store.getState().revision;
    setSaving(true);
    setMessage('');
    try {
      const result = await api.update(current.course.courseId, body, key);
      command.current = null;
      // Only a head this command actually produced is "ours". A resend is answered with the
      // course **as it is now**, which may already carry somebody else's later edit; taking
      // that as our own save would make the draft adopt their waypoints without asking.
      if (
        result.status === 'available' &&
        result.course.courseId === current.course.courseId &&
        result.course.headRevision === body.expectedRevision + 1
      )
        store.getState().acknowledgeSave(result.course.headRevision, savedDraftRevision);
      store.getState().clearRoute();
      setReviewedProposal(null);
      setMessage(
        result.status === 'available'
          ? `경로를 저장했습니다. 현재 수정 번호 ${result.course.headRevision}`
          : '저장했지만 이 코스는 지금 사용할 수 없습니다.',
      );
      onSaved(result);
    } catch (error) {
      if (error instanceof CourseRequestError && provesNothingWasStored(error.status)) {
        command.current = null;
        setMessage(saveErrors[error.code] ?? '경로를 저장하지 못했습니다.');
        // Refused because the stored course moved: read it again so the owner sees what it
        // is now and decides what to do with the draft.
        if ([404, 409, 410].includes(error.status)) onStale();
        return;
      }
      setMessage(
        '저장 결과를 확인하지 못했습니다. 같은 경로로 다시 저장하면 수정본이 중복으로 생기지 않습니다.',
      );
    } finally {
      // Unconditional on purpose, and checked rather than assumed: unlike a computation,
      // a save cannot be superseded while it is out there. The control is disabled for the
      // whole of it and there is no cancel that re-enables it, so exactly one save is in
      // flight at a time and this clears the one that just finished. If a cancel is ever
      // added here, this needs the same ownership test the computation's cleanup has.
      setSaving(false);
    }
  }

  const graphChanged = headGraph !== null && route !== null && headGraph !== route.graphBuildId;

  return (
    <section className={styles.editor} aria-label="경유지 편집">
      <h3>경유지 편집</h3>
      <p className={styles.note}>
        계산된 경로는 <strong>제안</strong>입니다. 실제 기록도, 승인된 계획도 아니며 검토하고
        저장해야 코스 수정본이 됩니다. 지도에 보이는 경로가 통행 허가나 안전을 보장하지 않습니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {state.refusal ? <p role="alert">{refusals[state.refusal]}</p> : null}
      {state.headConflict ? (
        <div role="group" aria-label="초안 충돌" data-testid="draft-conflict">
          <p role="alert">
            {state.headConflict.reason === 'edited-after-own-save'
              ? `이 코스를 저장했고(수정 번호 ${state.headConflict.headRevision}) 저장한 뒤에도 경유점을 더 고쳤습니다. 방금 고친 내용은 그대로 두었습니다. 저장된 내용으로 다시 시작할지 고르세요.`
              : `저장된 코스가 다른 곳에서 바뀌었습니다(수정 번호 ${state.headConflict.headRevision}). 편집 중인 경유점은 그대로 두었습니다. 저장된 내용으로 다시 시작할지 고르세요.`}
          </p>
          <Button variant="secondary" onClick={() => store.getState().adoptHead()}>
            저장된 내용으로 다시 시작
          </Button>
          <Button variant="secondary" onClick={() => store.getState().keepDraft()}>
            편집 중인 내용 유지
          </Button>
        </div>
      ) : null}

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

      <ol className={styles.waypoints} aria-label="경유점 목록">
        {state.waypoints.map((waypoint, index) => (
          <li key={waypoint.id} data-role={waypoint.role}>
            <span>
              {index + 1}.{' '}
              {waypoint.role === 'start' ? '시작' : waypoint.role === 'finish' ? '끝' : '경유'}
              {waypoint.locked ? ' · 잠김' : ''}
            </span>
            <span className={styles.coordinate}>
              {waypoint.position[1].toFixed(5)}, {waypoint.position[0].toFixed(5)}
            </span>
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
        ))}
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

      <div className={styles.actions}>
        <Button onClick={() => void compute()} disabled={computing}>
          {computing ? '경로 계산 중' : '경로 계산'}
        </Button>
        {computing ? (
          <Button
            variant="secondary"
            onClick={() => {
              // Cancelling says so here rather than waiting for the request to settle: a
              // transport may answer a cancelled request successfully instead of
              // rejecting, and that answer is discarded in silence.
              const inFlight = abort.current;
              if (!inFlight) return;
              abort.current = null;
              inFlight.abort();
              setComputing(false);
              setMessage(outcomes['cancelled'] ?? '');
            }}
          >
            계산 취소
          </Button>
        ) : null}
      </div>

      {state.route && route === null ? (
        <p role="status">
          계산한 경로는 이전 초안의 것입니다. 초안이 바뀌었으므로 다시 계산해야 저장할 수 있습니다.
        </p>
      ) : null}

      {route ? (
        <div className={styles.review} role="group" aria-label="계산된 경로 검토">
          <h4>계산된 경로 (제안)</h4>
          <dl className={styles.summary}>
            <dt>경로 계산 예상 거리</dt>
            <dd data-testid="route-engine-distance">{metres(route.engineDistanceMeters)}</dd>
            <dt>경로 계산 예상 시간</dt>
            <dd>{minutes(route.engineDurationSeconds)}</dd>
            <dt>경유점 이동 거리(최대)</dt>
            <dd>{metres(route.maxSnapDistanceMeters)}</dd>
            <dt>사용한 지도 데이터</dt>
            <dd data-testid="route-graph">{route.graphBuildId}</dd>
            <dt>엔진 버전</dt>
            <dd>{route.engineVersion ?? '알 수 없음'}</dd>
            <dt>계산 시각</dt>
            <dd>{route.computedAt}</dd>
          </dl>
          <p className={styles.note}>
            이 거리는 경로 계산 엔진의 예상값입니다. 기기 보고 거리·GPS 재계산 거리·저장되는 계획 선
            길이와 다른 값입니다.
          </p>
          {route.warnings.length > 0 ? (
            <ul aria-label="경로 계산 경고">
              {route.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {graphChanged ? (
            <p role="alert" data-testid="graph-changed">
              이 코스는 다른 지도 데이터({headGraph})로 계산되어 있었습니다. 저장하면 새 지도
              데이터({route.graphBuildId})로 계산한 경로로 바뀝니다.
            </p>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) =>
                setReviewedProposal(
                  event.target.checked
                    ? { proposalId: route.proposalId, draftRevision: route.draftRevision }
                    : null,
                )
              }
            />
            위 내용을 검토했습니다.
          </label>
          <Button onClick={() => void save()} disabled={!reviewed || saving}>
            검토한 경로 저장
          </Button>
        </div>
      ) : null}
    </section>
  );
}
