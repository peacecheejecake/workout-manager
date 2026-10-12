import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { galleryMediaNavigationV2Schema } from '@workout/contracts/gallery-navigation-v2';
import { galleryMediaNavigationV3Schema } from '@workout/contracts/gallery-navigation-v3';
import { GalleryCourseLink } from '../src/gallery-course-link';

afterEach(cleanup);
const link = {
  courseId: '10000000-0000-4000-8000-000000000003',
  courseRevision: 4,
  revisionId: '10000000-0000-4000-8000-000000000004',
};
function legacy(linked = true) {
  return galleryMediaNavigationV2Schema.parse({
    schemaVersion: 2,
    item: {
      id: '10000000-0000-4000-8000-000000000001',
      mediaKind: 'image',
      visibility: 'private',
      includeForCoach: false,
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
      file: {
        originalFileName: 'synthetic.png',
        mediaType: 'image/png',
        byteSize: 1,
        sha256: 'a'.repeat(64),
      },
      preview: null,
      accessRevision: 7,
      createdAt: '2026-10-09T00:00:00.000001Z',
      updatedAt: '2026-10-09T00:00:00.000001Z',
    },
    albumMembership: null,
    courseLink: linked ? link : null,
    capturedDay: { state: 'unknown' },
  });
}
function current(state: 'available' | 'unavailable' | null) {
  return galleryMediaNavigationV3Schema.parse({
    ...legacy(state !== null),
    schemaVersion: 3,
    courseAvailability: state === null ? null : { state },
  });
}
it('retains unavailable saved course/revision identifiers and prevents pointer and keyboard opening', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const dto = current('unavailable');
  render(<GalleryCourseLink navigation={dto} onOpen={open} />);
  const region = screen.getByRole('region', { name: '저장된 코스 연결' });
  expect(within(region).getByText('사용 불가')).toBeVisible();
  expect(within(region).queryByText(link.courseId)).not.toBeInTheDocument();
  expect(within(region).queryByText(link.revisionId)).not.toBeInTheDocument();
  expect(within(region).getByText('4', { selector: 'dd' })).toBeVisible();
  const button = within(region).getByRole('button', { name: '저장된 코스 버전 4 열기' });
  expect(button).toBeDisabled();
  await user.click(button);
  await user.tab();
  await user.keyboard('{Enter} ');
  expect(open).not.toHaveBeenCalled();
  expect(dto.courseLink).toEqual(link);
});
it('opens only an explicitly available V3 tuple once through keyboard activation', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(<GalleryCourseLink navigation={current('available')} onOpen={open} />);
  await user.tab();
  expect(screen.getByRole('button')).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(link);
});
it('does not manufacture unavailability or opening authority from a legacy V2 saved link', async () => {
  const open = vi.fn();
  render(<GalleryCourseLink navigation={legacy()} onOpen={open} />);
  expect(screen.getByText('사용 가능 여부 알 수 없음')).toBeVisible();
  expect(screen.queryByText('사용 불가')).not.toBeInTheDocument();
  expect(screen.queryByText(link.revisionId)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button'));
  expect(open).not.toHaveBeenCalled();
});
it.each([legacy(false), current(null)])(
  'distinguishes no saved link from an unavailable course',
  (navigation) => {
    render(<GalleryCourseLink navigation={navigation} onOpen={vi.fn()} />);
    expect(screen.getByText('연결된 코스 없음')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('사용 불가')).not.toBeInTheDocument();
  },
);
it('keeps an available read fact distinct from a missing host navigation capability', () => {
  render(<GalleryCourseLink navigation={current('available')} onOpen={null} />);
  expect(screen.getByText('사용 가능')).toBeVisible();
  expect(screen.getByText('현재 화면에서 코스 열기 기능을 사용할 수 없습니다.')).toBeVisible();
  expect(screen.getByRole('button')).toBeDisabled();
});
it('responds to new authoritative read facts without replacing the tuple or keeping a stale opening callback', async () => {
  const open = vi.fn();
  const { rerender } = render(
    <GalleryCourseLink navigation={current('available')} onOpen={open} />,
  );
  rerender(<GalleryCourseLink navigation={current('unavailable')} onOpen={open} />);
  await userEvent.click(screen.getByRole('button'));
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByText(link.revisionId)).not.toBeInTheDocument();
  rerender(<GalleryCourseLink navigation={legacy()} onOpen={open} />);
  expect(screen.getByText('사용 가능 여부 알 수 없음')).toBeVisible();
  expect(screen.getByRole('button')).toBeDisabled();
});
it('does not render availability as a known fact for a runtime-invalid typed caller value', () => {
  const invalid = { ...current('available'), courseLink: null };
  render(<GalleryCourseLink navigation={invalid} onOpen={vi.fn()} />);
  expect(screen.getByText('코스 연결 정보를 확인할 수 없음')).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText('사용 불가')).not.toBeInTheDocument();
});
