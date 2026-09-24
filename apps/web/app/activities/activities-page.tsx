'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ActivityBrowser } from '@workout/modules-activities/activity-browser';
import {
  ActivityMediaPanel,
  type GalleryMediaTransfer,
} from '@workout/modules-gallery/activity-media-panel';
import { StretchingActivityPanel } from '@workout/modules-supplementary/stretching-activity-panel';
import { shiftDashboardDate } from '@workout/contracts/dashboard';
import type { ShellBasemap } from '../basemap-config';
function Activities({ basemap }: { basemap: ShellBasemap | null }) {
  const session = useAuthenticatedSession();
  const [search, setSearch] = useState(() => window.location.search);
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  // One transfer per session, so the media tab's thumbnails are not reloaded on every render.
  const { fileTransfer } = session;
  const mediaTransfer = useMemo<GalleryMediaTransfer>(
    () => ({
      upload: (input) => fileTransfer.uploadGalleryMedia(input),
      open: (input) => fileTransfer.openGalleryMedia(input),
    }),
    [fileTransfer],
  );
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <ActivityBrowser
      {...session}
      search={search}
      initialTimezone={timezone}
      basemap={basemap}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
      importHref="/activities/import"
      createHref="/activities/new"
      editHref={(id) => `/activities/${encodeURIComponent(id)}/edit`}
      renderActivityDetails={(activityId) => (
        <StretchingActivityPanel {...session} activityId={activityId} />
      )}
      renderMediaTab={(activityId) => (
        <ActivityMediaPanel
          athleteId={session.athleteId}
          sessionId={session.sessionId}
          transport={session.transport}
          activityId={activityId}
          mediaTransfer={mediaTransfer}
        />
      )}
      linkedBlockHref={(linkedPlanVersionId, linkedBlockId) =>
        `/activities?${new URLSearchParams({ linkedPlanVersionId, linkedBlockId })}`
      }
      planDayHref={(date) =>
        `/planner?${new URLSearchParams({ lens: 'calendar', from: date, to: shiftDashboardDate(date, 1) })}`
      }
      onSearchChange={(query) => {
        const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
        window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
        setSearch(normalized);
      }}
    />
  );
}
export function ActivitiesPage({ basemap }: { basemap: ShellBasemap | null }) {
  return (
    <AuthenticatedWorkspace>
      <Activities basemap={basemap} />
    </AuthenticatedWorkspace>
  );
}
