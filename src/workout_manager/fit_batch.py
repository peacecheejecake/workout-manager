"""Local FIT conversion; no provider access or product activity writes."""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import pandas as pd
from fitparse import FitFile, FitParseError
from pyarrow import ArrowException

LOGGER = logging.getLogger(__name__)
MESSAGE_TYPES = ("record", "lap", "session")
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_MESSAGES = 1_000_000
MAX_STREAMS = 128
OutputFormat = Literal["csv", "parquet"]


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fit_streams(data: bytes) -> Iterator[bytes]:
    """Bound chained streams before fitparse can recursively follow empty headers."""
    offset = 0
    count = 0
    if not data:
        raise ValueError("Empty FIT input")
    while offset < len(data):
        count += 1
        if count > MAX_STREAMS:
            raise ValueError("FIT exceeds the local chained stream limit")
        header = data[offset : offset + 12]
        if len(header) < 12 or header[8:12] != b".FIT":
            raise ValueError("Invalid FIT stream header")
        header_size = header[0]
        if header_size < 12 or header_size == 13:
            raise ValueError("Invalid FIT header size")
        data_size = int.from_bytes(header[4:8], "little")
        end = offset + header_size + data_size + 2
        if end > len(data):
            raise ValueError("Truncated FIT stream")
        yield data[offset:end]
        offset = end


MESSAGE_ORDINAL = "_message_ordinal"


def parse_fit_streams(
    source: Path, extra_types: tuple[str, ...] = (), *, with_order: bool = False
) -> list[dict[str, list[dict[str, object]]]]:
    """Validate the complete FIT stream, including CRC, before writing any output.

    `extra_types` collects additional message names (for example `event`) for callers that
    need them. `with_order` adds the stream-local message position under
    `MESSAGE_ORDINAL`, which is the only thing that orders two messages sharing a
    whole-second timestamp. Conversion outputs use neither, so they are unchanged.
    """
    with source.open("rb") as stream:
        data = stream.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("FIT exceeds the 64 MiB local conversion limit")
    streams: list[dict[str, list[dict[str, object]]]] = []
    message_count = 0
    for stream in fit_streams(data):
        rows: dict[str, list[dict[str, object]]] = {
            name: [] for name in (*MESSAGE_TYPES, *extra_types)
        }
        fit = FitFile(stream, check_crc=True)
        try:
            for message in fit.get_messages(with_definitions=True):
                message_count += 1
                if message_count > MAX_MESSAGES:
                    raise ValueError("FIT exceeds the local message limit")
                if message.type == "data" and message.name in rows:
                    row = {field.name: field.value for field in message}
                    if with_order:
                        row[MESSAGE_ORDINAL] = message_count
                    rows[message.name].append(row)
        except (KeyError, IndexError, RecursionError) as error:
            # fitparse may leak implementation exceptions for invalid developer
            # metadata. Normalize them at the parser boundary without exposing data.
            raise FitParseError("Invalid FIT message structure") from error
        finally:
            fit.close()
        streams.append(rows)
    return streams


def validate_fit_bytes(data: bytes) -> None:
    """Apply the same size, framing, message-count and CRC checks as conversion.

    `fit_streams` only frames the stream; real CRC verification needs the parser, so
    downloads reuse this instead of trusting header/length alone.
    """
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("FIT exceeds the 64 MiB local conversion limit")
    message_count = 0
    streams = 0
    for stream in fit_streams(data):
        streams += 1
        fit = FitFile(stream, check_crc=True)
        try:
            for _ in fit.get_messages(with_definitions=True):
                message_count += 1
                if message_count > MAX_MESSAGES:
                    raise ValueError("FIT exceeds the local message limit")
        except (KeyError, IndexError, RecursionError) as error:
            raise FitParseError("Invalid FIT message structure") from error
        finally:
            fit.close()
    if streams == 0:
        raise ValueError("Empty FIT input")


def parse_fit(source: Path) -> dict[str, pd.DataFrame]:
    """Preserve the historical merged conversion frames across chained streams."""
    rows: dict[str, list[dict[str, object]]] = {name: [] for name in MESSAGE_TYPES}
    for stream in parse_fit_streams(source):
        for name in MESSAGE_TYPES:
            rows[name].extend(stream[name])
    # CSV needs a header even when the FIT contains no messages of this type.
    return {
        name: pd.DataFrame(values) if values else pd.DataFrame(columns=["timestamp"])
        for name, values in rows.items()
    }


def atomic_json(path: Path, value: dict[str, object]) -> None:
    handle, temporary = tempfile.mkstemp(prefix=".manifest-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def output_lock(output: Path, lock_name: str = ".conversion.lock") -> Iterator[None]:
    output.mkdir(parents=True, exist_ok=True)
    lock = output / lock_name
    if lock.is_symlink():
        raise ValueError("Output lock cannot be a symlink")
    with lock.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another conversion owns this output directory") from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def load_manifest(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"version": 1, "entries": {}}
    if path.is_symlink() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Unsafe conversion manifest")
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or not isinstance(value.get("entries"), dict)
    ):
        raise ValueError("Unsupported conversion manifest")
    return value


