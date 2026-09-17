import { useRef, useState } from 'react';
import { periodDraftSchema, type PeriodDraft } from '@workout/contracts/planning';
import { localDateSchema } from '@workout/contracts/primitives';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import styles from './period-constraints.module.css';

export function PeriodConstraintsEditor({
  period,
  onChange,
}: {
  period: PeriodDraft;
  onChange(constraints: NonNullable<PeriodDraft['constraints']>): void;
}) {
  const [unavailable, setUnavailable] = useState(''),
    [date, setDate] = useState(''),
    [seconds, setSeconds] = useState(''),
    [error, setError] = useState('');
  const addUnavailable = useRef<HTMLButtonElement>(null),
    addLimit = useRef<HTMLButtonElement>(null),
    clearButton = useRef<HTMLButtonElement>(null);
  const constraints = period.constraints ?? { unavailableDates: [], dailyTimeLimits: [] };
  function checkDate(value: string) {
    return (
      localDateSchema.safeParse(value).success &&
      value >= period.startDate &&
      value < period.endDateExclusive
    );
  }
  function add(kind: 'unavailable' | 'limit') {
    const selected = kind === 'unavailable' ? unavailable : date;
    if (!checkDate(selected)) {
      setError('조건 날짜는 이 기간의 시작일부터 종료일 전날까지 지정하세요.');
      return;
    }
    if (
      (kind === 'unavailable'
        ? constraints.unavailableDates
        : constraints.dailyTimeLimits.map((item) => item.date)
      ).includes(selected)
    ) {
      setError('같은 날짜가 이미 있습니다. 기존 항목을 수정하거나 삭제하세요.');
      return;
    }
    if (
      (kind === 'unavailable'
        ? constraints.unavailableDates.length
        : constraints.dailyTimeLimits.length) >= 3660
    ) {
      setError('각 제약 목록은 최대 3,660개 날짜까지 작성할 수 있습니다.');
      return;
    }
    if (
      kind === 'limit' &&
      (seconds === '' ||
        !Number.isInteger(Number(seconds)) ||
        Number(seconds) < 0 ||
        Number(seconds) > 86400)
    ) {
      setError('운동 가능 시간을 0–86,400 사이의 정수 초로 입력하세요. 빈칸은 0이 아닙니다.');
      return;
    }
    const next =
      kind === 'unavailable'
        ? { ...constraints, unavailableDates: [...constraints.unavailableDates, selected] }
        : {
            ...constraints,
            dailyTimeLimits: [
              ...constraints.dailyTimeLimits,
              { date: selected, availableSeconds: Number(seconds) },
            ],
          };
    // Existing invalid edits remain in the draft; only the new row is validated here.
    if (kind === 'limit')
      periodDraftSchema.shape.constraints
        .unwrap()
        .shape.dailyTimeLimits.element.parse(next.dailyTimeLimits.at(-1));
    onChange(next);
    setError('');
    if (kind === 'unavailable') setUnavailable('');
    else {
      setDate('');
      setSeconds('');
    }
  }
  return (
    <section className={styles.editor} aria-label="기간 직접 제약 편집">
      <h4>직접 지정한 기간 제약</h4>
      <p>
        {period.timezone}의 현지 날짜를 사용합니다. 가용 시간은 시각창이 아닌 날짜별 운동 가능
        시간량이며 0초와 미지정을 구분합니다. 날짜를 바꾸려면 항목을 삭제하고 추가하세요.
      </p>
      <div className={styles.fields}>
        <TextField
          label="운동 불가 날짜"
          type="date"
          value={unavailable}
          onChange={(event) => setUnavailable(event.target.value)}
        />
        <Button ref={addUnavailable} variant="secondary" onClick={() => add('unavailable')}>
          운동 불가 날짜 추가
        </Button>
      </div>
      <ul className={styles.rows}>
        {constraints.unavailableDates.map((value) => (
          <li key={value}>
            {value} · 운동 불가{' '}
            <Button
              variant="secondary"
              onClick={() => {
                onChange({
                  ...constraints,
                  unavailableDates: constraints.unavailableDates.filter((item) => item !== value),
                });
                addUnavailable.current?.focus();
              }}
            >
              {value} 운동 불가 날짜 삭제
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.fields}>
        <TextField
          label="가용 시간 날짜"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label="운동 가능 시간 (초)"
          type="number"
          min="0"
          max="86400"
          step="1"
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
        />
        <Button ref={addLimit} variant="secondary" onClick={() => add('limit')}>
          가용 시간 추가
        </Button>
      </div>
      <ul className={styles.rows}>
        {constraints.dailyTimeLimits.map((item) => (
          <li key={item.date}>
            <TextField
              label={`${item.date} 운동 가능 시간 (초)`}
              type="number"
              min="0"
              max="86400"
              step="1"
              value={Number.isFinite(item.availableSeconds) ? item.availableSeconds : ''}
              onChange={(event) =>
                onChange({
                  ...constraints,
                  dailyTimeLimits: constraints.dailyTimeLimits.map((row) =>
                    row.date === item.date
                      ? {
                          ...row,
                          availableSeconds:
                            event.target.value === '' ? Number.NaN : Number(event.target.value),
                        }
                      : row,
                  ),
                })
              }
            />
            {!Number.isInteger(item.availableSeconds) ||
            item.availableSeconds < 0 ||
            item.availableSeconds > 86400 ? (
              <p role="alert">
                {item.date}: 운동 가능 시간을 0–86,400 정수 초로 입력하세요. 빈칸은 0이 아닙니다.
              </p>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                onChange({
                  ...constraints,
                  dailyTimeLimits: constraints.dailyTimeLimits.filter(
                    (row) => row.date !== item.date,
                  ),
                });
                addLimit.current?.focus();
              }}
            >
              {item.date} 가용 시간 삭제
            </Button>
          </li>
        ))}
      </ul>
      <Button
        ref={clearButton}
        variant="secondary"
        onClick={() => {
          onChange({ unavailableDates: [], dailyTimeLimits: [] });
          setError('');
          clearButton.current?.focus();
        }}
      >
        이 기간의 직접 제약 모두 해제
      </Button>
      <p>
        조상 기간의 조건은 여기서 해제되지 않습니다. 기간을 줄여 조건 날짜가 범위를 벗어나면 날짜를
        직접 수정해야 합니다.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
