import { useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { activityCollectionProvenanceSchema } from '@workout/contracts/garmin-unofficial';
import styles from './collection-provenance.module.css';

export interface CollectionProvenanceProps {
  athleteId: string;
  sessionId: string;
  activityId: string;
  transport: AuthenticatedTransport;
}

/**
 * Which Garmin collector brought this activity in (M1-06b-tmp). An activity collected through
 * the temporary unofficial path always says so; a missing, failed or older-server read shows
 * no label rather than guessing one.
 */
export function CollectionProvenance({
  athleteId,
  sessionId,
  activityId,
  transport,
}: CollectionProvenanceProps) {
  const provenance = useQuery({
    queryKey: [
      'users',
      athleteId,
      'sessions',
      sessionId,
      'activity-browser',
      'collection-provenance',
      activityId,
    ],
    queryFn: async ({ signal }) => {
      const response = await transport.request({
        path: `/bff/v1/activities/${encodeURIComponent(activityId)}/collection-provenance`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted) throw new Error('CANCELLED');
      if (response.status !== 200) throw new Error('PROVENANCE_UNAVAILABLE');
      return activityCollectionProvenanceSchema.parse(response.body).provenance;
    },
  });
  const value = provenance.isSuccess ? provenance.data : null;
  if (!value) return null;
  if (value.provider === 'garmin-official')
    return <p className={styles.official}>Garmin 공식 연동으로 가져온 활동</p>;
  return (
    <div role="note" className={styles.unofficial}>
      <p>
        <strong>비공식 임시 Garmin 연결로 가져온 활동</strong>
      </p>
      <p>공식 Garmin 연동이 아닙니다. Garmin 내부 endpoint를 쓰는 임시 경로로 수집되었습니다.</p>
      <p>
        수집 시각: <time dateTime={value.collectedAt}>{value.collectedAt}</time>
      </p>
    </div>
  );
}
