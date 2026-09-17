import {
  Component,
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { planDraftSchema, type PlanDraft, type PeriodDraft } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { buildPeriodNavigation } from './period-navigation';
import type { PeriodOrbitProps } from './period-orbit';
import styles from './period-explorer.module.css';
export interface PeriodExplorerProps {
  plan: PlanDraft | undefined;
  selectedId: string | null;
  unavailableReason?: string;
  onSelect(id: string | null): void;
  onCalendar(period: PeriodDraft): void;
}
const loadOrbit = () =>
  import('./period-orbit').then((module) => ({ default: module.PeriodOrbit }));
class OrbitBoundary extends Component<
  { children: ReactNode; onRetry(): void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <div role="alert">
        <p>원형 보기를 불러오지 못했습니다. 아래 기간 목록으로 계속 탐색할 수 있습니다.</p>
        <Button variant="secondary" onClick={this.props.onRetry}>
          기간 원형 다시 불러오기
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function LazyOrbit(props: PeriodOrbitProps) {
  const [attempt, setAttempt] = useState(() => ({ key: 0, View: lazy(loadOrbit) }));
  return (
    <OrbitBoundary
      key={attempt.key}
      onRetry={() => setAttempt((current) => ({ key: current.key + 1, View: lazy(loadOrbit) }))}
    >
      <Suspense fallback={<p role="status">원형 보기 준비 중 · 목록은 바로 사용할 수 있습니다.</p>}>
        <attempt.View {...props} />
      </Suspense>
    </OrbitBoundary>
  );
}
function Summary({ period }: { period: PeriodDraft }) {
  return (
    <>
      <p>
        {period.startDate}–{period.endDateExclusive} (종료일 미포함) · {period.timezone}
      </p>
      <p>
        {period.intent || '목적 미정'}
        {period.isPartial ? ' · 부분 기간' : ''}
      </p>
    </>
  );
}
export function PeriodExplorer({
  plan,
  selectedId,
  unavailableReason,
  onSelect,
  onCalendar,
}: PeriodExplorerProps) {
  const [previewState, setPreviewState] = useState<{
    selection: string | null;
    focus: string | null;
    hover: string | null;
  }>({ selection: selectedId, focus: null, hover: null });
  if (previewState.selection !== selectedId)
    setPreviewState({ selection: selectedId, focus: null, hover: null });
  const preview =
    previewState.selection === selectedId ? (previewState.focus ?? previewState.hover) : null;
  const setPreview = (id: string | null, source: 'focus' | 'hover') =>
    setPreviewState((current) => ({
      selection: selectedId,
      focus: current.selection === selectedId ? current.focus : null,
      hover: current.selection === selectedId ? current.hover : null,
      [source]: id,
    }));
  const heading = useRef<HTMLHeadingElement>(null);
  const previousSelection = useRef(selectedId);
  useLayoutEffect(() => {
    if (previousSelection.current !== selectedId) heading.current?.focus();
    previousSelection.current = selectedId;
  }, [selectedId]);
  if (!plan)
    return (
      <section className={styles.explorer} aria-label="기간 탐색">
        <h2>Season · Wave · Phase · Block</h2>
        <p>{unavailableReason ?? '조회할 계획이 없습니다.'}</p>
      </section>
    );
  if (plan.periods.length === 0 && plan.sessions.length === 0)
    return (
      <section className={styles.explorer} aria-label="기간 탐색">
        <h2>Season · Wave · Phase · Block</h2>
        <p>등록된 기간이 없습니다. 기간을 먼저 작성하세요.</p>
      </section>
    );
  if (!planDraftSchema.safeParse(plan).success)
    return (
      <section className={styles.explorer} aria-label="기간 탐색">
        <h2>Season · Wave · Phase · Block</h2>
        <p role="alert">
          초안의 기간 구조가 유효하지 않아 원형 탐색을 표시할 수 없습니다. 입력 내용을 수정하세요.
        </p>
      </section>
    );
  const model = buildPeriodNavigation(plan, selectedId);
  if (model.status === 'missing')
    return (
      <section className={styles.explorer} aria-label="기간 탐색">
        <h2>Season · Wave · Phase · Block</h2>
        <p role="alert">URL이 가리키는 기간을 찾을 수 없습니다. 전체 계획에서 다시 선택하세요.</p>
        <Button onClick={() => onSelect(null)}>전체 계획 보기</Button>
      </section>
    );
  const current = model.current;
  const shownPreview = preview && model.children.find((period) => period.id === preview);
  return (
    <section className={styles.explorer} aria-label="기간 탐색">
      <h2>Season · Wave · Phase · Block</h2>
      <nav aria-label="기간 경로">
        <ol className={styles.navigation}>
          <li>
            <Button
              variant="secondary"
              aria-current={current ? undefined : 'page'}
              onClick={() => onSelect(null)}
            >
              전체 계획
            </Button>
          </li>
          {model.ancestors.map((period) => (
            <li key={period.id}>
              <Button variant="secondary" onClick={() => onSelect(period.id)}>
                {period.title}
              </Button>
            </li>
          ))}
          {current ? <li aria-current="page">{current.title}</li> : null}
        </ol>
      </nav>
      <div className={styles.summary} aria-label="현재 선택한 기간" role="region">
        <h3 ref={heading} tabIndex={-1}>
          {current?.title ?? plan.title}
        </h3>
        {current ? (
          <Summary period={current} />
        ) : (
          <p>
            {model.startDate}–{model.endDateExclusive} (종료일 미포함) · {plan.timezone}
          </p>
        )}
        {current ? (
          <>
            <Button variant="secondary" onClick={() => onSelect(current.parentId)}>
              상위 기간으로 돌아가기
            </Button>
            <Button
              variant="secondary"
              disabled={model.days > 366}
              onClick={() => onCalendar(current)}
            >
              이 기간 달력 보기
            </Button>
            {model.days > 366 ? <p>달력 조회는 최대 366일입니다. 하위 기간을 선택하세요.</p> : null}
          </>
        ) : null}
      </div>
      <p>
        원형 각도는 날짜 길이에 비례하며 훈련량·수행률이 아닙니다. 번호는 아래 목록과 연결됩니다.
      </p>
      <div className={styles.layout}>
        <div>
          <LazyOrbit
            centerLabel={current?.title ?? plan.title}
            segments={model.segments.map((segment) => ({
              id: segment.period.id,
              label: `${segment.period.level} · ${segment.period.title}`,
              number: segment.number,
              startFraction: segment.startFraction,
              endFraction: segment.endFraction,
              days: segment.days,
            }))}
            onSelect={onSelect}
            onPreview={setPreview}
          />
          {model.children.length ? (
            <p>자식 기간 미배정: {model.unassignedDays}일</p>
          ) : (
            <p>하위 기간이 없습니다. 선택한 기간의 일별 계획을 아래에서 확인하세요.</p>
          )}
        </div>
        <div>
          <h3>동일한 기간 목록</h3>
          <ol className={styles.children}>
            {model.children.map((period, index) => (
              <li key={period.id}>
                <span>{index + 1}. </span>
                <Button
                  variant="secondary"
                  onClick={() => onSelect(period.id)}
                  onMouseEnter={() => setPreview(period.id, 'hover')}
                  onMouseLeave={() => setPreview(null, 'hover')}
                  onFocus={() => setPreview(period.id, 'focus')}
                  onBlur={() => setPreview(null, 'focus')}
                >
                  {period.level} · {period.title}
                </Button>
                <Summary period={period} />
              </li>
            ))}
          </ol>
          {shownPreview ? (
            <aside className={styles.preview} aria-label="기간 미리보기">
              <h3>미리보기: {shownPreview.title}</h3>
              <Summary period={shownPreview} />
              <p>아직 선택을 변경하지 않았습니다.</p>
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  );
}
