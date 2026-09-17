import { useEffect, useState, type RefObject } from 'react';
import type * as ClientModule from './dashboard-layout-drag-client';
import type { DashboardWidgetId } from './dashboard-layout';
export interface DashboardDragItem {
  id: DashboardWidgetId;
  element: RefObject<HTMLElement | null>;
  handle: RefObject<HTMLButtonElement | null>;
}
export interface DashboardLayoutDragProps {
  items: DashboardDragItem[];
  container: RefObject<HTMLDivElement | null>;
  onMove(id: DashboardWidgetId, index: number): void;
  onReady(ready: boolean): void;
}
export function DashboardLayoutDrag(props: DashboardLayoutDragProps) {
  const { onReady } = props;
  const [client, setClient] = useState<typeof ClientModule | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let active = true;
    void import('./dashboard-layout-drag-client')
      .then((loaded) => {
        if (active) {
          setClient(loaded);
          onReady(true);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      onReady(false);
    };
  }, [onReady]);
  return client ? (
    <client.DashboardLayoutDragClient {...props} />
  ) : (
    <p>
      {failed
        ? '이동 손잡이를 불러오지 못했습니다.'
        : '이동 손잡이를 사용할 수 없거나 준비 중입니다.'}{' '}
      위·아래 버튼과 위치 선택은 계속 사용할 수 있습니다.
    </p>
  );
}
