import { plannedSessionSchema, type PlannedSession } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { heartRateTargetLabel, paceTargetLabel } from './session-target-labels';
import styles from './session-target-fields.module.css';

export type SessionTargetPatch = Pick<PlannedSession, 'paceTarget' | 'heartRateTarget'>;
export interface SessionTargetFieldsProps {
  session: PlannedSession;
  disabled: boolean;
  onChange(patch: SessionTargetPatch): void;
}
const inputValue = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? '' : value;
const enteredNumber = (text: string) => (text === '' ? Number.NaN : Number(text));

export function SessionTargetFields({ session, disabled, onChange }: SessionTargetFieldsProps) {
  const pace = session.paceTarget;
  const heartRate = session.heartRateTarget;
  const paceError = plannedSessionSchema.shape.paceTarget.safeParse(pace).success
    ? undefined
    : '빠른 경계와 느린 경계를 모두 입력하세요. 0보다 크고 86400 이하인 초/km이며 빠른 경계는 느린 경계보다 작거나 같아야 합니다.';
  const heartRateError = plannedSessionSchema.shape.heartRateTarget.safeParse(heartRate).success
    ? undefined
    : '하한과 상한을 모두 입력하세요. 1~1000의 정수 bpm이며 하한은 상한보다 작거나 같아야 합니다.';
  function editPace(key: 'minSecondsPerKm' | 'maxSecondsPerKm', value: string) {
    if (disabled) return;
    onChange({
      paceTarget: {
        minSecondsPerKm: pace?.minSecondsPerKm ?? Number.NaN,
        maxSecondsPerKm: pace?.maxSecondsPerKm ?? Number.NaN,
        [key]: enteredNumber(value),
      },
    });
  }
  function editHeartRate(key: 'minBpm' | 'maxBpm', value: string) {
    if (disabled) return;
    onChange({
      heartRateTarget: {
        minBpm: heartRate?.minBpm ?? Number.NaN,
        maxBpm: heartRate?.maxBpm ?? Number.NaN,
        [key]: enteredNumber(value),
      },
    });
  }
  return (
    <div className={styles.targets}>
      <fieldset disabled={disabled} className={styles.target}>
        <legend>목표 페이스</legend>
        <p>초/km 단위입니다. 숫자가 작을수록 빠르며 두 경계가 같으면 단일 목표입니다.</p>
        <TextField
          label="목표 페이스 빠른 경계 (초/km)"
          type="number"
          step="any"
          min="0"
          max="86400"
          value={inputValue(pace?.minSecondsPerKm)}
          {...(paceError ? { error: paceError } : {})}
          onChange={(event) => editPace('minSecondsPerKm', event.target.value)}
        />
        <TextField
          label="목표 페이스 느린 경계 (초/km)"
          type="number"
          step="any"
          min="0"
          max="86400"
          value={inputValue(pace?.maxSecondsPerKm)}
          {...(paceError ? { error: paceError } : {})}
          onChange={(event) => editPace('maxSecondsPerKm', event.target.value)}
        />
        <p>목표 페이스: {paceTargetLabel(pace)}</p>
        <Button
          variant="secondary"
          onClick={() => {
            if (!disabled) onChange({ paceTarget: null });
          }}
        >
          목표 페이스 비우기
        </Button>
      </fieldset>
      <fieldset disabled={disabled} className={styles.target}>
        <legend>목표 심박</legend>
        <p>bpm 단위입니다. 두 경계가 같으면 단일 목표이며 실측값이나 권장 강도가 아닙니다.</p>
        <TextField
          label="목표 심박 하한 (bpm)"
          type="number"
          step="1"
          min="1"
          max="1000"
          value={inputValue(heartRate?.minBpm)}
          {...(heartRateError ? { error: heartRateError } : {})}
          onChange={(event) => editHeartRate('minBpm', event.target.value)}
        />
        <TextField
          label="목표 심박 상한 (bpm)"
          type="number"
          step="1"
          min="1"
          max="1000"
          value={inputValue(heartRate?.maxBpm)}
          {...(heartRateError ? { error: heartRateError } : {})}
          onChange={(event) => editHeartRate('maxBpm', event.target.value)}
        />
        <p>목표 심박: {heartRateTargetLabel(heartRate)}</p>
        <Button
          variant="secondary"
          onClick={() => {
            if (!disabled) onChange({ heartRateTarget: null });
          }}
        >
          목표 심박 비우기
        </Button>
      </fieldset>
    </div>
  );
}
