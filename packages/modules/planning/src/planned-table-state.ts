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
export const plannedTablePins = ['date', 'title', ...plannedTableColumns] as const;
export type PlannedTablePin = (typeof plannedTablePins)[number];

export function readPlannedTableState(params: URLSearchParams) {
  const rawSort = params.get('plannedSort') ?? 'date_asc';
  const sort = plannedTableSorts.find((value) => value === rawSort);
  const rawColumns = params.get('plannedColumns');
  const requested =
    rawColumns === null ? [...plannedTableColumns] : rawColumns === '' ? [] : rawColumns.split(',');
  const validColumns =
    requested.every((value) => plannedTableColumns.some((column) => column === value)) &&
    new Set(requested).size === requested.length;
  const rawPins = params.get('plannedPinned') ?? '';
  const pins = rawPins === '' ? [] : rawPins.split(',');
  const validPins =
    pins.every((value) => plannedTablePins.some((column) => column === value)) &&
    new Set(pins).size === pins.length;
  return {
    sort: sort ?? 'date_asc',
    columns: validColumns
      ? plannedTableColumns.filter((column) => requested.includes(column))
      : [...plannedTableColumns],
    pinned: validPins ? plannedTablePins.filter((column) => pins.includes(column)) : [],
    error: sort === undefined || !validColumns || !validPins,
  };
}
