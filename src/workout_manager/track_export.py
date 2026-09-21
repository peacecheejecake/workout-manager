"""Bounded GPS track payloads for an explicit authenticated app import.

Extends the existing FIT detail export: the same parsed stream and the same source record
index produce both the GPS-free detail records and these samples, so `detailLink` points at
the detail record the sample was taken from. Detail v1~v3 payloads are unchanged and still
carry no coordinates. Nothing here downloads, infers a start time, or creates an Activity.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from datetime import datetime

import pandas as pd

from workout_manager.fit_batch import MESSAGE_ORDINAL

# Mirrors `trackLimits` and `defaultSegmentPolicy` in packages/contracts/src/tracks.ts.
MAX_TRACK_SAMPLES = 200_000
MAX_TRACK_SEGMENTS = 2_000
SEGMENT_POLICY: dict[str, object] = {"version": 1, "maxGapSeconds": 60, "maxGapMeters": 200}
PARSER_ID = "fit-python-export-v1"
PARSER_VERSION = 1
SEMICIRCLE_DEGREES = 180 / 2**31
EARTH_RADIUS_METERS = 6_371_008.8


# The sint32 invalid sentinel is 0x7FFFFFFF only. -2**31 semicircles is exactly -180
# degrees: a real longitude, and out of range for latitude. The two checks stay separate.
SINT32_INVALID = 0x7FFFFFFF


def semicircle_degrees(value: object, limit: float) -> float | None:
    """FIT position units are semicircles; the invalid sentinel becomes null, never 0."""
    if value is None or pd.isna(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise TypeError("Invalid FIT position value")
    if int(value) == SINT32_INVALID:
        return None
    degrees = float(value) * SEMICIRCLE_DEGREES
    if not math.isfinite(degrees) or abs(degrees) > limit:
        raise ValueError("FIT position outside the WGS84 range")
    return degrees


def optional_metric(value: object, *, low: float, high: float) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise TypeError("Invalid FIT track metric")
    number = float(value)
    if not math.isfinite(number) or number < low or number > high:
        return None
    return number


def first_metric(
    row: dict[str, object], names: tuple[str, ...], low: float, high: float
) -> float | None:
    """First present, non-null field wins; a missing field is unknown, never 0."""
    for name in names:
        value = optional_metric(row.get(name), low=low, high=high)
        if value is not None:
            return value
    return None


def haversine_meters(start: list[float], end: list[float]) -> float:
    lon1, lat1 = math.radians(start[0]), math.radians(start[1])
    lon2, lat2 = math.radians(end[0]), math.radians(end[1])
    a = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_METERS * math.asin(min(1.0, math.sqrt(a)))


def instant_ms(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    return datetime.fromisoformat(value).timestamp() * 1000


def break_reason(
    previous: dict[str, object] | None, sample: dict[str, object], *, stopped: bool = False
) -> str | None:
    """Same split policy as the TypeScript normalizer; gaps are never closed."""
    if previous is None:
        return "stream-start"
    if stopped:
        # A FIT timer stop ends the recording interval, exactly like the TypeScript reader.
        return "fit-event-stop"
    before_position = previous["position"]
    after_position = sample["position"]
    if before_position is None and after_position is None:
        return None
    if before_position is None or after_position is None:
        return "missing-position"
    assert isinstance(before_position, list) and isinstance(after_position, list)
    before = instant_ms(previous["recordedAt"])
    after = instant_ms(sample["recordedAt"])
    if before is not None and after is not None:
        if after < before:
            return "time-reversal"
        if after == before:
            return "duplicate-timestamp"
        if after - before > float(SEGMENT_POLICY["maxGapSeconds"]) * 1000:  # type: ignore[arg-type]
            return "time-gap"
    if abs(after_position[0] - before_position[0]) > 180:
        return "antimeridian-crossing"
    if haversine_meters(before_position, after_position) > float(SEGMENT_POLICY["maxGapMeters"]):  # type: ignore[arg-type]
        return "position-gap"
    return None


def track_sample(
    row: dict[str, object],
    detail: dict[str, object],
    *,
    stream_index: int,
    session_index: int,
    detail_schema_version: int,
) -> dict[str, object]:
    longitude = semicircle_degrees(row.get("position_long"), 180.0)
    latitude = semicircle_degrees(row.get("position_lat"), 90.0)
    source_index = int(str(detail["index"]))
    return {
        "sampleId": f"{stream_index}:{source_index}",
        "sourceIndex": source_index,
        "recordedAt": detail["timestamp"],
        "position": None if longitude is None or latitude is None else [longitude, latitude],
        "elevationMeters": first_metric(row, ("enhanced_altitude", "altitude"), -12_000, 12_000),
        # Device-reported cumulative distance, reused from the detail record.
        "distanceMeters": detail["distanceMeters"],
        "speedMetersPerSecond": first_metric(row, ("enhanced_speed", "speed"), 0, 1_000),
        "heartRateBpm": detail["heartRateBpm"],
        # FIT lap membership is not resolved in this export; it stays unknown, not 0.
        "lapIndex": None,
        "detailLink": {
            "detailSchemaVersion": detail_schema_version,
            "streamIndex": stream_index,
            "sessionIndex": session_index,
            "recordIndex": source_index,
        },
    }


TIMER_EVENT = "timer"
STOP_EVENT_TYPES = frozenset({"stop", "stop_all", "stop_disable", "stop_disable_all"})


def stop_ordinals(events: list[dict[str, object]]) -> list[int]:
    """Message positions of timer stops. Any stop type ends the interval, not only stop_all.

    Ordinals, not timestamps: a stop written in the same second as the preceding record
    still ends that recording interval, and only file order can tell us so. The deprecated
    `end`/`end_all` event types are not treated as stops; the current stop types are.
    """
    stops: list[int] = []
    for row in events:
        if row.get("event") != TIMER_EVENT or row.get("event_type") not in STOP_EVENT_TYPES:
            continue
        # Silently dropping a stop would turn a broken call into "no stops", which is
        # exactly the wrong failure. The caller must parse with `with_order=True`.
        stops.append(message_ordinal(row))
    return sorted(stops)


def message_ordinal(row: dict[str, object]) -> int:
    """Stream-local message position, required whenever stop boundaries are computed."""
    value = row.get(MESSAGE_ORDINAL)
    if value is None:
        raise ValueError("FIT message ordinal is required for track stop boundaries")
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("Invalid FIT message ordinal")
    return value


def stopped_between(stops: list[int], after: int | None, before: int) -> bool:
    """True when a stop message sits strictly between two record messages in file order."""
    if not stops or after is None:
        return False
    position = bisect_right(stops, after)
    return position < len(stops) and stops[position] < before


def track_payload(
    rows: list[dict[str, object]],
    details: list[dict[str, object]],
    *,
    stream_index: int,
    session_index: int,
    source_item_index: int,
    detail_schema_version: int,
    digest: str,
    byte_length: int,
    device_distance_meters: float | None,
    stops: list[int] | None = None,
) -> dict[str, object] | None:
    """Returns None when the session carries no record observations at all."""
    if not details:
        return None
    if len(details) > MAX_TRACK_SAMPLES:
        raise ValueError("FIT track exceeds the sample limit")
    stops = stops or []
    samples: list[dict[str, object]] = []
    segments: list[dict[str, object]] = []
    recomputed: float | None = None
    previous: dict[str, object] | None = None
    previous_ordinal: int | None = None
    for detail in details:
        row = rows[int(str(detail["index"]))]
        sample = track_sample(
            row,
            detail,
            stream_index=stream_index,
            session_index=session_index,
            detail_schema_version=detail_schema_version,
        )
        samples.append(sample)
        # Ordinals are only needed when stop boundaries are in play; requiring one then
        # keeps a broken call loud instead of quietly producing one unbroken segment.
        ordinal = message_ordinal(row) if stops else None
        stopped = (
            previous is not None
            and ordinal is not None
            and stopped_between(stops, previous_ordinal, ordinal)
        )
        reason = break_reason(previous, sample, stopped=stopped)
        if reason is not None:
            if len(segments) >= MAX_TRACK_SEGMENTS:
                raise ValueError("FIT track exceeds the segment limit")
            segments.append(
                {"index": len(segments), "startReason": reason, "sampleIds": [sample["sampleId"]]}
            )
        else:
            current = segments[-1]
            assert isinstance(current["sampleIds"], list)
            current["sampleIds"].append(sample["sampleId"])
            if previous is not None:
                before, after = previous["position"], sample["position"]
                if isinstance(before, list) and isinstance(after, list):
                    recomputed = (recomputed or 0.0) + haversine_meters(before, after)
        previous = sample
        previous_ordinal = ordinal
    return {
        "schemaVersion": 1,
        "provenance": {
            "kind": "local-file",
            "format": "fit",
            "fileSha256": digest,
            "fileByteLength": byte_length,
            "parserId": PARSER_ID,
            "parserVersion": PARSER_VERSION,
            "streamIndex": stream_index,
            "sourceItemIndex": source_item_index,
            "streamLabel": None,
        },
        "sourceKind": "fit-session",
        "name": None,
        "samples": samples,
        "segments": segments,
        "segmentPolicy": dict(SEGMENT_POLICY),
        "distances": {
            "deviceReportedMeters": device_distance_meters,
            "recomputedFromPositionsMeters": recomputed,
        },
    }
