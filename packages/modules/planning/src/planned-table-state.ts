export const plannedTableSorts = [
  'date_asc',
  'date_desc',
  'title_asc',
  'title_desc',
  'distance_asc',
  'distance_desc',
  'duration_asc',
  'duration_desc',
] as const;
export type PlannedTableSort = (typeof plannedTableSorts)[number];
export const plannedTableColumns = [
  'block',
  'purpose',
  'distance',
  'duration',
  'rpe',
  'notes',
] as const;
export type PlannedTableColumn = (typeof plannedTableColumns)[number];

export function readPlannedTableState(params: URLSearchParams) {
  const rawSort = params.get('plannedSort') ?? 'date_asc';
  const sort = plannedTableSorts.find((value) => value === rawSort);
  const rawColumns = params.get('plannedColumns');
  const requested =
    rawColumns === null ? [...plannedTableColumns] : rawColumns === '' ? [] : rawColumns.split(',');
  const validColumns =
    requested.every((value) => plannedTableColumns.some((column) => column === value)) &&
    new Set(requested).size === requested.length;
  return {
    sort: sort ?? 'date_asc',
    columns: validColumns
      ? plannedTableColumns.filter((column) => requested.includes(column))
      : [...plannedTableColumns],
    error: sort === undefined || !validColumns,
  };
}
