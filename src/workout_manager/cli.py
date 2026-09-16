"""Explicit, offline-only command line entry points."""

import argparse
import logging
from pathlib import Path

from workout_manager.activity_export import export_activity
from workout_manager.fit_batch import convert_batch


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
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "export-activity":
            export_activity(args.source, args.output, args.timezone)
            return 0
        return convert_batch(
            args.source,
            args.output_dir,
            args.format,
            recursive=args.recursive,
            overwrite=args.overwrite,
            resume=args.resume,
        )
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"Conversion unavailable ({type(error).__name__}): {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
