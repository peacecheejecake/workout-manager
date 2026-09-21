"""Synthetic FIT GPS fixtures. No personal, device or provider data."""

import json
import struct
from datetime import UTC, datetime
from pathlib import Path

import pytest
from test_fit_batch import crc

from workout_manager.activity_export import activity_commands, export_activity
from workout_manager.cli import main
from workout_manager.fit_batch import parse_fit_streams
from workout_manager.track_export import (
    SEMICIRCLE_DEGREES,
    semicircle_degrees,
    stop_ordinals,
    track_payload,
)

RECORD, LAP, SESSION = 20, 19, 18
UINT32, SINT32, UINT8, ENUM = 0x86, 0x85, 0x02, 0x00
EVENT = 21
INVALID_SINT32 = 0x7FFFFFFF
FIT_EPOCH = 631_065_600
# A real FIT date_time: below 0x10000000 parsers treat the value as raw system time.
FIT_EPOCH_OFFSET = int(datetime(2026, 3, 1, tzinfo=UTC).timestamp()) - FIT_EPOCH


def semicircles(degrees: float) -> int:
    return round(degrees / SEMICIRCLE_DEGREES)


def message(global_number: int, fields: list[tuple[int, int, int | None]]) -> bytes:
    definition = struct.pack("<BBBHB", 0x40, 0, 0, global_number, len(fields))
    data = bytes([0x00])
    for number, base_type, value in fields:
        size = 1 if base_type in (UINT8, ENUM) else 4
        definition += bytes([number, size, base_type])
        if value is None:
            raw = (
                0xFF
                if base_type == UINT8
                else INVALID_SINT32
                if base_type == SINT32
                else 0xFFFFFFFF
            )
        else:
            raw = value
        data += (
            bytes([raw & 0xFF])
            if size == 1
            else struct.pack("<i" if base_type == SINT32 else "<I", raw)
        )
    return definition + data


def record_message(
    seconds: int,
    longitude: float | None = None,
    latitude: float | None = None,
    heart_rate: int | None = None,
    distance_meters: float | None = None,
) -> bytes:
    return message(
        RECORD,
        [
            (253, UINT32, FIT_EPOCH_OFFSET + seconds),
            (0, SINT32, None if latitude is None else semicircles(latitude)),
            (1, SINT32, None if longitude is None else semicircles(longitude)),
            (3, UINT8, heart_rate),
            (5, UINT32, None if distance_meters is None else round(distance_meters * 100)),
        ],
    )


def timer_stop_message(seconds: int, event_type: int = 4) -> bytes:
    """FIT event_type: 1 stop, 4 stop_all, 8/9 stop_disable variants."""
    return message(
        EVENT,
        [
            (253, UINT32, FIT_EPOCH_OFFSET + seconds),
            (0, ENUM, 0),
            (1, ENUM, event_type),
        ],
    )


def session_message(elapsed_seconds: float, distance_meters: float | None) -> bytes:
    return message(
        SESSION,
        [
            (253, UINT32, FIT_EPOCH_OFFSET),
            (2, UINT32, FIT_EPOCH_OFFSET),
            (7, UINT32, round(elapsed_seconds * 1000)),
            (9, UINT32, None if distance_meters is None else round(distance_meters * 100)),
        ],
    )


def fit_track_bytes(records: list[bytes], elapsed_seconds: float = 600.0) -> bytes:
    body = session_message(elapsed_seconds, 1234.5) + b"".join(records)
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(body), b".FIT")
    header += struct.pack("<H", crc(header))
    content = header + body
    return content + struct.pack("<H", crc(content))


def write(tmp_path: Path, records: list[bytes]) -> Path:
    source = tmp_path / "track.fit"
    source.write_bytes(fit_track_bytes(records))
    return source


def test_semicircles_become_degrees_in_longitude_latitude_order(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5, heart_rate=140),
            record_message(1, longitude=127.0501, latitude=37.5001, heart_rate=141),
        ],
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert track["schemaVersion"] == 1
    assert track["provenance"]["kind"] == "local-file"
    assert "activityId" not in track["provenance"]
    longitude, latitude = track["samples"][0]["position"]
    assert longitude == pytest.approx(127.05, abs=1e-6)
    assert latitude == pytest.approx(37.5, abs=1e-6)
    assert [sample["sampleId"] for sample in track["samples"]] == ["0:0", "0:1"]
    assert track["segments"] == [
        {"index": 0, "startReason": "stream-start", "sampleIds": ["0:0", "0:1"]}
    ]