def output_paths(source: Path, base: Path, output: Path, format: OutputFormat) -> list[Path]:
    relative = source.relative_to(base)
    identity = hashlib.sha256(str(source).encode()).hexdigest()[:16]
    folder = output / relative.parent / f"{source.name}-{identity}"
    if not folder.resolve().is_relative_to(output):
        raise ValueError("Output path escapes output directory")
    return [folder / f"{name}.{format}" for name in MESSAGE_TYPES]


def can_resume(entry: object, digest: str, paths: list[Path], output: Path) -> bool:
    if not isinstance(entry, dict) or entry.get("status") != "success":
        return False
    hashes = entry.get("outputs")
    if entry.get("sha256") != digest or not isinstance(hashes, dict):
        return False
    return all(
        path.is_file()
        and not path.is_symlink()
        and hashes.get(path.relative_to(output).as_posix()) == sha256_file(path)
        for path in paths
    )


def write_frames(frames: dict[str, pd.DataFrame], paths: list[Path], format: OutputFormat) -> None:
    folder = paths[0].parent
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".conversion-", dir=folder) as temporary:
        staged = Path(temporary)
        for name, path in zip(MESSAGE_TYPES, paths, strict=True):
            target = staged / path.name
            if format == "csv":
                frames[name].to_csv(target, index=False)
            else:
                frames[name].to_parquet(target, index=False)
        # The manifest is committed only after all outputs exist. Interrupted writes
        # cannot pass resume's full set of content-hash checks.
        for path in paths:
            os.replace(staged / path.name, path)


def convert_batch(
    source: Path,
    output: Path,
    format: OutputFormat = "parquet",
    *,
    recursive: bool = False,
    overwrite: bool = False,
    resume: bool = False,
) -> int:
    source, output = source.resolve(), output.resolve()
    if not source.exists():
        raise ValueError("Input does not exist")
    if source.is_dir() and output.is_relative_to(source):
        raise ValueError("Output directory must be outside the input directory")
    if format not in ("csv", "parquet"):
        raise ValueError("Unsupported output format")
    base = source if source.is_dir() else source.parent
    candidates = (
        sorted(source.rglob("*") if recursive else source.iterdir())
        if source.is_dir()
        else [source]
    )
    files = [
        path
        for path in candidates
        if path.is_file() and not path.is_symlink() and path.suffix.lower() == ".fit"
    ]
    if not files:
        raise ValueError("Input contains no regular FIT files")
    failures = 0
    with output_lock(output):
        manifest_path = output / "manifest.json"
        manifest = load_manifest(manifest_path)
        entries = manifest["entries"]
        assert isinstance(entries, dict)  # Runtime checked by load_manifest.
        for path in files:
            key = str(path)
            previous = entries.get(key)
            attempt = previous.get("attempts", 0) if isinstance(previous, dict) else 0
            attempt = attempt if isinstance(attempt, int) and attempt >= 0 else 0
            entry: dict[str, object] = {
                "source": path.relative_to(base).as_posix(),
                "format": format,
                "attempts": attempt + 1,
                "provider": None,
                "activity_id": None,
            }
            try:
                source_stat = path.stat()
                entry["source_mtime_ns"] = source_stat.st_mtime_ns
                if source_stat.st_size > MAX_SOURCE_BYTES:
                    raise ValueError("FIT exceeds the 64 MiB local conversion limit")
                digest = sha256_file(path)
                entry["sha256"] = digest
                paths = output_paths(path, base, output, format)
                if resume and can_resume(previous, digest, paths, output):
                    LOGGER.info("Skipped verified output: %s", path.name)
                    continue
                if not overwrite and any(p.exists() or p.is_symlink() for p in paths):
                    raise FileExistsError("Output exists; use --overwrite to replace it")
                frames = parse_fit(path)
                if sha256_file(path) != digest:
                    raise ValueError("Source changed during conversion")
                write_frames(frames, paths, format)
                entry.update(
                    status="success",
                    outputs={p.relative_to(output).as_posix(): sha256_file(p) for p in paths},
                    rows={name: len(frame) for name, frame in frames.items()},
                )
                entries[key] = entry
                LOGGER.info("Converted: %s", path.name)
            except (
                FitParseError,
                ArrowException,
                OSError,
                ValueError,
                TypeError,
                OverflowError,
            ) as error:
                # Per-file isolation: one corrupt FIT must not stop the batch.
                failures += 1
                entry.update(status="failed", error=type(error).__name__)
                # Preserve verified success metadata after an overwrite refusal so
                # a subsequent --resume remains useful.
                if not isinstance(error, FileExistsError) or not isinstance(previous, dict):
                    entries[key] = entry
                LOGGER.error("Conversion failed (%s): %s", type(error).__name__, path.name)
            atomic_json(manifest_path, manifest)
    return 1 if failures else 0
