"""UNOFFICIAL in-app Garmin collector worker (M1-06b-tmp). NOT the official integration.

The app server (TypeScript) runs this module as a short-lived child process and talks to
it over newline-delimited JSON on stdin/stdout. One process serves one login (including
its MFA step) or one collection run, then exits. Everything the provider can do is reached
through ``garmin_fetch``'s existing, hardened pieces: the transport policy on the library's
sessions and token exchange, the library-log scrubbing, the bounded newest-first listing,
the ORIGINAL download with zip/CRC validation, and the redaction boundary. FIT sessions are
turned into the app's import commands by ``activity_export``, the same code the manual
``export-activity`` path uses, so the server imports them through its existing path.

Secrets and files
-----------------
- The password arrives in one ``login`` message on stdin -- never argv or environment --
  is held only by the credential frame (``_login_frame``), and is dropped in ``finally``.
- The library's own token file is never used. ``GARMINTOKENS`` is removed from the
  environment on start, the client's ``dump``/``load`` are replaced by refusals, a login
  never passes a token-store PATH, and the client's ``_tokenstore_path`` is checked to stay
  unset. The session goes back to the server as a string for encrypted storage only.
- Nothing written to stdout carries the password, the email or provider text: failures are
  reported as a fixed ``kind`` and a fixed ``code``. The library's own log records are
  scrubbed (best effort, see ``garmin_fetch.provider_log_scrubbing``) and go to stderr,
  which the server discards.

The pending MFA state lives in the provider object in THIS process's memory; the server
keeps the process alive for a short TTL and kills it afterwards. Nothing about it is
written anywhere.

Protocol (server -> worker, worker -> server)
---------------------------------------------
login:   {"op":"login","email","password"}
         -> {"type":"mfa_required"} then {"op":"mfa","code"} (or {"op":"cancel"})
         -> {"type":"connected","profileId","session"} | {"type":"failed","kind","code"}
collect: {"op":"collect","session","start","end","limit"}
         -> {"type":"opened","profileId"}; server answers {"op":"continue"} or {"op":"abort"}
         -> {"type":"listed","activities":[{"id","startedAtLocal"}],"complete","notes"}
         server answers {"op":"download","ids":[...]}
         -> {"type":"activity","id","sha256","imports":[...]} | {"type":"activity_failed",...}
         -> {"type":"finished","session","complete"} | {"type":"failed","kind",...}

``kind`` is one of ``auth`` (reconnect required; never retried), ``mfa_invalid``,
``rate_limited`` (with ``retryAfterSeconds`` when the provider sent one), ``transient`` and
``permanent``.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import math
import os
import resource
import sys
import tempfile
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import IO, Any

from fitparse import FitParseError

from workout_manager.activity_export import detailed_commands
from workout_manager.garmin_fetch import (
    MAX_ACTIVITIES,
    RateLimiter,
    UnofficialFetchError,
    _retry_after,
    extract_original_fit,
    harden_client,
    harden_token_exchange,
    is_rate_limited,
    provider_library,
    provider_log_scrubbing,
    read_only_session,
    redact,
    reharden_after_login,
    require_usable_password,
    scrub,
    select_activities,
)

PROVIDER = "garmin-connect-unofficial"
MAX_REQUEST_LINE_BYTES = 64 * 1024
MAX_SESSION_BYTES = 16 * 1024
MAX_MFA_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60
TOKEN_ENVIRONMENT = "GARMINTOKENS"

LOGGER = logging.getLogger(__name__)


class ProtocolError(RuntimeError):
    """The server sent something this worker does not accept; the process ends."""


class TokenFileRefused(RuntimeError):
    """Raised if anything tries to use the library's own token file."""


# ------------------------------------------------------------------------- channel


class Channel:
    """Newline-delimited JSON over the process's own pipes, bounded per line."""

    def __init__(self, reader: IO[str], writer: IO[str]) -> None:
        self._reader = reader
        self._writer = writer

    def send(self, message: dict[str, Any]) -> None:
        self._writer.write(json.dumps(message, separators=(",", ":"), allow_nan=False) + "\n")
        self._writer.flush()

    def receive(self) -> dict[str, Any]:
        line = self._reader.readline(MAX_REQUEST_LINE_BYTES + 1)
        if not line:
            raise ProtocolError("closed")
        if len(line) > MAX_REQUEST_LINE_BYTES or not line.endswith("\n"):
            raise ProtocolError("oversized")
        value = json.loads(line)
        if not isinstance(value, dict) or not isinstance(value.get("op"), str):
            raise ProtocolError("shape")
        return value


def _text(message: dict[str, Any], key: str, *, limit: int) -> str:
    value = message.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ProtocolError(key)
    return value


