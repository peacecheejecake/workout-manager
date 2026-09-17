import { describe, it, expect } from 'vitest';
import { sessionOperationDate } from '../src/session-operation-clock';
describe('operation calendar clock', () => {
  it('uses the plan local day rather than the UTC day at the same instant', () => {
    const instant = Date.parse('2026-09-17T00:30:00Z');
    expect(sessionOperationDate(instant, 'America/Los_Angeles')).toBe('2026-09-16');
    expect(sessionOperationDate(instant, 'Asia/Seoul')).toBe('2026-09-17');
  });
  it('respects the DST boundary without adding a fixed offset', () => {
    expect(sessionOperationDate(Date.parse('2026-03-09T03:30:00Z'), 'America/New_York')).toBe(
      '2026-03-08',
    );
    expect(sessionOperationDate(Date.parse('2026-03-09T04:30:00Z'), 'America/New_York')).toBe(
      '2026-03-09',
    );
  });
});
