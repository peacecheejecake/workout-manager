import type { ActivityContext } from '@workout/contracts/activity-context';

/**
 * The S09 impact tab keeps three kinds of statement apart (01 §7.2, V2-F14): observed or
 * calculated values, classifications or estimates, and consultation. This file derives the
 * last two from the activity context the tab already reads. It invents no classifier: the
 * only classification it has a source for is the one the user wrote on the linked planned
 * session, and a record-based estimate of purpose or intensity has no source at all.
 */

export const consultationRuleVersion = 'activity-impact-consultation-v1';

export type ImpactClassification =
  | {
      status: 'classified';
      key: 'purpose' | 'intensity';
      label: string;
      value: string;
      source: string;
      version: string;
      uncertainty: string;
    }
  | {
      status: 'none';
      key: 'purpose' | 'intensity' | 'record-estimate';
      label: string;
      reason: string;
    };

const planClassificationUncertainty =
  '계획을 세울 때 사용자가 붙인 분류입니다. 이 활동을 실제로 그렇게 수행했는지는 확인하지 않았습니다.';

export function impactClassifications(context: ActivityContext): ImpactClassification[] {
  const plan = context.planContext;
  const recordEstimate: ImpactClassification = {
    status: 'none',
    key: 'record-estimate',
    label: '기록 기반 목적·강도 추정',
    reason:
      '이 활동의 기록에서 목적이나 강도를 추정하는 검증된 분류 출처가 없습니다. 추정값을 만들지 않습니다.',
  };
  if (plan.status !== 'linked') {
    const reason =
      plan.status === 'unlinked'
        ? '연결한 계획이 없어 분류 출처가 없습니다. 날짜나 종목으로 분류를 추정하지 않습니다.'
        : plan.reason === 'unsupported_calendar'
          ? '기록 또는 연결 계획에 지원 범위를 벗어난 날짜가 있어 연결 계획의 분류를 읽지 않습니다. 날짜를 바꿔 분류하지 않습니다.'
          : '저장된 계획 연결을 확인할 수 없어 분류 출처가 없습니다.';
    return [
      { status: 'none', key: 'purpose', label: '목적 분류', reason },
      { status: 'none', key: 'intensity', label: '강도 분류', reason },
      recordEstimate,
    ];
  }
  const source = `연결 계획 세션 "${plan.session.title}" (사용자가 작성한 계획)`;
  const version = `계획 버전 ${plan.planVersion.version} · ${plan.planVersion.id}`;
  const purpose = plan.session.purpose.trim();
  const intensity = plan.session.intensityLabel ?? null;
  return [
    purpose
      ? {
          status: 'classified',
          key: 'purpose',
          label: '목적 분류',
          value: purpose,
          source,
          version,
          uncertainty: planClassificationUncertainty,
        }
      : {
          status: 'none',
          key: 'purpose',
          label: '목적 분류',
          reason: '연결 계획 세션에 목적이 적혀 있지 않습니다.',
        },
    intensity
      ? {
          status: 'classified',
          key: 'intensity',
          label: '강도 분류',
          value: `강도 라벨 ${intensity}`,
          source,
          version,
          uncertainty: planClassificationUncertainty,
        }
      : {
          status: 'none',
          key: 'intensity',
          label: '강도 분류',
          reason: '연결 계획 세션에 강도 라벨이 없습니다.',
        },
    recordEstimate,
  ];
}

/**
 * Items to look at when the future plan is reviewed. Fixed rules over the observed values
 * only; nothing here is a prediction, a score or a causal claim, and nothing here changes
 * the plan.
 */
export function consultationItems(context: ActivityContext): string[] {
  const plan = context.planContext;
  if (plan.status === 'unlinked')
    return [
      '계획 연결이 없어 계획 대비 검토 항목을 만들지 않습니다. 필요하면 이 활동을 계획 세션에 연결하세요.',
    ];
  if (plan.status === 'unavailable')
    return [
      plan.reason === 'unsupported_calendar'
        ? '기록 또는 연결 계획에 지원 범위를 벗어난 날짜가 있어 계획과 비교하지 않았고 검토 항목을 만들지 않습니다.'
        : '저장된 계획 연결을 확인할 수 없어 검토 항목을 만들지 않습니다.',
    ];
  const items: string[] = [];
  const distance = plan.distanceComparison;
  if (distance.status === 'range_available' && distance.rangePosition !== 'within')
    items.push(
      `실제 거리가 계획 거리 ${distance.rangePosition === 'below' ? '범위에 못 미쳤습니다' : '범위를 초과했습니다'}. 다음 세션의 거리 목표를 검토할 때 참고하세요.`,
    );
  else if (distance.status === 'available' && distance.delta !== null && distance.delta !== 0)
    items.push(
      `실제 거리가 계획보다 ${Math.abs(distance.delta)}m ${distance.delta > 0 ? '길었습니다' : '짧았습니다'}. 다음 세션의 거리 목표를 검토할 때 참고하세요.`,
    );
  else if (distance.status === 'missing_actual' || distance.status === 'range_missing_actual')
    items.push('실제 거리가 미확인입니다. 기록을 확인한 뒤 거리 목표를 검토하세요.');
  else if (distance.status === 'missing_plan' || distance.status === 'missing_both')
    items.push('계획 세션에 거리 목표가 없어 거리를 비교하지 않았습니다.');
  items.push(
    '계획 시간의 측정 정의(타이머·경과·이동)가 없어 시간을 비교하지 않았습니다. 계획에 측정 정의를 정할지 검토하세요.',
  );
  const rpe = context.activity.userReport?.sessionRpe ?? null;
  if (rpe === null)
    items.push('RPE를 보고하지 않았습니다. 다음 세션 강도를 검토하려면 보고가 필요합니다.');
  else if (plan.session.targetRpe !== null && plan.session.targetRpe !== rpe)
    items.push(
      `보고한 RPE는 ${rpe}, 계획 목표 RPE는 ${plan.session.targetRpe}로 서로 다릅니다. 다음 세션 강도를 검토할 때 참고하세요.`,
    );
  if (plan.blockMembership !== 'included')
    items.push(
      '이 활동은 연결 Block의 부분 합계에 들어가지 않았습니다. 계획 연결이 맞는지 검토하세요.',
    );
  if (plan.currentPlanVersionId !== plan.planVersion.id)
    items.push(
      '과거 계획 버전에 연결되어 있습니다. 앞으로의 계획은 현재 버전을 기준으로 검토하세요.',
    );
  return items;
}
