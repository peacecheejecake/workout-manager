const gates = {
  integration: 'M0-05: 실제 PostgreSQL/API integration 기반이 아직 구현되지 않았습니다.',
};
const gate = process.argv[2];
console.error(gates[gate] ?? `알 수 없는 검증 gate: ${String(gate)}`);
console.error(
  '미구현 검증은 통과로 처리하지 않습니다. docs/implementation/README.md를 확인하세요.',
);
process.exitCode = 1;
