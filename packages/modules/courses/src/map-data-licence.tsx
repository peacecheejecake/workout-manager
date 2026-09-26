import { useEffect, useState } from 'react';
import {
  odblLicenceUrl,
  osmAttribution,
  osmCopyrightUrl,
  type BasemapDataDisclosure,
  type GeoDatasetsDisclosure,
  type GeoDatasetsLicenceState,
  type RoutingDataDisclosure,
} from '@workout/contracts/map-data-licence';

import {
  readMapDataLicence,
  type BasemapLicenceState,
  type MapDataLicenceState,
  type RoutingLicenceState,
} from './map-data-licence-api';
import styles from './courses.module.css';
import page from './map-data-licence.module.css';

/**
 * The public map-data licence page (M0-06b-odbl, `/map-data-licence` in both shells).
 *
 * It needs no sign-in and reads no session. It states the ODbL notice (§4.2) and, for the
 * background tile deployment, routing graph and place/elevation datasets being served right
 * now, the method used to alter the OpenStreetMap extract (§4.6 option (b)). Every value comes from the
 * deployments' own build records as they are read now; the page types none of them.
 */
export interface MapDataLicenceViewProps {
  /** Test seam; the shells use the browser's fetch. */
  readonly fetcher?: typeof fetch;
}

type ViewState =
  { readonly status: 'loading' } | ({ readonly status: 'ready' } & MapDataLicenceState);

export function MapDataLicenceView({ fetcher }: MapDataLicenceViewProps) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void readMapDataLicence(fetcher, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ status: 'ready', ...result });
    });
    return () => controller.abort();
  }, [fetcher]);

  return (
    <article className={page.page} aria-labelledby="map-data-licence-title">
      <h1 id="map-data-licence-title">지도·경로 데이터 라이선스</h1>
      <section aria-labelledby="map-data-notice">
        <h2 id="map-data-notice">고지</h2>
        <p data-testid="map-data-notice">
          지도와 보행 경로는 OpenStreetMap 데이터로 만들었습니다. 데이터 {osmAttribution}.{' '}
          <a href={osmCopyrightUrl} rel="noreferrer noopener" referrerPolicy="no-referrer">
            {osmCopyrightUrl}
          </a>
        </p>
        <p>
          이 데이터와 여기서 만든 배경 타일·보행 경로 graph·장소·고도 데이터셋은 Open Database
          License 1.0을 따릅니다.{' '}
          <a href={odblLicenceUrl} rel="noreferrer noopener" referrerPolicy="no-referrer">
            {odblLicenceUrl}
          </a>
        </p>
        <p className={styles.note}>
          아래는 원본 추출물을 바꾼 방법입니다. 각 값은 지금 제공 중인 배포본의 빌드 기록에서
          읽었습니다.
        </p>
      </section>
      {state.status === 'loading' ? (
        <p role="status">배포 기록을 읽는 중입니다.</p>
      ) : (
        <>
          <BasemapSection state={state.basemap} />
          <RoutingSection state={state.routing} />
          <GeoDatasetsSection state={state.geoDatasets} />
        </>
      )}
    </article>
  );
}

function GeoDatasetsSection({ state }: { readonly state: GeoDatasetsLicenceState }) {
  return (
    <section aria-labelledby="map-data-geo-datasets" data-testid="map-data-geo-datasets">
      <h2 id="map-data-geo-datasets">장소·고도 데이터</h2>
      {state.kind === 'none' ? <p>이 서버는 장소·고도 데이터셋을 제공하지 않습니다.</p> : null}
      {state.kind === 'unavailable' ? (
        <p role="alert">장소·고도 데이터셋의 배포 기록을 확인하지 못했습니다.</p>
      ) : null}
      {state.kind === 'undisclosed' ? (
        <p role="alert" data-testid="map-data-geo-undisclosed">
          배포된 장소 데이터셋 {state.placesDatasetId ?? '없음'}·고도 데이터셋{' '}
          {state.elevationDatasetId ?? '없음'}의 변경 방법 기록이 없습니다. 기록을 함께 싣도록 다시
          빌드해야 배포할 수 있습니다.
        </p>
      ) : null}
      {state.kind === 'disclosed' ? (
        <GeoDatasetsDisclosureView disclosure={state.disclosure} />
      ) : null}
    </section>
  );
}

