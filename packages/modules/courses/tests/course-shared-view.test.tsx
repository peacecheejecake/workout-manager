import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mapDataLicencePagePath,
  odblLicenceUrl,
  osmCopyrightUrl,
} from '@workout/contracts/map-data-licence';
import type { MapViewProps } from '@workout/geo-kit/map-view';

import { SharedCourseView } from '../src/course-shared-view';

/**
 * The recipient's screen (M2-01k-o §3 B, T14, T16, T24, B-3, B-8, R-4), in jsdom. The same
 * facts in a real browser — requests, Referer, external origins — are the shells' E2E.
 */
const token = 'Tk_'.padEnd(43, 'x');
const answer = {
  coordinates: [
    [127.02227, 37.5],
    [127.03, 37.51],
  ],
  waypoints: [
    { role: 'start', position: [127.02227, 37.5] },
    { role: 'finish', position: [127.03, 37.51] },
  ],
  distanceMeters: 1400,
  expiresOn: '2026-10-02',
  routeDataNotice: true,
};

function FakeMap(props: MapViewProps) {
  return (
    <div data-testid="fake-map">
      {props.paths.length} · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>
    </div>
  );
}

function FakeMapWithoutAttribution() {
  return <div data-testid="fake-map">지도 배경 없음</div>;
}

beforeEach(() => {
  window.history.replaceState(null, '', `/shared/course#${token}`);
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('the shared course view', () => {
  it('loads nothing and reads no fragment before "코스 보기" (R-4, T14)', async () => {
    const fetcher = vi.fn();
    const sendBeacon = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, sendBeacon });
    render(<SharedCourseView fetcher={fetcher} mapView={FakeMap} />);
    expect(screen.getByRole('button', { name: '코스 보기' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fake-map')).toBeNull();
    expect(screen.queryByTestId('route-data-notice')).toBeNull();
    expect(window.location.hash).toBe(`#${token}`);
  });

  it('removes the fragment first, then reads with a POST body, no credentials and no referrer', async () => {
    const seen: { hash: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ hash: window.location.hash, init });
      return new Response(JSON.stringify(answer), { status: 200 });
    });
    render(<SharedCourseView fetcher={fetcher as typeof fetch} mapView={FakeMap} />);
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    expect(await screen.findByTestId('shared-course-expiry')).toHaveTextContent('2026-10-02');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/bff/v1/shared/course');
    // The fragment was already gone when the request went out.
    expect(seen[0]?.hash).toBe('');
    expect(window.location.href).not.toContain(token);
    expect(seen[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ token });
  });

  it('shows the allowlist only: no trim wording, no download, a no-referrer attribution link', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    const { container } = render(<SharedCourseView fetcher={fetcher} mapView={FakeMap} />);
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    await screen.findByTestId('fake-map');
    // B-3: nothing on this screen says a line was cut, or where a protected place is.
    expect(container.textContent).not.toMatch(/보호 구역|제거|잘린|trim/);
    // D5 / T16: no download control of any kind.
    expect(screen.queryByRole('button', { name: /다운로드|GPX|내보내기|받기/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /다운로드|GPX|내보내기/ })).toBeNull();
    expect(screen.getByRole('list', { name: '코스 지점' })).toHaveTextContent('출발');
    // B-8: all external attribution links leave without a referrer.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: '© OpenStreetMap' })).toHaveAttribute(
        'rel',
        'noreferrer noopener',
      ),
    );
    expect(container.querySelectorAll('a[href^="http"]')).toHaveLength(3);
    for (const anchor of container.querySelectorAll('a[href^="http"]')) {
      expect(anchor).toHaveAttribute('rel', 'noreferrer noopener');
      expect(anchor).toHaveAttribute('referrerpolicy', 'no-referrer');
    }
  });

  it('shows routed data attribution with no basemap, and omits it for a recorded course', async () => {
    const routedFetcher = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    const routed = render(
      <SharedCourseView fetcher={routedFetcher} mapView={FakeMapWithoutAttribution} />,
    );
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    expect(await screen.findByTestId('fake-map')).toHaveTextContent('지도 배경 없음');
    const notice = screen.getByTestId('route-data-notice');
    expect(notice).toHaveTextContent('OpenStreetMap');
    expect(screen.getByRole('link', { name: '저작권·출처' })).toHaveAttribute(
      'href',
      osmCopyrightUrl,
    );
    expect(screen.getByRole('link', { name: 'ODbL 1.0 라이선스' })).toHaveAttribute(
      'href',
      odblLicenceUrl,
    );
    expect(screen.getByRole('link', { name: '지도 데이터 변경 방법' })).toHaveAttribute(
      'href',
      mapDataLicencePagePath,
    );
    routed.unmount();

    const recordedFetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...answer, routeDataNotice: false }), { status: 200 }),
    );
    render(<SharedCourseView fetcher={recordedFetcher} mapView={FakeMapWithoutAttribution} />);
    window.history.replaceState(null, '', `/shared/course#${token}`);
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    await screen.findByTestId('fake-map');
    expect(screen.queryByTestId('route-data-notice')).toBeNull();
  });

  it('says the same thing for every link that is not there', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }),
    );
    render(<SharedCourseView fetcher={fetcher} mapView={FakeMap} />);
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '이 링크로 볼 수 있는 코스가 없습니다.',
    );
    expect(screen.queryByTestId('fake-map')).toBeNull();
    expect(screen.queryByTestId('route-data-notice')).toBeNull();
  });

  it('does not ask the server at all when the address carries no token', async () => {
    window.history.replaceState(null, '', '/shared/course');
    const fetcher = vi.fn();
    render(<SharedCourseView fetcher={fetcher} mapView={FakeMap} />);
    await userEvent.click(screen.getByRole('button', { name: '코스 보기' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
