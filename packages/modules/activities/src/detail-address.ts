/**
 * S09's spec address, `/activities/:id?tab=<tab>`, as an alias of the address the activity
 * screen actually reads, `/activities?selected=<id>&detailTab=<tab>` (M2-01k-k).
 *
 * The alias is a pure rewrite of the address. It consults nothing, so it cannot tell anyone
 * whether an activity exists or whose it is: the id and the tab are carried over verbatim and
 * the activity screen then answers exactly as it does for its own address. A non-uuid id
 * reaches the screen's invalid-address state, an unknown tab its unsupported-view state, and
 * an activity that is missing or someone else's the same "deleted or not accessible" answer.
 *
 * Other query parameters (list view, filters) are kept; a `selected` or `detailTab` already in
 * the query is replaced, because the path and `tab` are what the alias address names.
 */
export function activityDetailAliasTarget(pathId: string, search: URLSearchParams): string {
  const params = new URLSearchParams();
  params.set('selected', pathId);
  const tab = search.get('tab');
  if (tab !== null) params.set('detailTab', tab);
  for (const [name, value] of search) {
    if (name !== 'tab' && name !== 'selected' && name !== 'detailTab') params.append(name, value);
  }
  return `/activities?${params.toString()}`;
}
