'use client';

import { useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { LocalTrackPreview } from '@workout/modules-activities/track-preview';
import { createBrowserTrackParser } from '@workout/modules-activities/track-preview-browser';

function Preview() {
  const session = useAuthenticatedSession();
  // One parser instance per mount: each parse still gets its own worker.
  const [parser] = useState(() => createBrowserTrackParser());
  return (
    <LocalTrackPreview
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      parser={parser}
      // M2-01b renders the recording with no background map; d/e add the self-hosted one.
      basemap={null}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
    />
  );
}

export function TrackPreviewPage() {
  return (
    <AuthenticatedWorkspace>
      <Preview />
    </AuthenticatedWorkspace>
  );
}
