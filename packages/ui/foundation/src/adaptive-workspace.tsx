import type { ComponentProps } from 'react';
import styles from './adaptive-workspace.module.css';

export type AdaptiveWorkspaceProps = ComponentProps<'div'> & { requestedView?: 'stack' | 'split' };

/** Own drafts above this frame. CSS adapts the same DOM without replacing focused controls. */
export function AdaptiveWorkspace({
  children,
  requestedView = 'split',
  className,
  ...props
}: AdaptiveWorkspaceProps) {
  return (
    <div {...props} className={[styles.container, className].filter(Boolean).join(' ')}>
      <div className={styles.layout} data-view={requestedView}>
        {children}
      </div>
    </div>
  );
}
