'use client';

import type {
  CourseCandidateEvaluation,
  CourseCandidateKnowledgeV1,
  CourseRouteKnowledge,
} from '@workout/contracts/courses';
import type { OutAndBackRefusal } from './course-draft';
import { outAndBackOverlapDefinition, type OutAndBackAnalysis } from './out-and-back';
import styles from './courses.module.css';

/**
 * What the owner reads about an out-and-back (A→B→A) proposal and next to each
 * target-distance candidate (M2-01k-j, map plan §6: "연결성·목표 오차·중복/왕복 구간·알려진
 * 접근 제한·경사 출처를 표시한다").
 *
 * Every line here is either measured from the answer or a fact we do not have. The ones we
 * do not have say "확인되지 않음" — never "없음" as if absence were a finding, and never a
 * tick — and each says WHY it is unknown, truthfully.
 *
 * STAIRS, SURFACE AND ACCESS RESTRICTIONS (M2-01ap). The routing adapter now asks the engine
 * for `road_class`, `road_access`, `foot_access` and `surface`, and the server measures them
 * over the line (evaluation version 2, and the `knowledge` of a proposal). Each line shows the
 * findings the graph records with their lengths and, separately, the length it records none
 * for, as "확인되지 않음 … (why)":
 *
 * - stairs: `road_class=steps` stretches; a road class GraphHopper does not name is unknown.
 * - surface: every named surface; a way with no surface tag is unknown.
 * - access restrictions: `road_access` values other than `yes`, and `foot_access=no`. The rest
 *   is unknown, because `yes` is also what an untagged way reads. `road_access` comes from the
 *   vehicle and general access tags, so the screen says a value is on record, not that walking
 *   is forbidden — the pedestrian profile only routes where the graph allows walking.
 *
 * A search or revision measured under evaluation version 1 keeps the reasons it was measured
 * with: the adapter did not request those details then. Night access (lighting, opening
 * hours) and gradient are in neither the graph nor any dataset of ours.
 */

export const unknownFact = '확인되지 않음';

export const outAndBackRefusals: Record<OutAndBackRefusal, string> = {
  OUT_AND_BACK_NEEDS_TWO_POINTS: '왕복 초안에는 시작점 A와 반환점 B(끝 지점)가 필요합니다.',
  OUT_AND_BACK_SAME_POINT: '반환점 B(끝 지점)가 시작점 A와 같아 왕복 초안을 만들 수 없습니다.',
  OUT_AND_BACK_LOCKED_VIA:
    '왕복 초안은 A→B→A 세 지점만 씁니다. 잠긴 경유점이 있어 만들지 않았습니다. 잠금을 풀거나 지우세요.',
  DRAFT_LIMIT_REACHED: '이 초안의 수정 한도에 도달했습니다. 저장한 뒤 다시 편집하세요.',
};

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

/** A signed error against a target, from the error and ratio as they were measured. */
export function targetErrorText(errorMeters: number, errorRatio: number): string {
  return `${errorMeters >= 0 ? '+' : '−'}${metres(Math.abs(errorMeters))} (${(errorRatio * 100).toFixed(1)}%)`;
}

type Evaluation = CourseCandidateEvaluation;
/** Knowledge as either evaluation version carries it. */
export type RouteKnowledge = CourseCandidateKnowledgeV1 | CourseRouteKnowledge;

/** Connectivity: what the engine attested, and what that does not mean. */
export function connectivityText(value: Evaluation['connectivity']): string {
  switch (value) {
    case 'engine-attested-edges':
      return '엔진이 지났다고 밝힌 도로 구간으로 이어짐 · 지금 통행할 수 있다는 보장은 아님';
  }
}

/** Why each version-1 unknown was unknown when it was measured. */
const unknownInVersion1: Record<keyof CourseCandidateKnowledgeV1, string> = {
  accessRestrictions: '엔진에 요청하지 않음',
  surface: '엔진에 요청하지 않음',
  stairs: '엔진 도로 등급을 검증에만 쓰고 보관하지 않음',
  nightAccess: '자료 없음',
  gradient: '엔진 경사 자료 없음',
};

function isVersion1(knowledge: RouteKnowledge): knowledge is CourseCandidateKnowledgeV1 {
  return typeof knowledge.stairs === 'string';
}

const notReported = `${unknownFact} (엔진이 이 경로의 값을 답하지 않음)`;

/** Surface names as GraphHopper groups them, with the OSM value kept beside the word. */
const surfaceNames: Record<string, string> = {
  paved: '포장',
  asphalt: '아스팔트',
  concrete: '콘크리트',
  paving_stones: '보도블록',
  cobblestone: '돌 포장',
  unpaved: '비포장',
  compacted: '다진 흙',
  fine_gravel: '잔자갈',
  gravel: '자갈',
  ground: '흙',
  dirt: '흙길',
  grass: '잔디',
  sand: '모래',
  wood: '나무',
  other: '기타',
};

