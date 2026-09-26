import type { Metadata } from 'next';
import { MapDataLicencePage } from './map-data-licence-page';

/**
 * The public ODbL page (M0-06b-odbl): the licence notice and the method used to alter the
 * OpenStreetMap extract for the tiles and the routing graph served right now. It needs no
 * sign-in and reads no session; the values are read in the browser from the public
 * deployment files and the API's public disclosure, so the page is never a stale prerender.
 */
export const metadata: Metadata = {
  title: '지도·경로 데이터 라이선스',
  description: 'OpenStreetMap 데이터 고지와 원본 추출물 변경 방법',
};

export default function Page() {
  return (
    <main className="wm-page">
      <MapDataLicencePage />
    </main>
  );
}
