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
  // Navigation and renditions are mandatory members of profile27 (no separate switch). The
  // same runtime profile as the API composition: under baseline107 the API registers neither,
  // so the page keeps the legacy list and shows no rendition panel.
  const profile27 = process.env['WORKOUT_RUNTIME_PROFILE'] === 'installed-current-profile27';
  const navigationEnabled = profile27;
  const renditionsEnabled = profile27;
  const raw = query['query'];
  const navigationSearch = !navigationEnabled
    ? null
    : typeof raw === 'string'
      ? new URLSearchParams({ query: raw }).toString()
      : Array.isArray(raw)
        ? new URLSearchParams(raw.map((value) => ['query', value])).toString()
        : '';
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/resources">자료실</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <GalleryPage
        mediaKind={mediaKind.success ? mediaKind.data : null}
        album={album}
        navigationSearch={navigationSearch}
        renditionsEnabled={renditionsEnabled}
      />
    </main>
  );
}
