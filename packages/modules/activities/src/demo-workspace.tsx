'use client';

import { useState } from 'react';
import { WorkspaceProvider } from '@workout/platform/provider';
import { createFixtureHost, type FixtureScenario } from '@workout/platform/fixture-host';
import { ActivityList } from './activity-list';

export function DemoWorkspace() {
  const [session, setSession] = useState(() => ({
    user: 'A',
    revision: 0,
    scenario: 'populated' as FixtureScenario,
    host: createFixtureHost('A', 'populated'),
  }));
  const [signedIn, setSignedIn] = useState(true);
  function replace(user: string, scenario: FixtureScenario) {
    setSession((current) => ({
      user,
      scenario,
      revision: current.revision + 1,
      host: createFixtureHost(user, scenario),
    }));
  }
  return (
    <>
      <p>현재 개발 계정: {session.user}</p>
      <label htmlFor="fixture-scenario">데이터 시나리오</label>{' '}
      <select
        id="fixture-scenario"
        value={session.scenario}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'populated' || value === 'empty' || value === 'retry')
            replace(session.user, value);
        }}
      >
        <option value="populated">가상 활동</option>
        <option value="empty">빈 목록</option>
        <option value="retry">실패 후 재시도</option>
      </select>{' '}
      <button
        type="button"
        onClick={() => replace(session.user === 'A' ? 'B' : 'A', session.scenario)}
      >
        개발 계정 전환
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          replace(session.user, session.scenario);
          setSignedIn((value) => !value);
        }}
      >
        {signedIn ? '개발 세션 종료' : '개발 세션 시작'}
      </button>
      {signedIn ? (
        <WorkspaceProvider
          host={session.host}
          userId={session.user}
          workspaceId="activity-demo"
          sessionId={`fixture-${session.revision}`}
        >
          <ActivityList />
        </WorkspaceProvider>
      ) : (
        <p role="status">개발 세션이 종료되었습니다.</p>
      )}
    </>
  );
}
