"""Only synthetic FIT observations; no provider or personal health data."""

import json
import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from test_fit_batch import crc, fit_bytes

from workout_manager.activity_export import activity_commands, export_activity
from workout_manager.cli import main
from workout_manager.fit_batch import parse_fit, parse_fit_streams


def detail_fit():
    original = fit_bytes()
    content = original[:-2].replace(struct.pack("<I", 1_000_000), struct.pack("<I", 1_100_000_000))
    return content + struct.pack("<H", crc(content))


def ordered_fit(summary_first):
    definitions = b""
    fields = {
        0: (18, [(253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86)]),
        1: (20, [(253, 4, 0x86), (3, 1, 0x02)]),
        2: (19, [(253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86)]),
    }
    for local, (global_number, specs) in fields.items():
        definitions += struct.pack("<BBBH", 0x40 | local, 0, 0, global_number)
        definitions += bytes([len(specs)]) + bytes(value for spec in specs for value in spec)
    # Summary write times deliberately precede all intervals and don't order sessions.
    summaries = b"\x00" + struct.pack("<III", 1_000_000_010, 1_000_000_100, 10_000)
    summaries += b"\x00" + struct.pack("<III", 1_000_000_005, 1_000_000_200, 10_000)
    observations = b"\x01" + struct.pack("<IB", 1_000_000_105, 0)
    observations += b"\x01" + struct.pack("<IB", 1_000_000_205, 120)
    observations += b"\x02" + struct.pack("<III", 1_000_000_001, 1_000_000_200, 5_000)
    data = definitions + (summaries + observations if summary_first else observations + summaries)
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    return header + data + struct.pack("<H", crc(header + data))


def test_summary_first_last_real_parser_and_stream_ordinals(tmp_path):
    outputs = []
    for first in (True, False):
        path = tmp_path / f"{first}.fit"
        path.write_bytes(ordered_fit(first) + detail_fit())
        streams = parse_fit_streams(path)
        assert [len(stream["session"]) for stream in streams] == [2, 1]
        assert len(parse_fit(path)["session"]) == 3
        commands = activity_commands(path, include_details=True)
        outputs.append([command["details"] for command in commands])
        assert [item["sessionIndex"] for item in outputs[-1]] == [0, 1, 2]
        assert [item["streamIndex"] for item in outputs[-1]] == [0, 0, 1]
        assert outputs[-1][0]["records"][0]["heartRateBpm"] == 0
        assert outputs[-1][1]["records"][0]["index"] == 1
        assert outputs[-1][0]["laps"] == []
        assert outputs[-1][1]["laps"][0]["index"] == 0
        assert outputs[-1][2]["records"][0]["index"] == 0
        assert commands[2]["source"]["sourceId"].endswith(":session:2")
    assert outputs[0] == outputs[1]


