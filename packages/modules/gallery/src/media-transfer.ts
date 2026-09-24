import type { GalleryMediaType } from '@workout/contracts/gallery';

export interface GalleryMediaUploadInput {
  uploadId: string;
  file: File;
  mediaType: GalleryMediaType;
  signal: AbortSignal;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
}

export interface GalleryMediaOpenInput {
  mediaItemId: string;
  variant: 'original' | 'preview';
  signal: AbortSignal;
}

export interface GalleryMediaTransfer {
  upload(input: GalleryMediaUploadInput): Promise<void>;
  /** Resolves to a blob URL the caller owns and revokes. */
  open(input: GalleryMediaOpenInput): Promise<string>;
}
