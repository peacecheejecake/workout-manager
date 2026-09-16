'use client';

import { useQuery } from '@tanstack/react-query';
import { activityListQueryOptions } from '@workout/api-client/activities';
import { useHost, useWorkspaceDraft, useWorkspaceScope } from '@workout/platform/provider';

export function ActivityList() {
  const host = useHost();
  const scope = useWorkspaceScope();
  const draft = useWorkspaceDraft();
  const activities = useQuery(activityListQueryOptions(scope, host.transport));
  return (
    <section aria-labelledby="activity-list-title">
      <h2 id="activity-list-title">활동</h2>
      <p>개발용 가상 활동입니다. 실제 수행 기록이나 공식 연동 결과가 아닙니다.</p>
      {activities.isPending ? <p role="status">활동을 불러오는 중입니다.</p> : null}
      {activities.isError ? (
        <div role="alert">
          <p>활동을 불러오지 못했습니다.</p>
          <button type="button" onClick={() => void activities.refetch()}>
            다시 시도
          </button>
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
      <label htmlFor="workspace-note">작업 메모 (임시)</label>
      <textarea
        id="workspace-note"
        value={draft.state.note}
        onChange={(event) => draft.actions.setNote(event.target.value)}
      />
      <p>이 메모는 현재 작업 공간의 메모리에만 보관되며 활동을 기록하지 않습니다.</p>
      <button type="button" onClick={draft.actions.reset}>
        메모 초기화
      </button>
    </section>
  );
}
