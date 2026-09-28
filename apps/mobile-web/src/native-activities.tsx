import { useState } from 'react';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { ActivityBrowser } from '@workout/modules-activities/activity-browser';

/** The product iPhone uses the same review, explicit decision and ActivityDetail module. */
export function NativeActivities({
  athleteId,
  sessionId,
  transport,
  onBack,
}: {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  onBack(): void;
}) {
  const [search, setSearch] = useState('');
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  return (
    <section aria-labelledby="native-activities-heading">
      <button type="button" onClick={onBack}>
        계정으로 돌아가기
      </button>
      <h2 id="native-activities-heading">활동</h2>
      <ActivityBrowser
        surface="native-review"
        athleteId={athleteId}
        sessionId={sessionId}
        transport={transport}
        search={search}
        onSearchChange={setSearch}
        initialTimezone={timezone}
      />
    </section>
  );
}