/** What each recorded access value means, in the tag's own terms. */
const accessNames: Record<string, string> = {
  'road_access=destination': '목적지 방문만',
  'road_access=customers': '고객만',
  'road_access=delivery': '배송만',
  'road_access=forestry': '임업용',
  'road_access=agricultural': '농업용',
  'road_access=private': '사유',
  'road_access=other': '기타 제한',
  'road_access=no': '금지',
  'foot_access=no': '도보 금지',
};

type Reported<Fact> = Extract<Fact, { status: 'reported' }>;

function withUnknown(parts: string[], unknownMeters: number, because: string): string {
  if (unknownMeters > 0) parts.push(`${unknownFact} ${metres(unknownMeters)} (${because})`);
  return parts.length === 0 ? `${unknownFact} (${because})` : parts.join(' · ');
}

function reportedStairs(fact: Reported<CourseRouteKnowledge['stairs']>): string {
  const steps = fact.known.find((entry) => entry.value === 'steps');
  const other = fact.known.find((entry) => entry.value === 'not_steps');
  const parts: string[] = [];
  if (steps !== undefined)
    parts.push(`계단 ${steps.sections}곳 ${metres(steps.meters)} (highway=steps)`);
  if (other !== undefined)
    parts.push(
      steps === undefined
        ? `도로 등급에 계단 없음 ${metres(other.meters)}`
        : `계단 아닌 길 ${metres(other.meters)}`,
    );
  return withUnknown(parts, fact.unknownMeters, '도로 등급 미상');
}

function reportedSurface(fact: Reported<CourseRouteKnowledge['surface']>): string {
  return withUnknown(
    fact.known.map(
      (entry) =>
        `${surfaceNames[entry.value] ?? entry.value}(${entry.value}) ${metres(entry.meters)}`,
    ),
    fact.unknownMeters,
    'graph에 노면 값 없음',
  );
}

function reportedAccess(fact: Reported<CourseRouteKnowledge['accessRestrictions']>): string {
  return withUnknown(
    fact.known.map(
      (entry) =>
        `${entry.value}(${accessNames[entry.value] ?? entry.value}) ${metres(entry.meters)} · ${entry.sections}곳`,
    ),
    fact.unknownMeters,
    'graph에 제한 값 없음 · 제한이 없다는 확인은 아님',
  );
}

/** Known access restrictions on record, and the length with none on record. */
export function accessRestrictionsText(knowledge: RouteKnowledge): string {
  if (isVersion1(knowledge)) return `${unknownFact} (${unknownInVersion1.accessRestrictions})`;
  const fact = knowledge.accessRestrictions;
  switch (fact.status) {
    case 'reported':
      return reportedAccess(fact);
    case 'not_reported':
      return notReported;
  }
}

/** Stairways by road class, and the length whose class is unknown. */
export function stairsText(knowledge: RouteKnowledge): string {
  if (isVersion1(knowledge)) return `${unknownFact} (${unknownInVersion1.stairs})`;
  const fact = knowledge.stairs;
  switch (fact.status) {
    case 'reported':
      return reportedStairs(fact);
    case 'not_reported':
      return notReported;
  }
}

/** Surfaces on record, longest first, and the length with no surface tag. */
export function surfaceText(knowledge: RouteKnowledge): string {
  if (isVersion1(knowledge)) return `${unknownFact} (${unknownInVersion1.surface})`;
  const fact = knowledge.surface;
  switch (fact.status) {
    case 'reported':
      return reportedSurface(fact);
    case 'not_reported':
      return notReported;
  }
}

/** Night access: neither version has any data for it. */
export function nightAccessText(knowledge: RouteKnowledge): string {
  switch (knowledge.nightAccess) {
    case 'unknown':
      return `${unknownFact} (${unknownInVersion1.nightAccess})`;
  }
}

export function gradientSourceText(value: Evaluation['gradientSource']): string {
  switch (value) {
    case 'none':
      return `${unknownFact} (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)`;
  }
}

/** Where the stairs, surface and access lines come from, said once next to them. */
export const routeKnowledgeNote =
  '계단·노면·접근 제한은 경로 계산에 쓴 지도 데이터(graph)에 기록된 값을 이 선 위에서 잰 것입니다. 현장을 확인한 값이 아닙니다. road_access는 차량·일반 access 태그에서 온 값이라 도보 통행 금지를 뜻하지 않을 수 있습니다(도보 경로는 graph가 도보를 허용한 길로만 계산됩니다).';

/**
 * What a routed proposal is known to be, in the evaluation contract's own terms. A computed
 * route passed the same adapter guard every candidate leg passes, so its connectivity is the
 * same attested one. Its knowledge comes from the proposal answer (M2-01ap); the default
 * below is for a route that came with none, and says the engine did not report it.
 */
