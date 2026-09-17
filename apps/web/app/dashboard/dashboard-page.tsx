'use client';
import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import {
  DashboardWorkspace,
  type DashboardLinks,
} from '@workout/modules-dashboard/dashboard-workspace';
import { PlanningPeriodNavigator } from '@workout/modules-planning/planning-period-navigator';
import { shiftDashboardDate } from '@workout/contracts/dashboard';

const links: DashboardLinks = {
  planning: '/planner',
  activities: '/activities',
  activityRange: (range) => `/activities?${new URLSearchParams(range)}`,
  wellbeing: '/wellbeing',
  planDay: (date: string) =>
    `/planner?${new URLSearchParams({ lens: 'calendar', from: date, to: shiftDashboardDate(date, 1) })}`,
  planBlock: (id: string) => `/planner?${new URLSearchParams({ lens: 'period', period: id })}`,
  checkIn: (id: string) => `/wellbeing?${new URLSearchParams({ selected: id })}`,
};
function Dashboard() {
  const session = useAuthenticatedSession();
  // This child mounts only after AuthenticatedWorkspace validates the browser session.
  const [search, setSearch] = useState(() => window.location.search);
  const [initial] = useState(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)?.value ?? '';
    return { timezone, anchor: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}` };
  });
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  function changeSearch(query: string) {
    const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
    window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
    setSearch(normalized);
  }
  return (
    <DashboardWorkspace
      {...session}
      search={search}
      initialAnchor={initial.anchor}
      initialTimezone={initial.timezone}
      links={links}
      onSearchChange={changeSearch}
      periodNavigation={
        <PlanningPeriodNavigator
          {...session}
          search={search}
          onSearchChange={changeSearch}
          planHref={(id) => (id === null ? links.planning : links.planBlock(id))}
          onCalendar={(period) => {
            window.location.assign(
              `/planner?${new URLSearchParams({
                lens: 'period',
                period: period.id,
                plannedView: 'calendar',
              })}`,
            );
          }}
        />
      }
    />
  );
}
export function DashboardPage() {
  return (
    <AuthenticatedWorkspace>
      <Dashboard />
    </AuthenticatedWorkspace>
  );
}