# ------------------------------------------------------------------ token-file guard


def forbid_token_environment() -> None:
    """``Garmin.login()`` falls back to ``GARMINTOKENS``; that path must never be taken."""
    os.environ.pop(TOKEN_ENVIRONMENT, None)


def _refuse_token_file(*_: object, **__: object) -> None:
    raise TokenFileRefused("The library token file is disabled in the in-app collector")


def disable_token_file(api: object) -> None:
    """Replace the client's file persistence with refusals, before any login runs."""
    client = getattr(api, "client", None)
    if client is None:
        raise UnofficialFetchError("The provider object has no client")
    client.dump = _refuse_token_file  # type: ignore[attr-defined]
    client.load = _refuse_token_file  # type: ignore[attr-defined]


def require_no_token_path(api: object) -> None:
    client = getattr(api, "client", None)
    if getattr(client, "_tokenstore_path", None) is not None:
        raise TokenFileRefused("The provider attached a token-store path")


# ------------------------------------------------------------------ classification


@dataclass(frozen=True, slots=True)
class Failure:
    kind: str
    code: str
    retry_after_seconds: int | None = None

    def message(self, **extra: object) -> dict[str, Any]:
        value: dict[str, Any] = {"type": "failed", "kind": self.kind, "code": self.code}
        if self.retry_after_seconds is not None:
            value["retryAfterSeconds"] = self.retry_after_seconds
        value.update(extra)
        return value


def retry_after_seconds(error: BaseException, now: datetime | None = None) -> int | None:
    """Seconds or HTTP-date, bounded to a day. The pinned library usually drops the header."""
    raw = _retry_after(error)
    if raw is None:
        return None
    text = raw.strip()
    if text.isdigit():
        seconds = int(text)
    else:
        try:
            moment = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
        if moment.tzinfo is None:
            return None
        seconds = math.ceil((moment - (now or datetime.now(UTC))).total_seconds())
    return max(0, min(seconds, MAX_RETRY_AFTER_SECONDS))


def _class_names(error: BaseException) -> set[str]:
    return {klass.__name__ for klass in type(error).__mro__}


def classify(error: BaseException) -> Failure:
    """Map a provider exception to a fixed kind without importing the optional library."""
    if is_rate_limited(error):
        return Failure("rate_limited", "RATE_LIMITED", retry_after_seconds(error))
    names = _class_names(error)
    status = getattr(getattr(error, "response", None), "status_code", None)
    if "GarminConnectAuthenticationError" in names or status in (401, 403):
        return Failure("auth", "AUTHENTICATION_REJECTED")
    if isinstance(error, (TokenFileRefused, UnofficialFetchError)):
        # The transport policy or the token-file guard refused: retrying cannot help.
        return Failure("permanent", "POLICY_REFUSED")
    if isinstance(status, int) and 400 <= status < 500:
        return Failure("permanent", "PROVIDER_CLIENT_ERROR")
    if "GarminConnectConnectionError" in names or isinstance(error, (OSError, TimeoutError)):
        return Failure("transient", "PROVIDER_UNAVAILABLE")
    if isinstance(error, (ValueError, TypeError)):
        return Failure("permanent", "PROVIDER_SHAPE")
    return Failure("transient", "PROVIDER_UNAVAILABLE")


# --------------------------------------------------------------------------- login


ProviderFactory = Callable[..., Any]


def library_factory() -> ProviderFactory:
    """The pinned ``garminconnect`` class, with its own retries off: our run is bounded."""
    garmin = provider_library().Garmin  # type: ignore[attr-defined]

    def create(email: str | None = None, password: str | None = None) -> Any:
        return garmin(email=email, password=password, return_on_mfa=True, retry_attempts=0)

    return create


@dataclass(frozen=True, slots=True)
class LoginResult:
    api: Any = None
    needs_mfa: bool = False
    failure: Failure | None = None


def _login_frame(factory: ProviderFactory, message: dict[str, Any]) -> LoginResult:
    """The only frame that holds the email and password; they are dropped in ``finally``.

    A provider failure comes back as a fixed ``Failure``, never as an exception object,
    so no traceback carrying these locals leaves this frame.
    """
    email = password = None
    api = None
    try:
        email = _text(message, "email", limit=320)
        password = _text(message, "password", limit=1024)
        require_usable_password(password)
        with provider_log_scrubbing(password, email):
            api = factory(email=email, password=password)
            disable_token_file(api)
            harden_client(api)
            harden_token_exchange(api)
            # No token store: the session is returned to the server, never written here.
            status, _ = api.login()
            require_no_token_path(api)
        if status == "needs_mfa":
            return LoginResult(api=api, needs_mfa=True)
        return LoginResult(api=api)
    except ProtocolError:
        raise
    except Exception as error:  # noqa: BLE001 - any provider error may carry credentials.
        # Only the class-level classification leaves; the message is never forwarded.
        failure = classify(error)
        LOGGER.warning(
            "Unofficial login failed (%s): %s",
            failure.code,
            redact(scrub(f"{type(error).__name__}: {error}", password or "", email or "")),
        )
        api = None
        return LoginResult(failure=failure)
    finally:
        email = password = None
        del email, password


