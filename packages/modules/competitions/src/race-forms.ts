import {
  raceEventValuesSchema,
  raceResultValuesSchema,
  trainingBestValuesSchema,
} from '@workout/contracts/race-commands';
import type { RaceEvent, RaceResult, TrainingBest } from '@workout/contracts/races';
import type { CompetitionRelations, NamedChoice } from './competition-relations';

export type Draft = Readonly<Record<string, string>>;
export type Field = {
  key: string;
  label: string;
  type?: 'text' | 'date' | 'time' | 'number' | 'url' | 'datetime-local' | 'textarea';
  options?: readonly { value: string; label: string }[];
  disabled?: boolean;
  description?: string | undefined;
  apply?: (draft: Draft, next: string) => Draft;
};
const field = (key: string, label: string, type: Field['type'] = 'text'): Field => ({
  key,
  label,
  type,
});
const select = (key: string, label: string, options: readonly string[]): Field => ({
  key,
  label,
  options: options.map((value) => ({ value, label: value || '미상 / 연결 없음' })),
});
const value = (draft: Draft, key: string) => draft[key] ?? '';
const nullable = (draft: Draft, key: string) =>
  value(draft, key) === '' ? null : value(draft, key);
const number = (draft: Draft, key: string) =>
  value(draft, key) === '' ? null : Number(value(draft, key));
