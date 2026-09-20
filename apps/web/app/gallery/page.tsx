import { galleryMediaKindSchema } from '@workout/contracts/gallery';
import { GalleryPage } from './gallery-page';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const mediaKind = galleryMediaKindSchema.safeParse(query['mediaKind']);
  const album = typeof query['album'] === 'string' ? query['album'] : null;
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/resources">자료실</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <GalleryPage mediaKind={mediaKind.success ? mediaKind.data : null} album={album} />
    </main>
  );
}
