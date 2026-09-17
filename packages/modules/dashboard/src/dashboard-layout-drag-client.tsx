import { useEffect, useRef } from 'react';
import { DragDropProvider, useDragDropManager, useDraggable, useDroppable } from '@dnd-kit/react';
import type { DashboardLayoutDragProps, DashboardDragItem } from './dashboard-layout-drag';
export function DashboardLayoutDragClient({ items, container, onMove }: DashboardLayoutDragProps) {
  const started = useRef<{
    viewportWidth: number;
    viewportHeight: number;
    width: number;
    height: number;
  } | null>(null);
  const geometry = () => {
    const bounds = container.current?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
    };
  };
  return (
    <DragDropProvider
      onDragStart={() => {
        if (!started.current) started.current = geometry();
      }}
      onDragEnd={(event) => {
        const initial = started.current;
        started.current = null;
        const current = geometry();
        if (
          !initial ||
          initial.viewportWidth !== current.viewportWidth ||
          initial.viewportHeight !== current.viewportHeight ||
          initial.width !== current.width ||
          initial.height !== current.height
        )
          return;
        const source = event.operation.source;
        const target = event.operation.target;
        if (event.canceled || !source || !target) return;
        const sourceIndex = items.findIndex((item) => item.id === source.id);
        const targetIndex = items.findIndex((item) => item.id === target.id);
        const item = items[sourceIndex];
        if (item && targetIndex >= 0 && sourceIndex !== targetIndex) onMove(item.id, targetIndex);
      }}
    >
      <Geometry container={container} />
      {items.map((item) => (
        <Register key={item.id} item={item} />
      ))}
    </DragDropProvider>
  );
}
function Register({ item }: { item: DashboardDragItem }) {
  // Plain registration keeps heterogeneous widget DOM order unchanged until a valid drop.
  const { isDragSource } = useDraggable({
    id: item.id,
    element: item.element,
    handle: item.handle,
  });
  const { isDropTarget } = useDroppable({ id: item.id, element: item.element });
  useEffect(() => {
    const element = item.element.current;
    if (!element) return;
    element.setAttribute('data-dashboard-dragging', String(isDragSource));
    element.setAttribute('data-dashboard-drop-target', String(isDropTarget && !isDragSource));
    return () => {
      element.removeAttribute('data-dashboard-dragging');
      element.removeAttribute('data-dashboard-drop-target');
    };
  }, [isDragSource, isDropTarget, item.element]);
  return null;
}
function Geometry({ container }: Pick<DashboardLayoutDragProps, 'container'>) {
  const manager = useDragDropManager();
  useEffect(() => {
    if (!manager) return;
    const cancel = () => {
      if (manager.dragOperation.status.dragging) manager.actions.stop({ canceled: true });
    };
    let bounds: { width: number; height: number } | null = null;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (!next || !Number.isFinite(next.width) || !Number.isFinite(next.height)) return;
      if (bounds && (bounds.width !== next.width || bounds.height !== next.height)) cancel();
      bounds = { width: next.width, height: next.height };
    });
    if (container.current) observer.observe(container.current);
    let size = { width: window.innerWidth, height: window.innerHeight };
    const resize = () => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      if (next.width !== size.width || next.height !== size.height) cancel();
      size = next;
    };
    window.addEventListener('resize', resize);
    return () => {
      cancel();
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [manager, container]);
  return null;
}