function strings(input: Record<string, unknown>): Draft {
  return Object.fromEntries(
    Object.entries(input).map(([key, v]) => [key, v === null ? '' : String(v)]),
  );
}
function relation(
  key: string,
  label: string,
  draft: Draft,
  choices: readonly NamedChoice[] | undefined,
): Field {
  const stored = value(draft, key);
  const options = [
    { value: '', label: choices === undefined ? '연결 목록을 불러올 수 없음' : '연결 없음' },
    ...(choices ?? []).map((choice) => ({ value: choice.id, label: choice.label })),
  ];
  if (stored !== '' && !options.some((option) => option.value === stored))
    options.push({ value: stored, label: `기존 ${label} 연결 (선택 목록 밖)` });
  return {
    key,
    label,
    options,
    disabled: choices === undefined,
    description:
      choices === undefined
        ? '연결 목록이 제공되지 않았습니다. 기존 연결은 그대로 유지됩니다.'
        : undefined,
  };
}
const localFields = [field('localDate', '현지 날짜', 'date'), field('timezone', 'IANA 시간대')];
export function eventFields(d: Draft, relations?: CompetitionRelations): readonly Field[] {
  return [
    field('title', '대회 이름'),
    ...localFields,
    field('localStartTime', '현지 출발 시간', 'time'),
    field('locationName', '장소'),
    select('distanceKind', '거리 유형', ['standard', 'custom']),
    ...(value(d, 'distanceKind') === 'custom'
      ? [
          field('distanceLabel', '사용자 거리 이름'),
          field('nominalMeters', '명목 거리 (m)', 'number'),
        ]
      : [select('distanceClass', '표준 거리', ['5k', '10k', 'half-marathon', 'marathon'])]),
    select('priority', '목표 우선순위', ['', 'A', 'B', 'C']),
    select('participation', '참가 상태', ['considering', 'registered', 'withdrawn']),
    field('officialUrl', '공식 HTTPS URL', 'url'),
    field('targetSeconds', '목표 시간 (초)', 'number'),
    relation('planVersionId', '연결 계획', d, relations?.plans),
    {
      ...relation(
        'courseChoice',
        '고정 버전 코스',
        d,
        relations?.courses?.map((choice) => ({ id: choice.ref.revisionId, label: choice.label })),
      ),
      apply: (draft: Draft, next: string) => {
        if (next === '')
          return { ...draft, courseChoice: '', courseId: '', courseRevision: '', revisionId: '' };
        const choice = relations?.courses?.find((item) => item.ref.revisionId === next);
        return choice
          ? {
              ...draft,
              courseChoice: next,
              courseId: choice.ref.courseId,
              courseRevision: String(choice.ref.courseRevision),
              revisionId: choice.ref.revisionId,
            }
          : draft;
      },
    },
  ];
}
export function eventDraft(record?: RaceEvent): Draft {
  if (!record)
    return {
      distanceKind: 'standard',
      distanceClass: '10k',
      participation: 'considering',
      timezone: 'Asia/Seoul',
    };
  return strings({
    title: record.title,
    localDate: record.localDate,
    localStartTime: record.localStartTime,
    timezone: record.timezone,
    locationName: record.locationName,
    priority: record.priority,
    participation: record.participation,
    officialUrl: record.officialUrl,
    targetSeconds: record.targetSeconds,
    planVersionId: record.planVersionId,
    distanceKind: record.distance.kind,
    distanceClass: record.distance.kind === 'standard' ? record.distance.class : '10k',
    distanceLabel: record.distance.kind === 'custom' ? record.distance.label : '',
    nominalMeters: record.distance.kind === 'custom' ? record.distance.nominalMeters : null,
    courseChoice: record.course?.revisionId ?? null,
    courseId: record.course?.courseId ?? null,
    courseRevision: record.course?.courseRevision ?? null,
    revisionId: record.course?.revisionId ?? null,
  });
}
export function parseEvent(d: Draft) {
  const courseParts = ['courseId', 'courseRevision', 'revisionId'].map((key) => value(d, key));
  return raceEventValuesSchema.parse({
    title: value(d, 'title'),
    localDate: value(d, 'localDate'),
    localStartTime: nullable(d, 'localStartTime'),
    timezone: value(d, 'timezone'),
    locationName: nullable(d, 'locationName'),
    distance:
      value(d, 'distanceKind') === 'custom'
        ? {
            kind: 'custom',
            label: value(d, 'distanceLabel'),
            nominalMeters: number(d, 'nominalMeters'),
          }
        : { kind: 'standard', class: value(d, 'distanceClass') },
    priority: nullable(d, 'priority'),
    participation: value(d, 'participation'),
    officialUrl: nullable(d, 'officialUrl'),
    targetSeconds: number(d, 'targetSeconds'),
    planVersionId: nullable(d, 'planVersionId'),
    course: courseParts.every((part) => part === '')
      ? null
      : {
          courseId: value(d, 'courseId'),
          courseRevision: number(d, 'courseRevision'),
          revisionId: value(d, 'revisionId'),
        },
  });
}
export function resultFields(
  d: Draft,
  relations?: CompetitionRelations,
  events?: readonly NamedChoice[],
): readonly Field[] {
  return [
    ...localFields,
    relation('raceEventId', '연결 대회', d, events),
    select('sourceKind', '기록 출처', ['manual', 'official', 'device']),
    ...(value(d, 'sourceKind') === 'official'
      ? [field('authority', '공식 기록 기관'), field('resultUrl', '공식 기록 HTTPS URL', 'url')]
      : value(d, 'sourceKind') === 'device'
        ? [field('providerLabel', '기기 출처 이름')]
        : []),
    field('chipSeconds', 'Chip 시간 (초)', 'number'),
    field('gunSeconds', 'Gun 시간 (초)', 'number'),
    field('officialDistanceMeters', '공식 거리 (m)', 'number'),
    field('deviceDistanceMeters', '기기 거리 (m)', 'number'),
    relation('linkedActivityId', '연결 실제 활동', d, relations?.activities),
    field('weatherNote', '날씨 메모', 'textarea'),
  ];
}
export function resultDraft(record?: RaceResult): Draft {
  if (!record) return { sourceKind: 'manual', timezone: 'Asia/Seoul' };
  return strings({
    raceEventId: record.raceEventId,
    localDate: record.localDate,
    timezone: record.timezone,
    chipSeconds: record.chipSeconds,
    gunSeconds: record.gunSeconds,
    officialDistanceMeters: record.officialDistanceMeters,
    deviceDistanceMeters: record.deviceDistanceMeters,
    linkedActivityId: record.linkedActivityId,
    weatherNote: record.weatherNote,
    sourceKind: record.source.kind,
    authority: record.source.kind === 'official' ? record.source.authority : '',
    resultUrl: record.source.kind === 'official' ? record.source.resultUrl : '',
    providerLabel: record.source.kind === 'device' ? record.source.providerLabel : '',
  });
}
export function parseResult(d: Draft) {
  return raceResultValuesSchema.parse({
    kind: 'race-result',
    raceEventId: nullable(d, 'raceEventId'),
    localDate: value(d, 'localDate'),
    timezone: value(d, 'timezone'),
    source:
      value(d, 'sourceKind') === 'official'
        ? { kind: 'official', authority: value(d, 'authority'), resultUrl: value(d, 'resultUrl') }
        : value(d, 'sourceKind') === 'device'
          ? { kind: 'device', providerLabel: value(d, 'providerLabel') }
          : { kind: 'manual' },
    chipSeconds: number(d, 'chipSeconds'),
    gunSeconds: number(d, 'gunSeconds'),
    officialDistanceMeters: number(d, 'officialDistanceMeters'),
    deviceDistanceMeters: number(d, 'deviceDistanceMeters'),
    linkedActivityId: nullable(d, 'linkedActivityId'),
    weatherNote: nullable(d, 'weatherNote'),
  });
}
export function bestFields(d: Draft, relations?: CompetitionRelations): readonly Field[] {
  return [
    field('observedAt', '관측 시각 (ISO 8601, offset 포함)'),
    select('sourceKind', '훈련 기록 출처', ['manual', 'activity']),
    ...(value(d, 'sourceKind') === 'activity'
      ? [relation('activityId', '원본 실제 활동', d, relations?.activities)]
      : []),
    select('basis', '측정 기준', ['whole-activity', 'device-estimated-split', 'user-entered']),
    field('distanceMeters', '훈련 거리 (m)', 'number'),
    field('elapsedSeconds', '경과 시간 (초)', 'number'),
  ];
}
export function bestDraft(record?: TrainingBest): Draft {
  if (!record) return { sourceKind: 'manual', basis: 'user-entered' };
  return strings({
    observedAt: record.observedAt,
    basis: record.basis,
    distanceMeters: record.distanceMeters,
    elapsedSeconds: record.elapsedSeconds,
    sourceKind: record.source.kind,
    activityId: record.source.kind === 'activity' ? record.source.activityId : '',
  });
}
export function parseBest(d: Draft) {
  return trainingBestValuesSchema.parse({
    kind: 'training-best',
    observedAt: value(d, 'observedAt'),
    source:
      value(d, 'sourceKind') === 'activity'
        ? { kind: 'activity', activityId: value(d, 'activityId') }
        : { kind: 'manual' },
    basis: value(d, 'basis'),
    distanceMeters: number(d, 'distanceMeters'),
    elapsedSeconds: number(d, 'elapsedSeconds'),
  });
}
