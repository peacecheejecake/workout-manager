"""Compatibility entry point: uv run python scripts/fitparse.py FILE.fit.

Outputs now live in FILE's sibling ``fit-converted`` directory; the default
format is real Parquet. Pass the same options as ``workout-manager convert``.
"""

import sys
from pathlib import Path


def main() -> int:
    # This historical filename otherwise shadows the third-party fitparse package.
    script_directory = Path(__file__).resolve().parent
    sys.path[:] = [entry for entry in sys.path if Path(entry).resolve() != script_directory]
    from workout_manager.cli import main as run_cli

    arguments = sys.argv[1:]
    if arguments and not any(arg.split("=", 1)[0] == "--output-dir" for arg in arguments):
        arguments += ["--output-dir", str(Path(arguments[0]).parent / "fit-converted")]
    return run_cli(["convert", *arguments])


if __name__ == "__main__":
    raise SystemExit(main())
