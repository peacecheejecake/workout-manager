import type { ActivityContext } from '@workout/contracts/activity-context';
import { impactClassifications, type ImpactClassification } from './impact-split';

/** A classification is shown only together with its source, version and uncertainty. */
export function ClassificationItem({ item }: { item: ImpactClassification }) {
  if (
    item.status === 'none' ||
    !item.source.trim() ||
    !item.version.trim() ||
    !item.uncertainty.trim()
  )
    return (
      <div>
        <dt>{item.label}</dt>
        <dd>
          추정 없음 —{' '}
          {item.status === 'none' ? item.reason : '출처·버전·불확실성이 없어 표시하지 않습니다.'}
        </dd>
      </div>
    );
  return (
    <div>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
      <dd>출처: {item.source}</dd>
      <dd>버전: {item.version}</dd>
      <dd>불확실성: {item.uncertainty}</dd>
    </div>
  );
}

export function ImpactClassificationSection({ context }: { context: ActivityContext }) {
  return (
    <section aria-label="분류·추정">
      <h3>분류·추정</h3>
      <p>
        출처 표시: 항목마다 출처·버전·불확실성을 함께 적습니다. 셋 중 하나라도 없으면 값을 표시하지
        않고 추정 없음으로 둡니다.
      </p>
      <dl>
        {impactClassifications(context).map((item) => (
          <ClassificationItem key={item.key} item={item} />
        ))}
      </dl>
      <p>
        이 활동이 Block 합계에서 차지하는 비율은 계산하지 않습니다. 수집 완전성이 미확인이라 분모가
        불완전하므로, 관측·계산 절의 부분 합계만 보여 줍니다.
      </p>
    </section>
  );
}
