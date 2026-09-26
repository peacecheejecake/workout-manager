import {
  mapDataLicencePagePath,
  odblLicenceUrl,
  osmAttribution,
  osmCopyrightUrl,
} from '@workout/contracts/map-data-licence';

import styles from './courses.module.css';

/**
 * ODbL §4.2 wherever a computed route is shown (M0-06b-odbl).
 *
 * A route line comes from the pedestrian routing graph, a derived database of OpenStreetMap
 * data, so the screen that shows it carries the attribution, the OSM copyright link and the
 * licence URI — also when no background map is drawn, which is when the map's own
 * attribution line is absent. The last link is the public page with the alteration method.
 * Links send no referrer.
 */
export function RouteDataNotice() {
  return (
    <p className={styles.note} data-testid="route-data-notice">
      경로 데이터 {osmAttribution} ·{' '}
      <a href={osmCopyrightUrl} rel="noreferrer noopener" referrerPolicy="no-referrer">
        저작권·출처
      </a>{' '}
      ·{' '}
      <a href={odblLicenceUrl} rel="noreferrer noopener" referrerPolicy="no-referrer">
        ODbL 1.0 라이선스
      </a>{' '}
      · <a href={mapDataLicencePagePath}>지도 데이터 변경 방법</a>
    </p>
  );
}
