'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DragDropProvider, useDragDropManager } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { Group, Panel, Separator } from 'react-resizable-panels';
import styles from './interaction-panel.module.css';

const sampleItems = [
  { id: 'sample-warmup', label: '준비 운동 예시' },
  { id: 'sample-main', label: '본 운동 예시' },
  { id: 'sample-cooldown', label: '정리 운동 예시' },
];
type Item = (typeof sampleItems)[number];

function reordered(items: Item[], from: number, to: number) {
  if (from === to || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

/** Development fixture: order and draft remain local; no plan approval or actual record writes. */
export function InteractionPanel() {
  const instructionId = useId();
  const headingId = useId();
  const draftId = useId();
  const [items, setItems] = useState(sampleItems);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId}>정렬·패널 조절 개발 실험</h2>
      <p>합성 목록과 메모입니다. 순서 변경은 계획 승인이나 수행 기록을 만들지 않습니다.</p>
      <p id={instructionId}>
        이동 손잡이를 끌거나 Space로 잡고 방향키로 이동한 뒤 Space로 놓으세요. Escape로 취소할 수
        있습니다. 위·아래 버튼도 같은 순서 변경을 제공합니다.
      </p>
      <Group
        orientation="vertical"
        className={styles.group}
        style={{ height: 'var(--interaction-panel-height)' }}
        aria-label="정렬과 초안 패널"
      >
        <Panel id="sort-preview" defaultSize="60%" minSize="25%" className={styles.panel}>
          <DragDropProvider
            onDragStart={() => setDragging(true)}
            onDragEnd={(event) => {
              setDragging(false);
              if (event.canceled || !isSortable(event.operation.source)) return;
              const { initialIndex, index } = event.operation.source;
              setItems((current) => reordered(current, initialIndex, index));
            }}
          >
            <ResizeSafeSortableList>
              {items.map((item, index) => (
                <SortableRow
                  key={item.id}
                  item={item}
                  index={index}
                  lastIndex={items.length - 1}
                  dragging={dragging}
                  instructionId={instructionId}
                  move={(direction) =>
                    setItems((current) => reordered(current, index, index + direction))
                  }
                />
              ))}
            </ResizeSafeSortableList>
          </DragDropProvider>
        </Panel>
        <Separator className={styles.separator} aria-label="정렬과 메모 패널 크기 조절" />
        <Panel id="draft-preview" defaultSize="40%" minSize="25%" className={styles.panel}>
          <label className={styles.draftLabel} htmlFor={draftId}>
            크기 조절 중 유지할 초안
          </label>
          <textarea
            id={draftId}
            className={styles.draft}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="이 화면의 메모만 작성합니다."
          />
        </Panel>
      </Group>
      <p role="status" aria-label="현재 합성 순서">
        현재 순서: {items.map((item) => item.label).join(' → ')}
      </p>
      <p>패널 경계에 포커스한 뒤 위·아래 방향키로 크기를 조절할 수 있습니다.</p>
    </section>
  );
}

/** Layout changes invalidate the current pointer geometry, never the stored draft. */
function ResizeSafeSortableList({ children }: { children: ReactNode }) {
  const list = useRef<HTMLOListElement>(null);
  const manager = useDragDropManager();
  useEffect(() => {
    const panel = list.current?.parentElement;
    if (!panel || !manager) return;
    const cancel = () => {
      if (manager.dragOperation.status.dragging) manager.actions.stop({ canceled: true });
    };
    let previousSize: { width: number; height: number } | null = null;
    const observer = new ResizeObserver((entries) => {
      const bounds = entries.find((entry) => entry.target === panel)?.contentRect;
      if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
      const changed =
        previousSize !== null &&
        (previousSize.width !== bounds.width || previousSize.height !== bounds.height);
      previousSize = { width: bounds.width, height: bounds.height };
      if (changed) cancel();
    });
    observer.observe(panel);
    let viewport = { width: window.innerWidth, height: window.innerHeight };
    const onViewportResize = () => {
      const current = { width: window.innerWidth, height: window.innerHeight };
      if (current.width !== viewport.width || current.height !== viewport.height) {
        viewport = current;
        cancel();
      }
    };
    window.addEventListener('resize', onViewportResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onViewportResize);
    };
  }, [manager]);
  return (
    <ol ref={list} className={styles.list} aria-label="합성 운동 순서">
      {children}
    </ol>
  );
}

function SortableRow({
  item,
  index,
  lastIndex,
  dragging,
  instructionId,
  move,
}: {
  item: Item;
  index: number;
  lastIndex: number;
  dragging: boolean;
  instructionId: string;
  move: (direction: -1 | 1) => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({ id: item.id, index });
  return (
    <li ref={ref} className={styles.item} data-dragging={isDragSource || undefined}>
      <span>{item.label}</span>
      <div className={styles.actions}>
        <button
          ref={handleRef}
          type="button"
          className={styles.dragHandle}
          aria-label={`${item.label} 이동 손잡이`}
          aria-describedby={instructionId}
        >
          이동
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label={`${item.label} 위로`}
          disabled={dragging || index === 0}
          onClick={() => move(-1)}
        >
          위로
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label={`${item.label} 아래로`}
          disabled={dragging || index === lastIndex}
          onClick={() => move(1)}
        >
          아래로
        </button>
      </div>
    </li>
  );
}
