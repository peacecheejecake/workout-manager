interface ValidationIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}
const fieldNames: Readonly<Record<string, string>> = {
  title: '제목',
  timezone: '시간대',
  startDate: '시작일',
  endDateExclusive: '종료일',
  parentId: '상위 기간',
  intent: '목적',
  date: '날짜',
  localStartTime: '시작 시각',
  blockId: '소속 Block',
  sport: '종목',
  durationSeconds: '시간 (초)',
  distanceMeters: '거리 (m)',
  targetRpe: '목표 RPE',
  intensityLabel: '강도 라벨',
  purpose: '목적',
  notes: '메모',
  priority: '중요도',
  steps: '운동 단계',
  repetitions: '반복 횟수',
  kind: '단계 종류',
};
const customGuidance: Readonly<Record<string, string>> = {
  'Duplicate period IDs': '중복된 기간이 있습니다. 중복 항목을 삭제하고 다시 추가하세요.',
  'Duplicate session IDs': '중복된 세션이 있습니다. 중복 항목을 삭제하고 다시 추가하세요.',
  'Duplicate step IDs': '중복된 운동 단계가 있습니다. 중복 항목을 삭제하고 다시 추가하세요.',
  'Expected non-empty period':
    '종료일을 시작일 다음 날 이후로 지정하세요. 종료일은 포함하지 않습니다.',
  'Period timezone must match plan timezone': '계획과 동일한 시간대를 지정하세요.',
  'Season must be a root': 'Season에는 상위 기간을 지정하지 마세요.',
  'Required parent level is missing':
    'Season → Wave → Phase → Block 순서에 맞는 상위 기간을 선택하세요.',
  'Period exceeds parent range': '시작일과 종료일을 상위 기간 안에 배치하세요.',
  'Sibling periods overlap': '같은 상위 기간에 속한 기간들이 겹치지 않도록 날짜를 조정하세요.',
  'Plan is bounded to 3660 calendar days': '계획 전체 기간을 3,660일 이내로 줄이세요.',
  'Session must belong to its containing Block':
    '세션 날짜를 포함하는 Block을 선택하거나 날짜를 조정하세요.',
  'Plan exceeds 512 KiB': '계획 내용이 너무 많습니다. 메모나 항목 수를 줄이세요.',
};

/** Translate boundary failures for editing without exposing schema paths or parser internals. */
export function validationGuidance(issue: ValidationIssue): string {
  const collection = issue.path[0];
  const index = issue.path[1];
  const group = collection === 'periods' ? '기간' : collection === 'sessions' ? '세션' : '계획';
  const location = typeof index === 'number' ? `${group} ${index + 1}` : group;
  const leaf = issue.path.at(-1);
  const field = typeof leaf === 'string' ? fieldNames[leaf] : undefined;
  const prefix = `${location}${field ? ` · ${field}` : ''}: `;
  const custom = customGuidance[issue.message];
  if (custom) return prefix + custom;
  if (issue.path.length === 1 && collection === 'periods' && issue.code === 'too_small') {
    return '기간: Season을 추가한 뒤 필요한 Wave·Phase·Block을 구성하세요.';
  }
  if (leaf === 'intensityLabel') return prefix + '미지정 또는 A·B·C 중 하나를 선택하세요.';
  if (leaf === 'timezone') return prefix + 'Asia/Seoul, UTC 등 유효한 시간대를 입력하세요.';
  if (leaf === 'startDate' || leaf === 'endDateExclusive' || leaf === 'date') {
    return prefix + '달력에서 유효한 날짜를 선택하세요.';
  }
  if (leaf === 'localStartTime') return prefix + '유효한 시각을 입력하거나 미정이면 비워 두세요.';
  if (leaf === 'title' && issue.code === 'too_small') return prefix + '제목을 입력하세요.';
  if (issue.code === 'too_big' && issue.maximum !== undefined) {
    return (
      prefix +
      `허용 범위(${String(issue.maximum)} 이하)에 맞게 입력 길이·값 또는 항목 수를 줄이세요.`
    );
  }
  if (issue.code === 'too_small' && issue.minimum !== undefined) {
    return prefix + `${String(issue.minimum)} 이상으로 입력하세요.`;
  }
  if (
    leaf === 'durationSeconds' ||
    leaf === 'distanceMeters' ||
    leaf === 'targetRpe' ||
    leaf === 'repetitions'
  ) {
    return prefix + '허용 범위의 숫자를 입력하세요. 반복 횟수는 1 이상의 정수입니다.';
  }
  return prefix + '입력 내용을 확인하고 항목을 다시 선택하거나 수정하세요.';
}