@pytest.fixture
def stream_export(monkeypatch, tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(detail_fit())

    def export(stream):
        monkeypatch.setattr("workout_manager.activity_export.parse_fit_streams", lambda _: [stream])
        return activity_commands(source, include_details=True)

    return export


def test_single_session_preserves_duplicate_and_null_timestamps_zero_and_ignores_gps(stream_export):
    stamp = datetime(2026, 9, 17, tzinfo=UTC)
    result = stream_export(
        {
            "session": [{}],
            "record": [
                {"timestamp": stamp, "distance": 0, "heart_rate": 0, "position_lat": 123},
                {"timestamp": stamp},
                {},
            ],
            "lap": [{"total_timer_time": 0}],
        }
    )[0]["details"]
    assert [row["index"] for row in result["records"]] == [0, 1, 2]
    assert result["records"][0] == {
        "index": 0,
        "timestamp": stamp.isoformat(),
        "distanceMeters": 0,
        "heartRateBpm": 0,
    }
    assert result["records"][2]["timestamp"] is None
    assert result["laps"][0]["timerSeconds"] == 0
    assert result["laps"][0]["elapsedSeconds"] is None


@pytest.mark.parametrize(
    "case",
    [
        "overlap",
        "missing_range",
        "null_record",
        "outside",
        "boundary",
        "lap_missing_range",
        "lap_crossing",
        "no_session",
    ],
)
def test_ambiguous_or_unplaced_observations_rejected(stream_export, case):
    start = datetime(2026, 9, 17, tzinfo=UTC)
    stream = {
        "session": [
            {"start_time": start, "total_elapsed_time": 10},
            {"start_time": start + timedelta(seconds=10), "total_elapsed_time": 10},
        ],
        "record": [],
        "lap": [],
    }
    if case == "overlap":
        stream["session"][1]["start_time"] = start + timedelta(seconds=5)
    elif case == "missing_range":
        del stream["session"][0]["total_elapsed_time"]
    elif case == "null_record":
        stream["record"] = [{}]
    elif case == "outside":
        stream["record"] = [{"timestamp": start - timedelta(seconds=1)}]
    elif case == "boundary":
        stream["record"] = [{"timestamp": start + timedelta(seconds=10)}]
    elif case == "lap_missing_range":
        stream["lap"] = [{"timestamp": start}]
    elif case == "lap_crossing":
        stream["lap"] = [{"start_time": start, "total_elapsed_time": 15}]
    else:
        stream["session"] = []
        stream["record"] = [{}]
        # Keep one valid session in another stream; no cross-stream ownership.
        # The count guard may reject earlier, which is also an explicit failure.
    with pytest.raises(ValueError):
        stream_export(stream)


@pytest.mark.parametrize(
    "field,value",
    [
        ("heart_rate", 256),
        ("heart_rate", 1.5),
        ("distance", -1),
        ("distance", 1_000_000_001),
        ("distance", float("inf")),
    ],
)
def test_invalid_detail_metrics_rejected(stream_export, field, value):
    with pytest.raises(ValueError):
        stream_export({"session": [{}], "record": [{field: value}], "lap": []})


@pytest.mark.parametrize("kind,limit", [("record", 20_000), ("lap", 1_000)])
def test_count_limits_never_truncate(stream_export, kind, limit):
    stream = {"session": [{}], "record": [], "lap": []}
    stream[kind] = [{}] * limit
    assert (
        len(stream_export(stream)[0]["details"]["records" if kind == "record" else "laps"]) == limit
    )
    stream[kind].append({})
    with pytest.raises(ValueError, match="count limit"):
        stream_export(stream)


def test_detail_and_export_byte_limits_leave_no_output(monkeypatch, tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(detail_fit())
    output = tmp_path / "output.json"
    monkeypatch.setattr("workout_manager.activity_export.MAX_DETAIL_BYTES", 1)
    with pytest.raises(ValueError, match="4 MiB"):
        export_activity(source, output, include_details=True)
    assert not output.exists()
    monkeypatch.setattr("workout_manager.activity_export.MAX_DETAIL_BYTES", 4 * 1024 * 1024)
    monkeypatch.setattr("workout_manager.activity_export.MAX_EXPORT_BYTES", 1)
    with pytest.raises(ValueError, match="16 MiB"):
        export_activity(source, output, include_details=True)
    assert not output.exists()


def test_opt_in_fixture_revision_identity_and_legacy_default(tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(detail_fit())
    before = activity_commands(source)
    output = tmp_path / "details.json"
    assert main(["export-activity", str(source), "--output", str(output), "--include-details"]) == 0
    value = json.loads(output.read_text())
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-activity-details-export.json"
    assert value == json.loads(fixture.read_text())
    assert value["schemaVersion"] == 2
    assert value["imports"][0]["source"]["sourceId"] == before[0]["source"]["sourceId"]
    assert value["imports"][0]["source"]["revision"] == 2
    assert value["imports"][0]["idempotencyKey"].startswith("fit-details-v1-")
    assert len(value["imports"][0]["idempotencyKey"]) <= 128
    assert activity_commands(source) == before


def test_interval_overflow_is_a_bounded_export_failure(stream_export):
    with pytest.raises(ValueError, match="timestamp range"):
        stream_export(
            {
                "session": [
                    {
                        "start_time": datetime(9999, 12, 31, tzinfo=UTC),
                        "total_elapsed_time": 100_000,
                    },
                    {"start_time": datetime(2026, 1, 1, tzinfo=UTC), "total_elapsed_time": 1},
                ],
                "record": [],
                "lap": [],
            }
        )


def test_sessions_over_limit_rejected(stream_export):
    with pytest.raises(ValueError, match="1 to 100"):
        stream_export({"session": [{}] * 101, "record": [], "lap": []})


def test_observations_cannot_cross_stream_boundaries(monkeypatch, tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(detail_fit())
    monkeypatch.setattr(
        "workout_manager.activity_export.parse_fit_streams",
        lambda _: [
            {"session": [], "record": [{"timestamp": datetime(2026, 1, 1, tzinfo=UTC)}], "lap": []},
            {"session": [{}], "record": [], "lap": []},
        ],
    )
    with pytest.raises(ValueError, match="without a session"):
        activity_commands(source, include_details=True)


def test_changed_source_aborts_without_output(monkeypatch, tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(detail_fit())
    hashes = iter(["a" * 64, "b" * 64])
    monkeypatch.setattr("workout_manager.activity_export.sha256_file", lambda _: next(hashes))
    output = tmp_path / "output.json"
    with pytest.raises(ValueError, match="changed during export"):
        export_activity(source, output, include_details=True)
    assert not output.exists()
