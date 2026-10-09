import { useState } from 'react';
import { useTableViewport } from '@workout/table-kit/table-viewport';
import type { PlannedSession } from '@workout/contracts/planning';
import type { PlannedTableInteractionStore } from './planned-table-interaction';

const getRowId = (row: PlannedSession) => row.id;
function getFocusTarget(viewport: HTMLDivElement, id: string) {
  return (
    [...viewport.querySelectorAll<HTMLButtonElement>('[data-planned-session]')].find(
      (button) => button.dataset.plannedSession === id,
    ) ?? null
  );
}
export function usePlannedTableViewport(
  rows: PlannedSession[],
  mode: 'virtual' | 'all',
  store: PlannedTableInteractionStore,
) {
  const [focusedRowId, onFocusedRowChange] = useState<string | null>(null);
  return useTableViewport({
    rows,
    mode,
    getRowId,
    focusedRowId,
    onFocusedRowChange,
    getFocusTarget,
    readState: () => store.getState().state,
    onScrollLeftChange: (left) => store.getState().actions.setScrollLeft(left),
    onScrollAnchorChange: (anchor) => store.getState().actions.setScrollAnchor(anchor),
  });
}
