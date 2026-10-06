import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CompetitionWorkspace,
  type CompetitionSection,
} from '@workout/modules-competitions/competition-workspace';
import '@workout/ui-foundation/tokens.css';
import '@workout/ui-foundation/responsive.css';
import {
  createSyntheticFixture,
  fixtureRelations,
  type FixtureAccount,
  type FixtureMode,
} from './synthetic-transport';
import './fixture.css';

const modes: readonly { value: FixtureMode; label: string }[] = [
  { value: 'normal', label: '정상 합성 응답' },
  { value: 'offline', label: '합성 네트워크 실패' },
  { value: 'revision-conflict', label: '강제 CAS 충돌' },
  { value: 'plan-impact', label: 'Plan 영향 검토 필요' },
  { value: 'consent-required', label: '새 저장 동의 필요 (삭제 허용)' },
  { value: 'unavailable', label: '조회 unavailable' },
  { value: 'cursor-stale', label: '다음 페이지 cursor stale' },
  { value: 'hold-writes', label: '저장 응답 보류 (취소 무시)' },
  { value: 'hold-reads', label: '조회 응답 보류 (취소 무시)' },
];
function Fixture() {
  const [pending, setPending] = useState(0);
  const [model] = useState(() => createSyntheticFixture(setPending));
  const [actor, setActor] = useState<FixtureAccount | null>('synthetic-a');
  const [epoch, setEpoch] = useState(1);
  const [section, setSection] = useState<CompetitionSection>('events');
  const [catalog, setCatalog] = useState<'available' | 'unavailable'>('available');
  const [mode, setMode] = useState<FixtureMode>('normal');
  const transport = useMemo(() => model.transport(actor ?? 'synthetic-b'), [model, actor]);
  const sessionId = `fixture-session-${epoch}`;
  return (
    <>
      <aside className="fixture-controls" aria-label="합성 fixture 조작">
        <h1>합성 브라우저 검증 fixture</h1>
        <p>
          개인정보·실제 인증·API·DB·provider 호출이 없습니다. 메모리 transport의 저장 결과는 실제
          PostgreSQL 증거가 아닙니다. 페이지를 새로고침하면 합성 기록이 초기화됩니다.
        </p>
        <div className="fixture-fields">
          <label>
            합성 계정
            <select
              value={actor ?? 'logout'}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'synthetic-a' || value === 'synthetic-b') setActor(value);
                else setActor(null);
                setEpoch((prior) => prior + 1);
              }}
            >
              <option value="synthetic-a">계정 A · 합성 기록 있음</option>
              <option value="synthetic-b">계정 B · 처음에는 빈 목록</option>
              <option value="logout">로그아웃</option>
            </select>
          </label>
          <label>
            응답 시나리오
            <select
              value={mode}
              onChange={(event) => {
                const selected = modes.find((item) => item.value === event.target.value);
                if (selected) {
                  setMode(selected.value);
                  model.setMode(selected.value);
                }
              }}
            >
              {modes.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            합성 연결 선택 목록
            <select
              value={catalog}
              onChange={(event) =>
                setCatalog(event.target.value === 'available' ? 'available' : 'unavailable')
              }
            >
              <option value="available">계획·코스·실제 활동 이름 제공</option>
              <option value="unavailable">연결 목록 unavailable</option>
            </select>
          </label>
        </div>
        <div className="fixture-actions">
          <button type="button" onClick={() => model.release()} disabled={pending === 0}>
            보류된 응답 완료 ({pending})
          </button>
          <button type="button" onClick={() => setEpoch((prior) => prior + 1)}>
            세션 갱신 · 초안과 캐시 폐기
          </button>
          <button
            type="button"
            disabled={actor === null}
            onClick={() => {
              if (actor) model.bump(actor);
            }}
          >
            다른 편집 시뮬레이션 · 버전 증가
          </button>
          <button
            type="button"
            disabled={actor === null}
            onClick={() => {
              if (actor) model.addPage(actor);
              setEpoch((prior) => prior + 1);
            }}
          >
            합성 대회 51개 추가 · 목록 새로 시작
          </button>
          <button
            type="button"
            disabled={actor === null}
            onClick={() => {
              if (actor) model.clear(actor);
              setEpoch((prior) => prior + 1);
            }}
          >
            합성 기록 비우기 · 목록 새로 시작
          </button>
        </div>
        <p role="status">
          fixture 계정 {actor === null ? '로그아웃' : actor === 'synthetic-a' ? 'A' : 'B'} · 세션{' '}
          {epoch} · 보류 응답 {pending}개
        </p>
        <p>
          보류 모드에서는 취소된 이전 계정 요청도 완료할 수 있습니다. 이는 늦은 응답의 화면 유출
          방지를 검사하기 위한 합성 동작입니다.
        </p>
      </aside>
      <div className="fixture-module">
        <CompetitionWorkspace
          athleteId={actor}
          sessionId={sessionId}
          transport={transport}
          section={section}
          onSectionChange={setSection}
          {...(catalog === 'available' ? { relations: fixtureRelations } : {})}
        />
      </div>
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('FIXTURE_ROOT_MISSING');
createRoot(root).render(<Fixture />);