def test_invalid_position_sentinel_is_null_and_keeps_other_measurements(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5),
            record_message(1, heart_rate=150, distance_meters=12.5),
            record_message(2, longitude=127.0502, latitude=37.5002),
        ],
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    middle = track["samples"][1]
    assert middle["position"] is None
    assert middle["heartRateBpm"] == 150
    assert middle["distanceMeters"] == pytest.approx(12.5)
    assert [segment["startReason"] for segment in track["segments"]] == [
        "stream-start",
        "missing-position",
        "missing-position",
    ]


def test_sample_links_to_its_gps_free_detail_record(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5, heart_rate=140),
            record_message(1, longitude=127.0501, latitude=37.5, heart_rate=141),
        ],
    )
    command = activity_commands(source, include_track=True)[0]
    details, track = command["details"], command["track"]
    assert details["schemaVersion"] == 2
    for sample, record in zip(track["samples"], details["records"], strict=True):
        assert sample["detailLink"] == {
            "detailSchemaVersion": 2,
            "streamIndex": details["streamIndex"],
            "sessionIndex": details["sessionIndex"],
            "recordIndex": record["index"],
        }
        assert sample["recordedAt"] == record["timestamp"]
        assert sample["heartRateBpm"] == record["heartRateBpm"]
    # The detail record contract stays GPS free.
    assert set(details["records"][0]) == {"index", "timestamp", "distanceMeters", "heartRateBpm"}


def test_detail_only_export_is_byte_identical_with_and_without_track_support(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5, heart_rate=140),
            record_message(1, longitude=127.0501, latitude=37.5, heart_rate=141),
        ],
    )
    details = activity_commands(source, include_details=True)
    with_track = activity_commands(source, include_track=True)
    assert all("track" not in command for command in details)
    assert details[0]["details"] == with_track[0]["details"]
    assert details[0]["source"]["revision"] == 3
    assert with_track[0]["source"]["revision"] == 5
    assert with_track[0]["idempotencyKey"].startswith("fit-track-v1-")


def test_time_gap_and_position_gap_split_segments(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5),
            record_message(1, longitude=127.0501, latitude=37.5),
            record_message(300, longitude=127.0502, latitude=37.5),
            record_message(301, longitude=127.2, latitude=37.5),
        ],
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert [segment["startReason"] for segment in track["segments"]] == [
        "stream-start",
        "time-gap",
        "position-gap",
    ]
    assert track["distances"]["deviceReportedMeters"] == pytest.approx(1234.5)
    # Only within-segment pairs contribute to the recomputed distance.
    assert track["distances"]["recomputedFromPositionsMeters"] == pytest.approx(8.83, abs=0.5)


def test_semicircle_helper_rejects_out_of_range_values():
    assert semicircle_degrees(None, 180.0) is None
    assert semicircle_degrees(INVALID_SINT32, 90.0) is None
    with pytest.raises(ValueError):
        semicircle_degrees(semicircles(120.0), 90.0)
    with pytest.raises(TypeError):
        semicircle_degrees("37.5", 90.0)


def test_export_matches_the_contract_fixture(tmp_path):
    source = write(
        tmp_path,
        [
            record_message(0, longitude=127.05, latitude=37.5, heart_rate=140, distance_meters=0),
            record_message(
                1, longitude=127.0501, latitude=37.5001, heart_rate=142, distance_meters=13.2
            ),
            record_message(2, heart_rate=143, distance_meters=26.0),
            record_message(
                3, longitude=127.0503, latitude=37.5003, heart_rate=144, distance_meters=39.1
            ),
        ],
    )
    output = tmp_path / "import.json"
    assert main(["export-activity", str(source), "--output", str(output), "--include-track"]) == 0
    exported = json.loads(output.read_text())
    assert exported["schemaVersion"] == 5
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-track-export.json"
    assert json.loads(fixture.read_text()) == exported
    with pytest.raises(ValueError):
        export_activity(source, output, include_track=True)


