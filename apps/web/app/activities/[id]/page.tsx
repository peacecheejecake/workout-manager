import { redirect } from 'next/navigation';
import { activityDetailAliasTarget } from '@workout/modules-activities/detail-address';

/**
 * S09's spec address `/activities/:id?tab=<tab>` (M2-01k-k). It only forwards to the activity
 * screen's own address; the id is not checked here, so the answer for a malformed, missing or
 * someone else's activity is the screen's, and the same for all three kinds of caller.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
      search.append(name, item);
  }
  redirect(activityDetailAliasTarget(id, search));
}
