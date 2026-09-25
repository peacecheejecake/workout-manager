"""In-app unofficial collector worker (M1-06b-tmp): synthetic provider only, no network."""

from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from workout_manager import garmin_worker
from workout_manager.garmin_fetch import RateLimiter
from workout_manager.garmin_fixture import FixtureGarmin, synthetic_fit
from workout_manager.garmin_worker import (
    Channel,
    classify,
    disable_token_file,
    fixture_factory,
    retry_after_seconds,
    serve,
)

PASSWORD = "synthetic-pass-1"
EMAIL = "owner@example.test"


def scenario(tmp_path: Path, **overrides: Any) -> Path:
    value: dict[str, Any] = {
        "accounts": [
            {"email": EMAIL, "password": PASSWORD, "profileId": 1001},
            {
                "email": "mfa@example.test",
                "password": "synthetic-pass-2",
                "profileId": 1001,
                "mfaCode": "123456",
            },
        ],
        "activities": {
            "1001": [
                {
                    "id": 9001,
                    "startedAt": "2026-09-20T06:00:00+00:00",
                    "sport": "running",
                    "seconds": 1800,
                    "meters": 5000,
                },
                {
                    "id": 9002,
                    "startedAt": "2026-09-21T06:00:00+00:00",
                    "sport": "cycling",
                    "seconds": 3600,
                    "meters": 20000,
                },
            ]
        },
    }
    value.update(overrides)
    path = tmp_path / "scenario.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def fast_limiter() -> RateLimiter:
    return RateLimiter(1.0, clock=lambda: 0.0, sleep=lambda _: None)


def run(path: Path, *lines: dict[str, Any]) -> list[dict[str, Any]]:
    reader = io.StringIO("".join(json.dumps(line) + "\n" for line in lines))
    writer = io.StringIO()
    serve(Channel(reader, writer), fixture_factory(path), limiter=fast_limiter())
    return [json.loads(line) for line in writer.getvalue().splitlines()]


@pytest.fixture(autouse=True)
def private_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("GARMINTOKENS", raising=False)
    return home


def files_under(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()]


def login(path: Path, email: str = EMAIL, password: str = PASSWORD) -> list[dict[str, Any]]:
    return run(path, {"op": "login", "email": email, "password": password})


def test_login_returns_the_session_and_pinned_profile_and_writes_no_file(tmp_path, private_home):
    messages = login(scenario(tmp_path))
    assert [message["type"] for message in messages] == ["connected"]
    assert messages[0]["profileId"] == "1001"
    assert json.loads(messages[0]["session"])["di_token"].startswith("fixture-di.1001.")
    assert files_under(private_home) == []


def test_a_token_store_in_the_environment_is_never_used(tmp_path, monkeypatch):
    store = tmp_path / "leaked-store"
    monkeypatch.setenv("GARMINTOKENS", str(store))
    messages = login(scenario(tmp_path))
    assert messages[0]["type"] == "connected"
    # Without the guard the (library-faithful) fixture writes garmin_tokens.json here.
    assert not store.exists()
    assert "GARMINTOKENS" not in os.environ


def test_the_library_token_file_calls_are_refused(tmp_path):
    api = FixtureGarmin(json.loads(scenario(tmp_path).read_text()), email=EMAIL, password=PASSWORD)
    disable_token_file(api)
    with pytest.raises(garmin_worker.TokenFileRefused):
        api.client.dump(str(tmp_path / "store"))
    with pytest.raises(garmin_worker.TokenFileRefused):
        api.client.load(str(tmp_path / "store"))
    assert not (tmp_path / "store").exists()