function GeoDatasetsDisclosureView({ disclosure }: { readonly disclosure: GeoDatasetsDisclosure }) {
  const { source, alterationMethod: method, toolVersions } = disclosure;
  return (
    <>
      <dl className={styles.summary}>
        <dt>장소 데이터셋</dt>
        <dd data-testid="map-data-places-dataset">{disclosure.datasets.placesDatasetId}</dd>
        <dt>고도 데이터셋</dt>
        <dd data-testid="map-data-elevation-dataset">{disclosure.datasets.elevationDatasetId}</dd>
        <dt>원본 추출물</dt>
        <dd data-testid="map-data-geo-extract-url">{source.acquisition.url}</dd>
        <dt>추출물 SHA-256</dt>
        <dd>
          <code>{source.sha256}</code> ({source.bytes.toLocaleString('ko-KR')} bytes)
        </dd>
        <dt>Last-Modified</dt>
        <dd>
          {source.acquisition.lastModified ?? '기록 없음'} ({recordedByText(source.acquisition)})
        </dd>
        <dt>도구</dt>
        <dd>
          osmium {toolVersions.osmium ?? '알 수 없음'} · node {toolVersions.node}
        </dd>
      </dl>
      <h3>변경 방법</h3>
      <p>{method.description}</p>
      <h4>장소 추출 필터</h4>
      <ul>
        {method.placeFilters.map((filter) => (
          <li key={filter}>
            <code>{filter}</code>
          </li>
        ))}
      </ul>
      <h4>고도 추출 필터</h4>
      <ul>
        {method.elevationFilters.map((filter) => (
          <li key={filter}>
            <code>{filter}</code>
          </li>
        ))}
      </ul>
      <p>고도값 연결 최대 거리: {method.maxElevationSourceDistanceMeters}m.</p>
      <ScriptHashes scripts={method.scripts} />
    </>
  );
}

function BasemapSection({ state }: { readonly state: BasemapLicenceState }) {
  return (
    <section aria-labelledby="map-data-basemap" data-testid="map-data-basemap">
      <h2 id="map-data-basemap">배경 지도 타일</h2>
      {state.kind === 'none' ? <p>이 서버는 배경 지도 타일을 제공하지 않습니다.</p> : null}
      {state.kind === 'unavailable' ? (
        <p role="alert">배경 지도 배포 기록을 읽지 못했습니다.</p>
      ) : null}
      {state.kind === 'undisclosed' ? (
        <p role="alert" data-testid="map-data-basemap-undisclosed">
          지금 제공 중인 배포본 {state.deploymentId}에는 변경 방법 기록이 없습니다. 이 배포본은 변경
          방법을 함께 싣도록 다시 빌드해야 배포할 수 있습니다.
        </p>
      ) : null}
      {state.kind === 'disclosed' ? <BasemapDisclosure disclosure={state.disclosure} /> : null}
    </section>
  );
}

function BasemapDisclosure({ disclosure }: { readonly disclosure: BasemapDataDisclosure }) {
  const { source, alterationMethod: method, toolVersions } = disclosure;
  return (
    <>
      <dl className={styles.summary}>
        <dt>배포본</dt>
        <dd data-testid="map-data-deployment">{disclosure.deploymentId}</dd>
        <dt>빌드</dt>
        <dd>{disclosure.buildId}</dd>
        <dt>지역</dt>
        <dd>{disclosure.region}</dd>
        <dt>원본 추출물</dt>
        <dd>
          <span data-testid="map-data-basemap-extract-url">{source.acquisition.url}</span>
        </dd>
        <dt>추출물 SHA-256</dt>
        <dd>
          <code>{source.sha256}</code> ({source.bytes.toLocaleString('ko-KR')} bytes)
        </dd>
        <dt>Last-Modified</dt>
        <dd>
          {source.acquisition.lastModified ?? '기록 없음'} ({recordedByText(source.acquisition)})
        </dd>
        <dt>도구</dt>
        <dd>
          osmium {toolVersions.osmium ?? '알 수 없음'} · tippecanoe{' '}
          {toolVersions.tippecanoe ?? '알 수 없음'} · node {toolVersions.node}
        </dd>
      </dl>
      <h3>변경 방법</h3>
      <p>{method.description}</p>
      <ol>
        {method.layerFilters.map((filter) => (
          <li key={filter.layer}>
            레이어 {filter.layer}: <code>osmium tags-filter {filter.expressions.join(' ')}</code>
          </li>
        ))}
        <li>
          osmium export: <code>{method.osmiumExportFormat}</code>
        </li>
        <li>
          <code>tippecanoe {method.tippecanoeArguments.join(' ')}</code>
        </li>
        <li>
          zoom {method.minzoom}–{method.maxzoom}, glyph 구간 {method.glyphRanges.join(', ')}
        </li>
      </ol>
      <ScriptHashes scripts={method.scripts} />
    </>
  );
}

