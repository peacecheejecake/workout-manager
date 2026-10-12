import { GalleryPage } from '../gallery-page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default async function Page({ params }: { params: Promise<{ mediaItemId: string }> }) {
  const { mediaItemId } = await params;
  // Renditions are a mandatory profile27 member; baseline107 registers no rendition route.
  const renditionsEnabled =
    process.env['WORKOUT_RUNTIME_PROFILE'] === 'installed-current-profile27';
  const normalized = mediaItemId.toLowerCase();
  if (!UUID.test(normalized)) {
    return (
      <main className="wm-page">
        <p role="alert">미디어 주소가 올바르지 않습니다.</p>
      </main>
    );
  }
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/gallery">갤러리</a> · <a href="/dashboard">대시보드</a>
      </nav>
      <GalleryPage mediaItemId={normalized} renditionsEnabled={renditionsEnabled} />
    </main>
  );
}
