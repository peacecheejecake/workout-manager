"""Session heart rates use only genuine, synthetic FIT session fields."""

import json
import struct
from pathlib import Path

import pytest
from test_fit_batch import crc, fit_bytes

from workout_manager.activity_export import activity_commands, export_activity
from workout_manager.cli import main
from workout_manager.fit_batch import parse_fit_streams


def session_summary_fit(average=146, maximum=181):
    data = b""
    specs = [
        (20, [(253, 4, 0x86), (3, 1, 0x02)], struct.pack("<IB", 1_100_000_000, 120)),
        (
            19,
            [(253, 4, 0x86), (15, 1, 0x02), (16, 1, 0x02)],
            struct.pack("<IBB", 1_100_000_000, 110, 130),
        ),
        (
            18,
            [(253, 4, 0x86), (16, 1, 0x02), (17, 1, 0x02)],
            struct.pack("<IBB", 1_100_000_000, average, maximum),
        ),
    ]
    for local, (global_number, fields, values) in enumerate(specs):
        data += struct.pack("<BBBH", 0x40 | local, 0, 0, global_number)
        data += bytes([len(fields)]) + bytes(value for field in fields for value in field)
        data += bytes([local]) + values
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    return header + data + struct.pack("<H", crc(header + data))


def mixed_parent_bout_fit():
    """One 60-minute FIT session with 40-minute run and 10-minute strength laps."""
    start = 1_100_000_000
    definitions = b""
    for local, global_number, fields in [
        (0, 18, [(253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86), (8, 4, 0x86), (5, 1, 0x00)]),
        (1, 19, [(2, 4, 0x86), (7, 4, 0x86), (25, 1, 0x00), (39, 1, 0x00)]),
    ]:
        definitions += struct.pack("<BBBH", 0x40 | local, 0, 0, global_number)
        definitions += bytes([len(fields)]) + bytes(value for field in fields for value in field)
    rows = b"\x00" + struct.pack("<IIIIB", start + 3600, start, 3_600_000, 3_600_000, 0)
    rows += b"\x01" + struct.pack("<IIBB", start, 2_400_000, 1, 0)
    rows += b"\x01" + struct.pack("<IIBB", start + 2400, 600_000, 10, 20)
    data = definitions + rows
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    return header + data + struct.pack("<H", crc(header + data))


def test_explicit_parent_bouts_export_one_activity_with_unallocated_remainder(tmp_path):
    source = tmp_path / "mixed.fit"
    source.write_bytes(mixed_parent_bout_fit())
    output = tmp_path / "mixed.json"
    export_activity(source, output, include_bouts=True)
    exported = json.loads(output.read_text())
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-activity-bout-export.json"
    assert exported == json.loads(fixture.read_text())
    assert exported["schemaVersion"] == 4
    assert len(exported["imports"]) == 1
    command = exported["imports"][0]
    assert command["source"]["revision"] == 4
    assert command["activity"]["durationSeconds"] == 3600
    assert command["details"]["schemaVersion"] == 3
    assert [bout["kind"] for bout in command["details"]["allocation"]["bouts"]] == [
        "running",
        "strength",
        "mixed_unallocated",
    ]
    assert [bout["sourceLapIndex"] for bout in command["details"]["allocation"]["bouts"]] == [
        0,
        1,
        None,
    ]
    assert [lap["sport"] for lap in command["details"]["laps"]] == ["running", "strength"]
    assert activity_commands(source, include_details=True)[0]["source"]["revision"] == 3
    cli_output = tmp_path / "mixed-cli.json"
    assert (
        main(["export-activity", str(source), "--output", str(cli_output), "--include-bouts"]) == 0
    )
    assert json.loads(cli_output.read_text()) == exported