export interface RouteFacts {
  readonly connectivity: Evaluation['connectivity'];
  readonly knowledge: RouteKnowledge;
  readonly gradientSource: Evaluation['gradientSource'];
}

export const routedProposalFacts: RouteFacts = {
  connectivity: 'engine-attested-edges',
  knowledge: {
    stairs: { status: 'not_reported' },
    surface: { status: 'not_reported' },
    accessRestrictions: { status: 'not_reported' },
    nightAccess: 'unknown',
    gradient: 'unknown',
  },
  gradientSource: 'none',
};

export function OutAndBackReview({
  analysis,
  engineDistanceMeters,
  targetDistanceMeters,
  droppedVias = 0,
  facts = routedProposalFacts,
}: {
  readonly analysis: OutAndBackAnalysis;
  readonly engineDistanceMeters: number;
  /** The target the owner set when asking for this draft, or `null` when none was set. */
  readonly targetDistanceMeters: number | null;
  /** Via waypoints the out-and-back left out when it was made. Undo brings them back. */
  readonly droppedVias?: number;
  readonly facts?: RouteFacts;
}) {
  const error = targetDistanceMeters === null ? null : engineDistanceMeters - targetDistanceMeters;
  return (
    <section
      className={styles.review}
      aria-label="왕복 초안 검토"
      data-testid="out-and-back-review"
    >
      <h4>왕복 초안 (A→B→A)</h4>
      {droppedVias > 0 ? (
        <p role="status" data-testid="out-and-back-dropped">
          왕복 초안은 A→B→A 세 지점만 써서 사이의 경유점 {droppedVias}개를 뺐습니다. 되돌리기로
          되살릴 수 있습니다.
        </p>
      ) : null}
      <dl className={styles.summary}>
        <dt>가는 길 선 길이 (A→B)</dt>
        <dd data-testid="out-and-back-out">{metres(analysis.outMeters)}</dd>
        <dt>오는 길 선 길이 (B→A)</dt>
        <dd data-testid="out-and-back-back">{metres(analysis.backMeters)}</dd>
        <dt>가는 길과 겹치는 오는 길</dt>
        <dd data-testid="route-overlap">
          {analysis.segments.length === 0
            ? '겹치는 구간 없음'
            : `${metres(analysis.overlapMeters)} (${(analysis.overlapRatio * 100).toFixed(0)}%) · ${analysis.segments.length}곳`}
        </dd>
        <dt>목표 거리</dt>
        <dd>{targetDistanceMeters === null ? '정하지 않음' : metres(targetDistanceMeters)}</dd>
        <dt>목표 오차</dt>
        <dd data-testid="route-target-error">
          {targetDistanceMeters === null || error === null
            ? '목표 거리를 정하지 않아 오차가 없습니다'
            : targetErrorText(error, error / targetDistanceMeters)}
        </dd>
        <dt>연결성</dt>
        <dd data-testid="route-connectivity">{connectivityText(facts.connectivity)}</dd>
        <dt>알려진 접근 제한</dt>
        <dd data-testid="route-access">{accessRestrictionsText(facts.knowledge)}</dd>
        <dt>계단</dt>
        <dd data-testid="route-stairs">{stairsText(facts.knowledge)}</dd>
        <dt>노면</dt>
        <dd data-testid="route-surface">{surfaceText(facts.knowledge)}</dd>
        <dt>야간 통행</dt>
        <dd data-testid="route-night">{nightAccessText(facts.knowledge)}</dd>
        <dt>경사 출처</dt>
        <dd data-testid="route-gradient">{gradientSourceText(facts.gradientSource)}</dd>
      </dl>
      {analysis.segments.length > 0 ? (
        <ol aria-label="겹치는 구간">
          {analysis.segments.map((segment, index) => (
            <li key={`${segment.fromMeters}:${segment.toMeters}`}>
              {index + 1}구간 · 오는 길 {metres(segment.fromMeters)}–{metres(segment.toMeters)} 지점
              · {metres(segment.meters)}
            </li>
          ))}
        </ol>
      ) : null}
      <p className={styles.note}>
        겹침은 오는 길이 가는 길에서 {outAndBackOverlapDefinition.toleranceMeters}m 안에서 같은
        방향(또는 반대 방향)으로 나란히 가는 구간을 선의 모양으로만 잰 값입니다(정의 v
        {outAndBackOverlapDefinition.version}). 같은 길을 두 번 지난다는 뜻일 뿐, 그 길을 지금 다닐
        수 있다는 뜻은 아닙니다. 지도에는 겹치는 구간을 굵은 주황색 선으로 표시합니다.
      </p>
      <p className={styles.note}>{routeKnowledgeNote}</p>
    </section>
  );
}
