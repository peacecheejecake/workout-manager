"""SYNTHETIC stand-in for the ``garminconnect`` provider. Test double only.

The in-app unofficial collector (M1-06b-tmp) is exercised end to end -- app, API, database,
the TypeScript bridge and this Python worker -- without a live Garmin account. This module
imitates exactly the provider surface ``garmin_worker`` uses, driven by a scenario file:

- ``Garmin(email=, password=, return_on_mfa=, retry_attempts=)`` with ``login(tokenstore)``,
  ``resume_login(state, code)``, ``profile_id``, ``get_activities`` and
  ``download_activity(id, ActivityDownloadFormat.ORIGINAL)``;
- ``client`` with the two long-lived sessions and the DI token-exchange method the
  transport policy attaches to, and ``dumps``/``loads``/``dump``/``load``.

Like the pinned library, a ``tokenstore`` that is a PATH (or ``GARMINTOKENS``) makes the
fixture write a token file there. The worker must never let that happen; tests use this
behaviour to show that a regression would put a token file on disk.

Nothing here talks to the network. Every FIT file is generated from the scenario and holds
no personal data. It is selected only by an explicit ``--fixture`` argument that the app
server passes when a test harness composes it; the deployed configuration has no setting
for it.
"""

from __future__ import annotations

import io
import json
import os
import secrets
import struct
import time
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum, auto
from pathlib import Path
from typing import Any

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)
SPORTS = {"running": 1, "cycling": 2, "walking": 11}
TOKEN_PREFIX = "fixture-di"


class GarminConnectAuthenticationError(Exception):
    """Same class name as the library's, which the worker classifies by name."""


class GarminConnectConnectionError(Exception):
    response: Any = None


class GarminConnectNotFoundError(GarminConnectConnectionError):
    """A missing activity (404), as the library reports it."""


class GarminConnectTooManyRequestsError(Exception):
    def __init__(self, message: str, retry_after: str | None = None) -> None:
        super().__init__(message)
        self.response = _Response(429, {"Retry-After": retry_after} if retry_after else {})


@dataclass(frozen=True, slots=True)
class _Response:
    status_code: int
    headers: dict[str, str]


class _Session:
    """Carries only the callable the transport policy wraps; nothing ever sends through it."""

    def request(self, method: str, url: str, **kwargs: object) -> object:
        raise GarminConnectConnectionError("The synthetic provider has no network")


def _crc(data: bytes) -> int:
    result = 0
    for value in data:
        result ^= value
        for _ in range(8):
            result = (result >> 1) ^ (0xA001 if result & 1 else 0)
    return result


def _fit_time(moment: datetime) -> int:
    return int((moment - FIT_EPOCH).total_seconds())


def synthetic_fit(started: datetime, sport: str, seconds: int, meters: int) -> bytes:
    """A small valid FIT activity: one session, one lap and two records.

    Session and lap carry start, elapsed, timer, distance and sport; the records carry a
    heart rate and a distance. No position fields exist in it at all.
    """
    start = _fit_time(started)
    end = start + seconds
    sport_value = SPORTS.get(sport, 0)
    summary_fields = [(253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86), (8, 4, 0x86), (9, 4, 0x86)]
    definitions = {
        0: (18, [*summary_fields, (5, 1, 0x00)]),
        1: (19, [*summary_fields, (25, 1, 0x00)]),
        2: (20, [(253, 4, 0x86), (3, 1, 0x02), (5, 4, 0x86)]),
    }
    data = b""
    for local, (global_number, specs) in definitions.items():
        data += struct.pack("<BBBH", 0x40 | local, 0, 0, global_number)
        data += bytes([len(specs)]) + bytes(value for spec in specs for value in spec)
    summary = struct.pack("<IIIII", end, start, seconds * 1000, seconds * 1000, meters * 100)
    data += b"\x02" + struct.pack("<IBI", start, 120, 0)
    data += b"\x02" + struct.pack("<IBI", end, 140, meters * 100)
    data += b"\x01" + summary + bytes([sport_value])
    data += b"\x00" + summary + bytes([sport_value])
    header = struct.pack("<BBHI4s", 14, 0x10, 2132, len(data), b".FIT")
    header += struct.pack("<H", _crc(header))
    content = header + data
    return content + struct.pack("<H", _crc(content))