@pytest.mark.parametrize("event_type", [1, 4, 8, 9])
def test_fit_timer_stop_splits_python_track_segments(tmp_path, event_type):
    source = tmp_path / "stop.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                record_message(0, longitude=127.05, latitude=37.5),
                timer_stop_message(1, event_type),
                record_message(2, longitude=127.0501, latitude=37.5),
                record_message(3, longitude=127.0502, latitude=37.5),
            ]
        )
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert [segment["startReason"] for segment in track["segments"]] == [
        "stream-start",
        "fit-event-stop",
    ]
    assert [segment["sampleIds"] for segment in track["segments"]] == [
        ["0:0"],
        ["0:1", "0:2"],
    ]


def test_events_without_a_stop_do_not_split(tmp_path):
    source = tmp_path / "start.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                record_message(0, longitude=127.05, latitude=37.5),
                timer_stop_message(1, 0),  # event_type 0 is start, not a stop.
                record_message(2, longitude=127.0501, latitude=37.5),
            ]
        )
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert [segment["startReason"] for segment in track["segments"]] == ["stream-start"]


def test_minus_180_longitude_is_a_real_coordinate_not_a_sentinel(tmp_path):
    assert semicircle_degrees(-(2**31), 180.0) == pytest.approx(-180.0)
    assert semicircle_degrees(INVALID_SINT32, 180.0) is None
    with pytest.raises(ValueError):
        semicircle_degrees(-(2**31), 90.0)
    source = tmp_path / "antimeridian.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                record_message(0, longitude=-180.0, latitude=-37.5),
                record_message(1, longitude=-179.9999, latitude=-37.5),
            ]
        )
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert track["samples"][0]["position"][0] == pytest.approx(-180.0)
    assert track["samples"][0]["position"][1] == pytest.approx(-37.5)


def test_stop_in_the_same_second_as_the_previous_record_still_splits(tmp_path):
    source = tmp_path / "same-second.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                record_message(0, longitude=127.05, latitude=37.5),
                timer_stop_message(0),  # Same whole-second timestamp as the record above.
                record_message(2, longitude=127.0501, latitude=37.5),
            ]
        )
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert [segment["startReason"] for segment in track["segments"]] == [
        "stream-start",
        "fit-event-stop",
    ]


def test_stop_before_the_first_record_does_not_split(tmp_path):
    source = tmp_path / "leading-stop.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                timer_stop_message(0),
                record_message(0, longitude=127.05, latitude=37.5),
                record_message(1, longitude=127.0501, latitude=37.5),
            ]
        )
    )
    track = activity_commands(source, include_track=True)[0]["track"]
    assert [segment["startReason"] for segment in track["segments"]] == ["stream-start"]


def test_missing_message_ordinal_fails_loudly_instead_of_losing_stops(tmp_path):
    """An internal contract violation must not quietly degrade to "no stops"."""
    source = tmp_path / "ordinals.fit"
    source.write_bytes(
        fit_track_bytes(
            [
                record_message(0, longitude=127.05, latitude=37.5),
                timer_stop_message(1),
                record_message(2, longitude=127.0501, latitude=37.5),
            ]
        )
    )
    # Parsed without ordering, the same bytes cannot support stop boundaries.
    streams = parse_fit_streams(source, ("event",))
    with pytest.raises(ValueError):
        stop_ordinals(streams[0]["event"])
    ordered = parse_fit_streams(source, ("event",), with_order=True)
    stops = stop_ordinals(ordered[0]["event"])
    assert len(stops) == 1
    with pytest.raises(ValueError):
        track_payload(
            streams[0]["record"],  # Rows without ordinals.
            [
                {"index": 0, "timestamp": None, "distanceMeters": None, "heartRateBpm": None},
                {"index": 1, "timestamp": None, "distanceMeters": None, "heartRateBpm": None},
            ],
            stream_index=0,
            session_index=0,
            source_item_index=0,
            detail_schema_version=2,
            digest="a" * 64,
            byte_length=100,
            device_distance_meters=None,
            stops=stops,
        )
