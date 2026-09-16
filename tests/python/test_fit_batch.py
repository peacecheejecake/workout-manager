"""Synthetic FIT fixtures contain no user or provider data."""

import json
import struct
from pathlib import Path

import pandas as pd
import pytest

from workout_manager.cli import main
from workout_manager.fit_batch import convert_batch, parse_fit


def crc(data: bytes) -> int:
    result = 0
    for value in data:
        result ^= value
        for _ in range(8):
            result = (result >> 1) ^ (0xA001 if result & 1 else 0)
    return result


def fit_bytes(*, empty: bool = False, heart_rate: int = 120) -> bytes:
    data = b""
    if not empty:
        for local, global_number in enumerate((20, 19, 18)):
            # A record has heart rate; lap/session have timestamp only.
            fields = bytes([253, 4, 0x86])
            values = struct.pack("<I", 1_000_000)
            if global_number == 20:
                fields += bytes([3, 1, 0x02])
                values += bytes([heart_rate])
            definition = struct.pack("<BBBH", 0x40 | local, 0, 0, global_number)
            data += definition + bytes([len(fields) // 3]) + fields
            data += bytes([local]) + values
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    content = header + data
    return content + struct.pack("<H", crc(content))


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "input" / "activity.fit"
    path.parent.mkdir()
    path.write_bytes(fit_bytes())
    return path


def manifest(output: Path) -> dict:
    return json.loads((output / "manifest.json").read_text())


@pytest.mark.parametrize("format", ["csv", "parquet"])
def test_real_parser_roundtrip(source: Path, tmp_path: Path, format: str) -> None:
    output = tmp_path / "output"
    assert convert_batch(source, output, format) == 0
    read = pd.read_csv if format == "csv" else pd.read_parquet
    paths = list(output.rglob(f"*.{format}"))
    assert len(paths) == 3
    for path in paths:
        frame = read(path)
        assert len(frame) == 1
        assert "timestamp" in frame
        if path.stem == "record":
            assert frame.loc[0, "heart_rate"] == 120
    entry = manifest(output)["entries"][str(source)]
    assert entry["status"] == "success"
    assert entry["rows"] == {"record": 1, "lap": 1, "session": 1}
    assert len(entry["sha256"]) == 64
    assert len(entry["outputs"]) == 3


@pytest.mark.parametrize("format", ["csv", "parquet"])
def test_empty_messages_are_valid_empty_tables(source: Path, tmp_path: Path, format: str) -> None:
    source.write_bytes(fit_bytes(empty=True))
    output = tmp_path / "output"
    assert convert_batch(source, output, format) == 0
    read = pd.read_csv if format == "csv" else pd.read_parquet
    assert all(read(path).empty for path in output.rglob(f"*.{format}"))


@pytest.mark.parametrize(
    "data", [b"", b"not fit", fit_bytes()[:-1], fit_bytes()[:-2] + b"\xff\xff"]
)
def test_malformed_fit_does_not_write_outputs(source: Path, tmp_path: Path, data: bytes) -> None:
    source.write_bytes(data)
    output = tmp_path / "output"
    assert convert_batch(source, output) == 1
    assert not list(output.rglob("*.parquet"))
    assert manifest(output)["entries"][str(source)]["status"] == "failed"


def test_partial_failure_and_retry(source: Path, tmp_path: Path) -> None:
    bad = source.with_name("broken.fit")
    bad.write_bytes(b"bad")
    output = tmp_path / "output"
    assert convert_batch(source.parent, output) == 1
    old_times = {p: p.stat().st_mtime_ns for p in output.rglob("*.parquet")}
    bad.write_bytes(fit_bytes())
    assert convert_batch(source.parent, output, resume=True) == 0
    assert all(p.stat().st_mtime_ns == value for p, value in old_times.items())
    assert manifest(output)["entries"][str(bad)]["attempts"] == 2


def test_no_silent_overwrite_and_verified_resume(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "output"
    assert convert_batch(source, output) == 0
    before = (output / "manifest.json").read_bytes()
    assert convert_batch(source, output) == 1
    assert (output / "manifest.json").read_bytes() == before
    assert convert_batch(source, output, resume=True) == 0
    assert (output / "manifest.json").read_bytes() == before


def test_modified_output_is_not_resumed(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "output"
    assert convert_batch(source, output) == 0
    record = next(output.rglob("record.parquet"))
    record.write_bytes(b"tampered")
    assert convert_batch(source, output, resume=True) == 1
    assert convert_batch(source, output, resume=True, overwrite=True) == 0
    assert pd.read_parquet(record).loc[0, "heart_rate"] == 120


def test_changed_source_requires_overwrite(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "output"
    assert convert_batch(source, output) == 0
    source.write_bytes(fit_bytes(heart_rate=130))
    assert convert_batch(source, output, resume=True) == 1
    assert convert_batch(source, output, overwrite=True) == 0
    assert pd.read_parquet(next(output.rglob("record.parquet"))).loc[0, "heart_rate"] == 130


def test_duplicate_basenames_and_bytes_preserve_paths(source: Path, tmp_path: Path) -> None:
    second = source.parent / "nested" / source.name
    second.parent.mkdir()
    second.write_bytes(source.read_bytes())
    output = tmp_path / "output"
    assert convert_batch(source.parent, output, recursive=True) == 0
    assert len(list(output.rglob("record.parquet"))) == 2
    assert len(list((output / "nested").rglob("record.parquet"))) == 1
    assert convert_batch(source.parent, output, recursive=True, resume=True) == 0


def test_nonrecursive_does_not_visit_children(source: Path, tmp_path: Path) -> None:
    nested = source.parent / "nested"
    nested.mkdir()
    (nested / "bad.fit").write_bytes(b"bad")
    assert convert_batch(source.parent, tmp_path / "output") == 0


def test_output_inside_source_rejected(source: Path) -> None:
    with pytest.raises(ValueError, match="outside"):
        convert_batch(source.parent, source.parent / "output", recursive=True)


def test_empty_directory_rejected(tmp_path: Path) -> None:
    source = tmp_path / "input"
    source.mkdir()
    with pytest.raises(ValueError, match="no regular FIT"):
        convert_batch(source, tmp_path / "output")


def test_cli_exit_codes(source: Path, tmp_path: Path) -> None:
    args = [
        "convert",
        str(source),
        "--output-dir",
        str(tmp_path / "output"),
        "--format",
        "csv",
    ]
    assert main(args) == 0
    assert main(args) == 1
    assert main([*args, "--resume"]) == 0
    with pytest.raises(SystemExit) as error:
        main(["convert", str(source)])
    assert error.value.code == 2


def test_size_limit_checked_before_parsing(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("workout_manager.fit_batch.MAX_SOURCE_BYTES", 1)
    assert convert_batch(source, tmp_path / "output") == 1
    with pytest.raises(ValueError, match="limit"):
        parse_fit(source)


def test_manifest_corruption_is_not_overwritten(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    path = output / "manifest.json"
    path.write_text('{"version": 2, "entries": {}}')
    with pytest.raises(ValueError, match="Unsupported"):
        convert_batch(source, output)
    assert json.loads(path.read_text())["version"] == 2


def test_writer_failure_cannot_be_resumed_as_success(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "output"

    def fail(*args: object, **kwargs: object) -> None:
        raise OSError("synthetic disk failure")

    with monkeypatch.context() as patch:
        patch.setattr(pd.DataFrame, "to_parquet", fail)
        assert convert_batch(source, output) == 1
    assert not list(output.rglob("*.parquet"))
    assert manifest(output)["entries"][str(source)]["status"] == "failed"
    assert convert_batch(source, output, resume=True) == 0


def test_output_directory_lock(source: Path, tmp_path: Path) -> None:
    from workout_manager.fit_batch import output_lock

    output = tmp_path / "output"
    with output_lock(output), pytest.raises(ValueError, match="Another conversion"):
        convert_batch(source, output)


def test_generated_path_cannot_escape_through_symlink(source: Path, tmp_path: Path) -> None:
    from workout_manager.fit_batch import output_paths

    output = tmp_path / "output"
    output.mkdir()
    escape = tmp_path / "elsewhere"
    escape.mkdir()
    paths = output_paths(source, source.parent, output, "parquet")
    paths[0].parent.symlink_to(escape, target_is_directory=True)
    assert convert_batch(source, output) == 1
    assert not list(escape.iterdir())


def test_installed_cli_and_legacy_wrapper(source: Path, tmp_path: Path) -> None:
    import subprocess
    import sys

    executable = Path(sys.executable).parent / "workout-manager"
    result = subprocess.run(
        [
            str(executable),
            "convert",
            str(source),
            "--output-dir",
            str(tmp_path / "cli-output"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert len(list((tmp_path / "cli-output").rglob("*.parquet"))) == 3
    script = Path(__file__).resolve().parents[2] / "scripts" / "fitparse.py"
    result = subprocess.run(
        [sys.executable, str(script), str(source)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    outputs = list((source.parent / "fit-converted").rglob("*.parquet"))
    assert len(outputs) == 3
    assert (
        pd.read_parquet(next(path for path in outputs if path.stem == "record")).loc[
            0, "heart_rate"
        ]
        == 120
    )


def test_interrupted_publish_records_failure_and_needs_explicit_overwrite(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    output = tmp_path / "output"
    replace = os.replace

    def fail_second_output(old: Path, new: Path) -> None:
        if Path(new).name == "lap.parquet":
            raise OSError("synthetic interruption")
        replace(old, new)

    with monkeypatch.context() as patch:
        patch.setattr("workout_manager.fit_batch.os.replace", fail_second_output)
        assert convert_batch(source, output) == 1
    assert manifest(output)["entries"][str(source)]["status"] == "failed"
    assert convert_batch(source, output, resume=True) == 1
    assert convert_batch(source, output, resume=True, overwrite=True) == 0
    assert len(list(output.rglob("*.parquet"))) == 3


def test_many_empty_chained_streams_fail_without_stopping_batch(
    source: Path, tmp_path: Path
) -> None:
    bad = source.with_name("a-empty-chain.fit")
    bad.write_bytes(fit_bytes(empty=True) * 2000)
    output = tmp_path / "output"
    assert convert_batch(source.parent, output) == 1
    entries = manifest(output)["entries"]
    assert entries[str(bad)]["status"] == "failed"
    assert entries[str(source)]["status"] == "success"


def test_bounded_chained_streams_preserve_data(source: Path) -> None:
    source.write_bytes(fit_bytes(empty=True) + fit_bytes() + fit_bytes(heart_rate=130))
    frames = parse_fit(source)
    assert frames["record"]["heart_rate"].tolist() == [120, 130]
    assert len(frames["lap"]) == 2


def test_malformed_chained_stream_is_isolated(source: Path, tmp_path: Path) -> None:
    bad = source.with_name("a-malformed-chain.fit")
    bad.write_bytes(fit_bytes(empty=True) + fit_bytes()[:-1])
    output = tmp_path / "output"
    assert convert_batch(source.parent, output) == 1
    assert manifest(output)["entries"][str(bad)]["status"] == "failed"
    assert manifest(output)["entries"][str(source)]["status"] == "success"


def test_definition_messages_count_toward_limit(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Four definition messages, no data messages; the old iterator hid all four.
    data = (struct.pack("<BBBH", 0x40, 0, 0, 20) + bytes([1, 253, 4, 0x86])) * 4
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    content = header + data
    bad = source.with_name("definitions.fit")
    bad.write_bytes(content + struct.pack("<H", crc(content)))
    monkeypatch.setattr("workout_manager.fit_batch.MAX_MESSAGES", 3)
    with pytest.raises(ValueError, match="message limit"):
        parse_fit(bad)
    # An empty valid stream still succeeds after the rejected definition flood.
    source.write_bytes(fit_bytes(empty=True))
    output = tmp_path / "output"
    assert convert_batch(source.parent, output) == 1
    assert manifest(output)["entries"][str(source)]["status"] == "success"


def test_message_limit_is_shared_across_chained_streams(
    source: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source.write_bytes(fit_bytes() + fit_bytes())
    monkeypatch.setattr("workout_manager.fit_batch.MAX_MESSAGES", 10)
    with pytest.raises(ValueError, match="message limit"):
        parse_fit(source)


def test_invalid_developer_base_type_is_a_file_failure(source: Path, tmp_path: Path) -> None:
    from fitparse import FitFile, FitParseError

    # Declare developer index 0, then a field_description with unknown base type 127.
    data = struct.pack("<BBBH", 0x40, 0, 0, 207) + bytes([1, 3, 1, 2])
    data += bytes([0, 0])
    data += struct.pack("<BBBH", 0x41, 0, 0, 206) + bytes([3, 0, 1, 2, 1, 1, 2, 2, 1, 2])
    data += bytes([1, 0, 0, 127])
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    content = header + data
    payload = content + struct.pack("<H", crc(content))
    bad = source.with_name("a-invalid-developer.fit")
    bad.write_bytes(payload)
    # Establish the third-party regression using real parsing, not a mock.
    with pytest.raises(KeyError, match="127"):
        list(FitFile(payload).get_messages())
    with pytest.raises(FitParseError, match="Invalid FIT message structure"):
        parse_fit(bad)
    output = tmp_path / "output"
    assert convert_batch(source.parent, output) == 1
    entries = manifest(output)["entries"]
    assert entries[str(bad)]["status"] == "failed"
    assert entries[str(bad)]["error"] == "FitParseError"
    assert entries[str(source)]["status"] == "success"
