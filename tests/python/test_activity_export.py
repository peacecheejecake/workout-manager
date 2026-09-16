import json
from pathlib import Path

import pandas as pd
import pytest
from test_fit_batch import fit_bytes

from workout_manager.activity_export import activity_commands, export_activity
from workout_manager.cli import main


def test_real_fit_missing_fields_are_unknown_and_filename_is_not_identity(tmp_path):
    source = tmp_path / "first.fit"
    source.write_bytes(fit_bytes())
    copy = tmp_path / "renamed.fit"
    copy.write_bytes(source.read_bytes())
    first = activity_commands(source)
    assert first == activity_commands(copy)
    assert first[0]["activity"] == {
        "title": None,
        "kind": "unknown",
        "startedAt": None,
        "timezone": None,
        "durationSeconds": None,
        "durationKind": "unknown",
        "distanceMeters": None,
    }
    output = tmp_path / "import.json"
    assert main(["export-activity", str(source), "--output", str(output)]) == 0
    assert json.loads(output.read_text())["imports"] == first
    with pytest.raises(ValueError):
        export_activity(source, output)


def test_session_values_preserve_zero_and_timer_meaning(monkeypatch, tmp_path):
    source = tmp_path / "summary.fit"
    source.write_bytes(fit_bytes())
    monkeypatch.setattr(
        "workout_manager.activity_export.parse_fit",
        lambda _: {
            "session": pd.DataFrame(
                [
                    {
                        "start_time": pd.Timestamp("2026-09-16T01:00:00"),
                        "sport": "running",
                        "total_timer_time": 0,
                        "total_elapsed_time": 60,
                        "total_distance": 0,
                    },
                    {"start_time": None, "sport": None, "total_elapsed_time": 30},
                ]
            )
        },
    )
    commands = activity_commands(source, "Asia/Seoul")
    assert commands[0]["activity"]["durationSeconds"] == 0
    assert commands[0]["activity"]["durationKind"] == "timer"
    assert commands[0]["activity"]["startedAt"] == "2026-09-16T01:00:00+00:00"
    assert commands[0]["activity"]["distanceMeters"] == 0
    assert commands[1]["activity"]["durationKind"] == "elapsed"
    assert commands[0]["source"]["sourceId"] != commands[1]["source"]["sourceId"]


def test_corrupt_and_empty_fit_rejected(tmp_path):
    path = tmp_path / "bad.fit"
    path.write_bytes(b"bad")
    with pytest.raises(ValueError):
        activity_commands(path)
    path.write_bytes(fit_bytes(empty=True))
    with pytest.raises(ValueError):
        activity_commands(path)


def test_export_matches_browser_import_fixture(tmp_path):
    source = tmp_path / "synthetic.fit"
    source.write_bytes(fit_bytes())
    fixture = Path(__file__).parents[1] / "fixtures" / "fit-activity-export.json"
    assert json.loads(fixture.read_text()) == {
        "schemaVersion": 1,
        "imports": activity_commands(source),
    }
