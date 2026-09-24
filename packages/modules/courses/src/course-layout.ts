import { useSyncExternalStore } from 'react';
import { getLayoutMode, type LayoutMode } from '@workout/ui-foundation/responsive';

function subscribeToViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}

/**
 * Layout mode from the **generated** viewport specification, never from a breakpoint copied
 * into this package and never from the user agent. The server snapshot is the narrowest
 * mode, so the first paint is the one that fits everywhere.
 *
 * Its own file because more than one screen part reads it: the course screens choose their
 * composition with it, and the waypoint list decides whether it offers to collapse (07 §4,
 * tablet: "지도+접히는 경유점 목록").
 */
export function useLayoutModeFromViewport(): LayoutMode {
  return useSyncExternalStore(
    subscribeToViewport,
    () => getLayoutMode(window.innerWidth),
    () => 'mobile' as const,
  );
}
