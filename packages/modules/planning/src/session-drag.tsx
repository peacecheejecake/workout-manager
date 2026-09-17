import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import styles from './session-operations.module.css';
import type * as ClientAdapterModule from './session-drag-client';
type ClientAdapter = typeof ClientAdapterModule;
const AdapterContext = createContext<ClientAdapter | null>(null);
export interface SessionDragProviderProps {
  children: ReactNode;
  onMove?: ((id: string, date: string, blockId: string) => void) | undefined;
}
export interface DraggableSessionProps {
  sessionId: string;
  title: string;
  disabled: boolean;
  children: ReactNode;
}
export interface DayDropTargetProps {
  date: string;
  blockId: string | null;
  children: ReactNode;
}
export function SessionDragProvider({ children, onMove }: SessionDragProviderProps) {
  const [adapter, setAdapter] = useState<ClientAdapter | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // dnd-kit initializes ResizeObserver at module evaluation, including before hook setup.
    if (typeof ResizeObserver === 'undefined') return;
    let active = true;
    void import('./session-drag-client')
      .then((loaded) => {
        if (active) setAdapter(loaded);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <AdapterContext value={adapter}>
      {adapter ? (
        <adapter.SessionDragProvider onMove={onMove}>{children}</adapter.SessionDragProvider>
      ) : (
        <>
          <p>
            {failed
              ? '이동 손잡이를 불러오지 못했습니다. '
              : '이동 손잡이를 사용할 수 없거나 준비 중입니다. '}
            날짜·Block 입력과 계획 날짜 이동 버튼을 이용하세요.
          </p>
          {children}
        </>
      )}
    </AdapterContext>
  );
}
export function DraggableSession(props: DraggableSessionProps) {
  const adapter = use(AdapterContext);
  if (adapter) return <adapter.DraggableSession {...props} />;
  return (
    <div className={styles.draggable}>
      {props.children}
      <button
        type="button"
        disabled
        className={styles.dragHandle}
        aria-label={`${props.title} 날짜 이동 손잡이`}
      >
        날짜 이동
      </button>
    </div>
  );
}
export function DayDropTarget(props: DayDropTargetProps) {
  const adapter = use(AdapterContext);
  if (adapter) return <adapter.DayDropTarget {...props} />;
  return (
    <div className={styles.dropTarget} aria-label={`${props.date} 계획 이동 대상`}>
      {props.children}
    </div>
  );
}
