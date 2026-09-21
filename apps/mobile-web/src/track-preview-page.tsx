import { useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { LocalTrackPreview } from '@workout/modules-activities/track-preview';
import { createBrowserTrackParser } from '@workout/modules-activities/track-preview-browser';

function Preview() {
  const session = useAuthenticatedSession();
  const [parser] = useState(() => createBrowserTrackParser());
  return (
    <LocalTrackPreview
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      parser={parser}
      basemap={null}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
    />
  );
}

export function TrackPreviewPage() {
  return (
    <>
      <h1>기록 파일 미리보기</h1>
      <AuthenticatedWorkspace>
        <Preview />
      </AuthenticatedWorkspace>
    </>
  );
}
