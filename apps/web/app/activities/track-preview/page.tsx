import { TrackPreviewPage } from './track-preview-page';

export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/activities">활동 목록</a> · <a href="/activities/import">활동 가져오기</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <h1>기록 파일 미리보기</h1>
      <TrackPreviewPage />
    </main>
  );
}
