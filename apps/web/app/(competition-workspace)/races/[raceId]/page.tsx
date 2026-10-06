import { RaceDetailPage } from '../../../races/[raceId]/race-detail-page';

export default async function Page({ params }: { params: Promise<{ raceId: string }> }) {
  const { raceId } = await params;
  return <RaceDetailPage raceId={raceId} />;
}