def test_bout_export_rejects_overlap_and_keeps_missing_sport_unallocated(monkeypatch, tmp_path):
    from datetime import UTC, datetime, timedelta

    source = tmp_path / "mixed.fit"
    source.write_bytes(mixed_parent_bout_fit())
    start = datetime(2026, 9, 18, tzinfo=UTC)
    stream = {
        "session": [{"start_time": start, "total_elapsed_time": 3600}],
        "record": [],
        "lap": [
            {"start_time": start, "total_elapsed_time": 2400, "sport": "running"},
            {"start_time": start + timedelta(seconds=2400), "total_elapsed_time": 600},
        ],
    }
    monkeypatch.setattr("workout_manager.activity_export.parse_fit_streams", lambda _: [stream])
    assert [
        bout["kind"]
        for bout in activity_commands(source, include_bouts=True)[0]["details"]["allocation"][
            "bouts"
        ]
    ] == ["running", "mixed_unallocated", "mixed_unallocated"]
    stream["lap"][1]["start_time"] = start + timedelta(seconds=2399)
    with pytest.raises(ValueError, match="overlap"):
        activity_commands(source, include_bouts=True)
    del stream["lap"][1]["start_time"]
    assert [
        bout["kind"]
        for bout in activity_commands(source, include_bouts=True)[0]["details"]["allocation"][
            "bouts"
        ]
    ] == ["mixed_unallocated"]


def test_real_session_summary_export_matches_shared_fixture(tmp_path):
    source = tmp_path / "summary.fit"
    source.write_bytes(session_summary_fit())
    parsed = parse_fit_streams(source)[0]
    assert parsed["session"][0]["avg_heart_rate"] == 146
    assert parsed["session"][0]["max_heart_rate"] == 181
    legacy = activity_commands(source)[0]
    output = tmp_path / "summary.json"
    export_activity(source, output, include_details=True)
    value = json.loads(output.read_text())
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-activity-summary-export.json"
    assert value == json.loads(fixture.read_text())
    assert value["schemaVersion"] == 3
    command = value["imports"][0]
    assert command["source"]["revision"] == 3
    assert command["source"]["sourceId"] == legacy["source"]["sourceId"]
    assert command["source"]["contentHash"] == legacy["source"]["contentHash"]
    assert command["idempotencyKey"] == f"fit-details-v2-{command['source']['contentHash']}-0"
    assert command["details"]["schemaVersion"] == 2
    assert command["details"]["sessionSummary"] == {
        "averageHeartRateBpm": 146,
        "maximumHeartRateBpm": 181,
    }
    assert command["details"]["records"][0]["heartRateBpm"] == 120
    assert command["details"]["laps"][0]["averageHeartRateBpm"] == 110
    assert command["details"]["laps"][0]["maximumHeartRateBpm"] == 130


@pytest.mark.parametrize(
    "average,maximum,expected",
    [(0, 0, (0, 0)), (255, 255, (None, None)), (0, 181, (0, 181)), (146, 255, (146, None))],
)
def test_real_session_summary_preserves_zero_and_invalid_sentinel(
    tmp_path, average, maximum, expected
):
    source = tmp_path / "summary.fit"
    source.write_bytes(session_summary_fit(average, maximum))
    summary = activity_commands(source, include_details=True)[0]["details"]["sessionSummary"]
    assert summary == {"averageHeartRateBpm": expected[0], "maximumHeartRateBpm": expected[1]}


def test_summary_only_export_remains_exact_legacy_fixture(tmp_path):
    source = tmp_path / "legacy.fit"
    source.write_bytes(fit_bytes())
    output = tmp_path / "legacy.json"
    export_activity(source, output)
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-activity-export.json"
    assert output.read_bytes() == fixture.read_bytes()


def test_real_chained_sessions_keep_their_own_summaries(tmp_path):
    source = tmp_path / "chained.fit"
    source.write_bytes(session_summary_fit(100, 150) + session_summary_fit(160, 190))
    commands = activity_commands(source, include_details=True)
    assert [item["details"]["sessionSummary"]["averageHeartRateBpm"] for item in commands] == [
        100,
        160,
    ]
    assert [item["details"]["streamIndex"] for item in commands] == [0, 1]
    assert [item["details"]["sessionIndex"] for item in commands] == [0, 1]
