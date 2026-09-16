'use client';

import { useState } from 'react';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField } from '@workout/ui-foundation/text-field';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import styles from './activity-list.module.css';
import { useQuery } from '@tanstack/react-query';
import { activityListQueryOptions } from '@workout/api-client/activities';
import { useHost, useWorkspaceDraft, useWorkspaceScope } from '@workout/platform/provider';

export function ActivityList() {
  const [view, setView] = useState<'stack' | 'split'>('split');
  const host = useHost();
  const scope = useWorkspaceScope();
  const draft = useWorkspaceDraft();
  const activities = useQuery(activityListQueryOptions(scope, host.transport));
  return (
    <section className={styles.surface} aria-labelledby="activity-list-title">
      <h2 id="activity-list-title">활동</h2>
      <p>개발용 가상 활동입니다. 실제 수행 기록이나 공식 연동 결과가 아닙니다.</p>
      <div className={styles.toolbar} role="group" aria-label="활동 보기">
        <Button
          variant="secondary"
          aria-pressed={view === 'stack'}
          onClick={() => setView('stack')}
        >
          세로 보기
        </Button>
        <Button
          variant="secondary"
          aria-pressed={view === 'split'}
          onClick={() => setView('split')}
        >
          나란히 보기
        </Button>
      </div>
      <AdaptiveWorkspace requestedView={view}>
        <div>
          {activities.isPending ? <p role="status">활동을 불러오는 중입니다.</p> : null}
          {activities.isError ? (
            <div role="alert">
              <p>활동을 불러오지 못했습니다.</p>
              <Button onClick={() => void activities.refetch()}>다시 시도</Button>
            </div>
          ) : null}
          {activities.data ? (
            activities.data.items.length === 0 ? (
              <p>아직 활동이 없습니다.</p>
            ) : (
              <ul aria-label="활동 목록">
                {activities.data.items.map((activity) => (
                  <li key={activity.id}>
                    <strong>{activity.title}</strong>{' '}
                    <time dateTime={activity.startedAt}>{activity.startedAt}</time>{' '}
                    <span>
                      {activity.durationSeconds === null
                        ? '시간 미확인'
                        : `${activity.durationSeconds}초`}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
        <div>
          <TextAreaField
            id="workspace-note"
            label="작업 메모 (임시)"
            description="이 메모는 현재 작업 공간의 메모리에만 보관되며 활동을 기록하지 않습니다."
            value={draft.state.note}
            onChange={(event) => draft.actions.setNote(event.target.value)}
          />
          <Button variant="secondary" onClick={draft.actions.reset}>
            메모 초기화
          </Button>
        </div>
      </AdaptiveWorkspace>
    </section>
  );
}