def _connected(api: Any) -> dict[str, Any]:
    reharden_after_login(api)
    require_no_token_path(api)
    profile_id = getattr(api, "profile_id", None)
    if isinstance(profile_id, bool) or not isinstance(profile_id, int) or profile_id <= 0:
        return Failure("permanent", "PROFILE_UNAVAILABLE").message()
    session = api.client.dumps()
    parsed = json.loads(session)
    # A JWT_WEB-only login (the library's fallback) leaves no DI token to persist.
    if not isinstance(parsed, dict) or not parsed.get("di_token"):
        return Failure("permanent", "SESSION_NOT_PERSISTABLE").message()
    if len(session.encode("utf-8")) > MAX_SESSION_BYTES:
        return Failure("permanent", "SESSION_TOO_LARGE").message()
    return {"type": "connected", "profileId": str(profile_id), "session": session}


def serve_login(channel: Channel, factory: ProviderFactory, message: dict[str, Any]) -> None:
    result = _login_frame(factory, message)
    message.clear()  # The request dict held the password too.
    if result.failure is not None:
        channel.send(result.failure.message())
        return
    api = result.api
    if not result.needs_mfa:
        channel.send(_connected(api))
        return
    channel.send({"type": "mfa_required"})
    for _ in range(MAX_MFA_ATTEMPTS):
        answer = channel.receive()
        if answer.get("op") == "cancel":
            return
        if answer.get("op") != "mfa":
            raise ProtocolError("op")
        code = _text(answer, "code", limit=16)
        if not code.isdigit():
            raise ProtocolError("code")
        try:
            api.resume_login(None, code)
        except Exception as error:  # noqa: BLE001 - classified, never forwarded.
            failure = classify(error)
            if failure.kind == "auth":
                channel.send(Failure("mfa_invalid", "MFA_REJECTED").message())
                continue
            channel.send(failure.message())
            return
        channel.send(_connected(api))
        return
    channel.send(Failure("auth", "MFA_ATTEMPTS_EXHAUSTED").message())


# ------------------------------------------------------------------------- collect


class ClassifyingSource:
    """Keeps the raw classification that ``select_activities`` turns into a message."""

    __slots__ = ("_inner", "last_failure")

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.last_failure: Failure | None = None

    def list_activities(self, start: int, limit: int) -> object:
        try:
            return self._inner.list_activities(start, limit)
        except Exception as error:
            self.last_failure = classify(error)
            raise

    def download_original(self, activity_id: str) -> bytes:
        return self._inner.download_original(activity_id)


def _date(message: dict[str, Any], key: str) -> date:
    return date.fromisoformat(_text(message, key, limit=10))


@contextlib.contextmanager
def _private_directory() -> Iterator[Path]:
    """A 0700 directory for the one FIT file ``detailed_commands`` reads, then removed."""
    directory = Path(tempfile.mkdtemp(prefix="garmin-collect-"))
    try:
        yield directory
    finally:
        for child in directory.iterdir():
            child.unlink(missing_ok=True)
        directory.rmdir()


def import_commands(fit: bytes, directory: Path) -> list[dict[str, object]]:
    """Validated FIT bytes -> the app's schemaVersion 4 import commands (details + bouts)."""
    target = directory / "original.fit"
    handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(fit)
        return detailed_commands(target, None, include_bouts=True)
    finally:
        target.unlink(missing_ok=True)


