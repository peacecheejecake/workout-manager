'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  courseLimits,
  type CoursePosition,
  type CourseReadResult,
} from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';

import { CourseRequestError } from './course-api';
import { encodeBase64, readFileBytes, type CourseExtrasApi } from './course-extras-api';
import styles from './courses.module.css';

/**
 * The rest of S13/S14 on screen (M2-01j): importing a GPX file, the owner's private
 * preferences, protected areas and the derived revision that removes them, place search
 * and the elevation the dataset actually knows.
 *
 * Each panel says what it does not know as plainly as what it does. An import reports what
 * it refused to promote, elevation reports how many points it has no fact for, and the
 * surface, stairs and night-access notes say "unknown" because our data carries none of
 * them — a missing fact is never shown as a satisfied one.
 */
export type { CourseExtrasApi };

/**
 * Ownership for anything that comes back later.
 *
 * Five defects in this repository have had the same shape: an operation that outlives the
 * thing it belongs to and then writes to the screen anyway. A read of a file the owner has
 * replaced, an import response for a selection that is gone, a search answer for a query
 * nobody is looking at any more. Adding one more check at one more call site fixes one of
 * them; this fixes the shape.
 *
 * `claim()` starts an attempt and hands back `owns()`, which is true only while that
 * attempt is still the latest. Every panel below calls it once where the work starts, and
 * every point where an awaited operation comes back — success, refusal **and** the
 * `finally` that says the panel is idle again — is behind it.
 */
function useLatest(): () => () => boolean {
  const counter = useRef(0);
  return useCallback(() => {
    counter.current += 1;
    const mine = counter.current;
    return () => counter.current === mine;
  }, []);
}

/**
 * A decimal a person actually typed, or `null`.
 *
 * `Number('')` and `Number('   ')` are **0**, which is a real coordinate off the coast of
 * Africa and a real radius. Leaving a field empty used to send that 0 as if the owner had
 * meant it, which put a protected area somewhere they never chose. An empty field is a
 * missing value, and a missing value is not a zero.
 */
export function decimalOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readableExtrasError(error: unknown): string {
  if (!(error instanceof CourseRequestError)) return '요청을 완료하지 못했습니다.';
  switch (error.code) {
    case 'COURSE_IMPORT_SPANS_A_GAP':
      return '이 파일의 기록은 끊긴 구간이 여러 개입니다. 끊긴 곳을 직선으로 잇지 않으므로 코스로 가져오지 않았습니다.';
    case 'COURSE_IMPORT_NAME_REQUIRED':
      return '파일에 이름이 없습니다. 코스 이름을 입력하세요.';
    case 'COURSE_IMPORT_TOO_FEW_POSITIONS':
      return '좌표가 2개 미만이라 선으로 만들 수 없습니다.';
    case 'COURSE_IMPORT_TOO_MANY_VERTICES':
      return '좌표 수가 한도를 넘습니다.';
    case 'COURSE_IMPORT_FORMAT_UNSUPPORTED':
      return 'GPX 파일만 코스로 가져올 수 있습니다.';
    case 'TRACK_ARCHIVE_REJECTED':
      return '압축 파일은 받지 않습니다. GPX 파일 자체를 선택하세요.';
    case 'TRACK_FILE_TOO_LARGE':
      return '파일이 너무 큽니다.';
    case 'TRACK_XML_DTD_BLOCKED':
    case 'TRACK_XML_ENTITY_BLOCKED':
      return '이 파일은 외부 참조를 포함하고 있어 읽지 않았습니다.';
    case 'COURSE_TRIM_NO_PROTECTED_AREA':
      return '보호 구역이 없습니다. 먼저 보호 구역을 추가하세요.';
    case 'COURSE_TRIM_CHANGES_NOTHING':
      return '이 코스는 보호 구역을 지나지 않습니다. 제거할 좌표가 없습니다.';
    case 'COURSE_TRIM_SPLITS_THE_LINE':
      return '이 코스는 보호 구역에 다시 들어옵니다. 가운데를 지우면 선이 둘로 갈라지고, 그 사이를 직선으로 잇지 않으므로 만들지 않았습니다.';
    // A different fact, and it used to be told as the one above: every vertex is outside
    // the area but the drawn line runs through or along it. Nothing re-enters, so saying
    // "다시 들어옵니다" described something that did not happen.
    case 'COURSE_TRIM_LINE_CROSSES_AREA':
      return '이 코스의 정점은 모두 보호 구역 밖이지만, 정점 사이를 잇는 선이 보호 구역을 지나갑니다. 지울 정점이 없고 선을 옮기지도 않으므로 제거본을 만들지 않았습니다.';
    case 'COURSE_TRIM_REMOVES_EVERYTHING':
      return '코스 전체가 보호 구역 안에 있어 남는 선이 없습니다.';
    case 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE':
      return '보호 구역이 그 사이 바뀌었습니다. 목록을 다시 확인한 뒤 시도하세요.';
    case 'PRIVACY_ZONE_QUOTA_EXCEEDED':
      return `보호 구역은 ${courseLimits.privacyZonesPerTenant}개까지 만들 수 있습니다.`;
    default:
      return error.status === 409
        ? '다른 변경이 먼저 저장되었습니다. 다시 불러온 뒤 시도하세요.'
        : '입력을 확인한 뒤 다시 시도하세요.';
  }
}

