import { GALLERY_IMAGE_MAX_BYTES, GALLERY_VIDEO_MAX_BYTES } from '@workout/contracts/gallery';
import { GalleryRequestError } from './gallery-api';

const byteFormatter = new Intl.NumberFormat('ko-KR');

// The content PUT runs through the Host file transfer, not the JSON API, so its
// failures arrive as a plain Error carrying the server error code.
const TRANSFER_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_MEDIA_SIGNATURE: '파일 내용이 선언한 형식과 일치하지 않습니다.',
  FILE_TOO_LARGE: '파일이 허용된 크기를 넘었습니다. 사진은 15 MiB, 동영상은 64 MiB까지 저장합니다.',
  UNSUPPORTED_FILE_TYPE: '지원하지 않는 파일 형식입니다.',
  EMPTY_UPLOAD: '빈 파일은 저장할 수 없습니다.',
  CONTENT_LENGTH_MISMATCH: '전송된 크기가 선언한 크기와 다릅니다.',
  UPLOAD_FAILED: '이 업로드는 종료됐습니다. 파일을 다시 선택해 올리세요.',
  UPLOAD_RETRY_REQUIRED: '업로드를 처음부터 다시 시도하세요.',
  UPLOAD_RESUME_REQUIRED: '업로드가 중단됐습니다. 같은 파일로 다시 시도하세요.',
  MEDIA_TRANSFER_UNAVAILABLE: '이 환경에서는 파일 전송을 사용할 수 없습니다.',
};

export function readableGalleryError(error: unknown) {
  if (error instanceof Error && !(error instanceof GalleryRequestError)) {
    // Exact allowlist membership only: an inherited key such as `constructor`
    // must fall through to the generic message, never reach the render.
    const known = Object.hasOwn(TRANSFER_MESSAGES, error.message)
      ? TRANSFER_MESSAGES[error.message]
      : undefined;
    if (known !== undefined) return known;
  }
  if (!(error instanceof GalleryRequestError)) return '요청을 완료하지 못했습니다.';
  // The same curated allowlist also covers codes the JSON API returns.
  const knownCode = Object.hasOwn(TRANSFER_MESSAGES, error.code)
    ? TRANSFER_MESSAGES[error.code]
    : undefined;
  if (knownCode !== undefined) return knownCode;
  if (error.status === 409) return '다른 변경이 먼저 저장되었습니다. 최신 상태를 다시 확인하세요.';
  if (error.status === 413)
    return `파일이 허용된 크기를 넘었습니다. 사진은 ${byteFormatter.format(
      GALLERY_IMAGE_MAX_BYTES,
    )} 바이트, 동영상은 ${byteFormatter.format(GALLERY_VIDEO_MAX_BYTES)} 바이트까지 저장합니다.`;
  if (error.status === 415) return TRANSFER_MESSAGES['UNSUPPORTED_FILE_TYPE'] ?? '';
  if (error.status === 422) return TRANSFER_MESSAGES['INVALID_MEDIA_SIGNATURE'] ?? '';
  if (error.status === 404) return '미디어를 찾을 수 없거나 열람 권한이 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}
