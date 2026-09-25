'use client';

import type { CourseCandidateEvaluation } from '@workout/contracts/courses';
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
 * tick — and each says WHY it is unknown, truthfully:
 *
 * - access restrictions and surface ARE encoded in our graph (`road_access`, `foot_access`,
 *   `surface` in the serving profile's `graph.encoded_values`), but the routing adapter asks
 *   the engine only for `details=road_class`, so we never receive them. "엔진에 요청하지 않음".
 * - stairs would be the `steps` road class, which the adapter does request — to check the
 *   answer's edges — and then does not keep. "엔진 도로 등급을 검증에만 쓰고 보관하지 않음".
 * - night access (lighting, opening hours) is in neither the graph nor any dataset of ours.
 * - gradient: the graph is built without elevation and the engine is asked with
 *   `elevation=false`. Elevation samples, where we have them, come from our own sparse
 *   dataset and are shown by the elevation check, not here.
 *
 * Filling any of these in means requesting engine details through the adapter and the
 * contract; that is a follow-up node, not a display change.
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
type KnowledgeKey = keyof Evaluation['knowledge'];

/** Connectivity: what the engine attested, and what that does not mean. */
export function connectivityText(value: Evaluation['connectivity']): string {
  switch (value) {
    case 'engine-attested-edges':
      return '엔진이 지났다고 밝힌 도로 구간으로 이어짐 · 지금 통행할 수 있다는 보장은 아님';
  }
}

/** Why each unknown is unknown. See the module comment; every reason is a checked fact. */
const unknownBecause: Record<KnowledgeKey, string> = {
  accessRestrictions: '엔진에 요청하지 않음',
  surface: '엔진에 요청하지 않음',
  stairs: '엔진 도로 등급을 검증에만 쓰고 보관하지 않음',
  nightAccess: '자료 없음',
  gradient: '엔진 경사 자료 없음',
};

/**
 * One knowledge value from the evaluation contract. The contract types each as the literal
 * `'unknown'`, so this can only ever say that; the switch is there so a contract change that
 * adds a known value is a compile error here rather than a silent "충족".
 */
export function knowledgeText<Key extends KnowledgeKey>(
  key: Key,
  value: Evaluation['knowledge'][Key],
): string {
  switch (value) {
    case 'unknown':
      return `${unknownFact} (${unknownBecause[key]})`;
  }
}

/** Stairs, surface and night access, each with its own reason. */
export function walkingConditionsText(knowledge: Evaluation['knowledge']): string {
  return [
    `계단 ${knowledgeText('stairs', knowledge.stairs)}`,
    `노면 ${knowledgeText('surface', knowledge.surface)}`,
    `야간 통행 ${knowledgeText('nightAccess', knowledge.nightAccess)}`,
  ].join(' · ');
}

export function gradientSourceText(value: Evaluation['gradientSource']): string {
  switch (value) {
    case 'none':
      return `${unknownFact} (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)`;
  }
}

/**
 * What a routed proposal is known to be, in the evaluation contract's own terms. A computed
 * route passed the same adapter guard every candidate leg passes (so its connectivity is the
 * same attested one), and the adapter requested nothing else about its edges. Typed through
 * the contract so that when the contract learns a known value, this has to say where it came
 * from instead of the review keeping a hard-coded "unknown".
 */
export const routedProposalFacts: Pick<
  Evaluation,
  'connectivity' | 'knowledge' | 'gradientSource'
> = {
  connectivity: 'engine-attested-edges',
  knowledge: {
    stairs: 'unknown',
    surface: 'unknown',
    nightAccess: 'unknown',
    accessRestrictions: 'unknown',
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
  readonly facts?: typeof routedProposalFacts;
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
        <dd data-testid="route-access">
          {knowledgeText('accessRestrictions', facts.knowledge.accessRestrictions)}
        </dd>
        <dt>계단·노면·야간 통행</dt>
        <dd data-testid="route-conditions">{walkingConditionsText(facts.knowledge)}</dd>
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
    </section>
  );
}
