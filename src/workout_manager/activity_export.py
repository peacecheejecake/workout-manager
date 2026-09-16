"""Export bounded FIT session summaries for an explicit authenticated app import.

No network access, inferred start time, GPS export, or synthetic parent activity.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from workout_manager.fit_batch import MAX_SOURCE_BYTES, parse_fit, sha256_file


def optional_number(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise TypeError("Invalid FIT summary number")
    if not math.isfinite(value) or value < 0:
        raise ValueError("Invalid FIT summary number")
    return float(value)


def activity_commands(source: Path, timezone_name: str | None = None) -> list[dict[str, object]]:
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


def export_activity(source: Path, output: Path, timezone_name: str | None = None) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError("Activity export already exists")
    value = {"schemaVersion": 1, "imports": activity_commands(source, timezone_name)}
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".activity-export-", dir=output.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, output)  # Atomic creation: never replace a concurrent output.
    finally:
        Path(temporary).unlink(missing_ok=True)