def test_the_password_and_email_never_reach_output_or_logs(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    path = scenario(tmp_path)
    outputs = [
        *login(path),
        *login(path, password="wrong-password-9"),
        *login(path, email="nobody@example.test", password="another-secret-7"),
    ]
    rendered = json.dumps(outputs) + caplog.text
    for secret in (PASSWORD, "wrong-password-9", "another-secret-7", EMAIL, "nobody@example.test"):
        assert secret not in rendered
    assert [message.get("kind") for message in outputs[1:]] == ["auth", "auth"]


def test_mfa_is_resumed_in_the_same_process_and_attempts_are_bounded(tmp_path):
    path = scenario(tmp_path)
    ok = run(
        path,
        {"op": "login", "email": "mfa@example.test", "password": "synthetic-pass-2"},
        {"op": "mfa", "code": "000000"},
        {"op": "mfa", "code": "123456"},
    )
    assert [message["type"] for message in ok] == ["mfa_required", "failed", "connected"]
    assert ok[1]["kind"] == "mfa_invalid"
    exhausted = run(
        path,
        {"op": "login", "email": "mfa@example.test", "password": "synthetic-pass-2"},
        *[{"op": "mfa", "code": "000000"}] * 3,
    )
    assert exhausted[-1] == {"type": "failed", "kind": "auth", "code": "MFA_ATTEMPTS_EXHAUSTED"}


@pytest.mark.parametrize(
    ("failure", "kind"), [("rate_limited", "rate_limited"), ("transient", "transient")]
)
def test_login_failures_are_classified(tmp_path, failure, kind):
    assert login(scenario(tmp_path, loginFailure=failure))[0]["kind"] == kind


def session_for(path: Path) -> str:
    return login(path)[0]["session"]


def collect(path: Path, session: str, *replies: dict[str, Any], limit: int = 10):
    return run(
        path,
        {
            "op": "collect",
            "session": session,
            "start": "2026-09-01",
            "end": "2026-09-30",
            "limit": limit,
        },
        *replies,
    )


def test_collect_lists_then_downloads_only_what_the_server_asks_for(tmp_path, private_home):
    path = scenario(tmp_path)
    session = session_for(path)
    messages = collect(path, session, {"op": "continue"}, {"op": "download", "ids": ["9001"]})
    assert [message["type"] for message in messages] == ["opened", "listed", "activity", "finished"]
    assert messages[0]["profileId"] == "1001"
    assert [item["id"] for item in messages[1]["activities"]] == ["9002", "9001"]
    activity = messages[2]
    assert activity["id"] == "9001"
    command = activity["imports"][0]
    assert command["source"]["kind"] == "fit"
    assert command["source"]["sourceId"] == f"sha256:{activity['sha256']}:session:0"
    assert command["activity"]["kind"] == "running"
    assert command["activity"]["distanceMeters"] == 5000
    assert command["details"]["schemaVersion"] == 3
    # The library rotated the session; the new one is handed back for CAS storage.
    assert messages[3]["session"] != session
    assert messages[3]["complete"] is True
    assert files_under(private_home) == []


def test_collect_stops_on_abort_before_listing(tmp_path):
    path = scenario(tmp_path)
    messages = collect(path, session_for(path), {"op": "abort"})
    assert [message["type"] for message in messages] == ["opened"]


def test_a_rate_limited_listing_reports_retry_after_and_the_session(tmp_path):
    path = scenario(tmp_path)
    session = session_for(path)
    path = scenario(tmp_path, listFailure="rate_limited", retryAfter="120")
    messages = collect(path, session, {"op": "continue"})
    assert messages[-1]["kind"] == "rate_limited"
    assert messages[-1]["retryAfterSeconds"] == 120
    assert "session" in messages[-1]


def test_a_rejected_session_is_an_auth_failure(tmp_path):
    path = scenario(tmp_path)
    session = session_for(path)
    path = scenario(tmp_path, revokedProfiles=[1001])
    assert collect(path, session) == [
        {"type": "failed", "kind": "auth", "code": "AUTHENTICATION_REJECTED"}
    ]
    assert collect(path, '{"di_token": "not-a-fixture-token"}')[0]["kind"] == "auth"


def test_a_listing_auth_failure_is_not_transient(tmp_path):
    path = scenario(tmp_path)
    session = session_for(path)
    path = scenario(tmp_path, listFailure="auth")
    assert collect(path, session, {"op": "continue"})[-1]["kind"] == "auth"


def test_one_bad_download_is_isolated_and_429_stops_the_run(tmp_path):
    path = scenario(tmp_path)
    session = session_for(path)
    path = scenario(tmp_path, downloadFailures={"9002": "corrupt"})
    messages = collect(
        path, session, {"op": "continue"}, {"op": "download", "ids": ["9002", "9001"]}
    )
    assert [message["type"] for message in messages] == [
        "opened",
        "listed",
        "activity_failed",
        "activity",
        "finished",
    ]
    path = scenario(tmp_path, downloadFailures={"9002": "rate_limited"})
    messages = collect(
        path, session, {"op": "continue"}, {"op": "download", "ids": ["9002", "9001"]}
    )
    assert [message["type"] for message in messages] == ["opened", "listed", "failed"]
    assert messages[-1]["kind"] == "rate_limited"


def test_the_server_cannot_request_an_unlisted_activity(tmp_path):
    path = scenario(tmp_path)
    messages = collect(
        path, session_for(path), {"op": "continue"}, {"op": "download", "ids": ["1"]}
    )
    assert messages[-1]["code"] == "PROTOCOL"


def test_the_listing_bounds_are_the_fetch_bounds(tmp_path):
    path = scenario(tmp_path)
    messages = collect(path, session_for(path), limit=500)
    assert messages[-1]["code"] == "PROTOCOL"


def test_retry_after_accepts_seconds_and_http_dates():
    class Error(Exception):
        def __init__(self, value: str) -> None:
            super().__init__("429")
            self.response = type("R", (), {"status_code": 429, "headers": {"Retry-After": value}})

    now = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)
    assert retry_after_seconds(Error("90"), now) == 90
    assert retry_after_seconds(Error("Fri, 25 Sep 2026 12:05:00 GMT"), now) == 300
    assert retry_after_seconds(Error("999999999"), now) == 24 * 60 * 60
    assert retry_after_seconds(Error("soon"), now) is None
    assert classify(Error("90")).kind == "rate_limited"


