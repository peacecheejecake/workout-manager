import { useEffect, useRef, type ReactNode } from 'react';
import { DragDropProvider, useDragDropManager, useDraggable, useDroppable } from '@dnd-kit/react';
import { idSchema, localDateSchema } from '@workout/contracts/primitives';
import styles from './session-operations.module.css';

export function SessionDragProvider({
  children,
  onMove,
}: {
  children: ReactNode;
  onMove?: ((id: string, date: string, blockId: string) => void) | undefined;
}) {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled || !onMove) return;
        const source = event.operation.source?.data;
        const target = event.operation.target?.data;
        const session = idSchema.safeParse(source?.sessionId);
        const date = localDateSchema.safeParse(target?.date);
        const block = idSchema.safeParse(target?.blockId);
        if (session.success && date.success && block.success)
          onMove(session.data, date.data, block.data);
      }}
    >
      <GeometryGuard>
        <p>
          날짜 이동 손잡이를 끌어 날짜에 놓거나 Space로 잡고 방향키로 이동한 뒤 Space로 놓으세요.
          Escape로 취소합니다. 날짜·Block 입력과 이동 버튼으로도 같은 변경을 할 수 있습니다.
        </p>
        {children}
      </GeometryGuard>
    </DragDropProvider>
  );
}
function GeometryGuard({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const manager = useDragDropManager();
  useEffect(() => {
    if (!manager) return;
    const cancel = () => {
      if (manager.dragOperation.status.dragging) manager.actions.stop({ canceled: true });
    };
    let previous: { width: number; height: number } | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const bounds = entries[0]?.contentRect;
            if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height))
              return;
            if (previous && (previous.width !== bounds.width || previous.height !== bounds.height))
              cancel();
            previous = { width: bounds.width, height: bounds.height };
          });
    if (element.current) observer?.observe(element.current);
    let viewport = { width: window.innerWidth, height: window.innerHeight };
    const resize = () => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      if (viewport.width !== next.width || viewport.height !== next.height) cancel();
      viewport = next;
    };
    window.addEventListener('resize', resize);
    return () => {
      cancel();
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [manager]);
  return <div ref={element}>{children}</div>;
}
export function DraggableSession({
  sessionId,
  title,
  disabled,
  children,
}: {
  sessionId: string;
  title: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `planned-session:${sessionId}`,
    data: { sessionId },
    disabled,
  });
  return (
    <div ref={ref} className={styles.draggable} data-dragging={isDragSource}>
      {children}
      <button
        type="button"
        ref={handleRef}
        disabled={disabled}
        className={styles.dragHandle}
        aria-label={`${title} 날짜 이동 손잡이`}
      >
        날짜 이동
      </button>
    </div>
  );
}
export function DayDropTarget({
  date,
  blockId,
  children,
}: {
  date: string;
  blockId: string | null;
  children: ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `planned-day:${date}`,
    data: { date, blockId },
    disabled: blockId === null,
  });
  return (
    <div
      ref={ref}
      className={styles.dropTarget}
      data-over={isDropTarget}
      aria-label={`${date} 계획 이동 대상`}
    >
      {children}
    </div>
  );
}