def serve_collect(
    channel: Channel,
    factory: ProviderFactory,
    message: dict[str, Any],
    *,
    limiter: RateLimiter | None = None,
) -> None:
    session = _text(message, "session", limit=MAX_SESSION_BYTES)
    start, end = _date(message, "start"), _date(message, "end")
    limit = message.get("limit")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_ACTIVITIES:
        raise ProtocolError("limit")
    limiter = limiter or RateLimiter()
    try:
        api = factory()
        disable_token_file(api)
        harden_client(api)
        harden_token_exchange(api)
        # Inline JSON: the library loads it with `loads()` and keeps no token-store path.
        api.login(tokenstore=session)
        require_no_token_path(api)
        reharden_after_login(api)
    except Exception as error:  # noqa: BLE001 - classified, never forwarded.
        channel.send(classify(error).message())
        return
    profile_id = getattr(api, "profile_id", None)
    if isinstance(profile_id, bool) or not isinstance(profile_id, int):
        channel.send(Failure("permanent", "PROFILE_UNAVAILABLE").message())
        return
    channel.send({"type": "opened", "profileId": str(profile_id)})
    if channel.receive().get("op") != "continue":
        return

    def refreshed() -> str:
        # Whatever the library refreshed during the run is handed back for CAS storage.
        require_no_token_path(api)
        return api.client.dumps()

    with read_only_session(api) as inner:
        source = ClassifyingSource(inner)
        try:
            selection = select_activities(source, start, end, limit, limiter=limiter)
        except Exception as error:  # noqa: BLE001 - classified, never forwarded.
            # `select_activities` turns a provider error into a redacted message; the
            # classification was kept by the wrapper before that happened.
            failure = source.last_failure or classify(error)
            channel.send(failure.message(session=refreshed()))
            return
        channel.send(
            {
                "type": "listed",
                "activities": [
                    {"id": item.activity_id, "startedAtLocal": item.started_at_local}
                    for item in selection.activities
                ],
                "complete": selection.complete,
                "notes": list(selection.notes),
            }
        )
        answer = channel.receive()
        if answer.get("op") != "download":
            return
        requested = answer.get("ids")
        listed = {item.activity_id for item in selection.activities}
        if not isinstance(requested, list) or not all(
            isinstance(item, str) and item in listed for item in requested
        ):
            raise ProtocolError("ids")
        with _private_directory() as directory:
            for activity_id in requested:
                try:
                    limiter.wait()
                    fit = extract_original_fit(source.download_original(activity_id))
                    commands = import_commands(fit, directory)
                except (ValueError, TypeError, zipfile.BadZipFile, FitParseError) as error:
                    # Per-activity isolation, as in the CLI fetch: one bad file is recorded.
                    channel.send(
                        {"type": "activity_failed", "id": activity_id, "code": type(error).__name__}
                    )
                    continue
                except Exception as error:  # noqa: BLE001 - classified, never forwarded.
                    if "GarminConnectNotFoundError" in _class_names(error):
                        channel.send(
                            {"type": "activity_failed", "id": activity_id, "code": "NOT_FOUND"}
                        )
                        continue
                    channel.send(classify(error).message(session=refreshed()))
                    return
                channel.send(
                    {
                        "type": "activity",
                        "id": activity_id,
                        "sha256": commands[0]["source"]["contentHash"],  # type: ignore[index]
                        "imports": commands,
                    }
                )
    channel.send({"type": "finished", "session": refreshed(), "complete": selection.complete})


# --------------------------------------------------------------------------- entry


def fixture_factory(path: Path) -> ProviderFactory:
    from workout_manager.garmin_fixture import FixtureGarmin, load_scenario

    def create(email: str | None = None, password: str | None = None) -> Any:
        # Re-read per process so a test can change the scenario between runs.
        return FixtureGarmin(
            load_scenario(path), email=email, password=password, return_on_mfa=True
        )

    return create


def serve(channel: Channel, factory: ProviderFactory, *, limiter: RateLimiter | None = None) -> int:
    forbid_token_environment()
    try:
        message = channel.receive()
        if message["op"] == "login":
            serve_login(channel, factory, message)
        elif message["op"] == "collect":
            session = message.get("session")
            # The stored session is the secret during a run: scrub it from library records.
            with provider_log_scrubbing(session if isinstance(session, str) else ""):
                serve_collect(channel, factory, message, limiter=limiter)
        else:
            raise ProtocolError("op")
    except ProtocolError as error:
        with contextlib.suppress(Exception):
            channel.send(
                {"type": "failed", "kind": "permanent", "code": "PROTOCOL", "detail": str(error)}
            )
        return 2
    return 0


def disable_core_dumps() -> None:
    """A crash must not write the password or session held in memory to a core file."""
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main(argv: list[str] | None = None) -> int:
    # First, before anything secret can be in memory.
    disable_core_dumps()
    parser = argparse.ArgumentParser(prog="workout_manager.garmin_worker", add_help=False)
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--min-interval", type=float, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        factory = fixture_factory(args.fixture) if args.fixture else library_factory()
    except UnofficialFetchError:
        Channel(sys.stdin, sys.stdout).send(Failure("permanent", "LIBRARY_NOT_INSTALLED").message())
        return 2
    limiter = RateLimiter(args.min_interval) if args.min_interval is not None else None
    return serve(Channel(sys.stdin, sys.stdout), factory, limiter=limiter)


if __name__ == "__main__":
    raise SystemExit(main())
