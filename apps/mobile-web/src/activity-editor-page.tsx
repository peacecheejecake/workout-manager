'use client';

import { useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ActivityEditor } from '@workout/modules-activities/activity-editor';

type Target = { mode: 'create' } | { mode: 'edit'; activityId: string };
const activityHref = (id: string) => `/activities?selected=${encodeURIComponent(id)}`;
function Editor({ target }: { target: Target }) {
  const session = useAuthenticatedSession();
  const [initial] = useState(() => ({
    startedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  return (
    <ActivityEditor
      {...session}
      target={target}
      initialStartedAt={initial.startedAt}
      initialTimezone={initial.timezone}
      activityHref={activityHref}
      listHref="/activities"
    />
  );
}
export function ActivityEditorPage({ target }: { target: Target }) {
  return (
    <AuthenticatedWorkspace>
      <Editor target={target} />
    </AuthenticatedWorkspace>
  );
}
