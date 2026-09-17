import {
  createRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import { Button } from '@workout/ui-foundation/button';
import { responsiveSpec } from '@workout/ui-foundation/responsive';
import { DashboardLayoutDrag, type DashboardDragItem } from './dashboard-layout-drag';
import {
  type DashboardLayoutStore,
  type DashboardLayoutMode,
  type DashboardLayoutPreference,
  type DashboardWidgetId,
  type DashboardWidgetSize,
} from './dashboard-layout';
import styles from './dashboard-layout.module.css';
const labels: Record<DashboardWidgetId, string> = {
  plan: '현재 계획',
  'check-in': '최신 체크인',
  'period-summary': '기간 요약',
  'daily-distance': '일별 거리',
};
export interface DashboardLayoutEditorProps {
  store: DashboardLayoutStore;
  widgets: Record<DashboardWidgetId, ReactNode>;
  mode: DashboardLayoutMode;
  onApply?(preference: DashboardLayoutPreference): void;
}
const itemRefs = (id: DashboardWidgetId): DashboardDragItem => ({
  id,
  element: createRef<HTMLElement>(),
  handle: createRef<HTMLButtonElement>(),
});
export function DashboardLayoutEditor({
  store,
  widgets,
  mode,
  onApply,
}: DashboardLayoutEditorProps) {
  const committed = useStore(store, (value) => value.committed);
  const draft = useStore(store, (value) => value.draft);
  const actions = useStore(store, (value) => value.actions);
  const storageStatus = useStore(store, (value) => value.storageStatus);
  const preference = draft ?? committed;
  const editing = draft !== null;
  const container = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ element: HTMLElement; id: DashboardWidgetId } | null>(null);
  const finishFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (finishFrame.current !== null) cancelAnimationFrame(finishFrame.current);
    },
    [],
  );
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const [refs] = useState(() => ({
    plan: itemRefs('plan'),
    'check-in': itemRefs('check-in'),
    'period-summary': itemRefs('period-summary'),
    'daily-distance': itemRefs('daily-distance'),
  }));
  const order = preference.order.join(',');
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, []);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending?.element.isConnected) {
      const disabled = pending.element instanceof HTMLButtonElement && pending.element.disabled;
      if (
        document.activeElement === document.body ||
        (disabled && document.activeElement === pending.element)
      ) {
        const target = disabled
          ? refs[pending.id].element.current?.querySelector('select')
          : pending.element;
        target?.focus();
      }
    }
    pendingFocus.current = null;
  }, [order, refs]);
  function move(id: DashboardWidgetId, index: number) {
    pendingFocus.current =
      document.activeElement instanceof HTMLElement &&
      container.current?.contains(document.activeElement)
        ? { element: document.activeElement, id }
        : null;
    actions.move(id, index);
  }
  function finish(apply: boolean) {
    if (apply) {
      actions.apply();
      onApply?.(store.getState().committed);
    } else actions.cancel();
    if (finishFrame.current !== null) cancelAnimationFrame(finishFrame.current);
    finishFrame.current = requestAnimationFrame(() => {
      finishFrame.current = null;
      launcher.current?.focus();
    });
  }
  const twoColumns =
    mode !== 'mobile' && width >= responsiveSpec.componentContainers.workspaceMinPx;
  return (
    <section className={styles.editor} aria-label="대시보드 배치">
      <div className={styles.toolbar}>
        <Button ref={launcher} variant="secondary" disabled={editing} onClick={actions.beginEdit}>
          배치 편집
        </Button>
        {editing ? (
          <>
            <Button onClick={() => finish(true)}>배치 적용</Button>
            <Button variant="secondary" onClick={() => finish(false)}>
              배치 취소
            </Button>
            <Button variant="secondary" onClick={actions.resetDraft}>
              기본 배치로 되돌리기
            </Button>
          </>
        ) : null}
      </div>
      {editing ? (
        <p>
          배치 편집 중입니다. 이동 손잡이 또는 위·아래 버튼과 위치 선택을 사용하세요. 변경은 배치
          적용 전까지 임시이며 실제 계획·활동을 바꾸지 않습니다.
        </p>
      ) : (
        <p>일반 보기에서는 위젯을 끌거나 크기를 조절하지 않습니다.</p>
      )}
      {editing && !twoColumns ? (
        <p>현재 화면에서는 한 열로 표시합니다. 넓게 설정한 요청은 보존합니다.</p>
      ) : null}
      {storageStatus === 'unavailable' ? (
        <p role="status">이 브라우저에 배치를 저장하지 못했습니다. 현재 화면에서만 유지됩니다.</p>
      ) : storageStatus === 'invalid' ? (
        <p role="status">저장된 배치 형식이 올바르지 않아 기본 배치를 사용합니다.</p>
      ) : storageStatus === 'saved' ? (
        <p role="status">배치 설정을 이 브라우저에 저장했습니다.</p>
      ) : null}
      {editing ? (
        <DashboardLayoutDrag
          items={preference.order.map((id) => refs[id])}
          container={container}
          onMove={move}
          onReady={setReady}
        />
      ) : null}
      <div ref={container} className={styles.grid} data-columns={twoColumns ? 'two' : 'one'}>
        {preference.order.map((id, index) => (
          <section
            key={id}
            ref={refs[id].element}
            className={styles.widget}
            data-dashboard-widget={id}
            data-size={preference.sizes[mode][id]}
            data-editing={editing}
            aria-label={`${labels[id]} 위젯`}
          >
            {editing ? (
              <div className={styles.controls}>
                <button
                  type="button"
                  ref={refs[id].handle}
                  className={styles.handle}
                  disabled={!ready}
                  aria-label={`${labels[id]} 이동 손잡이`}
                >
                  이동
                </button>
                <Button
                  variant="secondary"
                  disabled={index === 0}
                  aria-label={`${labels[id]} 위로`}
                  onClick={() => move(id, index - 1)}
                >
                  위로
                </Button>
                <Button
                  variant="secondary"
                  disabled={index === preference.order.length - 1}
                  aria-label={`${labels[id]} 아래로`}
                  onClick={() => move(id, index + 1)}
                >
                  아래로
                </Button>
                <label>
                  {labels[id]} 위치
                  <select value={index} onChange={(event) => move(id, Number(event.target.value))}>
                    {preference.order.map((_, position) => (
                      <option key={position} value={position}>
                        {position + 1}번째
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {labels[id]} 너비
                  <select
                    value={preference.sizes[mode][id]}
                    onChange={(event) =>
                      actions.setSize(mode, id, event.target.value === 'wide' ? 'wide' : 'standard')
                    }
                  >
                    <option value="standard">기본 너비</option>
                    <option value="wide">넓게</option>
                  </select>
                </label>
                <ResizeGrip
                  mode={mode}
                  label={labels[id]}
                  size={preference.sizes[mode][id]}
                  container={refs[id].element}
                  onSize={(size) => actions.setSize(mode, id, size)}
                />
              </div>
            ) : null}
            <div>{widgets[id]}</div>
          </section>
        ))}
      </div>
    </section>
  );
}
function ResizeGrip({
  mode,
  label,
  size,
  container,
  onSize,
}: {
  mode: DashboardLayoutMode;
  label: string;
  size: DashboardWidgetSize;
  container: RefObject<HTMLElement | null>;
  onSize(size: DashboardWidgetSize): void;
}) {
  const active = useRef<{
    x: number;
    geometry: { viewportWidth: number; viewportHeight: number; width: number; height: number };
    mode: DashboardLayoutMode;
    initial: DashboardWidgetSize;
    next: DashboardWidgetSize;
  } | null>(null);
  const [preview, setPreview] = useState<{
    mode: DashboardLayoutMode;
    size: DashboardWidgetSize;
  } | null>(null);
  const geometry = () => {
    const rect = container.current?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    };
  };
  function cancel() {
    active.current = null;
    setPreview(null);
  }
  useEffect(() => {
    const cancelGeometry = () => {
      active.current = null;
      setPreview(null);
    };
    let previous: { width: number; height: number } | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect;
            if (!next) return;
            if (previous && (previous.width !== next.width || previous.height !== next.height))
              cancelGeometry();
            previous = { width: next.width, height: next.height };
          });
    if (container.current) observer?.observe(container.current);
    window.addEventListener('resize', cancelGeometry);
    return () => {
      active.current = null;
      observer?.disconnect();
      window.removeEventListener('resize', cancelGeometry);
    };
  }, [container, mode]);
  return (
    <>
      <button
        type="button"
        className={styles.handle}
        aria-label={`${label} 너비 조절 손잡이`}
        onPointerDown={(event) => {
          if (active.current) return;
          active.current = {
            x: event.clientX,
            initial: size,
            next: size,
            mode,
            geometry: geometry(),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const gesture = active.current;
          if (!gesture) return;
          const dx = event.clientX - gesture.x;
          gesture.next =
            dx >= responsiveSpec.interaction.primaryTargetProductGoalPx
              ? 'wide'
              : dx <= -responsiveSpec.interaction.primaryTargetProductGoalPx
                ? 'standard'
                : gesture.initial;
          setPreview({ mode, size: gesture.next });
        }}
        onPointerUp={() => {
          const gesture = active.current;
          active.current = null;
          setPreview(null);
          const current = geometry();
          if (
            gesture &&
            gesture.mode === mode &&
            gesture.geometry.viewportWidth === current.viewportWidth &&
            gesture.geometry.viewportHeight === current.viewportHeight &&
            gesture.geometry.width === current.width &&
            gesture.geometry.height === current.height &&
            gesture.next !== gesture.initial
          )
            onSize(gesture.next);
        }}
        onPointerCancel={cancel}
        onBlur={cancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          } else if (!event.repeat && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            onSize(event.key === 'ArrowRight' ? 'wide' : 'standard');
          }
        }}
      >
        너비 조절
      </button>
      <span>
        {preview && preview.mode === mode
          ? `임시 너비: ${preview.size === 'wide' ? '넓게' : '기본'}`
          : '좌우로 끌거나 방향키로 너비 선택 · Escape 취소'}
      </span>
    </>
  );
}