def test_the_fixture_fit_passes_the_crc_check():
    from workout_manager.fit_batch import validate_fit_bytes

    validate_fit_bytes(synthetic_fit(datetime(2026, 9, 20, 6, tzinfo=UTC), "running", 60, 100))


def test_the_worker_process_takes_the_password_from_stdin_only(tmp_path, private_home):
    """End to end through a real child process: argv and environment carry no secret."""
    path = scenario(tmp_path)
    request = json.dumps({"op": "login", "email": EMAIL, "password": PASSWORD}) + "\n"
    environment = {"PATH": os.environ.get("PATH", ""), "HOME": str(private_home)}
    completed = subprocess.run(
        [sys.executable, "-I", "-m", "workout_manager.garmin_worker", "--fixture", str(path)],
        input=request,
        capture_output=True,
        text=True,
        env=environment,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0
    assert json.loads(completed.stdout.splitlines()[0])["type"] == "connected"
    assert PASSWORD not in completed.stderr
    assert files_under(private_home) == []


def test_main_disables_core_dumps_before_reading_any_input(tmp_path, monkeypatch):
    import resource

    events: list[object] = []
    monkeypatch.setattr(
        garmin_worker.resource, "setrlimit", lambda kind, value: events.append((kind, value))
    )
    monkeypatch.setattr(garmin_worker.sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(garmin_worker.sys, "stdout", io.StringIO())
    original_serve = garmin_worker.serve

    def serve(*args, **kwargs):
        events.append("serve")
        return original_serve(*args, **kwargs)

    monkeypatch.setattr(garmin_worker, "serve", serve)
    garmin_worker.main(["--fixture", str(scenario(tmp_path))])
    assert events[0] == (resource.RLIMIT_CORE, (0, 0))
    assert events.index("serve") > 0


def test_the_worker_process_really_runs_without_core_dumps(tmp_path, private_home):
    """The limit as the real child process has it, read back through /proc-free getrlimit."""
    probe = (
        "import resource\n"
        "from workout_manager import garmin_worker\n"
        "garmin_worker.disable_core_dumps()\n"
        "print(resource.getrlimit(resource.RLIMIT_CORE))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-I", "-c", probe],
        capture_output=True,
        text=True,
        env={"PATH": os.environ.get("PATH", ""), "HOME": str(private_home)},
        timeout=60,
        check=True,
    )
    assert completed.stdout.strip() == "(0, 0)"
