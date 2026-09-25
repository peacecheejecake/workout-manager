'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  courseShareMeasuredResidual,
  courseSharingLimits,
  type CourseDisclosureExposure,
  type CourseDisclosureOption,
  type CourseDisclosurePreview,
  type CourseDisclosurePurpose,
  type CourseDisclosureReceipt,
  type CourseShare,
} from '@workout/contracts/course-sharing';
import { Button } from '@workout/ui-foundation/button';

import { CourseRequestError } from './course-api';
import type { CourseExtrasApi } from './course-extras-api';
import { readableExtrasError } from './course-extras';
import { sharedCourseLink, type CourseSharingApi } from './course-sharing-api';
import { CourseThumbnail } from './course-thumbnail';
import styles from './course-sharing.module.css';

/**
 * The privacy confirmation (M2-01k-o §5) and the owner's links (§2 B, §4).
 *
 * One screen for both ways out: "GPX 내보내기" and "링크로 공유" come here and neither goes
 * around it. It is built from the server's own preview — what would leave, exactly — and
 * says the seven things §5 lists: what leaves, the two ends, the protected areas, what risk
 * remains, what never leaves, what cannot be taken back, and (for a link) that the link is
 * fixed to this revision. The map is not the only carrier of any of it: every fact shown on
 * the line picture is also in the list beside it.
 *
 * A link's token is shown once, here, from component state, and is gone when the panel
 * closes. It is never put in a query cache, a store or browser storage (B-7).
 */

function metres(value: number): string {
  return value >= 1000 ? `약 ${(value / 1000).toFixed(1)}km` : `약 ${Math.round(value)}m`;
}

function position(value: readonly [number, number]): string {
  return `위도 ${value[1].toFixed(5)}, 경도 ${value[0].toFixed(5)}`;
}

/**
 * What deleting a protected area does to links, shown beside the areas while sharing is on
 * (R-7). M2-01as (review r1 item 7): the place's lifetime link count outlives the area.
 */
export const zoneDeletionShareNote =
  '보호 구역을 삭제하면 그 구역으로 잘린 링크는 모두 꺼집니다. 같은 곳에 구역을 다시 만들면 공유용 오프셋이 바뀝니다. 두 오프셋의 공유를 모으면 범위가 좁혀질 수 있습니다. 삭제한 뒤에도 이 장소에서 만든 링크 수는 대략의 위치(약 1 km 칸)와 함께 계정에 남아, 근처에 다시 만든 구역이 이어서 셉니다. 계정을 삭제하면 함께 지워집니다.';

export function readableSharingError(error: unknown): string {
  if (!(error instanceof CourseRequestError)) return '요청을 완료하지 못했습니다.';
  switch (error.code) {
    case 'COURSE_EXPORT_BLOCKED':
      return '이 코스는 보호 구역을 지나가서 내보내거나 공유할 수 없습니다. 보호 구역을 지나지 않게 코스를 고치세요.';
    case 'COURSE_EXPORT_NOT_CONFIRMED':
    case 'COURSE_DISCLOSURE_STALE':
    case 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE':
    case 'COURSE_REVISION_CONFLICT':
      return '확인한 뒤 코스나 보호 구역이 바뀌었습니다. 확인 화면을 다시 열어 주세요.';
    case 'COURSE_SHARE_REQUIRES_PROTECTED_AREA':
      return '링크로 공유하려면 보호 구역을 먼저 추가하세요.';
    case 'COURSE_SHARE_LIMIT_REACHED':
      return `켜져 있는 링크가 너무 많습니다. 코스당 ${courseSharingLimits.activeSharesPerCourse}개, 전체 ${courseSharingLimits.activeSharesPerOwner}개까지 만들 수 있습니다.`;
    case 'COURSE_SHARE_AREA_LIFETIME_REACHED':
      return `이 보호 구역 근처에서 만들 수 있는 링크 ${courseSharingLimits.shareLinksPerAreaLifetime}개를 모두 썼습니다. 끈 링크, 만료된 링크, 지운 뒤 다시 만든 보호 구역의 링크도 모두 셉니다. 새 보호 구역은 첫 링크 때 가까운 구역(약 1.5 km 안, 큰 구역일수록 더 멀리)이 이미 쓴 개수에서 시작합니다. 이 코스는 GPX로만 내보낼 수 있습니다.`;
    default:
      return readableExtrasError(error);
  }
}

