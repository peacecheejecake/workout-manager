'use client';

import { useMemo } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { AiSettingsWorkspace } from '@workout/modules-settings/ai-settings-workspace';
import { createAiSettingsPort } from '@workout/modules-settings/ai-settings-api';

function Settings() {
  const session = useAuthenticatedSession();
  const port = useMemo(() => createAiSettingsPort(session.transport), [session.transport]);
  return (
    <AiSettingsWorkspace athleteId={session.athleteId} sessionId={session.sessionId} port={port} />
  );
}

export function SettingsPage() {
  return (
    <AuthenticatedWorkspace>
      <Settings />
    </AuthenticatedWorkspace>
  );
}