def load_scenario(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError("Fixture scenario must be an object")
    return value


class FixtureClient:
    def __init__(self, owner: FixtureGarmin) -> None:
        self._owner = owner
        self.cs = _Session()
        self._api_session = _Session()
        self._tokenstore_path: str | None = None
        self.di_token: str | None = None
        self.di_refresh_token: str | None = None
        self.di_client_id: str | None = None

    def _http_post(self, url: str, **kwargs: object) -> object:
        raise GarminConnectConnectionError("The synthetic provider has no network")

    def dumps(self) -> str:
        return json.dumps(
            {
                "di_token": self.di_token,
                "di_refresh_token": self.di_refresh_token,
                "di_client_id": self.di_client_id,
            }
        )

    def loads(self, tokenstore: str) -> None:
        data = json.loads(tokenstore)
        self.di_token = data.get("di_token")
        self.di_refresh_token = data.get("di_refresh_token")
        self.di_client_id = data.get("di_client_id")
        if not self.di_token:
            raise GarminConnectConnectionError("Token extraction loads() structurally failed")

    def dump(self, path: str) -> None:
        # Mirrors the library: a directory token store gets one token file.
        target = Path(path).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        (target / "garmin_tokens.json").write_text(self.dumps(), encoding="utf-8")

    def load(self, path: str) -> None:
        self._tokenstore_path = path
        self.loads((Path(path).expanduser() / "garmin_tokens.json").read_text(encoding="utf-8"))

    def issue(self, profile_id: int) -> None:
        self.di_token = f"{TOKEN_PREFIX}.{profile_id}.{secrets.token_hex(8)}"
        self.di_refresh_token = f"fixture-refresh.{secrets.token_hex(8)}"
        self.di_client_id = "fixture"


class FixtureGarmin:
    """The provider surface ``garmin_worker`` needs, and nothing else."""

    class ActivityDownloadFormat(Enum):
        ORIGINAL = auto()

    def __init__(
        self,
        scenario: dict[str, Any],
        email: str | None = None,
        password: str | None = None,
        return_on_mfa: bool = False,
        retry_attempts: int = 0,
    ) -> None:
        self._scenario = scenario
        self.username = email
        self.password = password
        self.return_on_mfa = return_on_mfa
        self.retry_attempts = retry_attempts
        self.profile_id: int | None = None
        self.client = FixtureClient(self)
        self._pending: dict[str, Any] | None = None

    # ------------------------------------------------------------------ login
    def _account(self) -> dict[str, Any]:
        for account in self._scenario.get("accounts", []):
            if account.get("email") == self.username and account.get("password") == self.password:
                return account
        raise GarminConnectAuthenticationError("Authentication failed (401 Unauthorized).")

    def login(self, tokenstore: str | None = None) -> tuple[str | None, str | None]:
        # Holds the login open, so a test can stop the server while Garmin "answers".
        time.sleep(float(self._scenario.get("loginDelaySeconds", 0)))
        failure = self._scenario.get("loginFailure")
        if failure == "rate_limited":
            raise GarminConnectTooManyRequestsError("Too many login attempts.")
        if failure == "transient":
            raise GarminConnectConnectionError("Login failed: synthetic outage")
        tokenstore = tokenstore or os.getenv("GARMINTOKENS")
        path: str | None = None
        if tokenstore:
            if tokenstore.strip().startswith(("{", "[")):
                self.client.loads(tokenstore)
                self._resume_from_token()
                return None, None
            path = tokenstore
        account = self._account()
        if account.get("mfaCode") and self.return_on_mfa:
            self._pending = account
            return "needs_mfa", None
        self._finish(account)
        if path is not None:
            self.client._tokenstore_path = path
            self.client.dump(path)
        return None, None

    def resume_login(self, state: object, code: str) -> tuple[None, None]:
        if self._pending is None:
            raise GarminConnectAuthenticationError("No MFA login in progress")
        if code != self._pending.get("mfaCode"):
            raise GarminConnectAuthenticationError("MFA code rejected")
        account, self._pending = self._pending, None
        self._finish(account)
        return None, None

    def _finish(self, account: dict[str, Any]) -> None:
        profile_id = int(account["profileId"])
        self.client.issue(profile_id)
        self.profile_id = profile_id
        self.password = None

    def _resume_from_token(self) -> None:
        token = self.client.di_token or ""
        parts = token.split(".")
        revoked = set(self._scenario.get("revokedProfiles", []))
        if len(parts) != 3 or parts[0] != TOKEN_PREFIX or not parts[1].isdigit():
            raise GarminConnectAuthenticationError("Authentication failed (401 Unauthorized).")
        profile_id = int(parts[1])
        if profile_id in revoked:
            raise GarminConnectAuthenticationError("Authentication failed (401 Unauthorized).")
        self.profile_id = profile_id
        # The pinned library refreshes a DI token that is about to expire; the fixture
        # always rotates, so every run has a new session to write back.
        self.client.issue(profile_id)

    # ------------------------------------------------------------------- reads
    def _activities(self) -> list[dict[str, Any]]:
        values = self._scenario.get("activities", {}).get(str(self.profile_id), [])
        return sorted(values, key=lambda item: str(item["startedAt"]), reverse=True)

    def get_activities(self, start: int = 0, limit: int = 20) -> list[dict[str, Any]]:
        failure = self._scenario.get("listFailure")
        if failure == "rate_limited":
            raise GarminConnectTooManyRequestsError(
                "Rate limit exceeded: API Error 429", self._scenario.get("retryAfter")
            )
        if failure == "auth":
            raise GarminConnectAuthenticationError("Authentication failed: API Error 401")
        if failure == "transient":
            raise GarminConnectConnectionError("API call HTTP error: API Error 503")
        page = self._activities()[start : start + limit]
        return [
            {
                "activityId": int(item["id"]),
                "startTimeLocal": datetime.fromisoformat(str(item["startedAt"])).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
            }
            for item in page
        ]

    def download_activity(self, activity_id: str, dl_fmt: object) -> bytes:
        if dl_fmt is not FixtureGarmin.ActivityDownloadFormat.ORIGINAL:
            raise ValueError("Only ORIGINAL is synthesized")
        failure = self._scenario.get("downloadFailures", {}).get(str(activity_id))
        if failure == "rate_limited":
            raise GarminConnectTooManyRequestsError(
                "Rate limit exceeded: API Error 429", self._scenario.get("retryAfter")
            )
        if failure == "corrupt":
            return b"PK\x03\x04not-a-zip"
        for item in self._activities():
            if str(item["id"]) == str(activity_id):
                fit = synthetic_fit(
                    datetime.fromisoformat(str(item["startedAt"])),
                    str(item.get("sport", "running")),
                    int(item.get("seconds", 1800)),
                    int(item.get("meters", 5000)),
                )
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as archive:
                    archive.writestr(f"{activity_id}_ACTIVITY.fit", fit)
                return buffer.getvalue()
        raise GarminConnectNotFoundError("Download client error (404)")
