'use client';

import { useEffect, useRef, useState } from 'react';
import type { CoursePosition } from '@workout/contracts/courses';
import {
  courseGenerationGraphBuildId,
  courseLimits,
  targetDistanceLimits,
  type CourseReadResult,
  type CourseUpdateRequest,
} from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { CourseRequestError, type CourseApi } from './course-api';
import {
  currentCandidates,
  currentRoute,
  draftRequestWaypoints,
  pickedCandidate,
  type ComputedDraftRoute,
} from './course-draft';
import { useCourseDraft, useCourseDraftStore } from './course-draft-context';
import { WaypointListEditor } from './course-waypoint-list';
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

/** Each outcome is a different fact, and none of them is "we drew a straight line". */
export const outcomes: Record<string, string> = {
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

/**
 * A candidate search answers one of these. `no_candidate` is a **known** answer — the
 * search ran inside its bounds and found nothing worth offering — and it is said in those
 * words rather than as a failure, because "we looked and found none" and "we do not know
 * what happened" are different facts.
 */
const candidateOutcomes: Record<string, string> = {
  no_candidate:
    '정해진 한도 안에서 목표 거리에 맞는 후보를 찾지 못했습니다. 저장된 것은 없습니다. 목표 거리를 바꾸거나 다시 시도하세요.',
  no_route: '후보 경로를 잇는 보행 경로를 찾지 못했습니다. 저장된 것은 없습니다.',
  outside_coverage: '시작 지점이 보행 네트워크 범위 밖입니다. 이 지역은 후보를 만들 수 없습니다.',
  snap_too_far: '시작 지점이 보행 네트워크에서 너무 멀리 떨어져 있습니다.',
  timeout: '제한 시간 안에 탐색이 끝나지 않았습니다. 결과를 알 수 없으므로 저장된 것은 없습니다.',
  cancelled: '후보 생성을 취소했습니다. 초안은 그대로입니다.',
  overloaded: '지금은 계산 요청이 많습니다. 잠시 후 다시 시도하세요.',
  compute_budget_exceeded: '경로 탐색 한도를 넘었습니다. 목표 거리를 줄여 보세요.',
  engine_unavailable: '경로 계산 엔진에 연결하지 못했습니다. 초안은 그대로입니다.',
  engine_contract_violation: '엔진 응답을 신뢰할 수 없어 사용하지 않았습니다. 초안은 그대로입니다.',
  graph_mismatch: '실행 중인 지도 데이터가 고정된 것과 달라 후보를 사용하지 않았습니다.',
};

/** Why one attempt produced no candidate. Shown so the search is auditable, not magic. */
const attemptOutcomes: Record<string, string> = {
  accepted: '후보로 채택',
  duplicate: '이미 제안한 후보와 대부분 겹침',
  off_target: '목표 거리 허용 오차 밖',
  not_a_loop: '출발점으로 돌아오지 않음',
  outside_search_area: '탐색 허용 범위를 벗어남',
  request_refused: '요청 한도에 걸려 계산하지 않음',
  no_route: '보행 경로 없음',
  outside_coverage: '네트워크 범위 밖',
  snap_too_far: '네트워크에서 너무 멂',
  timeout: '제한 시간 초과',
  cancelled: '취소됨',
  overloaded: '요청 한도 초과',
  compute_budget_exceeded: '탐색 한도 초과',
  engine_unavailable: '엔진 연결 실패',
  engine_contract_violation: '엔진 응답 거절',
  graph_mismatch: '지도 데이터 불일치',
};

const candidateSaveErrors: Record<string, string> = {
  ROUTE_CANDIDATE_SET_MISMATCH: '고른 후보가 이 탐색의 것이 아닙니다. 후보를 다시 생성하세요.',
  CANDIDATE_TARGET_OUT_OF_RANGE: `목표 거리는 ${targetDistanceLimits.minTargetMeters}m 이상 ${targetDistanceLimits.maxTargetMeters}m 이하여야 합니다.`,
  CANDIDATE_LOCKED_WAYPOINTS_EXCEED_TARGET:
    '잠긴 경유점만으로도 목표 거리를 넘습니다. 목표를 늘리거나 잠금을 푸세요.',
  CANDIDATE_LOCKED_WAYPOINT_OUTSIDE_SEARCH_AREA: '잠긴 경유점이 이 목표 거리의 탐색 범위 밖입니다.',
  CANDIDATE_TOO_MANY_LOCKED_WAYPOINTS: '잠긴 경유점이 너무 많아 후보를 만들 수 없습니다.',
  CANDIDATE_LOCKED_FINISH_NOT_A_LOOP:
    '끝 지점이 시작과 다른 곳에 잠겨 있습니다. 후보는 출발점으로 돌아오는 경로이므로 끝 지점의 잠금을 풀어야 합니다.',
};

const saveErrors: Record<string, string> = {
  ...candidateSaveErrors,
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
};

/**
 * The unsaved-proposal bound, as a computation or a search meets it (M2-01p).
 *
 * Only those two can meet it: they are what creates a proposal, and a save only ever
 * consumes one. The server refuses before the engine runs, so nothing was computed and
 * nothing was stored. A newer answer on the same course replaces the older ones, so what
 * is still holding seats is unsaved work on other courses, and the only thing that frees a
 * seat without the owner saving is expiry — which is why the wait is stated as what it is.
 */
const proposalQuotaMessage = `저장하지 않은 경로 제안이 한도(모든 코스 합쳐 ${courseLimits.openRouteProposalsPerTenant}개)에 찼습니다. 제안이 만료되는 대로 자리가 나며, 늦어도 ${Math.round(courseLimits.routeProposalTtlSeconds / 60)}분 뒤에는 다시 계산할 수 있습니다. 저장된 것은 없습니다.`;

/**
 * Did this answer prove nothing was stored? Only our own refusals do. A gateway or overload
 * answer says nothing about whether the revision was written, so the command — body and
 * idempotency key together — is kept and the retry is the same command.
 */
export function provesNothingWasStored(status: number): boolean {
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
  const [generating, setGenerating] = useState(false);
  const [target, setTarget] = useState('5000');
  /**
   * What the owner read about the candidate they picked. Bound to the proposal and to the
   * draft, exactly as the route review is: picking a different candidate, running a new
   * search or touching a waypoint all mean nobody has read what is on screen now.
   */
  const [reviewedCandidate, setReviewedCandidate] = useState<{
    proposalId: string;
    draftRevision: number;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  const candidateSet = currentCandidates(state);
  const picked = pickedCandidate(state);
  const candidateReviewed =
    picked !== null &&
    reviewedCandidate !== null &&
    reviewedCandidate.proposalId === picked.proposalId &&
    reviewedCandidate.draftRevision === state.revision;
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
      if (error instanceof CourseRequestError && error.code === 'ROUTE_PROPOSAL_QUOTA_EXCEEDED') {
        setMessage(proposalQuotaMessage);
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

  /**
   * Ask for bounded target-distance candidates.
   *
   * Every rule the route computation follows applies here, for the same reasons: at most
   * one engine operation is in flight at a time, a cancelled search discards whatever
   * arrives afterwards, and an answer is used only when it is the answer to the question
   * that was asked — this course, this request, this draft. A search takes longer than one
   * computation, which makes the late-answer path more likely, not less.
   */
  async function generate() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const draftRevision = store.getState().revision;
    const requestId = crypto.randomUUID();
    const targetDistanceMeters = Number(target);
    // Refused here as well as at the contract: a target outside the range buys no engine
    // time at all, and the screen says which range rather than "the request was invalid".
    if (
      !Number.isFinite(targetDistanceMeters) ||
      targetDistanceMeters < targetDistanceLimits.minTargetMeters ||
      targetDistanceMeters > targetDistanceLimits.maxTargetMeters
    ) {
      setMessage(candidateSaveErrors['CANDIDATE_TARGET_OUT_OF_RANGE'] ?? '');
      abort.current = null;
      return;
    }
    setGenerating(true);
    setMessage('');
    // A new search means nothing on screen has been read yet.
    setReviewedCandidate(null);
    try {
      const answer = await api.generateCandidates(
        current.course.courseId,
        {
          requestId,
          draftRevision,
          targetDistanceMeters,
          seed: null,
          waypoints: draftRequestWaypoints(store.getState().waypoints),
        },
        controller.signal,
      );
      if (controller.signal.aborted || abort.current !== controller) return;
      if (answer.outcome !== 'candidates_generated') {
        // A named outcome. Nothing was stored, the draft is untouched, and no line is
        // invented to stand in for the candidates that were not found.
        store.getState().clearCandidates();
        setMessage(candidateOutcomes[answer.outcome] ?? '후보를 생성하지 못했습니다.');
        return;
      }
      const set = answer.set;
      if (
        set.courseId !== current.course.courseId ||
        set.requestId !== requestId ||
        set.draftRevision !== draftRevision
      ) {
        store.getState().clearCandidates();
        setMessage(
          '이 후보 목록이 방금 보낸 요청의 것이 아니어서 사용하지 않았습니다. 다시 생성하세요.',
        );
        return;
      }
      const applied = store.getState().applyCandidates({
        draftRevision: set.draftRevision,
        candidateSetId: set.candidateSetId,
        targetDistanceMeters: set.targetDistanceMeters,
        searchSeed: set.searchSeed,
        generatorVersion: set.generatorVersion,
        evaluationVersion: set.evaluationVersion,
        bounds: set.bounds,
        search: set.search,
        candidates: set.candidates.map((candidate) => ({
          proposalId: candidate.proposalId,
          ordinal: candidate.ordinal,
          attemptIndex: candidate.attemptIndex,
          candidateSeed: candidate.candidateSeed,
          coordinates: candidate.geometry.coordinates,
          engineDistanceMeters: candidate.engineDistanceMeters,
          engineDurationSeconds: candidate.engineDurationSeconds,
          graphBuildId: candidate.computation.graph.graphBuildId,
          engineVersion: candidate.computation.graph.engineVersion,
          computedAt: candidate.computation.computedAt,
          warnings: candidate.computation.warnings,
          evaluation: candidate.evaluation,
        })),
      });
      setMessage(
        applied
          ? `후보 ${set.candidates.length}개를 만들었습니다. 이것은 제안입니다. 하나를 고르고 검토한 뒤 저장하세요.`
          : '탐색하는 사이 초안이 바뀌어 이 후보를 적용하지 않았습니다. 현재 초안으로 다시 생성하세요.',
      );
    } catch (error) {
      if (abort.current !== controller) return;
      if (controller.signal.aborted) {
        setMessage(candidateOutcomes['cancelled'] ?? '');
        return;
      }
      if (error instanceof CourseRequestError) {
        if (error.status === 404) {
          setMessage('이 서버에는 경로 계산 기능이 구성되어 있지 않습니다.');
          return;
        }
        if (error.code === 'ROUTE_PROPOSAL_QUOTA_EXCEEDED') {
          setMessage(proposalQuotaMessage);
          return;
        }
        if (provesNothingWasStored(error.status)) {
          setMessage(candidateSaveErrors[error.code] ?? '후보를 생성하지 못했습니다.');
          return;
        }
      }
      setMessage('후보 생성 결과를 확인하지 못했습니다. 저장된 것은 없습니다.');
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setGenerating(false);
      }
    }
  }

  /**
   * One explicit save. It takes the change rather than reading the screen, because two
   * different reviews reach it — a computed reroute and a picked target-distance candidate
   * — and both must go out under the same rules: the revision the screen was showing, one
   * idempotency key per distinct command, and the same ownership test on the reply.
   */
  async function save(change: CourseUpdateRequest['change']) {
    const body = { expectedRevision: current.course.headRevision, change };
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
      store.getState().clearCandidates();
      setReviewedProposal(null);
      setReviewedCandidate(null);
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
  const candidateGraphChanged =
    headGraph !== null && picked !== null && headGraph !== picked.graphBuildId;

  return (
    <section className={styles.editor} aria-label="경유지 편집">
      <h3>경유지 편집</h3>
      <p className={styles.note}>
        계산된 경로는 <strong>제안</strong>입니다. 실제 기록도, 승인된 계획도 아니며 검토하고
        저장해야 코스 수정본이 됩니다. 지도에 보이는 경로가 통행 허가나 안전을 보장하지 않습니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
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

      <WaypointListEditor pickedPosition={pickedPosition} computing={computing || generating} />

      <div className={styles.actions}>
        {/*
          At most one engine operation is in flight at a time: both controls are disabled
          while either is running, so the single abort handle below can never belong to two
          of them and a late answer can never end the other one's progress.
        */}
        <Button onClick={() => void compute()} disabled={computing || generating}>
          {computing ? '경로 계산 중' : '경로 계산'}
        </Button>
        {computing || generating ? (
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
              const wasGenerating = generating;
              setComputing(false);
              setGenerating(false);
              setMessage(
                (wasGenerating ? candidateOutcomes['cancelled'] : outcomes['cancelled']) ?? '',
              );
            }}
          >
            {generating ? '후보 생성 취소' : '계산 취소'}
          </Button>
        ) : null}
      </div>

      <section className={styles.review} aria-label="목표 거리 후보">
        <h4>목표 거리 후보</h4>
        <p className={styles.note}>
          목표 거리는 <strong>근사치</strong>입니다. 아래 후보는 제안이며, 하나를 고르고 검토해
          저장해야 코스 수정본이 됩니다. 경로 계산 결과나 과거 기록은 지금 그 길을 다닐 수 있다는
          보장이 아닙니다.
        </p>
        <div className={styles.actions}>
          <TextField
            label="목표 거리(m)"
            value={target}
            inputMode="numeric"
            onChange={(event) => setTarget(event.target.value)}
          />
          <Button onClick={() => void generate()} disabled={computing || generating}>
            {generating ? '후보 생성 중' : '목표 거리 후보 생성'}
          </Button>
        </div>
        {state.candidates && candidateSet === null ? (
          <p role="status">
            만든 후보는 이전 초안의 것입니다. 초안이 바뀌었으므로 다시 생성해야 저장할 수 있습니다.
          </p>
        ) : null}
        {candidateSet ? (
          <div data-testid="candidate-set">
            <dl className={styles.summary}>
              <dt>목표 거리</dt>
              <dd>{metres(candidateSet.targetDistanceMeters)}</dd>
              <dt>탐색 seed</dt>
              <dd data-testid="candidate-seed">{candidateSet.searchSeed}</dd>
              <dt>생성기 버전</dt>
              <dd>{candidateSet.generatorVersion}</dd>
              <dt>평가 버전</dt>
              <dd data-testid="evaluation-version">{candidateSet.evaluationVersion}</dd>
              <dt>시도</dt>
              <dd data-testid="candidate-attempts">
                {candidateSet.search.attemptsMade} / {candidateSet.bounds.maxAttempts}
              </dd>
              <dt>중복으로 제외한 후보</dt>
              <dd data-testid="candidate-duplicates">{candidateSet.search.duplicatesDropped}</dd>
              <dt>탐색 범위 상한</dt>
              <dd>{metres(candidateSet.bounds.maxSearchRadiusMeters)}</dd>
              <dt>탐색 시간 상한</dt>
              <dd>{Math.round(candidateSet.bounds.searchBudgetMilliseconds / 1000)}초</dd>
              <dt>탐색 종료 이유</dt>
              <dd>{candidateSet.search.stoppedBecause}</dd>
            </dl>
            <ul aria-label="시도 기록">
              {candidateSet.search.attempts.map((attempt) => (
                <li key={attempt.attemptIndex}>
                  {attempt.attemptIndex + 1}번 시도 · {attempt.candidateSeed} ·{' '}
                  {attemptOutcomes[attempt.outcome] ?? attempt.outcome}
                </li>
              ))}
            </ul>
            <ul className={styles.waypoints} aria-label="후보 목록">
              {candidateSet.candidates.map((candidate) => (
                <li key={candidate.proposalId} data-testid={`candidate-${candidate.ordinal}`}>
                  <dl className={styles.summary}>
                    <dt>경로 계산 예상 거리</dt>
                    <dd>{metres(candidate.engineDistanceMeters)}</dd>
                    <dt>목표 오차</dt>
                    <dd data-testid={`candidate-error-${candidate.ordinal}`}>
                      {candidate.evaluation.distanceErrorMeters >= 0 ? '+' : '−'}
                      {metres(Math.abs(candidate.evaluation.distanceErrorMeters))} (
                      {(candidate.evaluation.distanceErrorRatio * 100).toFixed(1)}%)
                    </dd>
                    <dt>연결성</dt>
                    <dd>
                      {candidate.evaluation.loop.closed
                        ? '출발점으로 돌아옴'
                        : '출발점으로 돌아오지 않음'}{' '}
                      · 엔진이 지났다고 밝힌 도로 구간으로 이어짐
                    </dd>
                    <dt>반복·왕복 구간</dt>
                    <dd data-testid={`candidate-repeat-${candidate.ordinal}`}>
                      {metres(candidate.evaluation.repetition.repeatedMeters)} (
                      {(candidate.evaluation.repetition.repeatedRatio * 100).toFixed(0)}%)
                      {candidate.evaluation.repetition.outAndBack ? ' · 왕복 구간 많음' : ''}
                    </dd>
                    <dt>계단·노면·야간 통행·접근 제한</dt>
                    <dd data-testid={`candidate-knowledge-${candidate.ordinal}`}>
                      확인되지 않음 (자료 없음)
                    </dd>
                    <dt>경사 출처</dt>
                    <dd data-testid={`candidate-gradient-${candidate.ordinal}`}>없음</dd>
                    <dt>후보 seed</dt>
                    <dd>{candidate.candidateSeed}</dd>
                    <dt>사용한 지도 데이터</dt>
                    <dd>{candidate.graphBuildId}</dd>
                    <dt>계산 시각</dt>
                    <dd>{candidate.computedAt}</dd>
                  </dl>
                  {candidate.warnings.length > 0 ? (
                    <ul aria-label={`${candidate.ordinal + 1}번 후보 경고`}>
                      {candidate.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  <Button
                    variant="secondary"
                    aria-pressed={picked?.proposalId === candidate.proposalId}
                    onClick={() => store.getState().pickCandidate(candidate.proposalId)}
                  >
                    {candidate.ordinal + 1}번 후보 보기
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {picked ? (
          <div role="group" aria-label="고른 후보 검토" data-testid="candidate-review">
            <p className={styles.note}>
              고른 후보는 아직 저장되지도 승인되지도 않았습니다. 계단·노면·야간 통행 정보가 없으므로
              충족으로 판정하지 않습니다.
            </p>
            {candidateGraphChanged ? (
              <p role="alert" data-testid="candidate-graph-changed">
                이 코스는 다른 지도 데이터({headGraph})로 계산되어 있었습니다. 저장하면 새 지도
                데이터({picked.graphBuildId})로 만든 후보로 바뀝니다.
              </p>
            ) : null}
            <label>
              <input
                type="checkbox"
                checked={candidateReviewed}
                onChange={(event) =>
                  setReviewedCandidate(
                    event.target.checked
                      ? { proposalId: picked.proposalId, draftRevision: state.revision }
                      : null,
                  )
                }
              />
              위 후보 내용을 검토했습니다.
            </label>
            <Button
              onClick={() =>
                void (
                  candidateSet &&
                  candidateReviewed &&
                  save({
                    kind: 'pick-candidate',
                    candidateSetId: candidateSet.candidateSetId,
                    proposalId: picked.proposalId,
                    draftRevision: candidateSet.draftRevision,
                    acknowledgedGraph: { previous: headGraph, next: picked.graphBuildId },
                  })
                )
              }
              disabled={!candidateReviewed || saving}
            >
              고른 후보 저장
            </Button>
          </div>
        ) : null}
      </section>

      {route ? (
        <div className={styles.review} role="group" aria-label="계산된 경로 검토">
          <h4>계산된 경로 (제안)</h4>
          <RouteReviewSummary route={route} />
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
          <Button
            onClick={() =>
              void (
                route &&
                reviewed &&
                save({
                  kind: 'reroute',
                  proposalId: route.proposalId,
                  draftRevision: route.draftRevision,
                  acknowledgedGraph: { previous: headGraph, next: route.graphBuildId },
                })
              )
            }
            disabled={!reviewed || saving}
          >
            검토한 경로 저장
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * What the owner reads before saving a computed route: the engine's own estimates, how far
 * the waypoints were moved onto the network, which graph and engine answered, when, and
 * with which warnings. Shared by the editor of a stored course and the new-course screen
 * (M2-01r), so the two reviews cannot say different things about the same kind of answer.
 */
export function RouteReviewSummary({ route }: { readonly route: ComputedDraftRoute }) {
  return (
    <>
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
    </>
  );
}
