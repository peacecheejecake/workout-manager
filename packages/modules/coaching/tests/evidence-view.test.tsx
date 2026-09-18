import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import {
  coreEvidenceSnapshotSchema,
  type CoreEvidenceBody,
  type CoreEvidenceBodyV1,
  type CoreEvidenceBodyV2,
} from '@workout/contracts/evidence-snapshots';
import { EvidenceView } from '../src/evidence-view';
afterEach(cleanup);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-09-18T00:00:00Z';
function fixture(): CoreEvidenceBodyV1 {
  const values = {
    title: null,
    kind: 'running' as const,
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown' as const,
    distanceMeters: 0,
    timezone: null,
  };
  return {
    schemaVersion: 1,
    scope: 'running-core-v1',
    window: { from: '2026-09-17', toExclusive: '2026-09-19', timezone: 'UTC' },
    thread: {
      id,
      planVersionId: id,
      title: 'thread',
      scope: { kind: 'block', targetId: 'block' },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    plan: {
      id,
      version: 1,
      createdAt: at,
      draft: {
        title: 'plan',
        timezone: 'UTC',
        periods: [
          ...(['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
            id: level,
            parentId: index === 0 ? null : (levels[index - 1] ?? null),
            level,
            title: level,
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
          {
            id: 'block',
            parentId: 'phase',
            level: 'block',
            title: 'block',
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
    messages: [{ id, threadId: id, revision: 1, role: 'user', content: 'question', createdAt: at }],
    dependencies: {
      schemaVersion: 1,
      scope: 'core-ledgers-v1',
      athleteId: 'owner',
      capturedAt: at,
      trainingPlan: { kind: 'exists', versionId: other },
      activities: { count: '1', revisionSum: '1' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
    },
    activities: [
      {
        localDate: null,
        record: {
          id,
          revision: 1,
          source: { kind: 'fixture', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
          original: values,
          effective: values,
          overlay: {},
        },
      },
    ],
    checkIns: [],
    sessionCompletions: [],
  };
}

function available(body: CoreEvidenceBody = fixture()) {
  return coreEvidenceSnapshotSchema.parse({
    id,
    threadId: id,
    createdAt: at,
    status: 'available',
    body,
  });
}
function withConstraints(): CoreEvidenceBodyV2 {
  const body = fixture();
  return {
    ...body,
    schemaVersion: 2,
    scope: 'running-core-v2',
    dependencies: {
      ...body.dependencies,
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      userConstraints: { kind: 'exists', revision: 3 },
    },
    userConstraints: {
      headRevision: 3,
      items: [
        {
          id: other,
          revision: 2,
          text: '<img src=x onerror=alert(1)>\n  저장된 사용자 제약',
          confirmedAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
        },
      ],
    },
  };
}
async function expand(name: string) {
  await userEvent.click(screen.getByText(name, { selector: 'summary' }));
}
describe('frozen evidence view', () => {
  it('shows every v2 constraint outside collapsed evidence groups and date/scope filters with frozen provenance', async () => {
    const body = withConstraints();
    const saved = JSON.stringify(body);
    const { container } = render(<EvidenceView snapshot={available(body)} />);
    const region = screen.getByRole('region', { name: '필수 사용자 제약 근거' });
    expect(region).toBeVisible();
    expect(region.closest('details')).toBeNull();
    const text = body.userConstraints.items[0]?.text;
    if (!text) throw new Error('Missing constraint fixture');
    expect(within(region).getByText(text, { normalizer: (value) => value })).toBeVisible();
    expect(region).toHaveTextContent('저장 당시 제약 원장 버전 3');
    expect(region).toHaveTextContent(`제약 ID ${other} · 기록 버전 2`);
    expect(region).toHaveTextContent('사용자 확인 시각: 2026-09-01T00:00:00Z');
    expect(region).toHaveTextContent('마지막 수정 시각: 2026-09-02T00:00:00Z');
    expect(region).toHaveTextContent('날짜와 상담 범위에 관계없이 필수로 포함');
    expect(region).toHaveTextContent('현재 제약 원장의 최신 상태를 뜻하지 않습니다');
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
    expect(within(region).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(JSON.stringify(body)).toBe(saved);
    await expand('저장 당시 근거 범위와 변경 기준');
    expect(screen.queryByText('전체 사용자 제약', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('전체 사용자 선호')).toBeVisible();
  });
  it('distinguishes an absent v2 ledger from a captured explicitly emptied ledger', () => {
    const body = withConstraints();
    body.userConstraints = { headRevision: null, items: [] };
    body.dependencies.userConstraints = { kind: 'absent' };
    const { rerender } = render(<EvidenceView snapshot={available(body)} />);
    const region = screen.getByRole('region', { name: '필수 사용자 제약 근거' });
    expect(region).toHaveTextContent('저장 당시 제약 미기록');
    expect(region).not.toHaveTextContent('0개');
    body.userConstraints = { headRevision: 4, items: [] };
    body.dependencies.userConstraints = { kind: 'exists', revision: 4 };
    rerender(<EvidenceView snapshot={available(body)} />);
    expect(region).toHaveTextContent('저장 당시 명시적으로 비운 제약 원장');
    expect(region).toHaveTextContent('확인된 제약 문장 0개');
    expect(region).toHaveTextContent('저장 당시 제약 원장 버전 4');
    expect(region).not.toHaveTextContent('제약 미기록');
  });
  it('keeps legacy v1 exclusions explicit instead of implying absence or inserting current constraints', async () => {
    render(<EvidenceView snapshot={available()} />);
    const region = screen.getByRole('region', { name: '필수 사용자 제약 근거' });
    expect(region).toHaveTextContent('이전 근거 v1에는 사용자 제약 원장이 포함되지 않았습니다');
    expect(region).toHaveTextContent('제약이 없었다는 뜻은 아니며');
    expect(region).not.toHaveTextContent('0개');
    await expand('저장 당시 근거 범위와 변경 기준');
    expect(screen.getByText('전체 사용자 제약', { exact: true })).toBeVisible();
  });
  it('removes frozen constraint text and its provenance when the snapshot is purged', () => {
    const { rerender } = render(<EvidenceView snapshot={available(withConstraints())} />);
    expect(screen.getByRole('region', { name: '필수 사용자 제약 근거' })).toBeVisible();
    rerender(
      <EvidenceView
        snapshot={{ id, threadId: id, createdAt: at, status: 'purged', reason: 'source_deleted' }}
      />,
    );
    expect(screen.queryByRole('region', { name: '필수 사용자 제약 근거' })).not.toBeInTheDocument();
    expect(screen.queryByText(/저장된 사용자 제약/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '원본 기록 또는 사용자 제약이 삭제되었습니다',
    );
  });
  it('distinguishes pinned historical plan from captured current head, unknown activity time from in-window data, and known zero from missing', async () => {
    const body = fixture();
    const source = body.activities[0];
    if (!source) throw new Error('Missing fixture');
    body.activities.push({
      localDate: '2026-09-18',
      record: {
        ...source.record,
        id: other,
        original: {
          ...source.record.original,
          startedAt: at,
          timezone: 'UTC',
          distanceMeters: null,
          durationSeconds: 0,
          durationKind: 'timer',
        },
        effective: {
          ...source.record.effective,
          startedAt: at,
          timezone: 'UTC',
          distanceMeters: null,
          durationSeconds: 0,
          durationKind: 'timer',
        },
      },
    });
    body.dependencies.activities = { count: '2', revisionSum: '2' };
    render(<EvidenceView snapshot={available(body)} />);
    expect(screen.getByText(` 상담에 고정된 계획: v1 · ${id}`.trim())).toBeInTheDocument();
    expect(screen.getByText(`근거 저장 당시 현재 계획: ${other}`)).toBeInTheDocument();
    expect(
      screen.getByText('조회 범위: 2026-09-17 이상 ~ 2026-09-19 미만 · UTC'),
    ).toBeInTheDocument();
    await expand('실제 활동 2개');
    const unknown = screen.getByRole('article', { name: `근거 활동 ${id}` }),
      known = screen.getByRole('article', { name: `근거 활동 ${other}` });
    expect(unknown).toHaveTextContent('날짜 미확인 · 범위 포함 여부 미확인');
    expect(unknown).toHaveTextContent('0 m');
    expect(unknown).toHaveTextContent('미보고 · 정의 미확인');
    expect(known).toHaveTextContent('조회 시간대 날짜: 2026-09-18 · 조회 범위 안');
    expect(known).toHaveTextContent('0 초 · 타이머 시간');
    await expand('저장 당시 근거 범위와 변경 기준');
    expect(
      screen.getByText(/현재 최신 여부나 계획 승인 가능 여부를 판정하지 않습니다/),
    ).toBeVisible();
    expect(screen.getByText('활동 상세 레코드·랩')).toBeVisible();
  });
  it('renders injected user text literally and preserves whitespace without executable HTML', async () => {
    const body = fixture(),
      content = '<img src=x onerror=alert(1)>\n  user text';
    const message = body.messages[0];
    if (!message) throw new Error('Missing message');
    message.content = content;
    const { container } = render(<EvidenceView snapshot={available(body)} />);
    await expand('사용자 메시지 전체 1개');
    expect(screen.getByText(content, { normalizer: (value) => value }).textContent).toBe(content);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
  it('preserves check-in own local date and user completion meaning independently of activity windows', async () => {
    const body = fixture();
    body.checkIns = [
      {
        localDate: '2026-09-17',
        record: {
          id,
          revision: 1,
          values: {
            observedAt: '2026-09-17T23:30:00Z',
            timezone: 'Asia/Seoul',
            fatigue: 0,
            discomfort: null,
            bodyLocation: null,
            note: 'Self report',
          },
          localDate: '2026-09-18',
          recordedAt: at,
          updatedAt: at,
          source: 'user',
          method: 'self_report',
          definitionVersion: 'checkin-v1',
        },
      },
    ];
    body.dependencies.checkIns = { kind: 'exists', revision: 1 };
    body.plan.draft.sessions = [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-09-17',
        localStartTime: null,
        title: 'Session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ];
    body.sessionCompletions = [
      {
        sessionId: 'session',
        revision: 1,
        planVersionId: other,
        schedule: { blockId: 'block', date: '2026-09-17', localStartTime: null, timezone: 'UTC' },
        status: 'completed',
        reportedAt: at,
        reason: null,
        source: 'user',
        method: 'self_report',
        definitionVersion: 'session-completion-v1',
      },
    ];
    body.dependencies.sessionCompletions = { kind: 'exists', revision: 1 };
    render(<EvidenceView snapshot={available(body)} />);
    await expand('체크인 사용자 보고 1개');
    expect(
      screen.getByText(/조회 시간대 날짜: 2026-09-17 · 원래 기록 날짜: 2026-09-18/),
    ).toBeVisible();
    expect(screen.getByText(/피로: 0 · 불편감: 미보고/)).toBeVisible();
    await expand('세션 완료 사용자 보고 1개');
    expect(screen.getByText(/기기 측정이나 계획 이행률이 아닙니다/)).toBeVisible();
    expect(screen.getByText(/확인 시각은 기록을 남긴 시각/)).toBeVisible();
    expect(screen.getByText(`보고 당시 계획 ${other} · Block block`)).toBeVisible();
  });
  it.each(['source_deleted', 'consent_withdrawn'] as const)(
    'renders %s tombstones with only metadata and reason',
    (reason) => {
      render(
        <EvidenceView
          snapshot={coreEvidenceSnapshotSchema.parse({
            id,
            threadId: id,
            createdAt: at,
            status: 'purged',
            reason,
          })}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent('근거 본문이 폐기되었습니다.');
      expect(screen.getByText(/저장 시각:/)).toHaveTextContent(at);
      expect(screen.queryByText(/사용자 메시지 전체/)).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '저장된 상담 맥락' })).not.toBeInTheDocument();
    },
  );
  it('keeps empty reports and absent consent explicit without inventing healthy states or zero totals', async () => {
    const body = fixture();
    body.activities = [];
    body.dependencies.activities = { count: '0', revisionSum: '0' };
    render(<EvidenceView snapshot={available(body)} />);
    await expand('실제 활동 0개');
    expect(screen.getByText(/실제 수행이 없었다는 증거는 아닙니다/)).toBeVisible();
    await expand('체크인 사용자 보고 0개');
    expect(screen.getByText(/불편감이 없다는 뜻은 아닙니다/)).toBeVisible();
    await expand('저장 당시 근거 범위와 변경 기준');
    expect(screen.getByText('동의 기록 없음')).toBeVisible();
  });
});
