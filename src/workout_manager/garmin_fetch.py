"""UNOFFICIAL personal Garmin Connect download path. NOT the official Garmin integration.

This module drives the third-party ``garminconnect`` library against Garmin Connect's
undocumented mobile/web endpoints so a user can retrieve ORIGINAL FIT files from their
own account. It is not an entitled partner integration, it implements no partner
specification, and nothing here may be presented as the official Garmin integration
(EXT-G / M0-07b / M1-06b). The official path stays unimplemented.

Risks the operator accepts by running this:

- Using undocumented endpoints may violate Garmin's Terms of Service.
- Garmin may rate limit, lock, or otherwise act against the account.
- The endpoints, login flow, and payloads break whenever Garmin changes them.
- The library logs in with Garmin's own app client identifiers hardcoded in its source
  (``GCM_ANDROID_DARK``, ``GCM_IOS_DARK``, ``GarminConnect``) and uses ``curl_cffi``
  with ``impersonate="chrome"`` to present a browser-like TLS fingerprint and get past
  bot protection.

Fetching, validation, and writing are separated so each is testable with a fake source
and without credentials or a live provider.

Provider access goes through a wrapper exposing two read calls. The wrapper stores an
opaque handle rather than the provider, so ordinary attribute access and the usual
callable back-references (``__self__``, ``__closure__``, ``__wrapped__``, ``__dict__``)
do not lead to the provider or to its mutating methods (upload/delete/edit/schedule and
the health-log writes).

**This is a mistake-prevention measure, not a security boundary.** The provider lives in
a module-level registry, so any code in this process can reach it deliberately -- through
``_read_activities.__globals__``, through an exception traceback, or by importing this
module. ``release()`` unregisters the handle; it does not erase references already held
elsewhere. Do not describe this as isolation, sandboxing, or a guarantee.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import os
import re
import secrets
import tempfile
import threading
import time
import traceback as traceback_module
import weakref
import zipfile
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Protocol
from urllib.parse import urljoin, urlsplit

from fitparse import FitParseError

from workout_manager.fit_batch import (
    MAX_SOURCE_BYTES,
    atomic_json,
    load_manifest,
    output_lock,
    sha256_file,
    validate_fit_bytes,
)

LOGGER = logging.getLogger(__name__)

PROVIDER = "garmin-connect-unofficial"
MANIFEST_NAME = "download-manifest.json"
LOCK_NAME = ".download.lock"

# `client.cs` legitimately reaches the SSO and mobile-integration hosts on the JWT_WEB
# fallback and legacy refresh paths (client.py:1285, :1469, :1488). Refusing them
# outright would make those calls fail silently, because the library swallows the error.
ALLOWED_HOSTS = frozenset(
    {
        "connectapi.garmin.com",
        "connect.garmin.com",
        "sso.garmin.com",
        "mobile.integration.garmin.com",
    }
)
# 0.3.16 exchanges and refreshes DI tokens against this host through a module-level
# ``requests.post`` / ``curl_cffi.requests.post``, not through a patchable session.
AUTH_POST_HOSTS = frozenset({"diauth.garmin.com"})
MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024
TOKEN_EXCHANGE_METHOD = "_http_post"
REQUIRED_SESSIONS = ("cs", "_api_session")
HARDENED_ATTR = "_workout_manager_request"
TOKEN_EXCHANGE_ATTR = "_workout_manager_http_post"
MIN_PASSWORD_LENGTH = 8
MAX_REDIRECT_HOPS = 3
DOWNLOAD_CHUNK_BYTES = 64 * 1024
REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RANGE_DAYS = 366
MAX_ACTIVITIES = 200
LIST_PAGE_SIZE = 20
MAX_LIST_PAGES = 25
MIN_ALLOWED_INTERVAL_SECONDS = 1.0
DEFAULT_INTERVAL_SECONDS = 2.0
MAX_DOWNLOAD_BYTES = MAX_SOURCE_BYTES
READ_METHODS = ("get_activities", "download_activity")
# garminconnect 0.3.16 writes exactly this file inside a directory token store.
TOKEN_FILE_NAME = "garmin_tokens.json"
# Read-only enum on the library class; reading it avoids importing the optional extra.
DOWNLOAD_FORMAT_ATTRIBUTE = "ActivityDownloadFormat"

PROVIDER_PACKAGE = "garminconnect"
PROVIDER_EXTRA = "garmin"
INSTALL_COMMAND = f"uv sync --extra {PROVIDER_EXTRA}"

UNOFFICIAL_NOTICE = (
    "UNOFFICIAL personal download path -- this is NOT the official Garmin integration. "
    "It uses undocumented Garmin Connect endpoints through the third-party "
    "garminconnect library, for your own account only. Risks: this may violate "
    "Garmin's Terms of Service; Garmin may rate limit or act against the account; it "
    "breaks whenever Garmin changes its endpoints; the library logs in with Garmin's "
    "own app client identifiers hardcoded in its source (GCM_ANDROID_DARK, "
    "GCM_IOS_DARK, GarminConnect) and forges a browser TLS fingerprint through "
    'curl_cffi (impersonate="chrome") to get past bot protection. '
    "Read-only: after login this command calls only activity listing and file "
    "download, through a wrapper that exposes nothing else. That wrapper is a "
    "mistake-prevention measure, not a security boundary."
)


COVERAGE_NOTE = (
    "Transport policy coverage (garminconnect 0.3.16): the timeout, host allowlist, "
    "no-cross-host-redirect rule and size bound apply to the two long-lived API "
    "sessions (client.cs, client._api_session) and to the DI token exchange/refresh "
    "(client._http_post). They do NOT apply to the login strategies, which build their "
    "own curl_cffi/requests sessions internally; those are the library's own code path "
    "and are outside this adapter's control."
)


class UnofficialFetchError(RuntimeError):
    """Fetch refused or aborted; the message is already redacted."""


# --------------------------------------------------------------------------- redaction


# A credential keyword takes the next two whitespace-separated tokens with it, so
# "Authorization: Bearer <jwt>" cannot leave the value behind. Over-redacting a
# neighbouring word is the intended trade.
_SECRET_PATTERN = re.compile(
    r"(?i)\b(?:password|passwd|token|tokens|authorization|auth|cookie|jwt|bearer|oauth|"
    r"secret|refresh_token|access_token|di_token|csrf)\b(?:\s*[:=]?\s*\S+){0,2}"
)
_EMAIL_PATTERN = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_LONG_OPAQUE_PATTERN = re.compile(r"\b[A-Za-z0-9._\-]{40,}\b")
MAX_REDACTED_LENGTH = 240


def scrub(text: str, *secrets: str) -> str:
    """Remove literal secret values that `redact`'s patterns would not recognize.

    A provider message may echo the password or email with no keyword next to it, and
    no pattern can catch that. The login path knows the actual values, so it removes
    them explicitly.

    Run this on the RAW text, before `redact`: `redact` collapses whitespace, so a
    secret containing a newline would no longer match its original spelling afterwards.

    Limits, stated rather than implied: this is exact-value substitution. A secret that
    the provider transformed -- URL-encoded, truncated, split across fields, hashed, or
    case-folded -- is not matched. Very short secrets are refused at input instead of
    being substituted, because substituting them would shred unrelated text.
    """
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


class ProviderLogScrubber(logging.Filter):
    """Best-effort scrubbing of the library's OWN log records.

    `garminconnect` 0.3.16 logs warnings from inside its login strategies
    (client.py:585 among others) and its `_sanitize_exception_text` only strips URL
    query values, so provider HTML such as a page title can reach the log untouched.
    Those records never pass through this adapter's error boundary, so the only way to
    apply our redaction is to filter the library's logger.

    One instance is shared by every active login and scrubs against the union of all
    registered secret sets. Per-login filters would leak: a record emitted while two
    logins overlap would reach the second login's handler carrying only the second
    login's secrets, and the first login's password would be printed in full.

    This is best effort, not a guarantee: it covers records emitted through the
    `garminconnect` logger while the filter is installed. Anything the library prints
    directly, logs under another name, or emits before installation is not covered.
    """

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._registered: dict[int, tuple[str, ...]] = {}
        self._next_token = 0

    def register(self, secrets: tuple[str, ...]) -> int:
        with self._lock:
            self._next_token += 1
            token = self._next_token
            self._registered[token] = tuple(secret for secret in secrets if secret)
            return token

    def unregister(self, token: int) -> None:
        with self._lock:
            self._registered.pop(token, None)

    def active_secrets(self) -> tuple[str, ...]:
        with self._lock:
            return tuple({secret for group in self._registered.values() for secret in group})

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            rendered = record.getMessage()
        except Exception:  # noqa: BLE001 - a broken record must not break logging.
            rendered = str(record.msg)
        record.msg = redact(scrub(rendered, *self.active_secrets()))
        record.args = ()
        return True


_LOG_LOCK = threading.RLock()
_LOG_DEPTH = 0
_LOG_STATE: dict[str, object] | None = None
_LOG_SCRUBBER: ProviderLogScrubber | None = None


def _release_scrubbing(
    logger: logging.Logger, scrubber: ProviderLogScrubber, token: int
) -> logging.Handler | None:
    """Undo one entry. The caller must hold `_LOG_LOCK`; returns a handler to close."""
    global _LOG_DEPTH, _LOG_STATE, _LOG_SCRUBBER

    scrubber.unregister(token)
    _LOG_DEPTH -= 1
    if _LOG_DEPTH > 0 or _LOG_STATE is None:
        return None
    closing: logging.Handler | None = None
    filtered = _LOG_STATE["filtered"]
    if isinstance(filtered, list):
        for target in filtered:
            target.removeFilter(scrubber)
    installed = _LOG_STATE["handler"]
    if isinstance(installed, logging.Handler):
        logger.removeHandler(installed)
        closing = installed
    saved_handlers = _LOG_STATE["handlers"]
    if isinstance(saved_handlers, list):
        logger.handlers[:] = saved_handlers
    logger.propagate = bool(_LOG_STATE["propagate"])
    _LOG_STATE = None
    _LOG_SCRUBBER = None
    return closing


@contextmanager
def provider_log_scrubbing(*secrets: str) -> Iterator[ProviderLogScrubber]:
    """Filter the library's logger while a login runs, then put the logger back.

    Composite, not per-login: one shared filter and one handler are installed by the
    OUTERMOST context, and every context registers its own secrets into that shared
    filter on entry and removes them on exit. Concurrent logins therefore scrub against
    each other's secrets instead of each installing a handler that knows only its own.

    The whole ENTRY -- registration, depth increment and installation -- happens under
    one lock. Releasing between the depth increment and the installation left a window
    in which a second login saw "not outermost", installed nothing and ran its body
    while the shared filter was not attached to the logger yet, so its records went out
    unscrubbed. The login body itself runs with the lock released; only entry and exit
    are serialized.

    Depth decides installation and teardown, so a context that exits while another is
    still live leaves the logger alone; the last one out restores the original handler
    list and ``propagate``. The caller's own handlers are kept and keep receiving
    records -- the shared filter is added to each of them rather than replacing them.
    ``propagate`` is off for the duration because child loggers inherit handlers but not
    filters, so propagation would hand unfiltered records to the root handlers.

    Two trade-offs, time-boxed to the login and stated rather than implied: a handler
    configured on the ROOT logger does not receive provider records while this is
    active, and a handler this logger SHARES with another logger has this filter applied
    to its unrelated records too.
    """
    global _LOG_DEPTH, _LOG_STATE, _LOG_SCRUBBER

    logger = logging.getLogger(PROVIDER_PACKAGE)
    with _LOG_LOCK:
        if _LOG_SCRUBBER is None:
            _LOG_SCRUBBER = ProviderLogScrubber()
        scrubber = _LOG_SCRUBBER
        # Registered before anything can log, and before the handler exists.
        token = scrubber.register(tuple(secrets))
        _LOG_DEPTH += 1
        try:
            if _LOG_DEPTH == 1:
                state: dict[str, object] = {
                    "handler": None,
                    "filtered": [],
                    "handlers": list(logger.handlers),
                    "propagate": logger.propagate,
                }
                _LOG_STATE = state
                handler = logging.StreamHandler()
                handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
                handler.addFilter(scrubber)
                filtered = state["filtered"]
                assert isinstance(filtered, list)
                # A handler whose addFilter raises must not leave the filters already
                # added on the earlier handlers behind; the except below rolls back.
                for target in list(logger.handlers):
                    target.addFilter(scrubber)
                    filtered.append(target)
                logger.addHandler(handler)
                logger.propagate = False
                state["handler"] = handler
        except BaseException:
            _release_scrubbing(logger, scrubber, token)
            raise
    try:
        yield scrubber
    finally:
        with _LOG_LOCK:
            closing = _release_scrubbing(logger, scrubber, token)
        if closing is not None:
            closing.close()


def redact(value: object) -> str:
    """Strip anything that could carry a credential before it reaches a log."""
    text = str(value)
    text = _SECRET_PATTERN.sub("[redacted]", text)
    text = _EMAIL_PATTERN.sub("[redacted-email]", text)
    text = _LONG_OPAQUE_PATTERN.sub("[redacted]", text)
    text = " ".join(text.split())
    if len(text) > MAX_REDACTED_LENGTH:
        text = f"{text[:MAX_REDACTED_LENGTH]}..."
    return text


# ------------------------------------------------------------------- read-only source


class ReadOnlyActivitySource(Protocol):
    """The only provider surface the rest of this module may use."""

    def list_activities(self, start: int, limit: int) -> object: ...

    def download_original(self, activity_id: str) -> bytes: ...


# Private registry. Storing the provider here rather than on the wrapper keeps it off
# the reference paths an accidental edit would follow from the wrapper (attributes,
# bound-method ``__self__``, closure cells), which ``__slots__`` alone does not prevent.
# It does NOT hide the provider from this process: ``_read_activities.__globals__`` and
# any exception traceback reach it, and ``release()`` does not undo that.
_PROVIDER_REGISTRY: dict[str, object] = {}


def _provider(handle: str) -> object:
    api = _PROVIDER_REGISTRY.get(handle)
    if api is None:
        raise UnofficialFetchError("The provider session was already released")
    return api


def _read_activities(handle: str, start: int, limit: int) -> object:
    """Module-level: no ``__self__``, no closure cell, nothing to walk back through."""
    return getattr(_provider(handle), READ_METHODS[0])(start=start, limit=limit)


def _read_original(handle: str, activity_id: str) -> object:
    api = _provider(handle)
    original = getattr(api, DOWNLOAD_FORMAT_ATTRIBUTE).ORIGINAL
    return getattr(api, READ_METHODS[1])(activity_id, original)


class GarminReadOnlySource:
    """Holds an opaque handle only.

    The provider is not reachable from this wrapper by attribute access or by walking
    ``__self__`` / ``__closure__`` / ``__wrapped__`` / ``__dict__``. It IS reachable
    through module globals and exception tracebacks; see the module docstring.
    """

    __slots__ = ("_handle",)

    def __init__(self, handle: str) -> None:
        self._handle = handle

    def list_activities(self, start: int, limit: int) -> object:
        return _read_activities(self._handle, start, limit)

    def download_original(self, activity_id: str) -> bytes:
        payload = _read_original(self._handle, activity_id)
        if not isinstance(payload, (bytes, bytearray)):
            raise TypeError("Provider returned a non-binary download")
        return bytes(payload)

    def release(self) -> None:
        """Unregister the handle so later calls fail.

        This does not erase references held elsewhere in the process.
        """
        _PROVIDER_REGISTRY.pop(self._handle, None)


def provider_library() -> object:
    """Import the optional provider library or explain exactly how to install it.

    ``convert`` and ``export-activity`` never call this, so a pure local-conversion
    environment (CI included) does not need the scraping library or curl_cffi.
    """
    try:
        import garminconnect
    except ImportError as error:
        raise UnofficialFetchError(
            f"The unofficial Garmin fetch needs the optional '{PROVIDER_EXTRA}' extra, "
            f"which is not installed. Install it with: {INSTALL_COMMAND}. "
            "`workout-manager convert` and `export-activity` do not need it."
        ) from error
    return garminconnect


def provider_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(PROVIDER_PACKAGE)
    except PackageNotFoundError:
        return "unknown"


def read_only_source(api: object) -> GarminReadOnlySource:
    """Register the provider behind an opaque handle after checking the read methods."""
    for name in (*READ_METHODS, DOWNLOAD_FORMAT_ATTRIBUTE):
        if not hasattr(api, name):
            raise UnofficialFetchError(
                f"The provider object has no '{name}'; this adapter does not match "
                f"{PROVIDER_PACKAGE} {provider_version()}."
            )
    handle = secrets.token_hex(16)
    _PROVIDER_REGISTRY[handle] = api
    return GarminReadOnlySource(handle)


@contextmanager
def read_only_session(api: object) -> Iterator[GarminReadOnlySource]:
    """Register and always unregister; no window between assignment and cleanup."""
    source = read_only_source(api)
    try:
        yield source
    finally:
        source.release()


# ----------------------------------------------------------------- transport policy


def require_allowed_url(url: object, allowed_hosts: frozenset[str] = ALLOWED_HOSTS) -> None:
    if not isinstance(url, str) or not url:
        raise UnofficialFetchError("Provider request has no usable URL")
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise UnofficialFetchError("Provider request is not HTTPS")
    if (parts.hostname or "").lower() not in allowed_hosts:
        raise UnofficialFetchError("Provider request or redirect left the allowed hosts")


def bounded_timeout(provided: object, cap: float) -> float:
    """Enforce the cap rather than defaulting it; a larger or absent value is replaced."""
    if isinstance(provided, bool) or not isinstance(provided, (int, float)):
        return cap
    return float(provided) if 0 < provided <= cap else cap


def _redirect_location(response: object) -> str | None:
    status = getattr(response, "status_code", None)
    if not isinstance(status, int) or not (300 <= status < 400):
        return None
    headers = getattr(response, "headers", None)
    location = headers.get("Location") if hasattr(headers, "get") else None
    return location if isinstance(location, str) and location else None


def _declared_length(response: object) -> int | None:
    headers = getattr(response, "headers", None)
    raw = headers.get("Content-Length") if hasattr(headers, "get") else None
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


# Weak references to the wrappers this module installed. Identity, not membership: a
# `in` test on a set would go through the candidate's own `__eq__`/`__hash__`, which a
# forged callable can define, so every comparison below uses `is`.
_INSTALLED_REFS: list[weakref.ref] = []


def _remember_installed(wrapper: Callable[..., object]) -> None:
    _INSTALLED_REFS[:] = [ref for ref in _INSTALLED_REFS if ref() is not None]
    _INSTALLED_REFS.append(weakref.ref(wrapper))


def is_installed_by_us(candidate: object) -> bool:
    """True only when `candidate` IS one of the wrappers this module installed."""
    if candidate is None:
        return False
    return any(ref() is candidate for ref in _INSTALLED_REFS)


def _close(response: object) -> None:
    closer = getattr(response, "close", None)
    if callable(closer):
        with suppress(Exception):
            closer()


def bound_response_body(response: object, max_bytes: int) -> object:
    """Read the body in chunks and abort past the cap.

    ``stream=True`` responses must be consumed promptly, so the body is pulled through
    ``iter_content`` here and cached back on the response for the library to read. A
    response object without ``iter_content`` (only fakes, in practice) falls back to a
    post-hoc length check, which bounds the result but not the peak memory.
    """
    declared = _declared_length(response)
    if declared is not None and declared > max_bytes:
        _close(response)
        raise UnofficialFetchError("Provider response exceeds the size limit")
    chunks = getattr(response, "iter_content", None)
    if not callable(chunks):
        # No streaming available: the body is already in memory, so this bounds the
        # result but NOT the peak memory. Only fakes take this path in practice.
        body = getattr(response, "content", b"")
        if isinstance(body, (bytes, bytearray)) and len(body) > max_bytes:
            _close(response)
            raise UnofficialFetchError("Provider response exceeds the size limit")
        return response
    collected: list[bytes] = []
    total = 0
    try:
        for chunk in chunks(DOWNLOAD_CHUNK_BYTES):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                raise UnofficialFetchError("Provider response exceeds the size limit")
            collected.append(bytes(chunk))
    except BaseException:
        # Including a mid-stream provider error: the connection must not be leaked.
        _close(response)
        raise
    body = b"".join(collected)
    # requests caches the body here; without it `.content` raises "already consumed".
    with suppress(AttributeError, TypeError):
        response._content = body  # type: ignore[attr-defined]
        response._content_consumed = True  # type: ignore[attr-defined]
    return response


def harden_session(
    session: object,
    *,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
    allowed_hosts: frozenset[str] = ALLOWED_HOSTS,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
) -> bool:
    """Enforce timeout, host allowlist, redirect control and a streamed size bound.

    Automatic redirects are disabled and hops are followed here. A hop to a different
    host is refused outright rather than followed: the host set is small and known, so a
    cross-host hop is a signal, not a destination -- and refusing it means the request
    headers (Authorization, Cookie, CSRF) are never replayed to another host and no
    method/body rewriting is needed. Every superseded response is closed before the next
    hop, because these are ``stream=True`` responses holding pooled connections.
    """
    original = getattr(session, "request", None)
    if not callable(original):
        return False
    if is_installed_by_us(original):
        return True

    def request(method: str, url: str, **kwargs: object) -> object:
        kwargs["allow_redirects"] = False
        kwargs["stream"] = True
        kwargs["timeout"] = bounded_timeout(kwargs.get("timeout"), timeout)
        require_allowed_url(url, allowed_hosts)
        origin = (urlsplit(url).hostname or "").lower()
        target = url
        for _ in range(MAX_REDIRECT_HOPS + 1):
            response = original(method, target, **kwargs)
            location = _redirect_location(response)
            if location is None:
                return bound_response_body(response, max_bytes)
            following = urljoin(target, location)
            _close(response)
            parts = urlsplit(following)
            if parts.scheme != "https" or (parts.hostname or "").lower() != origin:
                raise UnofficialFetchError(
                    "Provider redirected to a different host; refusing to follow it"
                )
            require_allowed_url(following, allowed_hosts)
            target = following
        raise UnofficialFetchError("Provider redirect chain exceeded the allowed hops")

    _remember_installed(request)
    # Informational handle only; the decision above is made by identity, not by this.
    setattr(session, HARDENED_ATTR, request)
    session.request = request  # type: ignore[attr-defined]
    return True


def _required_sessions(api: object) -> list[tuple[str, object]]:
    client = getattr(api, "client", api)
    return [(name, getattr(client, name, None)) for name in REQUIRED_SESSIONS]


def _refuse(detail: str) -> UnofficialFetchError:
    return UnofficialFetchError(
        f"Refusing to run: {detail} The transport timeout, host allowlist, redirect "
        "control and size bound would not be enforced on a network path "
        f"({PROVIDER_PACKAGE} {provider_version()}); update this adapter first."
    )


def harden_client(api: object) -> int:
    """Apply the transport policy to every session the library is expected to use.

    Fails closed on partial application: if any expected session is missing, the run is
    refused rather than proceeding with one unprotected session. Idempotent -- a session
    already carrying the installed callable is left alone.

    This does NOT cover every request the library makes. See `COVERAGE_NOTE`.
    """
    hardened = 0
    for name, session in _required_sessions(api):
        if session is None:
            raise _refuse(f"session '{name}' is missing.")
        if not harden_session(session):
            raise _refuse(f"session '{name}' has no usable request callable.")
        hardened += 1
    return hardened


def harden_token_exchange(api: object) -> bool:
    """Wrap the DI token exchange/refresh, which does not go through any session.

    0.3.16 posts to ``diauth.garmin.com`` through module-level ``requests.post`` /
    ``curl_cffi.requests.post`` (client.py ``_http_post``). Patching those module
    functions would change behaviour for every library in the process, so the instance
    method is wrapped instead. The response body is already read by that call, so the
    size limit here bounds the result, not the peak memory.
    """
    client = getattr(api, "client", api)
    original = getattr(client, TOKEN_EXCHANGE_METHOD, None)
    if not callable(original):
        raise _refuse(f"the DI token-exchange entry point '{TOKEN_EXCHANGE_METHOD}' is missing.")
    if is_installed_by_us(original):
        return True

    def post(url: str, **kwargs: object) -> object:
        require_allowed_url(url, ALLOWED_HOSTS | AUTH_POST_HOSTS)
        kwargs["timeout"] = bounded_timeout(kwargs.get("timeout"), REQUEST_TIMEOUT_SECONDS)
        # Enforced, not defaulted: an explicit allow_redirects=True must not win.
        kwargs["allow_redirects"] = False
        response = original(url, **kwargs)
        if _redirect_location(response) is not None:
            _close(response)
            raise UnofficialFetchError("Token exchange was redirected; refusing to follow it")
        declared = _declared_length(response)
        body = getattr(response, "content", b"")
        oversized = declared is not None and declared > MAX_TOKEN_RESPONSE_BYTES
        if oversized or (
            isinstance(body, (bytes, bytearray)) and len(body) > MAX_TOKEN_RESPONSE_BYTES
        ):
            _close(response)
            raise UnofficialFetchError("Token exchange response exceeds the size limit")
        return response

    _remember_installed(post)
    setattr(client, TOKEN_EXCHANGE_ATTR, post)
    setattr(client, TOKEN_EXCHANGE_METHOD, post)
    return True


def reharden_after_login(api: object) -> int:
    """Re-apply the policy to whatever sessions exist now.

    0.3.16 REPLACES ``client.cs`` with a plain session when the DI token exchange fails
    and it falls back to JWT_WEB (client.py:1280). Rejecting that would fail a login
    that actually succeeded, so the replacement is re-hardened instead. Failing to
    harden a session still refuses the run.
    """
    hardened = harden_client(api)
    harden_token_exchange(api)
    return hardened


# ------------------------------------------------------------------------ rate limit


class RateLimiter:
    """Serial pacing with an injectable clock so tests never sleep."""

    def __init__(
        self,
        interval: float = DEFAULT_INTERVAL_SECONDS,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not math.isfinite(interval) or interval < MIN_ALLOWED_INTERVAL_SECONDS:
            # NaN compares false against every bound, so check finiteness explicitly.
            raise ValueError("Request interval must be a finite value of at least 1.0 seconds")
        self.interval = interval
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None

    def wait(self) -> None:
        now = self._clock()
        if self._last is not None:
            remaining = self.interval - (now - self._last)
            if remaining > 0:
                self._sleep(remaining)
        self._last = self._clock()


# --------------------------------------------------------------------- selection


@dataclass(frozen=True, slots=True)
class ActivitySummary:
    activity_id: str
    started_at_local: str
    start_date: date


@dataclass(frozen=True, slots=True)
class Selection:
    activities: tuple[ActivitySummary, ...] = ()
    invalid: int = 0
    pages: int = 0
    complete: bool = True
    notes: tuple[str, ...] = ()


_LOCAL_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f")


def parse_summary(entry: object) -> ActivitySummary:
    """Validate one untrusted listing entry; never trust provider shapes."""
    # Every unusable shape is one failure domain here: the caller skips the entry and
    # keeps going, so a separate TypeError would add nothing.
    if not isinstance(entry, dict):
        raise ValueError("Activity entry is not an object")  # noqa: TRY004
    raw_id = entry.get("activityId")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (int, str)):
        raise ValueError("Activity entry has no usable activityId")  # noqa: TRY004
    identity = str(raw_id).strip()
    if not identity.isdigit() or int(identity) <= 0 or len(identity) > 24:
        raise ValueError("Activity entry has an invalid activityId")
    raw_start = entry.get("startTimeLocal")
    if not isinstance(raw_start, str) or not raw_start.strip():
        raise ValueError("Activity entry has no usable startTimeLocal")
    started = raw_start.strip()
    for pattern in _LOCAL_FORMATS:
        try:
            # Garmin reports local civil time with no offset; keep it naive rather
            # than inventing a timezone the provider did not send.
            moment = datetime.strptime(started, pattern)  # noqa: DTZ007
        except ValueError:
            continue
        return ActivitySummary(identity, started, moment.date())
    raise ValueError("Activity entry has an unreadable startTimeLocal")


def validate_range(start: date, end: date, limit: int) -> None:
    if end < start:
        raise ValueError("End date precedes start date")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"Date range exceeds the {MAX_RANGE_DAYS} day maximum")
    if limit < 1 or limit > MAX_ACTIVITIES:
        raise ValueError(f"Activity limit must be between 1 and {MAX_ACTIVITIES}")


def _page_entries(page: object) -> Sequence[object]:
    if isinstance(page, list):
        return page
    if isinstance(page, dict):
        entries = page.get("activityList")
        if isinstance(entries, list):
            return entries
    raise ValueError("Activity listing has an unsupported shape")


def select_activities(
    source: ReadOnlyActivitySource,
    start: date,
    end: date,
    limit: int,
    *,
    limiter: RateLimiter | None = None,
) -> Selection:
    """Page the newest-first listing only as far as the explicit bounds require."""
    validate_range(start, end, limit)
    limiter = limiter or RateLimiter()
    chosen: list[ActivitySummary] = []
    seen: set[str] = set()
    notes: list[str] = []
    invalid = 0
    pages = 0
    complete = False
    for page_index in range(MAX_LIST_PAGES):
        limiter.wait()
        pages += 1
        page: object = None
        failure: UnofficialFetchError | None = None
        try:
            page = source.list_activities(page_index * LIST_PAGE_SIZE, LIST_PAGE_SIZE)
        except Exception as error:  # noqa: BLE001 - redacted at this single boundary.
            failure = provider_failure(error, "listing activities")
        if failure is not None:
            # Raised outside the except block: no active exception, so no __context__.
            raise failure
        entries = _page_entries(page)
        if not entries:
            complete = True
            break
        reached_older = False
        for entry in entries:
            try:
                summary = parse_summary(entry)
            except ValueError as error:
                invalid += 1
                LOGGER.warning("Skipped unusable activity entry: %s", redact(error))
                continue
            if summary.start_date < start:
                reached_older = True
                continue
            if summary.start_date > end or summary.activity_id in seen:
                continue
            seen.add(summary.activity_id)
            chosen.append(summary)
            if len(chosen) >= limit:
                complete = True
                notes.append("Stopped at the requested activity limit")
                break
        if complete or reached_older:
            complete = True
            break
    if not complete:
        notes.append(
            f"Listing stopped after the {MAX_LIST_PAGES} page budget; the range may be "
            "incomplete. Narrow the date range and run again."
        )
    if invalid:
        notes.append(f"{invalid} listing entries were unusable and were skipped")
    return Selection(tuple(chosen), invalid, pages, complete, tuple(notes))


# ---------------------------------------------------------------------- validation


def extract_original_fit(payload: bytes) -> bytes:
    """Unwrap Garmin's ORIGINAL zip and validate the FIT before anything is written."""
    if len(payload) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Download exceeds the 64 MiB limit")
    if not payload:
        raise ValueError("Download is empty")
    data = payload
    if payload[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = [
                info
                for info in archive.infolist()
                if not info.is_dir() and info.filename.lower().endswith(".fit")
            ]
            if len(members) != 1:
                raise ValueError("Download archive does not hold exactly one FIT file")
            member = members[0]
            if member.file_size > MAX_DOWNLOAD_BYTES:
                raise ValueError("Archived FIT exceeds the 64 MiB limit")
            with archive.open(member) as stream:
                data = stream.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise ValueError("Archived FIT exceeds the 64 MiB limit")
    # Framing alone is not enough: a payload with valid headers and lengths but a bad
    # header/data CRC must never be stored as a successful download, because resume
    # would then treat it as verified. Reuse the local conversion CRC check.
    validate_fit_bytes(data)
    return data


def write_fit(data: bytes, target: Path) -> str:
    """Stage, fsync, and replace atomically; return the SHA-256 of the stored file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------- fetch


def provider_failure(error: BaseException, context: str) -> UnofficialFetchError:
    """Build -- never re-use -- the sanitized exception for a provider failure.

    A fresh object is returned so no traceback, ``__cause__`` or ``__context__`` from
    the provider survives. Callers must raise it *outside* their ``except`` block, or
    Python attaches the original exception as ``__context__`` regardless of ``from``.
    """
    if isinstance(error, UnofficialFetchError):
        return UnofficialFetchError(str(error))
    if is_rate_limited(error):
        after = _retry_after(error)
        return UnofficialFetchError(
            f"Provider returned 429 while {context}; stopping without retry"
            + (f" (Retry-After: {redact(after)})" if after else "")
        )
    return UnofficialFetchError(
        f"Provider failure while {context} ({type(error).__name__}): {redact(error)}"
    )


def is_rate_limited(error: BaseException) -> bool:
    """Recognize the provider's 429 without importing the optional library."""
    if any("TooManyRequests" in klass.__name__ for klass in type(error).__mro__):
        return True
    return getattr(getattr(error, "response", None), "status_code", None) == 429


def _retry_after(error: BaseException) -> str | None:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        value = headers.get("Retry-After")
    except AttributeError:
        return None
    return str(value) if value is not None else None


def fetch_activities(
    source: ReadOnlyActivitySource,
    output: Path,
    *,
    start: date,
    end: date,
    limit: int,
    resume: bool = True,
    overwrite: bool = False,
    limiter: RateLimiter | None = None,
) -> int:
    """Download bounded ORIGINAL FIT files into ``output``; return 1 when any failed."""
    output = output.resolve()
    limiter = limiter or RateLimiter()
    selection = select_activities(source, start, end, limit, limiter=limiter)
    for note in selection.notes:
        LOGGER.warning("%s", note)
    if not selection.activities:
        LOGGER.info("No activities matched the requested range")
        return 0
    failures = 0
    aborted: UnofficialFetchError | None = None
    with output_lock(output, lock_name=LOCK_NAME):
        manifest_path = output / MANIFEST_NAME
        manifest = load_manifest(manifest_path)
        entries = manifest["entries"]
        assert isinstance(entries, dict)  # Runtime checked by load_manifest.
        for summary in selection.activities:
            key = summary.activity_id
            previous = entries.get(key)
            attempts = previous.get("attempts", 0) if isinstance(previous, dict) else 0
            attempts = attempts if isinstance(attempts, int) and attempts >= 0 else 0
            target = output / f"{summary.activity_id}.fit"
            entry: dict[str, object] = {
                "provider": PROVIDER,
                "activity_id": summary.activity_id,
                "started_at_local": summary.started_at_local,
                "output": target.name,
                "attempts": attempts + 1,
                "official": False,
            }
            if resume and _can_resume(previous, target):
                LOGGER.info("Skipped verified download: %s", summary.activity_id)
                continue
            if not overwrite and (target.exists() or target.is_symlink()):
                failures += 1
                entry.update(status="failed", error="FileExistsError")
                entries[key] = entry
                atomic_json(manifest_path, manifest)
                LOGGER.error("Output exists; use --overwrite: %s", summary.activity_id)
                continue
            try:
                limiter.wait()
                data = extract_original_fit(source.download_original(summary.activity_id))
                entry.update(
                    status="success",
                    sha256=write_fit(data, target),
                    bytes=len(data),
                )
                entries[key] = entry
                LOGGER.info("Downloaded: %s", summary.activity_id)
            except Exception as error:  # noqa: BLE001 - redacted at this boundary.
                entry.update(status="failed", error=type(error).__name__)
                entries[key] = entry
                atomic_json(manifest_path, manifest)
                if is_rate_limited(error) or not isinstance(
                    error,
                    (OSError, ValueError, TypeError, zipfile.BadZipFile, FitParseError),
                ):
                    # 429: never retry on top of the library's own handling. Anything
                    # unexpected is surfaced too, but only ever as redacted text.
                    aborted = provider_failure(error, f"downloading activity {summary.activity_id}")
                else:
                    # Per-activity isolation: one bad download must not stop the run.
                    failures += 1
                    LOGGER.error(
                        "Download failed (%s): %s -- %s",
                        type(error).__name__,
                        summary.activity_id,
                        redact(error),
                    )
            if aborted is not None:
                break
            atomic_json(manifest_path, manifest)
    if aborted is not None:
        # Raised outside the except block so no provider traceback becomes __context__.
        raise aborted
    return 1 if failures else 0


def _can_resume(entry: object, target: Path) -> bool:
    if not isinstance(entry, dict) or entry.get("status") != "success":
        return False
    digest = entry.get("sha256")
    if not isinstance(digest, str) or not target.is_file() or target.is_symlink():
        return False
    if target.stat().st_size > MAX_DOWNLOAD_BYTES:
        # An oversized file is never a verified output; do not read it into memory.
        return False
    return sha256_file(target) == digest


# ------------------------------------------------------------------ credentials


def default_token_store() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    return root / "workout-manager" / "garmin-tokens"


def reject_symlinked_chain(path: Path) -> None:
    """Refuse a symlink anywhere in the token path, not only its last component.

    The library checks the chain too, but `Garmin.login()` swallows token-load and
    token-dump errors and carries on, so that check cannot be relied on here. This runs
    before any credential is read. It is a check, not a lock: a symlink swapped in after
    this returns (TOCTOU) is not prevented -- O_NOFOLLOW on the final component and the
    0600 verification afterwards are the remaining defences.
    """
    for candidate in (path, *path.parents):
        try:
            symlinked = candidate.is_symlink()
        except OSError as error:
            raise UnofficialFetchError(
                f"Token store path cannot be checked for symlinks: {redact(error)}"
            ) from None
        if symlinked:
            raise UnofficialFetchError(
                f"Token store path must not contain a symlink: {candidate.name!r}"
            )


def prepare_token_store(path: Path) -> Path:
    """Create the token directory owner-only; never log or read its contents."""
    path = path.expanduser()
    reject_symlinked_chain(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    reject_symlinked_chain(path)
    return path


def require_usable_password(password: str) -> None:
    """Refuse a secret too short to substitute out of provider text.

    Scrubbing a one- or two-character value would shred unrelated words, and leaving it
    unscrubbed is the wrong default. Garmin's own account-creation and password-reset
    documentation requires at least 8 characters, so this rejects nothing Garmin would
    accept for a new account today. Whether an older account may still hold a shorter
    password was not confirmed.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise UnofficialFetchError(
            f"The Garmin password must be at least {MIN_PASSWORD_LENGTH} characters for "
            "this command to remove it reliably from provider errors and logs."
        )


def read_credentials(
    prompt: Callable[[str], str] | None = None,
    secret_prompt: Callable[[str], str] | None = None,
) -> tuple[str, str]:
    """Environment first, interactive prompt second. Never CLI arguments."""
    import getpass

    prompt = prompt or input
    secret_prompt = secret_prompt or getpass.getpass
    email = os.environ.get("GARMIN_EMAIL", "").strip() or prompt("Garmin account email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or secret_prompt("Garmin account password: ")
    if not email or not password:
        raise UnofficialFetchError("Garmin credentials are required")
    require_usable_password(password)
    return email, password


def token_file(store: Path) -> Path:
    """The single file the pinned library writes inside a directory token store."""
    return store / TOKEN_FILE_NAME


def _token_files(store: Path) -> Iterator[Path]:
    """Yield each regular file in the store, refusing symlinks instead of skipping them."""
    if not store.is_dir():
        return
    for path in sorted(store.iterdir()):
        if path.is_symlink():
            raise UnofficialFetchError(
                "Refusing to continue: the Garmin token store contains a symlink "
                f"({path.name}). Remove it and run again."
            )
        if path.is_file():
            yield path


def reserve_token_file(store: Path) -> None:
    """Create the token file 0600 before login, so a file we create is never wider.

    This does not depend on process-global state such as ``umask``. A file that already
    exists is checked here too, because creation-time modes never fix an existing one.
    """
    target = token_file(store)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        os.close(os.open(target, flags, 0o600))
    except FileExistsError:
        pass
    except OSError as error:
        raise UnofficialFetchError(
            f"Could not reserve the Garmin token file at 0600: {redact(error)}"
        ) from None
    verify_token_permissions(store)


def verify_token_permissions(store: Path) -> None:
    """Fail closed: a token file that cannot be kept at 0600 stops the run."""
    for path in _token_files(store):
        if path.stat().st_mode & 0o777 == 0o600:
            continue
        corrected = False
        try:
            os.chmod(path, 0o600)
            corrected = path.stat().st_mode & 0o777 == 0o600
        except OSError:
            corrected = False
        if corrected:
            continue
        removed = True
        try:
            path.unlink()
        except OSError:
            removed = False
        outcome = (
            "It was removed."
            if removed
            else "It could NOT be removed either and is still on disk with its current "
            "permissions -- delete it yourself."
        )
        raise UnofficialFetchError(
            "Refusing to continue: a Garmin token file is not 0600 and could not be "
            f"fixed. {outcome} Check the token store's filesystem and permissions."
        )


@dataclass(frozen=True, slots=True)
class LoginOutcome:
    """What the credential-holding frame reports back; never an exception object."""

    api: object | None = None
    message: str | None = None
    interrupted: str | None = None
    where: str | None = None


def _stack_summary(error: BaseException, *secrets: str) -> str:
    """File/line/function only -- no locals, no arguments, no source text.

    Dropping the interrupt's traceback protects the credentials the library's frames
    hold, but it also loses where a real hang was. This keeps the location diagnosable
    without carrying any frame state.
    """
    frames = traceback_module.extract_tb(error.__traceback__)
    rendered = " <- ".join(
        f"{Path(frame.filename).name}:{frame.lineno} {frame.name}" for frame in frames[-6:]
    )
    return redact(scrub(rendered, *secrets))


def _perform_login(
    store: Path,
    credentials: Callable[[], tuple[str, str]] | None,
    mfa_prompt: Callable[[], str] | None,
) -> LoginOutcome:
    """Hold the credentials in this frame only; return the api or a sanitized message.

    The caller raises. Nothing from here appears in the final exception's traceback, and
    the credentials are dropped in ``finally`` so even a frame captured by a propagating
    interrupt shows them gone. The api is dropped too on any failure, because the
    library keeps the plaintext password on it until a login succeeds.
    """
    import getpass

    Garmin = provider_library().Garmin

    email = password = None
    api = None
    try:
        email, password = (credentials or read_credentials)()
        # Enforced here, not only in `read_credentials`, so an injected callback cannot
        # introduce a password this command could not scrub out of provider text.
        require_usable_password(password)
        prompt_mfa = mfa_prompt or (lambda: getpass.getpass("Garmin MFA code: ").strip())
        # Filtering is installed before the library can log anything about this login,
        # and the caller's logging configuration is restored on the way out.
        with provider_log_scrubbing(password, email):
            api = Garmin(email=email, password=password, prompt_mfa=prompt_mfa)
            # Fails closed before any credential leaves the process.
            LOGGER.info("Applied transport policy to %d provider sessions", harden_client(api))
            harden_token_exchange(api)
            api.login(tokenstore=str(store))
    except Exception as error:  # noqa: BLE001 - any provider error may embed credentials.
        # `redact` catches credential-shaped text; `scrub` removes the literal values,
        # which a provider message can echo with no keyword beside them.
        # Scrub the RAW text first: `redact` collapses whitespace, after which a secret
        # containing one would no longer match its original spelling.
        safe = redact(scrub(f"{type(error).__name__}: {error}", password or "", email or ""))
        api = None
        return LoginOutcome(message=f"Unofficial login failed: {safe}")
    except BaseException as error:  # noqa: BLE001 - interrupts must not carry credentials.
        # An interrupt raised inside the library leaves ITS frames in the traceback,
        # holding an api that still carries the plaintext password. Those frames cannot
        # be scrubbed, so the original traceback is deliberately dropped and the caller
        # re-raises a fresh interrupt instead.
        api = None
        return LoginOutcome(
            interrupted=type(error).__name__,
            where=_stack_summary(error, password or "", email or ""),
        )
    finally:
        email = password = prompt_mfa = None
        del email, password
    return LoginOutcome(api=api)


def login_read_only_source(
    token_store: Path,
    *,
    credentials: Callable[[], tuple[str, str]] | None = None,
    mfa_prompt: Callable[[], str] | None = None,
) -> GarminReadOnlySource:
    """Log in through the unofficial library and return only its read surface.

    Prefer `login_read_only_session`; a caller of this must release the source itself.
    This frame never holds the email or password, so the exception it raises carries
    neither in its traceback. A caller-supplied `credentials` callable is the caller's
    own object and is not inspected.
    """
    store = prepare_token_store(token_store)
    # Pre-created 0600 and checked before any credential is read.
    reserve_token_file(store)
    outcome = _perform_login(store, credentials, mfa_prompt)
    # Runs on success, failure and interrupt alike.
    verify_token_permissions(store)
    if outcome.interrupted is not None:
        if outcome.where:
            LOGGER.warning("Login stopped at: %s", outcome.where)
        # Raised fresh from this frame; the library's traceback is not re-used.
        if outcome.interrupted == "KeyboardInterrupt":
            raise KeyboardInterrupt
        raise UnofficialFetchError(f"Login stopped by {outcome.interrupted}")
    if outcome.message is not None:
        # Raised from a frame that never held credentials and whose `api` is None.
        raise UnofficialFetchError(outcome.message)
    api = outcome.api
    reharden_after_login(api)
    LOGGER.info("%s", COVERAGE_NOTE)
    return read_only_source(api)


@contextmanager
def login_read_only_session(
    token_store: Path,
    *,
    credentials: Callable[[], tuple[str, str]] | None = None,
    mfa_prompt: Callable[[], str] | None = None,
) -> Iterator[GarminReadOnlySource]:
    """Log in and always unregister the provider handle afterwards."""
    source = login_read_only_source(token_store, credentials=credentials, mfa_prompt=mfa_prompt)
    try:
        yield source
    finally:
        source.release()