function RoutingSection({ state }: { readonly state: RoutingLicenceState }) {
  return (
    <section aria-labelledby="map-data-routing" data-testid="map-data-routing">
      <h2 id="map-data-routing">보행 경로 graph</h2>
      {state.kind === 'none' ? <p>이 서버는 경로를 계산하지 않습니다.</p> : null}
      {state.kind === 'unavailable' ? <p role="alert">경로 graph 기록을 읽지 못했습니다.</p> : null}
      {state.kind === 'disclosed' ? <RoutingDisclosure disclosure={state.disclosure} /> : null}
    </section>
  );
}

function RoutingDisclosure({ disclosure }: { readonly disclosure: RoutingDataDisclosure }) {
  const { graph, engine, profile, extract, derivation } = disclosure;
  const barriers = derivation?.militaryPerimeterBarriers ?? null;
  return (
    <>
      {disclosure.artifactNotice === 'verified' ? null : (
        <p role="alert" data-testid="map-data-routing-notice-state">
          {disclosure.artifactNotice === 'missing'
            ? '이 graph 산출물 안에는 라이선스 고지 파일이 없습니다. 고지를 함께 싣도록 다시 가져와야(import) 배포할 수 있습니다.'
            : '이 graph 산출물 안의 라이선스 고지가 graph 기록과 다릅니다.'}
        </p>
      )}
      <dl className={styles.summary}>
        <dt>graph</dt>
        <dd data-testid="map-data-graph">{graph.graphBuildId}</dd>
        <dt>graph 내용 SHA-256</dt>
        <dd>
          <code>{graph.graphContentSha256}</code>
        </dd>
        <dt>엔진</dt>
        <dd>
          {engine.engine} {engine.engineVersion} (artifact SHA-256{' '}
          <code>{engine.engineArtifactSha256}</code>)
        </dd>
        <dt>프로필</dt>
        <dd>
          {profile.profileId} “{profile.profileName}” (설정 SHA-256{' '}
          <code>{profile.profileConfigSha256}</code>)
        </dd>
        <dt>원본 추출물</dt>
        <dd>
          {extract.region} · SHA-256 <code>{extract.sha256}</code> (
          {extract.byteLength.toLocaleString('ko-KR')} bytes)
        </dd>
        <dt>추출물 주소·Last-Modified</dt>
        <dd>
          {extract.acquisition === null
            ? '이 graph의 빌드 기록에 없음'
            : `${extract.acquisition.url} · ${extract.acquisition.lastModified ?? '기록 없음'} (${recordedByText(extract.acquisition)})`}
        </dd>
        <dt>도로 데이터 시점</dt>
        <dd>{graph.roadDataAt}</dd>
        <dt>가져온 시각</dt>
        <dd>{graph.graphImportedAt}</dd>
      </dl>
      <h3>변경 방법</h3>
      {derivation === null ? (
        <p>파생 단계 기록이 없습니다. 추출물을 바꾸지 않고 그대로 가져온 graph입니다.</p>
      ) : (
        <ol>
          {barriers === null ? null : (
            <li data-testid="map-data-military-barriers">
              군사 구역 경계 차단: 보행 가능한 길이 <code>landuse=military</code>·
              <code>military=*</code> 면을 합친 경계를 지나는 곳에 barrier node를 넣었습니다. 도구{' '}
              {barriers.tool} (SHA-256 <code>{barriers.toolSha256}</code>),{' '}
              {derivation.osmium ?? 'osmium 버전 기록 없음'}. 변경 파일 SHA-256{' '}
              <code>{barriers.changesSha256}</code>, 파생 추출물 SHA-256{' '}
              <code>{barriers.derivedExtractSha256}</code>. 개수:{' '}
              {Object.entries(barriers.summary)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => `${key} ${value}`)
                .join(', ')}
            </li>
          )}
          {derivation.timeConditionalWays === null ? null : (
            <li>
              시간 조건 통행 way {derivation.timeConditionalWays}개 목록(경고만 붙이고 경로는 바꾸지
              않음)
            </li>
          )}
          <li>
            {engine.engine} {engine.engineVersion}로 프로필 {profile.profileId}에 따라 가져오기
          </li>
        </ol>
      )}
    </>
  );
}

function ScriptHashes({ scripts }: { readonly scripts: Readonly<Record<string, string>> }) {
  const entries = Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right));
  return (
    <>
      <h3>빌드 스크립트</h3>
      <ul>
        {entries.map(([path, sha256]) => (
          <li key={path}>
            {path} · SHA-256 <code>{sha256}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

function recordedByText(acquisition: { readonly recordedBy: string }): string {
  switch (acquisition.recordedBy) {
    case 'download-response':
      return '이 빌드의 다운로드 응답';
    case 'acquisition-record':
      return '다운로드 때 남긴 기록';
    case 'earlier-build-report':
      return '같은 파일을 받은 이전 빌드 기록';
    default:
      return '기록 없음';
  }
}
