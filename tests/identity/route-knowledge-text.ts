import type { CourseRouteKnowledge } from '../../packages/contracts/src/courses';

/**
 * The review's stairs, surface and access wording (M2-01ap), written out again here from the
 * answer the server sent, so a spec compares the screen with the response rather than with the
 * screen's own formatter. Kept deliberately small: if the screen's wording changes, this is
 * the one place a spec has to follow it.
 */
function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

const unknown = '확인되지 않음';
const notReported = `${unknown} (엔진이 이 경로의 값을 답하지 않음)`;

const surfaceNames: Record<string, string> = {
  paved: '포장',
  asphalt: '아스팔트',
  concrete: '콘크리트',
  paving_stones: '보도블록',
  cobblestone: '돌 포장',
  unpaved: '비포장',
  compacted: '다진 흙',
  fine_gravel: '잔자갈',
  gravel: '자갈',
  ground: '흙',
  dirt: '흙길',
  grass: '잔디',
  sand: '모래',
  wood: '나무',
  other: '기타',
};

const accessNames: Record<string, string> = {
  'road_access=destination': '목적지 방문만',
  'road_access=customers': '고객만',
  'road_access=delivery': '배송만',
  'road_access=forestry': '임업용',
  'road_access=agricultural': '농업용',
  'road_access=private': '사유',
  'road_access=other': '기타 제한',
  'road_access=no': '금지',
  'foot_access=no': '도보 금지',
};

function withUnknown(parts: string[], unknownMeters: number, because: string): string {
  if (unknownMeters > 0) parts.push(`${unknown} ${metres(unknownMeters)} (${because})`);
  return parts.length === 0 ? `${unknown} (${because})` : parts.join(' · ');
}

export function expectedAccessText(knowledge: CourseRouteKnowledge): string {
  const fact = knowledge.accessRestrictions;
  if (fact.status === 'not_reported') return notReported;
  return withUnknown(
    fact.known.map(
      (entry) =>
        `${entry.value}(${accessNames[entry.value]}) ${metres(entry.meters)} · ${entry.sections}곳`,
    ),
    fact.unknownMeters,
    'graph에 제한 값 없음 · 제한이 없다는 확인은 아님',
  );
}

export function expectedStairsText(knowledge: CourseRouteKnowledge): string {
  const fact = knowledge.stairs;
  if (fact.status === 'not_reported') return notReported;
  const steps = fact.known.find((entry) => entry.value === 'steps');
  const other = fact.known.find((entry) => entry.value === 'not_steps');
  const parts: string[] = [];
  if (steps) parts.push(`계단 ${steps.sections}곳 ${metres(steps.meters)} (highway=steps)`);
  if (other)
    parts.push(
      steps
        ? `계단 아닌 길 ${metres(other.meters)}`
        : `도로 등급에 계단 없음 ${metres(other.meters)}`,
    );
  return withUnknown(parts, fact.unknownMeters, '도로 등급 미상');
}

export function expectedSurfaceText(knowledge: CourseRouteKnowledge): string {
  const fact = knowledge.surface;
  if (fact.status === 'not_reported') return notReported;
  return withUnknown(
    fact.known.map(
      (entry) => `${surfaceNames[entry.value]}(${entry.value}) ${metres(entry.meters)}`,
    ),
    fact.unknownMeters,
    'graph에 노면 값 없음',
  );
}

export const expectedNightText = `${unknown} (자료 없음)`;