export interface CourseImportPanelProps {
  api: CourseExtrasApi;
  onImported: (result: CourseReadResult) => void;
}

/**
 * Import a GPX file.
 *
 * The file is read here only to send its bytes: nothing on this screen parses it, decides
 * what it contains or computes a distance from it. The server parses it and answers with
 * what it found, which is why a file holding several tracks or routes comes back as a list
 * to choose from rather than as a course somebody else picked.
 */
export function CourseImportPanel({ api, onImported }: CourseImportPanelProps) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [items, setItems] = useState<
    {
      sourceKind: 'gpx-trk' | 'gpx-rte';
      itemIndex: number;
      name: string | null;
      pointCount: number;
    }[]
  >([]);
  /**
   * The bytes waiting to be sent, and the ownership of the selection they came from. The
   * two are one value on purpose: nothing in this panel can hold the bytes without also
   * holding whose they are, so neither a read nor a response can be applied to a selection
   * it does not own.
   */
  const pending = useRef<{
    owns: () => boolean;
    fileBase64: string;
    originalFilename: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The command and the key it was sent under, held together.
   *
   * An import is a write, so a lost response does not say whether it stored a course. The
   * rule is M2-01f's: the same command is retried under the **same** idempotency key, and
   * the key is dropped only on a confirmed success or on a refusal that proves nothing was
   * stored (a 4xx of ours, other than the ones that mean "try again"). A fresh key on every
   * click would turn one interrupted import into two courses.
   */
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  /**
   * Every file selection is an attempt: choosing a file supersedes the one before it, and
   * both the read of the file and the import sent for it answer to that one claim.
   */
  const claimSelection = useLatest();

  const send = async (
    selection: { sourceKind: 'gpx-trk' | 'gpx-rte'; itemIndex: number } | null,
  ) => {
    const file = pending.current;
    if (!file) return;
    // The response, whenever it arrives, speaks only for the selection it was sent for.
    const owns = file.owns;
    const requestName = name.trim() === '' ? null : name.trim();
    const fingerprint = JSON.stringify([
      requestName,
      file.originalFilename,
      selection,
      file.fileBase64.length,
      file.fileBase64.slice(0, 64),
    ]);
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, key: crypto.randomUUID() };
    const key = command.current.key;
    setBusy(true);
    try {
      const result = await api.importCourse(
        {
          name: requestName,
          originalFilename: file.originalFilename,
          selection,
          fileBase64: file.fileBase64,
        },
        key,
      );
      if (!owns()) return;
      if (result.outcome === 'requires_selection') {
        setItems([...result.items]);
        setMessage('이 파일에는 기록과 경로가 여러 개 있습니다. 하나를 고르세요. 합치지 않습니다.');
        return;
      }
      setItems([]);
      pending.current = null;
      command.current = null;
      setName('');
      setMessage(
        result.course.status === 'available'
          ? `코스를 가져왔습니다: ${result.course.course.name} · 수정 번호 ${result.course.course.headRevision}`
          : '코스를 가져왔습니다.',
      );
      onImported(result.course);
    } catch (error) {
      if (!owns()) return;
      // Only a refusal of ours proves nothing was stored. 408, 425 and 429 can come from
      // somewhere in between, and so can every 5xx and every missing response, so those
      // keep the command exactly as it was sent.
      if (
        error instanceof CourseRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status)
      )
        command.current = null;
      setMessage(readableExtrasError(error));
    } finally {
      // A superseded request does not get to say the panel is idle: the selection that
      // replaced it owns `busy`, and its own read may still be running.
      if (owns()) setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="GPX 가져오기">
      <h3>GPX 가져오기</h3>
      <p className={styles.note}>
        파일은 서버가 다시 읽습니다. 기록(trk)과 경로(rte)는 구분해서 다루며, 가져온 결과는 계획
        코스이지 실제 운동 기록이 아닙니다.
      </p>
      {/*
        Deliberately not "코스 이름": the course detail beside this panel already has a
        field with that name, and a label that contains another control's whole label is
        ambiguous — for a reader working by label as much as for a test.
      */}
      <TextField
        label="새 코스의 이름 (비우면 파일에 적힌 이름을 사용합니다)"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className={styles.fileField}>
        <span>GPX 파일</span>
        <input
          type="file"
          accept=".gpx,application/gpx+xml"
          aria-label="가져올 GPX 파일"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Every selection gets a number, and a read may only speak for the selection
            // it belongs to. Reads finish out of order — a large file chosen first can
            // land after a small one chosen second — and without this the screen showed
            // one file while the bytes waiting to be sent were another's. The same
            // number is what stops a read that was already superseded (by a new choice,
            // by an oversized file, or by a cleared input) from resurrecting itself.
            const owns = claimSelection();
            setItems([]);
            setMessage('');
            pending.current = null;
            command.current = null;
            if (!file) {
              setBusy(false);
              return;
            }
            if (file.size > courseLimits.importFileBytes) {
              setBusy(false);
              setMessage('파일이 너무 큽니다.');
              return;
            }
            setBusy(true);
            void readFileBytes(file)
              .then((bytes) => {
                if (!owns()) return;
                pending.current = {
                  owns,
                  fileBase64: encodeBase64(bytes),
                  originalFilename: file.name === '' ? null : file.name,
                };
                setBusy(false);
              })
              .catch(() => {
                if (!owns()) return;
                pending.current = null;
                setBusy(false);
                setMessage('파일을 읽지 못했습니다.');
              });
          }}
        />
      </label>
      <Button variant="primary" disabled={busy} onClick={() => void send(null)}>
        가져오기
      </Button>
      {items.length > 0 ? (
        <ul aria-label="가져올 항목">
          {items.map((item) => (
            <li key={`${item.sourceKind}-${item.itemIndex}`}>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void send({ sourceKind: item.sourceKind, itemIndex: item.itemIndex })
                }
              >
                {item.sourceKind === 'gpx-trk' ? '기록' : '경로'} {item.itemIndex + 1}:{' '}
                {item.name ?? '이름 없음'} · {item.pointCount}점
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

export interface CoursePlaceSearchProps {
  api: CourseExtrasApi;
  /** Hands the chosen place to the screen, which is what the waypoint editor reads. */
  onPick: (position: CoursePosition, name: string) => void;
}

/** Search our own place data. A POST, so the bias position never enters a request line. */
export function CoursePlaceSearch({ api, onPick }: CoursePlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [places, setPlaces] = useState<
    {
      placeId: string;
      name: string;
      localName: string | null;
      kind: string;
      position: CoursePosition;
    }[]
  >([]);
  const [attribution, setAttribution] = useState<string | null>(null);
  const claimSearch = useLatest();
  /** The request a newer query supersedes. Aborting it is what the API's `signal` is for. */
  const inFlight = useRef<AbortController | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    // A new query owns the screen from here on. The one it replaces is cancelled, and
    // whatever that one does next — answer or fail — writes nothing.
    const owns = claimSearch();
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setMessage('');
    setPlaces([]);
    setAttribution(null);
    if (query.trim() === '') return;
    try {
      const result = await api.searchPlaces({ query: query.trim(), near: null }, controller.signal);
      if (!owns()) return;
      if (result.outcome === 'no_dataset') {
        setMessage('이 서버에는 장소 데이터가 배포되어 있지 않습니다. 검색하지 않았습니다.');
        return;
      }
      if (result.outcome === 'outside_region') {
        setMessage(`${result.dataset.region} 밖은 검색할 수 없습니다.`);
        return;
      }
      setAttribution(
        `${result.dataset.attribution} · 데이터 ${result.dataset.datasetId} · 갱신 주기 ${result.dataset.updateCadence}`,
      );
      setPlaces([...result.places]);
      if (result.places.length === 0) setMessage('찾은 장소가 없습니다.');
      else if (result.matchCount > result.places.length)
        setMessage(`${result.matchCount}개 중 ${result.places.length}개를 보여 줍니다.`);
    } catch (error) {
      // A cancelled request has nothing to say, and neither has a superseded one.
      if (!owns()) return;
      setMessage(readableExtrasError(error));
    }
  };

  return (
    <section className={styles.panel} aria-label="장소 검색">
      <h3>장소 검색</h3>
      <form onSubmit={search}>
        <TextField
          label="장소 이름"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="secondary" type="submit">
          검색
        </Button>
      </form>
      {places.length > 0 ? (
        <ul aria-label="검색 결과">
          {places.map((place) => (
            <li key={place.placeId}>
              <Button variant="secondary" onClick={() => onPick(place.position, place.name)}>
                {place.name}
                {place.localName ? ` (${place.localName})` : ''} · {place.kind}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {attribution ? <p className={styles.note}>{attribution}</p> : null}
    </section>
  );
}

export interface CourseElevationPanelProps {
  api: CourseExtrasApi;
  courseId: string;
  /** Query scope of the signed-in owner and session. A cache never crosses an account. */
  scope: readonly string[];
}

/**
 * What our own elevation dataset knows about this course, and what it does not.
 *
 * There is no ascent total here on purpose: the dataset is sparse, and adding up a handful
 * of known points would produce a number nobody measured.
 */
export function CourseElevationPanel({ api, courseId, scope }: CourseElevationPanelProps) {
  const profile = useQuery({
    queryKey: [...scope, 'elevation', courseId],
    queryFn: ({ signal }) => api.elevation(courseId, signal),
  });
  return (
    <section className={styles.panel} aria-label="고도 출처">
      <h3>고도</h3>
      {profile.isPending ? <p role="status">고도를 확인하는 중입니다.</p> : null}
      {profile.isError ? <p role="alert">고도를 확인하지 못했습니다.</p> : null}
      {profile.data?.outcome === 'no_dataset' ? (
        <p>이 서버에는 고도 데이터가 배포되어 있지 않습니다. 고도를 추정하지 않습니다.</p>
      ) : null}
      {profile.data?.outcome === 'outside_region' ? (
        <p>{profile.data.dataset.region} 밖이라 고도 데이터가 없습니다.</p>
      ) : null}
      {profile.data?.outcome === 'profile' ? (
        <>
          <p>
            표본 {profile.data.points.length}곳 중 <strong>{profile.data.knownCount}곳</strong>에
            고도 값이 있습니다 (정점 {profile.data.vertexCount}개,{' '}
            {Math.round(profile.data.maxSourceDistanceMeters)}m 안의 값만 사용).
          </p>
          <p className={styles.note}>
            {profile.data.dataset.attribution} · 데이터 {profile.data.dataset.datasetId} · 갱신 주기{' '}
            {profile.data.dataset.updateCadence}. 값이 없는 지점은 0이 아니라 <strong>모름</strong>
            이며, 사이를 채우거나 누적 상승을 계산하지 않습니다.
          </p>
        </>
      ) : null}
      <p className={styles.note}>
        노면·계단·야간 통행 정보는 이 데이터에 없습니다. <strong>확인되지 않음</strong>으로 두며,
        통행 가능 여부·안전을 뜻하지 않습니다.
      </p>
    </section>
  );
}

export interface CoursePrivacyPanelProps {
  api: CourseExtrasApi;
  /** Query scope of the signed-in owner and session. A cache never crosses an account. */
  scope: readonly string[];
  courseId: string;
  headRevision: number;
  generationKind: string;
  onTrim: (input: { courseId: string; expectedRevision: number; zoneSetDigest: string }) => void;
  trimMessage: string;
}

/**
 * Protected areas and the derived revision that removes them.
 *
 * The trim never rewrites the revision it trims: it appends a new one, and the screen says
 * so. The area set the owner is looking at travels with the request, so a trim computed
 * against areas that have since changed is refused rather than quietly applied.
 */
export function CoursePrivacyPanel({
  api,
  scope,
  courseId,
  headRevision,
  generationKind,
  onTrim,
  trimMessage,
}: CoursePrivacyPanelProps) {
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [radius, setRadius] = useState('300');
  const [message, setMessage] = useState('');
  const zoneKey = [...scope, 'privacy-zones'];
  const zones = useQuery({
    queryKey: zoneKey,
    queryFn: ({ signal }) => api.privacyZones(signal),
  });
  const zoneSet = zones.data;
  /**
   * The list is re-read after every write; the write's own answer is not the authority.
   *
   * Both writes answer with the whole list, and a list computed before another write has
   * already landed is out of date by the time it arrives. Sharing one claim stopped a late
   * addition from putting a removed area back — but it also **threw a successful addition
   * away** whenever a later removal failed: the answer was discarded as superseded, and
   * nothing then told the screen that the server had the new area. Observed as a list
   * showing only the old area while the server held both.
   *
   * So neither answer is written into the cache. Each settled write invalidates the list
   * and the query re-reads it, which is the one thing that is true of the server after
   * both writes rather than after one of them. Ordering is then the query's problem, which
   * is where it belongs, and nothing is lost or resurrected.
   *
   * The claim stays, for the **message**: that is one slot on the screen, and a refusal of
   * a superseded write must not speak over the write that replaced it.
   */
  const claimZoneMessage = useLatest();
  const rereadZones = () => {
    void queries.invalidateQueries({ queryKey: zoneKey });
  };
  const add = useMutation({
    mutationFn: (input: { name: string; center: CoursePosition; radiusMeters: number }) =>
      api.createPrivacyZone(input),
    onMutate: () => ({ owns: claimZoneMessage() }),
    onSuccess: (_result, _input, context) => {
      // The form belongs to this addition and to nothing else: it is cleared because this
      // addition succeeded, whatever else has happened since.
      setName('');
      setLongitude('');
      setLatitude('');
      if (!context.owns()) return;
      setMessage('보호 구역을 추가했습니다.');
    },
    onError: (error: unknown, _input, context) => {
      if (!context?.owns()) return;
      setMessage(readableExtrasError(error));
    },
    onSettled: rereadZones,
  });
  const remove = useMutation({
    mutationFn: (zoneId: string) => api.removePrivacyZone(zoneId),
    onMutate: () => ({ owns: claimZoneMessage() }),
    onSuccess: (_result, _zoneId, context) => {
      if (!context.owns()) return;
      setMessage('보호 구역을 삭제했습니다.');
    },
    onError: (error: unknown, _zoneId, context) => {
      if (!context?.owns()) return;
      setMessage(readableExtrasError(error));
    },
    onSettled: rereadZones,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const longitudeValue = decimalOrNull(longitude);
    const latitudeValue = decimalOrNull(latitude);
    const radiusMeters = decimalOrNull(radius);
    if (
      longitudeValue === null ||
      latitudeValue === null ||
      radiusMeters === null ||
      Math.abs(longitudeValue) > 180 ||
      Math.abs(latitudeValue) > 90 ||
      radiusMeters < courseLimits.privacyZoneMinRadiusMeters ||
      radiusMeters > courseLimits.privacyZoneMaxRadiusMeters ||
      name.trim() === ''
    ) {
      setMessage('이름과 좌표, 반경을 확인하세요. 좌표는 비워 둘 수 없습니다.');
      return;
    }
    const center: CoursePosition = [longitudeValue, latitudeValue];
    add.mutate({ name: name.trim(), center, radiusMeters });
  };

  return (
    <section className={styles.panel} aria-label="보호 구역">
      <h3>보호 구역</h3>
      <p className={styles.note}>
        보호 구역은 본인만 볼 수 있으며 코스 기록에 좌표가 들어가지 않습니다. 제거본은 원본을
        덮어쓰지 않고 <strong>새 수정본</strong>으로 추가됩니다.
      </p>
      {zones.isPending ? <p role="status">보호 구역을 불러오는 중입니다.</p> : null}
      {zones.isError ? <p role="alert">보호 구역을 불러오지 못했습니다.</p> : null}
      {zones.data ? (
        <ul aria-label="보호 구역 목록">
          {zones.data.zones.map((zone) => (
            <li key={zone.zoneId}>
              <span>
                {zone.name} · 반경 {Math.round(zone.radiusMeters)}m
              </span>
              <Button variant="secondary" onClick={() => remove.mutate(zone.zoneId)}>
                {zone.name} 삭제
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit}>
        <TextField
          label="보호 구역 이름"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="보호 구역 경도"
          value={longitude}
          onChange={(event) => setLongitude(event.target.value)}
        />
        <TextField
          label="보호 구역 위도"
          value={latitude}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <TextField
          label="보호 구역 반경(m)"
          value={radius}
          onChange={(event) => setRadius(event.target.value)}
        />
        <Button variant="secondary" type="submit">
          보호 구역 추가
        </Button>
      </form>
      <Button
        variant="primary"
        disabled={zoneSet === undefined || zoneSet.zones.length === 0}
        // Built from the list or not built at all: the button cannot be pressed without
        // one, so there is no unreachable "no list yet" branch inside it to mislead a
        // reader into thinking this can run before the areas are known.
        onClick={
          zoneSet === undefined
            ? undefined
            : () =>
                onTrim({
                  courseId,
                  expectedRevision: headRevision,
                  zoneSetDigest: zoneSet.zoneSetDigest,
                })
        }
      >
        보호 구역 제거본 만들기
      </Button>
      {generationKind === 'privacy-trimmed' ? (
        <p className={styles.note}>
          현재 수정본은 보호 구역이 제거된 파생본입니다. 내보내는 GPX와 화면의 좌표도 이 선입니다.
        </p>
      ) : null}
      {trimMessage ? <p role="status">{trimMessage}</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
