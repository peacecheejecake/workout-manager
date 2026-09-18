"""Export bounded FIT session summaries for an explicit authenticated app import.

No network access, inferred start time, GPS export, or synthetic parent activity.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from workout_manager.fit_batch import MAX_SOURCE_BYTES, parse_fit, parse_fit_streams, sha256_file


def optional_number(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise TypeError("Invalid FIT summary number")
    if not math.isfinite(value) or value < 0:
        raise ValueError("Invalid FIT summary number")
    return float(value)


def activity_commands(
    source: Path,
    timezone_name: str | None = None,
    *,
    include_details: bool = False,
    include_bouts: bool = False,
) -> list[dict[str, object]]:
    if include_details or include_bouts:
        return detailed_commands(source, timezone_name, include_bouts=include_bouts)
    if timezone_name is not None:
        ZoneInfo(timezone_name)  # Explicit user metadata; never infer from GPS or this machine.
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("FIT exceeds export size limit")
    digest = sha256_file(source)
    sessions = parse_fit(source)["session"]
    if sha256_file(source) != digest:
        raise ValueError("FIT changed during export")
    if len(sessions) == 0 or len(sessions) > 100:
        raise ValueError("Expected 1 to 100 FIT session messages")
    commands: list[dict[str, object]] = []
    for index, row in enumerate(sessions.to_dict(orient="records")):
        start = row.get("start_time")
        started_at = None
        if isinstance(start, datetime) and not pd.isna(start):
            # FIT date_time is UTC; unlike local_timestamp it is not local civil time.
            started_at = start.replace(tzinfo=UTC).isoformat()
        timer = optional_number(row.get("total_timer_time"))
        elapsed = optional_number(row.get("total_elapsed_time"))
        kind = row.get("sport")
        if kind not in {"running", "cycling", "walking", "strength", "other"}:
            kind = "unknown"
        commands.append(
            {
                "idempotencyKey": f"fit-{digest}-{index}",
                "source": {
                    "kind": "fit",
                    "sourceId": f"sha256:{digest}:session:{index}",
                    "revision": 1,
                    "contentHash": digest,
                },
                "activity": {
                    "title": None,
                    "kind": kind,
                    "startedAt": started_at,
                    "timezone": timezone_name,
                    "durationSeconds": timer if timer is not None else elapsed,
                    "durationKind": "timer"
                    if timer is not None
                    else "elapsed"
                    if elapsed is not None
                    else "unknown",
                    "distanceMeters": optional_number(row.get("total_distance")),
                },
            }
        )
    return commands


def export_activity(
    source: Path,
    output: Path,
    timezone_name: str | None = None,
    *,
    include_details: bool = False,
    include_bouts: bool = False,
) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError("Activity export already exists")
    value = {
        "schemaVersion": 4 if include_bouts else 3 if include_details else 1,
        "imports": activity_commands(
            source, timezone_name, include_details=include_details, include_bouts=include_bouts
        ),
    }
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if (include_details or include_bouts) and len(content.encode("utf-8")) > MAX_EXPORT_BYTES:
        raise ValueError("Activity export exceeds 16 MiB limit")
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".activity-export-", dir=output.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, output)  # Atomic creation: never replace a concurrent output.
    finally:
        Path(temporary).unlink(missing_ok=True)


MAX_DETAIL_RECORDS = 20_000
MAX_DETAIL_LAPS = 1_000
MAX_DETAIL_BYTES = 4 * 1024 * 1024
MAX_EXPORT_BYTES = 16 * 1024 * 1024


def detail_number(value: object, *, heart_rate: bool = False) -> float | int | None:
    number = optional_number(value)
    if number is None:
        return None
    if heart_rate:
        if number > 255 or not number.is_integer():
            raise ValueError("Invalid FIT heart rate")
        return int(number)
    if number > 1_000_000_000:
        raise ValueError("FIT metric exceeds detail limit")
    return number


def detail_time(value: object) -> datetime | None:
    if value is None or pd.isna(value):
        return None
    if not isinstance(value, datetime):
        raise TypeError("Invalid FIT timestamp")
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def timestamp(value: object) -> str | None:
    instant = detail_time(value)
    return instant.isoformat() if instant is not None else None


def summary_range(row: dict[str, object]) -> tuple[datetime, datetime]:
    # Garmin FIT summaries' timestamp is write time, not their interval end.
    start = detail_time(row.get("start_time"))
    elapsed = detail_number(row.get("total_elapsed_time"))
    if start is None or elapsed is None:
        raise ValueError("Multiple sessions require explicit start and elapsed time")
    try:
        return start, start + timedelta(seconds=elapsed)
    except OverflowError as error:
        raise ValueError("FIT summary interval exceeds timestamp range") from error


def detail_owners(
    stream: dict[str, list[dict[str, object]]],
) -> tuple[list[list[dict[str, object]]], list[list[dict[str, object]]]]:
    sessions = stream["session"]
    records: list[list[dict[str, object]]] = [[] for _ in sessions]
    laps: list[list[dict[str, object]]] = [[] for _ in sessions]
    if not sessions:
        if stream["record"] or stream["lap"]:
            raise ValueError("FIT stream has observations without a session")
        return records, laps
    ranges = [summary_range(row) for row in sessions] if len(sessions) > 1 else []
    ordered = sorted(ranges)
    if any(right[0] < left[1] for left, right in pairwise(ordered)):
        raise ValueError("FIT session ranges overlap")
    for name, assigned in (("record", records), ("lap", laps)):
        for index, row in enumerate(stream[name]):
            if ranges:
                if name == "record":
                    start = detail_time(row.get("timestamp"))
                    if start is None:
                        raise ValueError("Cannot assign a timestamp-less record to a session")
                    end = start
                else:
                    start, end = summary_range(row)
                # Closed containment preserves final samples. A shared boundary with
                # two possible owners is rejected rather than guessed or dropped.
                owners = [i for i, (a, b) in enumerate(ranges) if a <= start and end <= b]
                if len(owners) != 1:
                    raise ValueError("FIT observation has no unique session owner")
                owner = owners[0]
            else:
                owner = 0
            if name == "record":
                item = {
                    "index": index,
                    "timestamp": timestamp(row.get("timestamp")),
                    "distanceMeters": detail_number(row.get("distance")),
                    "heartRateBpm": detail_number(row.get("heart_rate"), heart_rate=True),
                }
            else:
                item = {
                    "index": index,
                    "startedAt": timestamp(row.get("start_time")),
                    "recordedAt": timestamp(row.get("timestamp")),
                    "elapsedSeconds": detail_number(row.get("total_elapsed_time")),
                    "timerSeconds": detail_number(row.get("total_timer_time")),
                    "distanceMeters": detail_number(row.get("total_distance")),
                    "averageHeartRateBpm": detail_number(
                        row.get("avg_heart_rate"), heart_rate=True
                    ),
                    "maximumHeartRateBpm": detail_number(
                        row.get("max_heart_rate"), heart_rate=True
                    ),
                }
            assigned[owner].append(item)
            limit = MAX_DETAIL_RECORDS if name == "record" else MAX_DETAIL_LAPS
            if len(assigned[owner]) > limit:
                raise ValueError("FIT details exceed observation count limit")
    return records, laps


def bout_allocation(parent: dict[str, object], laps: list[dict[str, object]]) -> dict[str, object]:
    """Only explicit FIT lap boundaries can claim a sport within one parent session."""
    start, end = summary_range(parent)
    if end <= start:
        raise ValueError("FIT parent interval must have positive elapsed time")
    parent_interval = {"startedAt": start.isoformat(), "endedAtExclusive": end.isoformat()}
    unknown = lambda a, b: {
        "sourceLapIndex": None,
        "startedAt": a.isoformat(),
        "endedAtExclusive": b.isoformat(),
        "kind": "mixed_unallocated",
    }
    if not laps:
        return {"parent": parent_interval, "bouts": [unknown(start, end)]}
    ranges: list[tuple[datetime, datetime, dict[str, object]]] = []
    for lap in laps:
        if lap["startedAt"] is None or lap["elapsedSeconds"] is None:
            # A missing lap edge may cover any portion; do not assign the other laps either.
            return {"parent": parent_interval, "bouts": [unknown(start, end)]}
        lap_start = datetime.fromisoformat(str(lap["startedAt"]))
        lap_end = lap_start + timedelta(seconds=float(lap["elapsedSeconds"]))
        if lap_start < start or lap_end > end or lap_end <= lap_start:
            raise ValueError("FIT lap exceeds parent interval")
        ranges.append((lap_start, lap_end, lap))
    ranges.sort(key=lambda item: (item[0], item[1], item[2]["index"]))
    if any(right[0] < left[1] for left, right in pairwise(ranges)):
        raise ValueError("FIT lap intervals overlap")
    bouts: list[dict[str, object]] = []
    cursor = start
    for lap_start, lap_end, lap in ranges:
        if cursor < lap_start:
            bouts.append(unknown(cursor, lap_start))
        sport = lap["sport"]
        bouts.append(
            {
                "sourceLapIndex": lap["index"],
                "startedAt": lap_start.isoformat(),
                "endedAtExclusive": lap_end.isoformat(),
                "kind": sport
                if sport in {"running", "cycling", "walking", "strength"}
                else "mixed_unallocated",
            }
        )
        cursor = lap_end
    if cursor < end:
        bouts.append(unknown(cursor, end))
    return {"parent": parent_interval, "bouts": bouts}


def detailed_commands(
    source: Path, timezone_name: str | None, *, include_bouts: bool = False
) -> list[dict[str, object]]:
    if timezone_name is not None:
        ZoneInfo(timezone_name)
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("FIT exceeds export size limit")
    digest = sha256_file(source)
    streams = parse_fit_streams(source)
    if sha256_file(source) != digest:
        raise ValueError("FIT changed during export")
    count = sum(len(stream["session"]) for stream in streams)
    if not 1 <= count <= 100:
        raise ValueError("Expected 1 to 100 FIT session messages")
    commands: list[dict[str, object]] = []
    for stream_index, stream in enumerate(streams):
        records, laps = detail_owners(stream)
        for local_index, row in enumerate(stream["session"]):
            index = len(commands)
            owned_laps = laps[local_index]
            if include_bouts:
                for lap in owned_laps:
                    source_lap = stream["lap"][int(lap["index"])]
                    raw_sport = source_lap.get("sport")
                    raw_sub_sport = source_lap.get("sub_sport")
                    lap["sport"] = (
                        "strength"
                        if raw_sport == "training" and raw_sub_sport == "strength_training"
                        else raw_sport
                        if raw_sport in {"running", "cycling", "walking"}
                        else None
                    )
            details = {
                "schemaVersion": 3 if include_bouts else 2,
                "streamIndex": stream_index,
                "sessionIndex": index,
                "startedAt": timestamp(row.get("start_time")),
                "recordedAt": timestamp(row.get("timestamp")),
                "elapsedSeconds": detail_number(row.get("total_elapsed_time")),
                "sessionSummary": {
                    "averageHeartRateBpm": detail_number(
                        row.get("avg_heart_rate"), heart_rate=True
                    ),
                    "maximumHeartRateBpm": detail_number(
                        row.get("max_heart_rate"), heart_rate=True
                    ),
                },
                "records": records[local_index],
                "laps": owned_laps,
            }
            if include_bouts:
                details["allocation"] = bout_allocation(row, owned_laps)
            compact = json.dumps(
                details, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
            if len(compact.encode("utf-8")) > MAX_DETAIL_BYTES:
                raise ValueError("FIT details exceed 4 MiB limit")
            timer = detail_number(row.get("total_timer_time"))
            elapsed = detail_number(row.get("total_elapsed_time"))
            kind = row.get("sport")
            if kind not in {"running", "cycling", "walking", "strength", "other"}:
                kind = "unknown"
            if include_bouts:
                allocated = {bout["kind"] for bout in details["allocation"]["bouts"]}
                kind = (
                    next(iter(allocated))
                    if len(allocated) == 1 and "mixed_unallocated" not in allocated
                    else "unknown"
                )
            commands.append(
                {
                    "idempotencyKey": f"fit-details-v{'3' if include_bouts else '2'}-{digest}-{index}",
                    "source": {
                        "kind": "fit",
                        "sourceId": f"sha256:{digest}:session:{index}",
                        "revision": 4 if include_bouts else 3,
                        "contentHash": digest,
                    },
                    "activity": {
                        "title": None,
                        "kind": kind,
                        "startedAt": details["startedAt"],
                        "timezone": timezone_name,
                        "durationSeconds": timer if timer is not None else elapsed,
                        "durationKind": "timer"
                        if timer is not None
                        else "elapsed"
                        if elapsed is not None
                        else "unknown",
                        "distanceMeters": detail_number(row.get("total_distance")),
                    },
                    "details": details,
                }
            )
    return commands