export interface CourseDisclosureProps {
  readonly api: CourseSharingApi;
  /** The user/session scope every course query key of this screen starts with. */
  readonly scope: readonly unknown[];
  readonly courseId: string;
  readonly purpose: CourseDisclosurePurpose;
  /** Performs the authenticated GPX download for a receipt. */
  readonly onExport?: (receipt: CourseDisclosureReceipt) => Promise<void>;
  /** The course changed (a trimmed revision was appended) or a link was made. */
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly onAddZone?: () => void;
}

function OptionFacts({
  option,
  label,
}: {
  readonly option: CourseDisclosureOption;
  readonly label: string;
}) {
  return (
    <>
      <CourseThumbnail
        coordinates={option.coordinates}
        label={label}
        testId="course-disclosure-line"
      />
      <ul aria-label="나갈 시작점과 끝점">
        <li>
          시작: {position(option.start)}
          {option.startShiftMeters > 0.5
            ? ` · 원래 시작에서 ${metres(option.startShiftMeters)} 떨어진 곳`
            : ' · 원래 시작 그대로'}
        </li>
        <li>
          끝: {position(option.finish)}
          {option.finishShiftMeters > 0.5
            ? ` · 원래 끝에서 ${metres(option.finishShiftMeters)} 떨어진 곳`
            : ' · 원래 끝 그대로'}
        </li>
        {option.removedWaypointCount > 0 ? (
          <li>보호 구역 안의 경유점 {option.removedWaypointCount}개는 이름과 함께 빠집니다.</li>
        ) : null}
      </ul>
    </>
  );
}

