export function attendanceLockLabel(value: boolean | undefined): string {
  if (value === undefined) return '꺼짐 (이전 형식에 값 없음)';
  return value ? '켜짐 (세션 삭제 보호)' : '꺼짐';
}
