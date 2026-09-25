import type { ActivityContext } from '@workout/contracts/activity-context';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { ActivityContextPanel } from './activity-context-panel';
import { ImpactClassificationSection } from './impact-classification';
import { ImpactConsultationSection, type CoachingLink } from './impact-consultation';

export type { CoachingLink } from './impact-consultation';

/**
 * S09's impact tab (01 §7.2, V2-F14): observed/calculated, classification/estimate and
 * consultation, each under its own heading and source line. No section shows a risk
 * percentage, a causal number or a contribution share, and none writes the plan.
 */
export function ActivityImpactPanel({
  context,
  transport,
  scope,
  planDayHref,
  linkedBlockHref,
  coachingHref,
}: {
  context: ActivityContext;
  transport: AuthenticatedTransport;
  scope: ReadonlyArray<string>;
  planDayHref?: (date: string) => string;
  linkedBlockHref?: (versionId: string, blockId: string) => string;
  coachingHref?: (link: CoachingLink) => string;
}) {
  return (
    <div>
      <ActivityContextPanel
        context={context}
        {...(planDayHref ? { planDayHref } : {})}
        {...(linkedBlockHref ? { linkedBlockHref } : {})}
      />
      <ImpactClassificationSection context={context} />
      <ImpactConsultationSection
        context={context}
        transport={transport}
        scope={scope}
        {...(coachingHref ? { coachingHref } : {})}
      />
    </div>
  );
}
