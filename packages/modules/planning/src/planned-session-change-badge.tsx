import type { PlannedSessionChange } from './planned-session-change';
import styles from './planned-session-change-badge.module.css';

const labels = {
  saved: '저장본',
  unchanged: '저장본과 동일',
  changed: '수정된 초안',
  added: '새 세션',
} satisfies Record<PlannedSessionChange, string>;

export function PlannedSessionChangeBadge({ change }: { change: PlannedSessionChange }) {
  return (
    <span className={styles.badge} data-session-change={change}>
      {labels[change]}
    </span>
  );
}
