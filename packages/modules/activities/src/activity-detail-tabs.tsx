import { useId, useRef, type ReactNode } from 'react';
import { Button } from '@workout/ui-foundation/button';
import type { ActivityDetailTab } from './browser-search';
import styles from './activity-detail-tabs.module.css';

const tabs = [
  ['overview', '개요'],
  ['intervals', '구간'],
  ['route', '경로'],
  ['impact', '영향'],
  ['media', '미디어'],
  ['source', '출처'],
] as const;
// The route tab is reachable whether or not a track is stored: the panel behind it is
// what distinguishes "no stored track" from "stored, but no GPS" from "failed to load".
// A tab is disabled only when the screen that hosts these tabs says why it cannot serve it
// (for example the media tab in a shell that composes no media panel, M2-01k-l).
export type UnavailableDetailTabs = Partial<Readonly<Record<ActivityDetailTab, string>>>;
export function ActivityDetailTabs({
  value,
  onChange,
  unavailable = {},
  children,
}: {
  value: ActivityDetailTab | null;
  onChange(tab: ActivityDetailTab): void;
  unavailable?: UnavailableDetailTabs;
  children: ReactNode;
}) {
  const id = useId();
  const refs = useRef(new Map<ActivityDetailTab, HTMLButtonElement>());
  const enabled = tabs.map(([tab]) => tab).filter((tab) => unavailable[tab] === undefined);
  const focusable = value !== null && enabled.includes(value) ? value : 'overview';
  const unavailableMessage = value === null ? null : (unavailable[value] ?? null);
  return (
    <div className={styles.workspace}>
      <div role="tablist" aria-label="활동 상세 보기" className={styles.tabs}>
        {tabs.map(([tab, label]) => (
          <Button
            key={tab}
            id={`${id}-${tab}`}
            variant="secondary"
            role="tab"
            ref={(node) => {
              if (node) refs.current.set(tab, node);
              else refs.current.delete(tab);
            }}
            disabled={!enabled.includes(tab)}
            aria-selected={value === tab}
            aria-controls={`${id}-panel`}
            tabIndex={focusable === tab ? 0 : -1}
            aria-describedby={unavailable[tab] === undefined ? undefined : `${id}-${tab}-reason`}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              const current = enabled.indexOf(tab);
              const next =
                event.key === 'ArrowRight'
                  ? (current + 1) % enabled.length
                  : event.key === 'ArrowLeft'
                    ? (current + enabled.length - 1) % enabled.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? enabled.length - 1
                        : null;
              const target = next === null ? undefined : enabled[next];
              if (target === undefined) return;
              event.preventDefault();
              refs.current.get(target)?.focus();
              onChange(target);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {tabs.map(([tab, label]) =>
        unavailable[tab] === undefined ? null : (
          <p key={tab} id={`${id}-${tab}-reason`}>
            {label}: {unavailable[tab]}
          </p>
        ),
      )}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={value ? `${id}-${value}` : undefined}
        aria-label={value === null ? '지원하지 않는 상세 보기' : undefined}
        tabIndex={0}
      >
        {value === null || unavailableMessage ? (
          <>
            <p role={value === null ? 'alert' : 'status'}>
              {unavailableMessage ?? '알 수 없는 활동 상세 보기입니다.'}
            </p>
            <Button
              onClick={() => {
                onChange('overview');
                refs.current.get('overview')?.focus();
              }}
            >
              개요로 이동
            </Button>
          </>
        ) : null}
        {children}
      </div>
    </div>
  );
}
