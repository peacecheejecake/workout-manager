import type { NutritionPlanVersionCompatibleV4 } from '@workout/contracts/nutrition-race-plan-v4';
import { Button } from '@workout/ui-foundation/button';
import styles from './nutrition.module.css';

type Anchor = NutritionPlanVersionCompatibleV4['items'][number]['anchor'];
export function nutritionAnchorLabel(anchor: Anchor): string {
  switch (anchor.kind) {
    case 'absolute':
      return `${anchor.date} · ${anchor.localTime ?? '시각 미지정'} · ${anchor.timezone}`;
    case 'relative':
      return `${anchor.entity} ${anchor.point} ${anchor.offsetMinutes}분 · 저장된 연결 기준 (미해결 가능)`;
    case 'disconnected':
      return '대회 연결 해제 · 시각 사용 중단 · 명시 재연결과 재승인 필요';
  }
}
/** Frozen approved source facts only. No current-event lookup, clone, repin or
 * conversion into the legacy V1 editor's write command. */
export function PlanReadonlyDetail({
  record,
  history,
  refreshing,
  refreshFailed,
  onRefresh,
}: {
  record: NutritionPlanVersionCompatibleV4;
  history: { versionId: string; version: number; approvedAt: string }[];
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}) {
  const pins = 'raceTimingPins' in record ? record.raceTimingPins : [];
  const bindings = new Map(
    'itemRaceTimingBindings' in record
      ? record.itemRaceTimingBindings.map((entry) => [entry.itemId, entry.binding])
      : [],
  );
  const pinByTuple = new Map(
    pins.map((pin) => [JSON.stringify([pin.eventId, pin.eventRevision]), pin]),
  );
  return (
    <section className={styles.card} aria-label="승인된 영양 계획 읽기 전용">
      <h2>
        {record.purpose} · 승인 버전 {record.version}
      </h2>
      <p>이 승인본은 읽기 전용입니다. 시각 변경에는 별도 검토와 승인이 필요합니다.</p>
      <p>
        {record.period.from} ~ {record.period.toInclusive} · {record.timezone}
      </p>
      <p>
        승인 {record.approvedAt} · 연결 훈련 버전 {record.linkedTrainingPlanVersionId ?? '없음'}
      </p>
      <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
        서버 최신 버전 확인
      </Button>
      {refreshFailed ? (
        <p role="alert">최신 조회에 실패했습니다. 저장된 승인본을 표시합니다.</p>
      ) : null}
      <ul className={styles.list}>
        {record.items.map((item) => {
          const binding = bindings.get(item.id);
          const pin =
            binding?.state === 'captured'
              ? pinByTuple.get(JSON.stringify([binding.eventId, binding.eventRevision]))
              : undefined;
          return (
            <li key={item.id}>
              <h3>{item.title}</h3>
              <p>{nutritionAnchorLabel(item.anchor)}</p>
              {item.anchor.kind === 'relative' && item.anchor.entity === 'race' ? (
                pin ? (
                  <p>
                    저장된 대회 revision {pin.eventRevision} · {pin.localDate} ·{' '}
                    {pin.localStartTime ?? '시작 시각 미상'} · {pin.timezone}. 시작{' '}
                    {pin.start.state === 'known' ? pin.start.instant : '미해결'} · 종료 미상. 현재
                    대회 값으로 갱신하지 않습니다.
                  </p>
                ) : (
                  <p>과거 연결 시각 미해결. 현재 시각으로 대체하지 않습니다.</p>
                )
              ) : null}
              {item.anchor.kind === 'relative' && item.anchor.entity === 'session' ? (
                <p>
                  연결된 훈련 버전의 세션 기준입니다. 현재 훈련 시각을 가져와 대체하지 않습니다.
                </p>
              ) : null}
              <ul className={styles.subList}>
                {item.foods.map((food, index) => (
                  <li key={index}>
                    {food.description} ·{' '}
                    {food.quantity === null ? '수량 미상' : `${food.quantity} ${food.unit}`} · 음식
                    원본 버전 {food.foodVersionId ?? '직접 기록'} · {food.sourceBasis}
                  </li>
                ))}
              </ul>
              <ul className={styles.subList}>
                {item.targets.map((target) => (
                  <li key={target.metric}>
                    {target.metric} 목표 {target.amount.min}–{target.amount.max}{' '}
                    {target.amount.unit} · {target.amount.basis}
                  </li>
                ))}
              </ul>
              <p>
                {item.instructions || '추가 지시 없음'} · {item.source}
              </p>
            </li>
          );
        })}
      </ul>
      <h3>승인 버전 이력</h3>
      <ul className={styles.list}>
        {history.map((entry) => (
          <li key={entry.versionId}>
            버전 {entry.version} · {entry.approvedAt} · {entry.versionId}
          </li>
        ))}
      </ul>
      <p>계획과 음식·수량은 실제 섭취 기록이 아닙니다. 실제 섭취는 별도로 보존됩니다.</p>
    </section>
  );
}
