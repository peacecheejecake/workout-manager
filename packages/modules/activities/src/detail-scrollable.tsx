import { useId, useRef, type ReactNode } from 'react';
import { Button } from '@workout/ui-foundation/button';
import styles from './activity-workbench.module.css';

/**
 * A horizontally scrollable table area with its own scroll buttons, so the columns past
 * the right edge are reachable without a pointer or a trackpad (keyboard focus on a row's
 * select button does not scroll the other columns into view).
 */
export function Scrollable({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  return (
    <>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => ref.current?.scrollBy({ left: -240, behavior: 'auto' })}
        >
          {label} 왼쪽 스크롤
        </Button>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => ref.current?.scrollBy({ left: 240, behavior: 'auto' })}
        >
          {label} 오른쪽 스크롤
        </Button>
      </div>
      <div
        id={id}
        ref={ref}
        className={styles.scroll}
        role="region"
        aria-label={`${label} 스크롤 영역`}
      >
        {children}
      </div>
    </>
  );
}