export function CourseDisclosure({
  api,
  scope,
  courseId,
  purpose,
  onExport,
  onChanged,
  onClose,
  onAddZone,
}: CourseDisclosureProps) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  // Read fresh every time the screen opens and kept only while it is open: the preview is
  // what the server would disclose NOW, and a stale one is refused on confirmation anyway.
  const preview = useQuery({
    queryKey: [...scope, 'disclosure', courseId, purpose],
    queryFn: ({ signal }) => api.preview(courseId, purpose, signal),
    staleTime: 0,
    gcTime: 0,
  });
  const title = purpose === 'export' ? 'GPX 내보내기 전 확인' : '링크 공유 전 확인';
  return (
    <section className={styles.confirmation} aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1}>
        {title}
      </h3>
      {preview.isPending ? <p role="status">나갈 내용을 계산하는 중입니다.</p> : null}
      {preview.isError ? <p role="alert">{readableSharingError(preview.error)}</p> : null}
      {preview.data ? (
        <DisclosureBody
          key={`${preview.data.courseRevision}:${preview.data.zoneSetDigest}`}
          api={api}
          preview={preview.data}
          {...(onExport ? { onExport } : {})}
          onChanged={onChanged}
          onClose={onClose}
          {...(onAddZone ? { onAddZone } : {})}
        />
      ) : null}
      {!preview.data ? (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function DisclosureBody({
  api,
  preview,
  onExport,
  onChanged,
  onClose,
  onAddZone,
}: {
  readonly api: CourseSharingApi;
  readonly preview: CourseDisclosurePreview;
  readonly onExport?: (receipt: CourseDisclosureReceipt) => Promise<void>;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly onAddZone?: () => void;
}) {
  const purpose = preview.purpose;
  const [exposure, setExposure] = useState<CourseDisclosureExposure | null>(
    preview.defaultExposure,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [includeNames, setIncludeNames] = useState(preview.includeNamesDefault);
  const [expiresInDays, setExpiresInDays] = useState<number>(
    courseSharingLimits.shareExpiryDefaultDays,
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  // The token lives here and nowhere else, and only until this panel closes.
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const option = preview.options.find((candidate) => candidate.exposure === exposure) ?? null;
  const addZone = onAddZone ? (
    <Button variant="secondary" onClick={onAddZone}>
      보호 구역 추가하러 가기
    </Button>
  ) : null;

  if (
    purpose === 'share' &&
    preview.outcome === 'blocked' &&
    preview.blockedReason === 'COURSE_TRIM_REMOVES_EVERYTHING'
  )
    return (
      <>
        {/* M2-01as: a link loses a further stretch of path past each cut end. */}
        <p role="alert">
          링크는 보호 구역 둘레를 넉넉히 자른 뒤, 잘린 끝마다 코스를 따라{' '}
          {metres(
            courseSharingLimits.shareContinuationCutFactor *
              courseSharingLimits.shareMinimumScaleMeters,
          )}{' '}
          이상을 더 잘라 냅니다. 이 코스는 그러고 나면 남는 선이 없어 링크로 공유할 수 없습니다. 더
          긴 코스는 공유할 수 있고, 이 코스도 GPX로는 내보낼 수 있습니다.
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </>
    );
  if (preview.outcome === 'blocked')
    return (
      <>
        <p role="alert">
          {readableExtrasError(new CourseRequestError(409, preview.blockedReason ?? ''))} 보호
          구역을 지나지 않게 코스를 고치세요. 이 코스는 {purpose === 'export' ? '내보낼' : '공유할'}{' '}
          수 없습니다.
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </>
    );
  if (purpose === 'share' && preview.outcome === 'no-zones')
    return (
      <>
        <p role="alert">
          보호 구역을 먼저 추가하세요. 링크 공유에는 보호 구역이 하나 이상 필요합니다.
        </p>
        <div className={styles.actions}>
          {addZone}
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </>
    );

  const needsAcknowledgement = option?.requiresAcknowledgement ?? false;
  const canConfirm = option !== null && (!needsAcknowledgement || acknowledged) && !pending;

  async function confirm() {
    if (option === null) return;
    setPending(true);
    setMessage('');
    try {
      const receipt = await api.confirm(
        preview.courseId,
        {
          purpose,
          expectedRevision: preview.courseRevision,
          acknowledgedZoneSetDigest: preview.zoneSetDigest,
          exposure: option.exposure,
          includeNames,
          acknowledgedRisk: needsAcknowledgement && acknowledged,
        },
        crypto.randomUUID(),
      );
      if (purpose === 'export') {
        await onExport?.(receipt);
        // The trimmed confirmation appended a revision: the screen reads the course again,
        // and this panel's work is done.
        onChanged();
        onClose();
      } else {
        const created = await api.createShare(preview.courseId, receipt.receiptId, expiresInDays);
        setLink(sharedCourseLink(window.location.origin, created.token));
        onChanged();
      }
    } catch (error) {
      setMessage(readableSharingError(error));
    } finally {
      setPending(false);
    }
  }

  const lineLabel = purpose === 'export' ? '내보낼 선 미리보기' : '링크가 보여 줄 선 미리보기';
  return (
    <>
      {purpose === 'export' && preview.outcome === 'ends-inside' ? (
        <fieldset>
          <legend>어떤 선을 내보낼까요?</legend>
          {preview.options.map((candidate) => (
            <label key={candidate.exposure} className={styles.choice}>
              <input
                type="radio"
                name="disclosure-exposure"
                checked={exposure === candidate.exposure}
                onChange={() => {
                  setExposure(candidate.exposure);
                  setAcknowledged(false);
                }}
              />
              {candidate.exposure === 'trimmed'
                ? '보호 구역 안의 시작·끝을 제거한 선 (기본)'
                : '정확한 선 (내 GPX 파일에만)'}
            </label>
          ))}
        </fieldset>
      ) : null}

      <section aria-label="나가는 것">
        <h4>1. 나가는 것</h4>
        {option ? (
          <p>
            선 전체(정점 {option.vertexCount}개, {metres(option.distanceMeters)}).{' '}
            {purpose === 'export'
              ? '코스 이름과 경유점 이름은 기본으로 포함되며, 아래에서 뺄 수 있습니다.'
              : '코스 이름과 경유점 이름은 기본으로 빠지며, 아래에서 넣을 수 있습니다.'}
          </p>
        ) : null}
        <label className={styles.choice}>
          <input
            type="checkbox"
            checked={includeNames}
            onChange={(event) => setIncludeNames(event.target.checked)}
          />
          코스 이름과 경유점 이름 포함
        </label>
      </section>

      <section aria-label="시작과 끝">
        <h4>2. 시작과 끝</h4>
        {option ? <OptionFacts option={option} label={lineLabel} /> : null}
        {preview.outcome === 'no-zones' ? (
          <>
            <p className={styles.warning}>보호 구역이 없어 정확한 시작·끝이 포함됩니다.</p>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              보호 구역이 없어 정확한 시작·끝이 포함된다는 것을 확인했습니다.
            </label>
            <div className={styles.actions}>{addZone}</div>
          </>
        ) : null}
        {option?.exposure === 'owner-exact' ? (
          <>
            <p className={styles.warning}>
              보호 구역 안의 좌표가 파일에 포함됩니다. 이 파일은 철회할 수 없습니다.
            </p>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              보호 구역 안의 좌표가 포함된다는 것을 확인했습니다.
            </label>
          </>
        ) : null}
        {purpose === 'share' && preview.outcome === 'ends-inside' ? (
          <p className={styles.note}>링크는 항상 보호 구역을 제거한 선을 보여 줍니다.</p>
        ) : null}
        {preview.outcome === 'no-intersection' ? (
          <p className={styles.note}>
            이 코스는 보호 구역을 지나지 않습니다. 시작·끝이 그대로 나갑니다.
          </p>
        ) : null}
        {option?.appendsRevision ? (
          <p className={styles.note}>
            확인하면 이 코스에 보호 구역을 제거한 수정본이 새로 추가됩니다. 원래 수정본은 그대로
            남습니다.
          </p>
        ) : null}
      </section>

      <section aria-label="보호 구역과의 관계">
        <h4>3. 보호 구역</h4>
        {preview.zones.length === 0 ? (
          <p>적용된 보호 구역이 없습니다.</p>
        ) : (
          <>
            <p>적용된 보호 구역 {preview.zones.length}개</p>
            <ul aria-label="적용된 보호 구역">
              {preview.zones.map((zone, index) => (
                <li key={`${zone.name}:${index}`}>
                  {zone.name} · 이 구역에서 제거되는 정점 {zone.removedVertexCount}개
                </li>
              ))}
            </ul>
          </>
        )}
        <p className={styles.note}>보호 구역의 중심 좌표는 어디로도 나가지 않습니다.</p>
      </section>

      <section aria-label="남는 위험">
        <h4>4. 남는 위험</h4>
        <ul>
          <li>
            보호 구역 가장자리에서 선이 시작됩니다. 같은 곳에서 출발한 코스를 여러 번 공유하면 구역
            중심을 추정할 수 있습니다.
          </li>
          <li>반복해서 달리는 경로는 시작·끝을 지워도 동네를 드러낼 수 있습니다.</li>
          {purpose === 'export' ? (
            <li>내보낸 제거본 파일 3개 이상이면 집 위치를 몇 m 안으로 계산할 수 있습니다.</li>
          ) : null}
        </ul>
      </section>

      <section aria-label="나가지 않는 것">
        <h4>5. 나가지 않는 것</h4>
        <p>시각, 활동 연결, 코스 id, 기기 정보, 소유자 이름·계정은 나가지 않습니다.</p>
      </section>

      <section aria-label="철회 한계">
        <h4>6. 되돌릴 수 있는 것과 없는 것</h4>
        {purpose === 'export' ? (
          <p>내보낸 파일은 철회할 수 없습니다.</p>
        ) : (
          <>
            <p>
              링크는 언제든 끌 수 있고 {expiresInDays}일 안에 만료되지만(만료 시각은 만든 시각이
              드러나지 않도록 날짜 경계인 오전 9시로 맞춥니다), 받은 사람이 이미 본 화면을
              기록했다면 되돌릴 수 없습니다. 받은 사람은 파일을 받을 수 없습니다. 브라우저 기록에
              링크가 남을 수 있습니다.
            </p>
            {/* R-5: every link cut against one protected area is cut the same way. */}
            <p>
              같은 보호 구역 근처의 코스로 만든 링크들은 같은 방식으로 잘립니다. 누군가 그 링크를
              여러 개 모아 보면 같은 사람이 만든 것임을 알아챌 수 있고, 모을수록 보호 구역의 위치를
              좁혀 볼 여지도 커집니다.
            </p>
            {/* M2-01as: the residual the attack suite measured, in metres. */}
            <p data-testid="share-residual">
              그래서 한 보호 구역 근처에서 만들 수 있는 링크는 모두 합쳐{' '}
              {courseSharingLimits.shareLinksPerAreaLifetime}개입니다(끈 링크, 만료된 링크, 지운 뒤
              다시 만든 보호 구역의 링크도 셉니다). 새로 만든 보호 구역은 첫 링크 때, 가까운 곳(약
              1.5 km 안, 큰 구역일수록 더 멀리 — 3 km쯤까지)의 구역이 이미 쓴 개수에서 시작하고, 그
              뒤로는 구역마다 따로 셉니다. 합성 코스로 한 실험에서, 한 구역의 링크{' '}
              {courseShareMeasuredResidual.links}개를 모두 모은 사람은 집 위치를 절반의 경우{' '}
              {courseShareMeasuredResidual.medianMeters}m 안팎까지, 열 번에 한 번은{' '}
              {courseShareMeasuredResidual.p10Meters}m 안까지 좁혔습니다. 링크는 잘린 끝에서 코스를
              따라 더 잘라 내므로 짧은 코스는 링크로 공유할 수 없습니다.
            </p>
          </>
        )}
      </section>

      {purpose === 'share' ? (
        <section aria-label="고정">
          <h4>7. 고정</h4>
          <p>링크는 지금 확인한 판을 보여 줍니다. 코스를 고쳐도 링크의 내용은 바뀌지 않습니다.</p>
          <label className={styles.choice}>
            링크 유효 기간
            <select
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              {[1, 3, 7, 14, courseSharingLimits.shareExpiryMaxDays].map((days) => (
                <option key={days} value={days}>
                  {days}일
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      {link === null ? (
        <div className={styles.actions}>
          <Button disabled={!canConfirm} onClick={() => void confirm()}>
            {purpose === 'export' ? '확인하고 GPX 내보내기' : '확인하고 링크 만들기'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
        </div>
      ) : (
        <div className={styles.linkField}>
          <label htmlFor={`${preview.courseId}-shared-link`}>공유 링크</label>
          <input
            id={`${preview.courseId}-shared-link`}
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
          />
          <p className={styles.note}>
            이 링크는 지금 한 번만 보입니다. 닫으면 다시 볼 수 없으며, 필요하면 새 링크를 만드세요.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              링크 복사
            </Button>
            <Button variant="secondary" onClick={onClose}>
              닫기
            </Button>
          </div>
          {copied ? <p role="status">링크를 복사했습니다.</p> : null}
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
    </>
  );
}

export interface CourseSharePanelProps {
  readonly api: CourseSharingApi;
  readonly extrasApi: CourseExtrasApi;
  readonly scope: readonly unknown[];
  readonly courseId: string;
  readonly onShare: () => void;
  readonly onAddZone?: () => void;
}

function shareStateLabel(share: CourseShare): string {
  switch (share.state) {
    case 'active':
      return `켜짐 · ${share.expiresAt.slice(0, 10)}까지`;
    case 'expired':
      return '만료됨';
    case 'invalidated':
      return '복원으로 무효화됨 · 새 확인과 새 링크가 필요합니다';
    case 'revoked':
      return share.revokeReason === 'zone_added'
        ? '꺼짐 · 새 보호 구역과 겹쳐 자동으로 꺼졌습니다'
        : share.revokeReason === 'zone_removed'
          ? '꺼짐 · 보호 구역이 삭제되어 꺼졌습니다'
          : '꺼짐';
  }
}

/**
 * The owner's links for the open course (§2 B), shown only when the server has the flag on:
 * a server without it has no list route, and then this renders nothing at all (T9).
 */
export function CourseSharePanel({
  api,
  extrasApi,
  scope,
  courseId,
  onShare,
  onAddZone,
}: CourseSharePanelProps) {
  const queries = useQueryClient();
  const [message, setMessage] = useState('');
  const shares = useQuery({
    queryKey: [...scope, 'shares'],
    queryFn: ({ signal }) => api.shares(signal),
  });
  const zones = useQuery({
    queryKey: [...scope, 'privacy-zones'],
    queryFn: ({ signal }) => extrasApi.privacyZones(signal),
  });
  if (!shares.data) return null;
  const mine = shares.data.shares.filter((share) => share.courseId === courseId);
  const reread = () => void queries.invalidateQueries({ queryKey: [...scope, 'shares'] });
  const act = async (work: () => Promise<unknown>, done: string) => {
    setMessage('');
    try {
      await work();
      setMessage(done);
    } catch (error) {
      setMessage(readableSharingError(error));
    } finally {
      reread();
    }
  };
  const hasZone = (zones.data?.zones.length ?? 0) > 0;
  return (
    <section className={styles.links} aria-label="링크 공유">
      <h3>링크 공유</h3>
      <p className={styles.note}>
        받은 사람은 로그인 없이 보기만 합니다. 공개 목록이나 검색에는 나타나지 않습니다.
      </p>
      {zones.isSuccess && !hasZone ? (
        <>
          <p role="status">보호 구역을 먼저 추가하세요. 링크 공유에는 보호 구역이 필요합니다.</p>
          {onAddZone ? (
            <Button variant="secondary" onClick={onAddZone}>
              보호 구역 추가하러 가기
            </Button>
          ) : null}
        </>
      ) : (
        <Button variant="primary" disabled={!zones.isSuccess} onClick={onShare}>
          링크로 공유
        </Button>
      )}
      {mine.length > 0 ? (
        <ul aria-label="이 코스의 링크">
          {mine.map((share) => (
            <li key={share.shareId}>
              <span>
                수정 번호 {share.courseRevision} · {shareStateLabel(share)}
              </span>
              {share.state === 'active' ? (
                <Button
                  variant="secondary"
                  onClick={() => void act(() => api.revokeShare(share.shareId), '링크를 껐습니다.')}
                >
                  링크 끄기
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>이 코스의 링크가 없습니다.</p>
      )}
      {shares.data.activeTotal > 0 ? (
        <Button
          variant="danger"
          onClick={() => void act(() => api.revokeAllShares(), '모든 링크를 껐습니다.')}
        >
          모든 링크 끄기
        </Button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
