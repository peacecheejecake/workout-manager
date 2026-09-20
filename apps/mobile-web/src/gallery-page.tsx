import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { GalleryWorkspace } from '@workout/modules-gallery/gallery-workspace';
import { galleryMediaKindSchema } from '@workout/contracts/gallery';
import type { GalleryMediaKind } from '@workout/contracts/gallery';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function Gallery({
  mediaItemId,
  mediaKind,
  album,
}: {
  mediaItemId: string | null;
  mediaKind: GalleryMediaKind | null;
  album: string | null;
}) {
  const session = useAuthenticatedSession();
  return (
    <GalleryWorkspace
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      mediaTransfer={{
        upload: (input) => session.fileTransfer.uploadGalleryMedia(input),
        open: (input) => session.fileTransfer.openGalleryMedia(input),
      }}
      mediaItemId={mediaItemId}
      mediaKind={mediaKind}
      album={album}
    />
  );
}

export function GalleryPage({ path, query }: { path: string; query: string }) {
  const candidate = path.match(/^\/gallery\/([^/]+)\/?$/)?.[1]?.toLowerCase() ?? null;
  if (candidate !== null && !UUID.test(candidate)) {
    return <p role="alert">미디어 주소가 올바르지 않습니다.</p>;
  }
  const parameters = new URLSearchParams(query);
  const mediaKind = galleryMediaKindSchema.safeParse(parameters.get('mediaKind'));
  const album = parameters.get('album');
  return (
    <AuthenticatedWorkspace>
      <Gallery
        mediaItemId={candidate}
        mediaKind={mediaKind.success ? mediaKind.data : null}
        album={album && album.trim() ? album.trim() : null}
      />
    </AuthenticatedWorkspace>
  );
}
