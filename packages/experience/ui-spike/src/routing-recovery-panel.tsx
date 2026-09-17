import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@workout/ui-foundation/button';
import {
  createDeferredRoutingFixture,
  createRoutingStore,
  routingFixtureQueueLimit,
} from './routing-state';
import styles from './routing-recovery-panel.module.css';
const labels = {
  idle: '미계산 초안',
  requesting: '응답 대기 중',
  cancelled: '요청 취소됨',
  error: '경로 요청 실패',
  computed: '합성 계산 결과',
};
export function RoutingRecoveryPanel() {
  const [fixture] = useState(createDeferredRoutingFixture);
  const [store] = useState(() => createRoutingStore(fixture.port));
  const revision = useStore(store, (state) => state.draftRevision);
  const destination = useStore(store, (state) => state.destination);
  const scenario = useStore(store, (state) => state.scenario);
  const result = useStore(store, (state) => state.result);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    store.getState().activate();
    return () => {
      store.getState().dispose();
      fixture.clear();
    };
  }, [store, fixture]);
  return (
    <section aria-label="라우팅 오류 복구 검증" className={styles.panel}>
      <h2>라우팅 오류 복구 검증</h2>
      <p>NEG-SYN-02 revision 2 · 로컬 가상 평면 fixture</p>
      <p>
        외부 요청 없는 합성 응답 검증입니다. 좌표는 가상 평면이며 실제 보행 경로가 아닙니다.
        요청·오류·성공은 계획 저장이나 승인으로 이어지지 않습니다.
      </p>
      <p>초안 수정 번호: {revision}</p>
      <p>합성 도착점: {destination}</p>
      <label>
        합성 응답 시나리오
        <select
          value={scenario}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === '429' ||
              value === 'timeout' ||
              value === 'NoRoute' ||
              value === 'success'
            )
              store.getState().setScenario(value);
          }}
        >
          <option value="429">429</option>
          <option value="timeout">timeout</option>
          <option value="NoRoute">NoRoute</option>
          <option value="success">success</option>
        </select>
      </label>
      <div className={styles.actions}>
        <Button
          disabled={result.status === 'requesting' || pending >= routingFixtureQueueLimit}
          onClick={() => {
            void store.getState().request();
            setPending(fixture.count());
          }}
        >
          경로 요청
        </Button>
        <Button
          disabled={pending === 0}
          onClick={() => {
            fixture.deliver();
            setPending(fixture.count());
          }}
        >
          대기 응답 전달
        </Button>
        <Button
          disabled={pending === 0}
          onClick={() => {
            fixture.deliver('latest');
            setPending(fixture.count());
          }}
        >
          최신 응답 전달
        </Button>
        <Button disabled={result.status !== 'requesting'} onClick={() => store.getState().cancel()}>
          경로 요청 취소
        </Button>
        <Button onClick={() => store.getState().editDestination()}>합성 도착점 바꾸기</Button>
      </div>
      <p>대기 응답: {pending}</p>
      {pending >= routingFixtureQueueLimit ? (
        <p>
          대기 응답 한도 {routingFixtureQueueLimit}개입니다. 응답을 전달한 뒤 새 요청을 실행하세요.
        </p>
      ) : null}
      <p>
        대기 응답 전달은 가장 오래된 응답, 최신 응답 전달은 가장 최근 응답을 전달합니다. 취소된
        요청의 응답도 전달해 늦은 응답이 무시되는지 확인할 수 있습니다. 자동 재시도는 없습니다.
      </p>
      <p role="status">경로 상태: {labels[result.status]}</p>
      {result.status === 'error' ? (
        <p role="alert">
          합성 오류: {result.reason}. 초안은 유지됩니다. 다시 요청하려면 경로 요청을 선택하세요.
        </p>
      ) : null}
      {result.status === 'computed' ? (
        <figure>
          <svg viewBox="0 0 100 100" role="img" aria-label="합성 계산 결과 · 실제 보행 경로 아님">
            <polyline points={result.points.map(({ x, y }) => `${x},${y}`).join(' ')} />
          </svg>
          <figcaption>합성 계산 결과</figcaption>
        </figure>
      ) : (
        <p>표시할 계산 경로가 없습니다. 출발점과 도착점의 직선을 성공 경로로 대체하지 않습니다.</p>
      )}
    </section>
  );
}
