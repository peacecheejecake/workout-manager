"""Explicit command line entry points.

`convert` and `export-activity` are offline only. `fetch` is an explicitly opt-in,
UNOFFICIAL personal download path and is not the official Garmin integration.
"""

import argparse
import logging
import os
from datetime import date
from pathlib import Path

from workout_manager.activity_export import export_activity
from workout_manager.fit_batch import convert_batch
from workout_manager.garmin_fetch import (
    COVERAGE_NOTE,
    DEFAULT_INTERVAL_SECONDS,
    MAX_ACTIVITIES,
    MAX_RANGE_DAYS,
    UNOFFICIAL_NOTICE,
    RateLimiter,
    UnofficialFetchError,
    default_token_store,
    fetch_activities,
    login_read_only_session,
    redact,
    validate_range,
)

LOGGER = logging.getLogger(__name__)

FETCH_HELP = (
    "UNOFFICIAL, opt-in download of your OWN Garmin activities as original FIT "
    "(NOT the official Garmin integration)"
)


def iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Expected a YYYY-MM-DD date") from error


def add_fetch_parser(commands: argparse._SubParsersAction) -> None:
    fetch = commands.add_parser(
        "fetch",
        help=FETCH_HELP,
        description=f"{FETCH_HELP}.\n\n{UNOFFICIAL_NOTICE}\n\n{COVERAGE_NOTE}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        # No flag abbreviations: `--token` must not silently become `--token-store`.
        allow_abbrev=False,
    )
    fetch.add_argument("--output-dir", type=Path, required=True)
    fetch.add_argument(
        "--start", type=iso_date, required=True, help="Inclusive local start date (YYYY-MM-DD)"
    )
    fetch.add_argument(
        "--end", type=iso_date, required=True, help="Inclusive local end date (YYYY-MM-DD)"
    )
    fetch.add_argument(
        "--limit",
        type=int,
        required=True,
        help=f"Maximum activities to download (1-{MAX_ACTIVITIES})",
    )
    fetch.add_argument(
        "--min-interval",
        type=float,
        default=DEFAULT_INTERVAL_SECONDS,
        help="Minimum seconds between provider requests (minimum 1.0)",
    )
    fetch.add_argument(
        "--token-store",
        type=Path,
        default=None,
        help="Directory for the 0600 token cache (default: ~/.config/workout-manager/garmin-tokens)",
    )
    fetch.add_argument("--overwrite", action="store_true")
    fetch.add_argument(
        "--no-resume",
        action="store_true",
        help="Re-download even when the manifest already records a verified file",
    )
    fetch.add_argument(
        "--execute",
        action="store_true",
        help="Required opt-in. Without it nothing is requested from the network.",
    )


def run_fetch(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if not args.execute:
        parser.exit(
            2,
            f"{UNOFFICIAL_NOTICE}\nOpt-in only: re-run with --execute to contact Garmin.\n",
        )
    if os.environ.get("CI"):
        parser.exit(2, "The unofficial Garmin fetch is disabled in CI.\n")
    # Requirement: the first log line of the command states what this is.
    LOGGER.warning("%s", UNOFFICIAL_NOTICE)
    LOGGER.info(
        "Bounded run: %s..%s, at most %d activities, at least %.1fs between requests "
        "(range maximum %d days).",
        args.start.isoformat(),
        args.end.isoformat(),
        args.limit,
        args.min_interval,
        MAX_RANGE_DAYS,
    )
    # Reject the bounds before any credential is read or sent.
    validate_range(args.start, args.end, args.limit)
    limiter = RateLimiter(args.min_interval)
    token_store = args.token_store or default_token_store()
    with login_read_only_session(token_store) as source:
        return fetch_activities(
            source,
            args.output_dir,
            start=args.start,
            end=args.end,
            limit=args.limit,
            resume=not args.no_resume,
            overwrite=args.overwrite,
            limiter=limiter,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local FIT batch utilities")
    commands = parser.add_subparsers(dest="command", required=True)
    convert = commands.add_parser("convert", help="Convert local FIT files")
    convert.add_argument("source", type=Path)
    convert.add_argument("--output-dir", type=Path, required=True)
    convert.add_argument("--format", choices=("csv", "parquet"), default="parquet")
    convert.add_argument("--recursive", action="store_true")
    convert.add_argument("--overwrite", action="store_true")
    convert.add_argument("--resume", action="store_true")
    export = commands.add_parser(
        "export-activity", help="Export FIT sessions for explicit app import"
    )
    export.add_argument("source", type=Path)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--timezone", default=None)
    export.add_argument("--include-details", action="store_true")
    export.add_argument(
        "--include-bouts",
        action="store_true",
        help="Export explicit FIT lap boundaries as non-overlapping parent bouts (v4)",
    )
    export.add_argument(
        "--include-track",
        action="store_true",
        help="Also export bounded GPS samples and segments for each session (v5)",
    )
    add_fetch_parser(commands)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "fetch":
            message: str | None = None
            try:
                return run_fetch(args, parser)
            except UnofficialFetchError as error:
                message = str(error)
            except Exception as error:  # noqa: BLE001 - nothing provider-side escapes raw.
                message = f"Unofficial fetch failed ({type(error).__name__}): {redact(error)}"
            # Raised outside the except block: no provider exception stays as __context__.
            raise UnofficialFetchError(message)
        if args.command == "export-activity":
            export_activity(
                args.source,
                args.output,
                args.timezone,
                include_details=args.include_details,
                include_bouts=args.include_bouts,
                include_track=args.include_track,
            )
            return 0
        return convert_batch(
            args.source,
            args.output_dir,
            args.format,
            recursive=args.recursive,
            overwrite=args.overwrite,
            resume=args.resume,
        )
    except UnofficialFetchError as error:
        parser.exit(2, f"Unofficial fetch stopped: {error}\n")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"Command unavailable ({type(error).__name__}): {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
