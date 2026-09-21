"""Synthetic fixtures only.

Every test here runs against a fake read-only source. No credentials, no token store
contents, and no live provider are involved, and nothing contacts Garmin. The optional
`garmin` extra is not required: nothing here imports `garminconnect`.
"""

from __future__ import annotations

import io
import json
import os
import struct
import types
import zipfile
from collections import deque
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from fitparse import FitParseError

from workout_manager.cli import main
from workout_manager.garmin_fetch import (
    INSTALL_COMMAND,
    LIST_PAGE_SIZE,
    MAX_ACTIVITIES,
    MAX_DOWNLOAD_BYTES,
    MAX_LIST_PAGES,
    MAX_REDIRECT_HOPS,
    UNOFFICIAL_NOTICE,
    GarminReadOnlySource,
    RateLimiter,
    Selection,
    UnofficialFetchError,
    bound_response_body,
    bounded_timeout,
    extract_original_fit,
    fetch_activities,
    harden_client,
    harden_session,
    harden_token_exchange,
    is_rate_limited,
    login_read_only_source,
    parse_summary,
    prepare_token_store,
    provider_library,
    provider_log_scrubbing,
    read_credentials,
    read_only_session,
    read_only_source,
    redact,
    reharden_after_login,
    require_allowed_url,
    reserve_token_file,
    scrub,
    select_activities,
    token_file,
    validate_range,
    verify_token_permissions,
    write_fit,
)

MUTATING_METHODS = (
    "upload_activity",
    "delete_activity",
    "set_activity_name",
    "add_weigh_in",
    "add_hydration_data",
    "schedule_workout",
    "update_menstrual_daily_log",
)


def crc(data: bytes) -> int:
    result = 0
    for value in data:
        result ^= value
        for _ in range(8):
            result = (result >> 1) ^ (0xA001 if result & 1 else 0)
    return result


def fit_bytes() -> bytes:
    data = struct.pack("<BBBH", 0x40, 0, 0, 20) + bytes([1, 253, 4, 0x86])
    data += bytes([0]) + struct.pack("<I", 1_000_000)
    header = struct.pack("<BBHI4s", 14, 0x10, 100, len(data), b".FIT")
    header += struct.pack("<H", crc(header))
    content = header + data
    return content + struct.pack("<H", crc(content))


def zipped(*members: tuple[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, payload in members:
            archive.writestr(name, payload)
    return buffer.getvalue()


def entry(activity_id: int, day: str) -> dict[str, object]:
    return {"activityId": activity_id, "startTimeLocal": f"{day} 07:00:00", "ownerId": 1}


class FakeSource:
    """Implements the read-only protocol only; it has no mutating surface at all."""

    def __init__(
        self,
        pages: list[list[object]],
        payloads: dict[str, object] | None = None,
    ) -> None:
        self.pages = pages
        self.payloads = payloads or {}
        self.listed: list[tuple[int, int]] = []
        self.downloaded: list[str] = []

    def list_activities(self, start: int, limit: int) -> list[object]:
        self.listed.append((start, limit))
        index = start // limit
        return self.pages[index] if index < len(self.pages) else []

    def download_original(self, activity_id: str) -> bytes:
        self.downloaded.append(activity_id)
        value = self.payloads.get(activity_id, zipped((f"{activity_id}.fit", fit_bytes())))
        if isinstance(value, Exception):
            raise value
        assert isinstance(value, bytes)
        return value


@pytest.fixture
def limiter() -> RateLimiter:
    ticks = iter(range(100000))
    return RateLimiter(1.0, clock=lambda: float(next(ticks)), sleep=lambda _: None)


def manifest(output: Path) -> dict:
    return json.loads((output / "download-manifest.json").read_text())


# ------------------------------------------------------------------ read-only surface


class ProviderApi:
    """Stands in for the library facade, mutating methods included."""

    ActivityDownloadFormat = type("Formats", (), {"ORIGINAL": "original"})

    def __init__(self, payload: object = b"") -> None:
        self.payload = payload
        self.deleted: list[str] = []
        self.uploaded: list[str] = []

    def get_activities(self, start: int, limit: int) -> list[object]:
        return []

    def download_activity(self, activity_id: str, fmt: object) -> object:
        assert fmt == "original"
        return self.payload

    def delete_activity(self, activity_id: str) -> None:
        self.deleted.append(activity_id)

    def upload_activity(self, path: str) -> None:
        self.uploaded.append(path)


def peek(item: object, name: str) -> object:
    """Attribute access that swallows failures.

    This still calls `getattr`, so a lazy module attribute or a property CAN run its
    side effect; only the resulting exception is absorbed. pytest's mark objects
    synthesize attributes on access, so they are skipped outright.
    """
    module = getattr(type(item), "__module__", "")
    if isinstance(module, str) and module.startswith(("_pytest", "pytest")):
        return None  # pytest.mark synthesizes attributes on access.
    try:
        return getattr(item, name, None)
    except BaseException:  # noqa: BLE001 - walking untrusted objects, never fail here.
        return None


def reachable(
    root: object,
    depth: int = 6,
    *,
    module_globals: bool = False,
    frame_locals: bool = False,
) -> list[object]:
    """Walk reference paths from `root`.

    Three separable concerns, because mixing them makes assertions meaningless:
    - default: attributes, `__self__`, `__func__`, `__wrapped__`, closures, `__dict__`,
      `__slots__`. This is the path an accidental edit would follow.
    - `module_globals`: also `__globals__`. Everything a module defines is reachable
      this way, so only a POSITIVE claim ("still reachable") is meaningful here.
    - `frame_locals`: also `__context__`, `__cause__` and each traceback frame's LOCALS
      (never its globals, which would drag in the whole defining module).
    """
    follow_dicts = module_globals or frame_locals
    seen: set[int] = set()
    found: list[object] = []
    # Breadth first, so each object is recorded at its shortest distance from the root.
    stack: deque[tuple[object, int]] = deque([(root, 0)])
    while stack:
        item, level = stack.popleft()
        if level > depth or id(item) in seen:
            continue
        seen.add(id(item))
        found.append(item)
        children: list[object] = []
        for name in ("__self__", "__wrapped__", "__func__"):
            child = peek(item, name)
            if child is not None:
                children.append(child)
        if module_globals:
            defining_globals = peek(item, "__globals__")
            if isinstance(defining_globals, dict):
                children.extend(defining_globals.values())
        if frame_locals:
            traceback = peek(item, "__traceback__")
            while isinstance(traceback, types.TracebackType):
                # On 3.13 f_locals is a FrameLocalsProxy, not a dict, so the generic
                # dict branch below would never walk its values.
                children.extend(dict(traceback.tb_frame.f_locals).values())
                traceback = traceback.tb_next
        if module_globals or frame_locals:
            for name in ("__context__", "__cause__"):
                linked = peek(item, name)
                if linked is not None:
                    children.append(linked)
        if isinstance(item, dict) and follow_dicts:
            children.extend(item.values())
        closure = peek(item, "__closure__")
        for cell in closure if isinstance(closure, tuple) else ():
            try:
                children.append(cell.cell_contents)
            except (ValueError, AttributeError):
                continue
        namespace = peek(item, "__dict__")
        if isinstance(namespace, dict):
            children.extend(namespace.values())
        slots = peek(type(item), "__slots__") or ()
        for slot in slots if isinstance(slots, (tuple, list)) else ():
            value = peek(item, slot)
            if value is not None:
                children.append(value)
        stack.extend((child, level + 1) for child in children)
    return found


def test_provider_is_not_reachable_by_attribute_or_closure_paths() -> None:
    api = ProviderApi()
    with read_only_session(api) as source:
        # Walk from the wrapper itself and from both of its public bound methods.
        roots = [source, source.list_activities, source.download_original]
        visited = [item for root in roots for item in reachable(root)]
        assert not any(item is api for item in visited)
        for item in visited:
            for name in MUTATING_METHODS:
                assert not hasattr(item, name), f"{name} reachable through {item!r}"
        assert set(GarminReadOnlySource.__slots__) == {"_handle"}
        assert not hasattr(source, "__dict__")
        # Pin the class shape too: a new property or __getattr__ would otherwise keep
        # this test green while opening a fresh path to the provider.
        assert_wrapper_shape_is_allowlisted()
        assert isinstance(source._handle, str)
        with pytest.raises(AttributeError):
            source.upload_activity = object()  # type: ignore[attr-defined]
    assert api.deleted == [] and api.uploaded == []


ALLOWED_SOURCE_ATTRIBUTES = frozenset({"list_activities", "download_original", "release"})


def assert_wrapper_shape_is_allowlisted() -> None:
    namespace = vars(GarminReadOnlySource)
    assert {name for name in dir(GarminReadOnlySource) if not name.startswith("_")} == (
        ALLOWED_SOURCE_ATTRIBUTES
    )
    assert "__getattr__" not in namespace
    assert "__getattribute__" not in namespace
    assert not [name for name, value in namespace.items() if isinstance(value, property)]


def test_the_wrapper_class_exposes_nothing_beyond_the_allowlist() -> None:
    assert_wrapper_shape_is_allowlisted()


def test_module_globals_do_reach_the_provider_this_is_not_a_boundary() -> None:
    """Pins the documented limitation so no one can claim isolation later."""
    api = ProviderApi()
    with read_only_session(api) as source:
        visited = reachable(source.list_activities, depth=3, module_globals=True)
        assert any(item is api for item in visited), (
            "Expected the registry to stay reachable through __globals__; if this ever "
            "stops being true, strengthen the docs deliberately rather than by accident."
        )


def test_release_does_not_erase_references_already_held() -> None:
    api = ProviderApi()
    source = read_only_source(api)
    source.release()
    # The registry no longer answers, but an existing reference still works. This is
    # exactly why the docs say mistake prevention, not a security boundary.
    with pytest.raises(UnofficialFetchError):
        source.list_activities(0, 20)
    assert api.get_activities(0, 20) == []


def test_a_sanitized_failure_carries_no_provider_context() -> None:
    class ProviderBoom(Exception):
        """Carries a credential-bearing payload, like a real provider exception would."""

    class Listing(FakeSource):
        def list_activities(self, start: int, limit: int) -> object:  # type: ignore[override]
            raise ProviderBoom("cookie=JWT_WEB=abc123")

    ticks = iter(range(1000))
    pacer = RateLimiter(1.0, clock=lambda: float(next(ticks)), sleep=lambda _: None)
    with pytest.raises(UnofficialFetchError) as raised:
        select_activities(Listing([]), date(2026, 9, 1), date(2026, 9, 2), 5, limiter=pacer)
    failure = raised.value
    assert failure.__context__ is None
    assert failure.__cause__ is None
    assert "abc123" not in str(failure)
    # Neither the provider exception nor its traceback is reachable from what we raise.
    for item in reachable(failure, depth=6, frame_locals=True):
        assert not isinstance(item, ProviderBoom)


def test_released_source_refuses_further_provider_calls() -> None:
    source = read_only_source(ProviderApi())
    source.release()
    with pytest.raises(UnofficialFetchError, match="already released"):
        source.list_activities(0, 20)


def test_read_only_session_releases_even_on_failure() -> None:
    source: GarminReadOnlySource | None = None
    with pytest.raises(ZeroDivisionError), read_only_session(ProviderApi()) as opened:
        source = opened
        raise ZeroDivisionError
    assert source is not None
    with pytest.raises(UnofficialFetchError, match="already released"):
        source.list_activities(0, 20)


def test_read_only_source_refuses_an_unexpected_provider_object() -> None:
    with pytest.raises(UnofficialFetchError, match="has no 'get_activities'"):
        read_only_source(object())


def test_read_only_source_requests_the_original_format() -> None:
    with read_only_session(ProviderApi(payload=b"bytes")) as source:
        assert source.download_original("1") == b"bytes"


def test_read_only_source_rejects_non_binary_downloads() -> None:
    with (
        read_only_session(ProviderApi(payload="not bytes")) as source,
        pytest.raises(TypeError, match="non-binary"),
    ):
        source.download_original("1")


# ------------------------------------------------------------------------- redaction


@pytest.mark.parametrize(
    "text",
    [
        "login failed for password=hunter2",
        "Authorization: Bearer abc.def.ghi",
        "Cookie: JWT_WEB=zzz",
        "user someone@example.com could not sign in",
        "di_token " + "A" * 80,
    ],
)
def test_redaction_removes_credential_shaped_text(text: str) -> None:
    cleaned = redact(text)
    for secret in ("hunter2", "abc.def.ghi", "zzz", "someone@example.com", "A" * 80):
        assert secret not in cleaned
    assert "[redacted" in cleaned


def test_scrub_runs_before_normalization_can_hide_a_secret() -> None:
    secret = "aa\nbb-and-more"
    # redact() collapses whitespace, so scrubbing afterwards would miss this value.
    assert secret not in redact(scrub(f"rejected {secret} here", secret))
    assert "aa bb-and-more" not in redact(scrub(f"rejected {secret} here", secret))


def test_scrub_has_no_minimum_length() -> None:
    assert scrub("abc", "abc") == "[redacted]"


def test_the_provider_logger_is_scrubbed() -> None:
    import logging as logging_module

    secret = "Tr0ubador-and-3"
    parent = logging_module.getLogger("garminconnect")
    records: list[str] = []

    class Capture(logging_module.Handler):
        def emit(self, record: logging_module.LogRecord) -> None:
            records.append(record.getMessage())

    # A handler the caller configured before we touch anything.
    capture = Capture()
    parent.addHandler(capture)
    previous_propagate = parent.propagate
    try:
        with provider_log_scrubbing(secret, "someone@example.com"):
            # Emitted by the library's own child logger, not through our boundary.
            logging_module.getLogger("garminconnect.client").warning(
                "portal failed: %s for %s", secret, "someone@example.com"
            )
            assert records
            assert secret not in records[0]
            assert "someone@example.com" not in records[0]
            # The caller's handler is kept, not replaced.
            assert capture in parent.handlers
        # Restored: handler set, propagate and the caller's filters are as before.
        assert parent.handlers == [capture]
        assert parent.propagate is previous_propagate
        assert capture.filters == []
        records.clear()
        logging_module.getLogger("garminconnect.client").warning("later: %s", secret)
        assert records[0] == f"later: {secret}"
    finally:
        parent.removeHandler(capture)
        parent.propagate = previous_propagate


def test_overlapping_scrubbing_contexts_restore_the_original_state() -> None:
    import logging as logging_module

    parent = logging_module.getLogger("garminconnect")
    caller = logging_module.Handler()
    parent.addHandler(caller)
    original_propagate = parent.propagate
    try:
        outer = provider_log_scrubbing("outer-secret-value")
        inner = provider_log_scrubbing("inner-secret-value")
        outer.__enter__()
        inner.__enter__()
        # The outer context exits first; the inner one is still live.
        outer.__exit__(None, None, None)
        assert parent.propagate is False
        inner.__exit__(None, None, None)
        # Only the last exit restores, and it restores the ORIGINAL state.
        assert parent.propagate is original_propagate
        assert parent.handlers == [caller]
        assert caller.filters == []
    finally:
        parent.removeHandler(caller)
        parent.propagate = original_propagate


def test_concurrent_logins_do_not_leak_each_others_secrets(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Two real threads, both contexts live at once.

    Per-context filters leaked here: a record emitted while both logins were active
    reached the other login's handler, which carried only its own secrets.
    """
    import io
    import logging as logging_module
    import threading

    first, second = "AlphaOne9!", "BetaTwo8!"
    parent = logging_module.getLogger("garminconnect")
    sink = io.StringIO()
    caller = logging_module.StreamHandler(sink)
    saved_handlers = list(parent.handlers)
    saved_propagate = parent.propagate
    parent.handlers[:] = [caller]
    ready = threading.Barrier(2)
    logged = threading.Barrier(2)
    failures: list[BaseException] = []

    def worker(secret: str) -> None:
        try:
            with provider_log_scrubbing(secret):
                ready.wait(10)  # both contexts are live before anything is logged
                logging_module.getLogger("garminconnect.client").warning("failure %s", secret)
                logged.wait(10)
        except BaseException as error:  # noqa: BLE001 - reported on the main thread.
            failures.append(error)

    threads = [threading.Thread(target=worker, args=(value,)) for value in (first, second)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
    finally:
        parent.handlers[:] = saved_handlers
        parent.propagate = saved_propagate
    assert not failures
    emitted = sink.getvalue() + capsys.readouterr().err
    assert first not in emitted
    assert second not in emitted
    assert emitted.count("[redacted]") >= 2
    # And the logger is back to what it was before either thread ran.
    assert parent.handlers == saved_handlers
    assert parent.propagate is saved_propagate


def test_a_second_login_cannot_log_inside_the_entry_window() -> None:
    """Synchronise INSIDE the entry window, not after it.

    Registration, the depth increment and the installation must be one atomic step.
    When the lock was released in between, a second context saw "not outermost",
    installed nothing and ran its body while the shared filter was not attached yet.
    """
    import io
    import logging as logging_module
    import threading

    first, second = "AlphaOne9!", "BetaTwo8!"
    parent = logging_module.getLogger("garminconnect")
    sink = io.StringIO()
    paused, resume, logged = threading.Event(), threading.Event(), threading.Event()

    class Pausing(logging_module.Handler):
        """Blocks inside addFilter, which the outermost entry calls while installing."""

        def addFilter(self, filter: object) -> None:  # logging's own parameter name.
            paused.set()
            resume.wait(10)
            super().addFilter(filter)  # type: ignore[arg-type]

        def emit(self, record: logging_module.LogRecord) -> None:
            sink.write(record.getMessage() + "\n")

    saved_handlers = list(parent.handlers)
    saved_propagate = parent.propagate
    parent.handlers[:] = [Pausing()]
    failures: list[BaseException] = []

    def outer() -> None:
        try:
            with provider_log_scrubbing(first):
                resume.set()
        except BaseException as error:  # noqa: BLE001 - reported on the main thread.
            failures.append(error)

    def inner() -> None:
        try:
            with provider_log_scrubbing(second):
                logging_module.getLogger("garminconnect.client").warning("failure %s", second)
                logged.set()
        except BaseException as error:  # noqa: BLE001 - reported on the main thread.
            failures.append(error)

    first_thread = threading.Thread(target=outer)
    second_thread = threading.Thread(target=inner)
    try:
        first_thread.start()
        assert paused.wait(10), "the outermost entry never reached installation"
        second_thread.start()
        # The window is closed: the second context cannot reach its body yet.
        assert not logged.wait(0.5)
        resume.set()
        first_thread.join(10)
        second_thread.join(10)
    finally:
        resume.set()
        parent.handlers[:] = saved_handlers
        parent.propagate = saved_propagate
    assert not failures
    emitted = sink.getvalue()
    assert first not in emitted
    assert second not in emitted
    assert "[redacted]" in emitted


def test_a_handler_that_refuses_a_filter_leaves_nothing_behind() -> None:
    import logging as logging_module

    class Refusing(logging_module.Handler):
        def addFilter(self, filter: object) -> None:  # logging's own parameter name.
            raise RuntimeError("this handler refuses filters")

    parent = logging_module.getLogger("garminconnect")
    good = logging_module.Handler()
    bad = Refusing()
    parent.addHandler(good)
    parent.addHandler(bad)
    original_propagate = parent.propagate
    try:
        with (
            pytest.raises(RuntimeError, match="refuses filters"),
            provider_log_scrubbing("some-secret-value"),
        ):
            pass
        # The filter added to the earlier handler was rolled back.
        assert good.filters == []
        assert parent.handlers == [good, bad]
        assert parent.propagate is original_propagate
    finally:
        parent.removeHandler(good)
        parent.removeHandler(bad)
        parent.propagate = original_propagate


def test_redaction_bounds_length() -> None:
    assert len(redact("x " * 5000)) <= 244


# ----------------------------------------------------------------- transport policy


class FakeResponse:
    """Streamed like the real thing: the body is only available through iter_content."""

    def __init__(
        self,
        url: str = "https://connectapi.garmin.com/x",
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        body: bytes = b"ok",
        chunk: int = 4,
    ) -> None:
        self.url = url
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body
        self.chunk = chunk
        self.closed = False
        self.chunks_read = 0

    def iter_content(self, size: int) -> Iterator[bytes]:
        step = min(size, self.chunk)
        for offset in range(0, len(self.body), step):
            if self.closed:
                raise AssertionError("Read from a closed response")
            self.chunks_read += 1
            yield self.body[offset : offset + step]

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, *responses: FakeResponse) -> None:
        self.responses = list(responses) or [FakeResponse()]
        self.calls: list[dict[str, object]] = []

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        return self.responses[index]


def redirect(location: str, status: int = 302) -> FakeResponse:
    return FakeResponse(status_code=status, headers={"Location": location})


def test_body_is_read_in_bounded_chunks() -> None:
    response = FakeResponse(body=b"x" * 32, chunk=4)
    assert bound_response_body(response, 64) is response
    # Cached back onto the response so the library's `.content` still works.
    assert response._content == b"x" * 32
    assert response._content_consumed is True
    assert response.chunks_read == 8


def test_a_body_past_the_cap_aborts_mid_stream_and_closes() -> None:
    response = FakeResponse(body=b"x" * 4096, chunk=8)
    with pytest.raises(UnofficialFetchError, match="size limit"):
        bound_response_body(response, 16)
    assert response.closed is True
    # Aborted early instead of materializing the whole body first.
    assert response.chunks_read <= 4


def test_a_mid_stream_failure_still_closes_the_response() -> None:
    class Failing(FakeResponse):
        def iter_content(self, size: int) -> Iterator[bytes]:
            yield b"x" * 4
            raise OSError("connection reset")

    response = Failing()
    with pytest.raises(OSError, match="connection reset"):
        bound_response_body(response, 1024)
    assert response.closed is True


def test_a_falsely_small_content_length_does_not_defeat_the_cap() -> None:
    response = FakeResponse(body=b"x" * 512, chunk=8, headers={"Content-Length": "4"})
    with pytest.raises(UnofficialFetchError, match="size limit"):
        bound_response_body(response, 16)
    assert response.closed is True


@pytest.mark.parametrize(
    ("provided", "expected"),
    [(None, 30.0), (600, 30.0), (0, 30.0), (-1, 30.0), (True, 30.0), ("x", 30.0), (5, 5.0)],
)
def test_timeout_is_enforced_not_defaulted(provided: object, expected: float) -> None:
    assert bounded_timeout(provided, 30.0) == expected


def test_hardened_session_marks_the_installed_callable_by_identity() -> None:
    session = FakeSession()
    harden_session(session)
    from workout_manager.garmin_fetch import HARDENED_ATTR, is_installed_by_us

    assert getattr(session, HARDENED_ATTR) is session.request
    assert is_installed_by_us(session.request) is True


def test_a_callable_forging_equality_does_not_pass_as_hardened() -> None:
    from workout_manager.garmin_fetch import is_installed_by_us

    class Forger:
        def __eq__(self, other: object) -> bool:
            return True

        def __hash__(self) -> int:
            return 0

        def __call__(self, *args: object, **kwargs: object) -> None:
            return None

    # Set membership would consult __eq__; the check must be an `is` comparison.
    assert is_installed_by_us(Forger()) is False


def test_a_forged_marker_does_not_pass_as_hardened() -> None:
    from workout_manager.garmin_fetch import HARDENED_ATTR, is_installed_by_us

    session = FakeSession()
    unprotected = session.request
    # Forge the informational handle the way an attacker or a careless edit could.
    setattr(session, HARDENED_ATTR, unprotected)
    assert is_installed_by_us(unprotected) is False
    assert harden_session(session) is True
    assert session.request is not unprotected
    with pytest.raises(UnofficialFetchError, match="allowed hosts"):
        session.request("GET", "https://evil.example.com/x")


def test_a_forged_token_exchange_marker_does_not_pass_either() -> None:
    from workout_manager.garmin_fetch import TOKEN_EXCHANGE_ATTR

    api = FakeApi()
    setattr(api, TOKEN_EXCHANGE_ATTR, api._http_post)
    harden_token_exchange(api)
    with pytest.raises(UnofficialFetchError, match="allowed hosts"):
        api._http_post("https://evil.example.com/token")


def test_the_token_exchange_enforces_rather_than_defaults_redirect_policy() -> None:
    api = FakeApi()
    harden_token_exchange(api)
    api._http_post("https://diauth.garmin.com/token", allow_redirects=True)
    assert api.posts[0][1]["allow_redirects"] is False


def test_hardened_session_overrides_a_larger_provider_timeout() -> None:
    session = FakeSession()
    assert harden_session(session) is True
    session.request("GET", "https://connectapi.garmin.com/x", timeout=600)
    session.request("GET", "https://connectapi.garmin.com/x", timeout=None)
    assert [call["timeout"] for call in session.calls] == [30.0, 30.0]
    assert all(call["allow_redirects"] is False for call in session.calls)
    assert all(call["stream"] is True for call in session.calls)


def test_hardened_session_rejects_foreign_hosts_and_plain_http() -> None:
    session = FakeSession()
    harden_session(session)
    with pytest.raises(UnofficialFetchError, match="allowed hosts"):
        session.request("GET", "https://evil.example.com/x")
    with pytest.raises(UnofficialFetchError, match="HTTPS"):
        session.request("GET", "http://connectapi.garmin.com/x")
    assert session.calls == []


def test_the_sso_and_mobile_hosts_are_allowed() -> None:
    # client.cs uses these on the JWT_WEB fallback and legacy refresh paths; refusing
    # them outright would make those calls fail silently inside the library.
    require_allowed_url("https://sso.garmin.com/sso/embed")
    require_allowed_url("https://mobile.integration.garmin.com/gcm/ios")


@pytest.mark.parametrize(
    "location",
    [
        "https://cdn.example.com/file.zip",  # off the allowlist entirely
        "https://connect.garmin.com/y",  # on the allowlist, but a different host
        "http://connectapi.garmin.com/y",  # same host, downgraded scheme
    ],
)
def test_a_cross_host_redirect_is_refused_and_never_requested(location: str) -> None:
    hop = redirect(location)
    session = FakeSession(hop, FakeResponse())
    harden_session(session)
    with pytest.raises(UnofficialFetchError, match="different host|refusing"):
        session.request("GET", "https://connectapi.garmin.com/x")
    # Only the first request was issued; the credentials were never replayed.
    assert len(session.calls) == 1
    assert hop.closed is True


def test_a_same_host_redirect_is_followed() -> None:
    hop = redirect("https://connectapi.garmin.com/y")
    final = FakeResponse(url="https://connectapi.garmin.com/y")
    session = FakeSession(hop, final)
    harden_session(session)
    assert session.request("GET", "https://connectapi.garmin.com/x") is final
    assert [call["url"] for call in session.calls] == [
        "https://connectapi.garmin.com/x",
        "https://connectapi.garmin.com/y",
    ]
    assert hop.closed is True


def test_an_endless_same_host_redirect_chain_is_refused() -> None:
    session = FakeSession(redirect("https://connectapi.garmin.com/loop"))
    harden_session(session)
    with pytest.raises(UnofficialFetchError, match="redirect chain"):
        session.request("GET", "https://connectapi.garmin.com/x")
    assert len(session.calls) == MAX_REDIRECT_HOPS + 1
    assert session.responses[0].closed is True


def test_an_oversized_response_is_refused_on_its_declared_length() -> None:
    oversized = FakeResponse(headers={"Content-Length": str(MAX_DOWNLOAD_BYTES + 1)})
    session = FakeSession(oversized)
    harden_session(session)
    with pytest.raises(UnofficialFetchError, match="size limit"):
        session.request("GET", "https://connectapi.garmin.com/x")
    assert oversized.closed is True
    assert oversized.chunks_read == 0


def test_an_oversized_undeclared_body_is_still_refused() -> None:
    session = FakeSession(FakeResponse(body=b"x" * 32))
    harden_session(session, max_bytes=8)
    with pytest.raises(UnofficialFetchError, match="size limit"):
        session.request("GET", "https://connectapi.garmin.com/x")


class FakeApi:
    def __init__(self, *, api_session: bool = True) -> None:
        self.client = self
        self.cs = FakeSession()
        self.posts: list[tuple[str, dict[str, object]]] = []
        if api_session:
            self._api_session = FakeSession()

    def _http_post(self, url: str, **kwargs: object) -> FakeResponse:
        self.posts.append((url, kwargs))
        return FakeResponse(url=url, body=b"{}")


def test_harden_client_covers_both_long_lived_sessions() -> None:
    api = FakeApi()
    assert harden_client(api) == 2
    reharden_after_login(api)


def test_harden_client_is_idempotent() -> None:
    api = FakeApi()
    assert harden_client(api) == 2
    assert harden_client(api) == 2


def test_harden_client_fails_closed_on_partial_application() -> None:
    with pytest.raises(UnofficialFetchError, match="session '_api_session' is missing"):
        harden_client(FakeApi(api_session=False))


def test_a_session_replaced_during_login_is_rehardened_not_rejected() -> None:
    # 0.3.16 swaps client.cs for a JWT_WEB fallback session; rejecting that would fail
    # a login that actually succeeded.
    api = FakeApi()
    harden_client(api)
    replacement = FakeSession()
    api.cs = replacement
    assert reharden_after_login(api) == 2
    replacement.request("GET", "https://connectapi.garmin.com/x")
    assert replacement.calls[0]["timeout"] == 30.0
    with pytest.raises(UnofficialFetchError, match="allowed hosts"):
        replacement.request("GET", "https://evil.example.com/x")


def test_a_session_removed_during_login_is_refused() -> None:
    api = FakeApi()
    harden_client(api)
    del api._api_session
    with pytest.raises(UnofficialFetchError, match="session '_api_session' is missing"):
        reharden_after_login(api)


def test_rehardening_does_not_double_wrap_an_intact_session() -> None:
    api = FakeApi()
    harden_client(api)
    installed = api.cs.request
    reharden_after_login(api)
    assert api.cs.request is installed


def test_the_di_token_exchange_is_wrapped_too() -> None:
    api = FakeApi()
    original = api._http_post
    assert harden_token_exchange(api) is True
    assert api._http_post is not original
    api._http_post("https://diauth.garmin.com/di-oauth2-service/oauth/token")
    _, kwargs = api.posts[0]
    assert kwargs["timeout"] == 30.0
    assert kwargs["allow_redirects"] is False


def test_the_di_token_exchange_refuses_other_hosts_and_redirects() -> None:
    api = FakeApi()
    harden_token_exchange(api)
    with pytest.raises(UnofficialFetchError, match="allowed hosts"):
        api._http_post("https://evil.example.com/token")

    class Redirecting(FakeApi):
        def _http_post(self, url: str, **kwargs: object) -> FakeResponse:
            return redirect("https://evil.example.com/token")

    other = Redirecting()
    harden_token_exchange(other)
    with pytest.raises(UnofficialFetchError, match="redirected"):
        other._http_post("https://diauth.garmin.com/token")


def test_a_missing_token_exchange_entry_point_is_refused() -> None:
    class MovedApi:
        client = object()

    with pytest.raises(UnofficialFetchError, match="_http_post"):
        harden_token_exchange(MovedApi())


def test_require_allowed_url_rejects_missing_urls() -> None:
    with pytest.raises(UnofficialFetchError, match="usable URL"):
        require_allowed_url(None)


# -------------------------------------------------------------------------- selection


def test_parse_summary_accepts_a_well_formed_entry() -> None:
    summary = parse_summary(entry(4242, "2026-09-10"))
    assert summary.activity_id == "4242"
    assert summary.start_date == date(2026, 9, 10)


@pytest.mark.parametrize(
    "value",
    [
        "not an object",
        {"startTimeLocal": "2026-09-10 07:00:00"},
        {"activityId": True, "startTimeLocal": "2026-09-10 07:00:00"},
        {"activityId": "12a", "startTimeLocal": "2026-09-10 07:00:00"},
        {"activityId": 0, "startTimeLocal": "2026-09-10 07:00:00"},
        {"activityId": 1, "startTimeLocal": ""},
        {"activityId": 1, "startTimeLocal": "10/09/2026"},
    ],
)
def test_parse_summary_rejects_untrusted_shapes(value: object) -> None:
    with pytest.raises(ValueError):
        parse_summary(value)


@pytest.mark.parametrize(
    ("start", "end", "limit"),
    [
        (date(2026, 9, 10), date(2026, 9, 1), 5),
        (date(2025, 1, 1), date(2026, 9, 1), 5),
        (date(2026, 9, 1), date(2026, 9, 10), 0),
        (date(2026, 9, 1), date(2026, 9, 10), MAX_ACTIVITIES + 1),
    ],
)
def test_validate_range_refuses_unbounded_requests(start: date, end: date, limit: int) -> None:
    with pytest.raises(ValueError):
        validate_range(start, end, limit)


def test_select_stops_at_the_first_older_activity(limiter: RateLimiter) -> None:
    source = FakeSource(
        [
            [entry(3, "2026-09-12"), entry(2, "2026-09-11")],
            [entry(1, "2026-09-01")],
            [entry(99, "2025-01-01")],
        ]
    )
    selection = select_activities(source, date(2026, 9, 10), date(2026, 9, 20), 50, limiter=limiter)
    assert [item.activity_id for item in selection.activities] == ["3", "2"]
    assert selection.pages == 2
    assert selection.complete is True


def test_select_stops_at_the_activity_limit(limiter: RateLimiter) -> None:
    source = FakeSource([[entry(index, "2026-09-12") for index in range(10, 20)]])
    selection = select_activities(source, date(2026, 9, 1), date(2026, 9, 20), 3, limiter=limiter)
    assert len(selection.activities) == 3
    assert any("activity limit" in note for note in selection.notes)


def test_select_skips_unusable_entries_without_aborting(limiter: RateLimiter) -> None:
    source = FakeSource([[{"activityId": None}, entry(7, "2026-09-12")], []])
    selection = select_activities(source, date(2026, 9, 1), date(2026, 9, 20), 5, limiter=limiter)
    assert [item.activity_id for item in selection.activities] == ["7"]
    assert selection.invalid == 1


def test_select_deduplicates_repeated_ids(limiter: RateLimiter) -> None:
    source = FakeSource([[entry(7, "2026-09-12"), entry(7, "2026-09-12")], []])
    selection = select_activities(source, date(2026, 9, 1), date(2026, 9, 20), 5, limiter=limiter)
    assert len(selection.activities) == 1


def test_select_reports_an_exhausted_page_budget(limiter: RateLimiter) -> None:
    pages = [[entry(index, "2026-09-12")] for index in range(1, MAX_LIST_PAGES + 5)]
    source = FakeSource(pages)
    selection = select_activities(source, date(2026, 9, 1), date(2026, 9, 20), 200, limiter=limiter)
    assert selection.pages == MAX_LIST_PAGES
    assert selection.complete is False
    assert any("page budget" in note for note in selection.notes)
    assert source.listed[-1] == ((MAX_LIST_PAGES - 1) * LIST_PAGE_SIZE, LIST_PAGE_SIZE)


def test_select_rejects_an_unsupported_listing_shape(limiter: RateLimiter) -> None:
    class BadSource(FakeSource):
        def list_activities(self, start: int, limit: int) -> object:  # type: ignore[override]
            return "nope"

    with pytest.raises(ValueError, match="unsupported shape"):
        select_activities(BadSource([]), date(2026, 9, 1), date(2026, 9, 2), 5, limiter=limiter)


def test_selection_defaults_are_empty() -> None:
    assert Selection().activities == () and Selection().notes == ()


# ------------------------------------------------------------------------- validation


def test_extract_accepts_a_raw_fit_and_a_zipped_fit() -> None:
    assert extract_original_fit(fit_bytes()) == fit_bytes()
    assert extract_original_fit(zipped(("a.fit", fit_bytes()))) == fit_bytes()


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"not a fit file at all",
        zipped(("a.txt", b"x")),
        zipped(("a.fit", fit_bytes()), ("b.fit", fit_bytes())),
        zipped(("a.fit", b"not a fit")),
    ],
)
def test_extract_rejects_unusable_downloads(payload: bytes) -> None:
    with pytest.raises(ValueError):
        extract_original_fit(payload)


def test_extract_rejects_a_crc_corrupt_fit() -> None:
    payload = bytearray(fit_bytes())
    payload[-1] ^= 0xFF  # Valid framing and length, broken file CRC.
    with pytest.raises((ValueError, FitParseError)):
        extract_original_fit(bytes(payload))


def test_crc_corrupt_download_is_never_recorded_as_success(
    tmp_path: Path, limiter: RateLimiter
) -> None:
    payload = bytearray(fit_bytes())
    payload[-1] ^= 0xFF
    source = FakeSource([[entry(11, "2026-09-12")], []], {"11": zipped(("a.fit", bytes(payload)))})
    output = tmp_path / "out"
    assert (
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
        == 1
    )
    assert manifest(output)["entries"]["11"]["status"] == "failed"
    assert not (output / "11.fit").exists()


def test_extract_rejects_an_oversized_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("workout_manager.garmin_fetch.MAX_DOWNLOAD_BYTES", 8)
    with pytest.raises(ValueError, match="limit"):
        extract_original_fit(fit_bytes())


def test_write_fit_is_atomic_and_owner_only(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "1.fit"
    digest = write_fit(fit_bytes(), target)
    assert target.read_bytes() == fit_bytes()
    assert len(digest) == 64
    assert os.stat(target).st_mode & 0o777 == 0o600
    assert not [path for path in target.parent.iterdir() if path.name.startswith(".download-")]


# ------------------------------------------------------------------------------ fetch


def test_fetch_writes_original_fit_and_a_resumable_manifest(
    tmp_path: Path, limiter: RateLimiter
) -> None:
    source = FakeSource([[entry(11, "2026-09-12"), entry(12, "2026-09-11")], []])
    output = tmp_path / "out"
    assert (
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=10,
            limiter=limiter,
        )
        == 0
    )
    assert (output / "11.fit").read_bytes() == fit_bytes()
    record = manifest(output)["entries"]["11"]
    assert record["status"] == "success"
    assert record["provider"] == "garmin-connect-unofficial"
    assert record["official"] is False
    assert record["activity_id"] == "11"
    assert len(record["sha256"]) == 64
    assert record["attempts"] == 1
    assert source.downloaded == ["11", "12"]


def test_fetch_resume_skips_verified_downloads(tmp_path: Path, limiter: RateLimiter) -> None:
    pages = [[entry(11, "2026-09-12")], []]
    output = tmp_path / "out"
    kwargs = {"start": date(2026, 9, 1), "end": date(2026, 9, 20), "limit": 5}
    fetch_activities(FakeSource(pages), output, limiter=limiter, **kwargs)
    again = FakeSource(pages)
    assert fetch_activities(again, output, limiter=limiter, **kwargs) == 0
    assert again.downloaded == []
    (output / "11.fit").write_bytes(b"tampered")
    third = FakeSource(pages)
    fetch_activities(third, output, limiter=limiter, overwrite=True, **kwargs)
    assert third.downloaded == ["11"]


def test_fetch_refuses_to_overwrite_without_the_flag(tmp_path: Path, limiter: RateLimiter) -> None:
    output = tmp_path / "out"
    output.mkdir()
    (output / "11.fit").write_bytes(b"existing")
    source = FakeSource([[entry(11, "2026-09-12")], []])
    assert (
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
        == 1
    )
    assert source.downloaded == []
    assert manifest(output)["entries"]["11"]["error"] == "FileExistsError"
    assert (output / "11.fit").read_bytes() == b"existing"


def test_fetch_isolates_a_single_bad_download(tmp_path: Path, limiter: RateLimiter) -> None:
    source = FakeSource(
        [[entry(11, "2026-09-12"), entry(12, "2026-09-11")], []],
        {"11": b"corrupt payload"},
    )
    output = tmp_path / "out"
    assert (
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
        == 1
    )
    entries = manifest(output)["entries"]
    assert entries["11"]["status"] == "failed"
    assert entries["12"]["status"] == "success"
    assert (output / "12.fit").is_file()
    assert not (output / "11.fit").exists()


class GarminConnectTooManyRequestsError(Exception):
    """Stands in for the optional library's 429; matched by class name, not by import."""


def test_fetch_stops_on_429_without_retrying(tmp_path: Path, limiter: RateLimiter) -> None:
    class Limited(GarminConnectTooManyRequestsError):
        response = type("R", (), {"headers": {"Retry-After": "120"}})()

    source = FakeSource(
        [[entry(11, "2026-09-12"), entry(12, "2026-09-11")], []],
        {"11": Limited("rate limited")},
    )
    output = tmp_path / "out"
    with pytest.raises(UnofficialFetchError, match="Retry-After: 120"):
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
    assert source.downloaded == ["11"]
    entries = manifest(output)["entries"]
    assert entries["11"]["error"] == "Limited"
    assert "12" not in entries


def test_fetch_with_no_matching_activities_writes_nothing(
    tmp_path: Path, limiter: RateLimiter
) -> None:
    output = tmp_path / "out"
    assert (
        fetch_activities(
            FakeSource([[]]),
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 2),
            limit=5,
            limiter=limiter,
        )
        == 0
    )
    assert not output.exists()


def test_rate_limiter_paces_requests() -> None:
    slept: list[float] = []
    ticks = iter([0.0, 0.0, 0.5, 0.5])
    pacer = RateLimiter(2.0, clock=lambda: next(ticks), sleep=slept.append)
    pacer.wait()
    pacer.wait()
    assert slept == [pytest.approx(1.5)]


@pytest.mark.parametrize("interval", [0.1, 0.0, -5.0, float("nan"), float("inf")])
def test_rate_limiter_refuses_an_unusable_interval(interval: float) -> None:
    # NaN compares false against every bound, so it would otherwise disable pacing.
    with pytest.raises(ValueError, match="finite"):
        RateLimiter(interval)


def test_cli_refuses_a_nan_min_interval(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sys

    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setitem(sys.modules, "garminconnect", None)
    with pytest.raises(SystemExit) as raised:
        main([*FETCH_ARGS, "--execute", "--min-interval", "nan"])
    assert raised.value.code == 2
    assert "finite" in capsys.readouterr().err


def test_rate_limit_detection_without_the_optional_library() -> None:
    assert is_rate_limited(GarminConnectTooManyRequestsError("x")) is True
    assert is_rate_limited(ValueError("x")) is False
    limited = ValueError("x")
    limited.response = type("R", (), {"status_code": 429})()  # type: ignore[attr-defined]
    assert is_rate_limited(limited) is True


def test_an_unexpected_provider_error_surfaces_redacted(
    tmp_path: Path, limiter: RateLimiter
) -> None:
    class Weird(Exception):
        pass

    secret = Weird("session cookie=JWT_WEB=abc123 for someone@example.com")
    source = FakeSource([[entry(11, "2026-09-12")], []], {"11": secret})
    output = tmp_path / "out"
    with pytest.raises(UnofficialFetchError) as raised:
        fetch_activities(
            source,
            output,
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
    message = str(raised.value)
    assert "Weird" in message
    assert "abc123" not in message
    assert "someone@example.com" not in message
    assert manifest(output)["entries"]["11"]["error"] == "Weird"


def test_an_aborted_download_carries_no_provider_context(
    tmp_path: Path, limiter: RateLimiter
) -> None:
    class ProviderBoom(Exception):
        pass

    class Raising(FakeSource):
        def download_original(self, activity_id: str) -> bytes:  # type: ignore[override]
            self.downloaded.append(activity_id)
            # Constructed inline: the only way to reach it afterwards would be through
            # the exception we raise, not through anything the caller stored.
            raise ProviderBoom("token=abc")

    source = Raising([[entry(11, "2026-09-12")], []])
    with pytest.raises(UnofficialFetchError) as raised:
        fetch_activities(
            source,
            tmp_path / "out",
            start=date(2026, 9, 1),
            end=date(2026, 9, 20),
            limit=5,
            limiter=limiter,
        )
    failure = raised.value
    assert failure.__context__ is None
    assert failure.__cause__ is None
    # Deep enough to reach source.payloads -> the original exception, if it survived.
    for item in reachable(failure, depth=8, frame_locals=True):
        assert not isinstance(item, ProviderBoom)


def test_a_listing_failure_is_redacted_too(limiter: RateLimiter) -> None:
    class Listing(FakeSource):
        def list_activities(self, start: int, limit: int) -> object:  # type: ignore[override]
            raise RuntimeError("password=hunter2 rejected for someone@example.com")

    with pytest.raises(UnofficialFetchError) as raised:
        select_activities(Listing([]), date(2026, 9, 1), date(2026, 9, 2), 5, limiter=limiter)
    message = str(raised.value)
    assert "listing activities" in message
    assert "hunter2" not in message
    assert "someone@example.com" not in message


def test_a_listing_429_is_handled_like_a_download_429(limiter: RateLimiter) -> None:
    class Limited(GarminConnectTooManyRequestsError):
        response = type("R", (), {"headers": {"Retry-After": "90"}})()

    class Listing(FakeSource):
        def list_activities(self, start: int, limit: int) -> object:  # type: ignore[override]
            raise Limited("slow down")

    with pytest.raises(UnofficialFetchError, match="Retry-After: 90"):
        select_activities(Listing([]), date(2026, 9, 1), date(2026, 9, 2), 5, limiter=limiter)


# --------------------------------------------------------------- optional extra guard


def test_missing_extra_reports_the_install_command(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys

    monkeypatch.setitem(sys.modules, "garminconnect", None)
    with pytest.raises(UnofficialFetchError) as raised:
        provider_library()
    message = str(raised.value)
    assert INSTALL_COMMAND in message
    assert "garmin" in message
    assert "convert" in message


def test_missing_extra_surfaces_through_the_cli(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sys

    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setitem(sys.modules, "garminconnect", None)
    with pytest.raises(SystemExit) as raised:
        main([*FETCH_ARGS, "--execute"])
    assert raised.value.code == 2
    assert INSTALL_COMMAND in capsys.readouterr().err


def test_local_conversion_does_not_need_the_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys

    monkeypatch.setitem(sys.modules, "garminconnect", None)
    with pytest.raises(SystemExit) as raised:
        main(["convert", "missing.fit", "--output-dir", "out"])
    # A missing input, not an ImportError: the local path never touches the library.
    assert raised.value.code == 2


def test_harden_client_error_names_the_library_and_version() -> None:
    class MovedApi:
        client = object()

    with pytest.raises(UnofficialFetchError, match="Refusing to run") as raised:
        harden_client(MovedApi())
    assert "garminconnect" in str(raised.value)


# ------------------------------------------------------------------------ credentials


def test_token_store_is_created_owner_only(tmp_path: Path) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    assert os.stat(store).st_mode & 0o777 == 0o700


def test_token_store_refuses_a_symlink(tmp_path: Path) -> None:
    (tmp_path / "real").mkdir()
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "real")
    with pytest.raises(UnofficialFetchError, match="symlink"):
        prepare_token_store(link)


def _refuse_chmod(*args: object, **kwargs: object) -> None:
    raise OSError("read-only filesystem")


def _refuse_unlink(*args: object, **kwargs: object) -> None:
    raise OSError("read-only filesystem")


def test_the_token_file_is_created_owner_only_before_login(tmp_path: Path) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    reserve_token_file(store)
    target = token_file(store)
    assert target.is_file()
    assert os.stat(target).st_mode & 0o777 == 0o600
    # Idempotent: a second run keeps the existing file.
    target.write_text("{}")
    reserve_token_file(store)
    assert target.read_text() == "{}"


def test_a_pre_existing_loose_token_file_is_caught_before_login(tmp_path: Path) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    target = token_file(store)
    target.write_text("{}")
    os.chmod(target, 0o644)
    # Creation-time modes never fix an existing file, so this must be checked, not assumed.
    reserve_token_file(store)
    assert os.stat(target).st_mode & 0o777 == 0o600


def test_token_permission_check_passes_for_owner_only_files(tmp_path: Path) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    target = token_file(store)
    target.write_text("{}")
    os.chmod(target, 0o600)
    verify_token_permissions(store)
    assert target.exists()


def test_a_symlink_in_the_token_store_is_refused_not_skipped(tmp_path: Path) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    (tmp_path / "elsewhere.json").write_text("{}")
    (store / "garmin_tokens.json").symlink_to(tmp_path / "elsewhere.json")
    with pytest.raises(UnofficialFetchError, match="symlink"):
        verify_token_permissions(store)


def test_a_loose_token_file_is_removed_and_the_run_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    target = token_file(store)
    target.write_text("{}")
    os.chmod(target, 0o644)
    monkeypatch.setattr("workout_manager.garmin_fetch.os.chmod", _refuse_chmod)
    with pytest.raises(UnofficialFetchError, match="It was removed"):
        verify_token_permissions(store)
    assert not target.exists()


def test_an_unremovable_loose_token_file_is_reported_truthfully(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = prepare_token_store(tmp_path / "tokens")
    target = token_file(store)
    target.write_text("{}")
    os.chmod(target, 0o644)
    monkeypatch.setattr("workout_manager.garmin_fetch.os.chmod", _refuse_chmod)
    monkeypatch.setattr(Path, "unlink", _refuse_unlink)
    with pytest.raises(UnofficialFetchError) as raised:
        verify_token_permissions(store)
    message = str(raised.value)
    assert "could NOT be removed" in message
    assert "It was removed." not in message
    assert target.exists()


SECRET_PASSWORD = "Tr0ubador-and-3"
SECRET_EMAIL = "someone@example.com"


class FakeGarmin:
    """Echoes the password in its failure, the way a careless provider error can."""

    ActivityDownloadFormat = type("Formats", (), {"ORIGINAL": "original"})

    def __init__(self, email: str, password: str, prompt_mfa: object = None) -> None:
        self.username = email
        self.password = password
        self.client = self
        self.cs = FakeSession()
        self._api_session = FakeSession()
        self.logged_in = False

    def _http_post(self, url: str, **kwargs: object) -> FakeResponse:
        return FakeResponse(url=url, body=b"{}")

    def login(self, tokenstore: str | None = None) -> None:
        raise RuntimeError(f"rejected {self.password} for {self.username}")

    def get_activities(self, start: int, limit: int) -> list[object]:
        return []

    def download_activity(self, activity_id: str, fmt: object) -> bytes:
        return b""


def _install_fake_library(monkeypatch: pytest.MonkeyPatch, factory: object) -> None:
    monkeypatch.setattr(
        "workout_manager.garmin_fetch.provider_library",
        lambda: types.SimpleNamespace(Garmin=factory),
    )


def assert_secret_absent(items: list[object], secret: str) -> None:
    """Fail if the secret value is reachable anywhere in `items`.

    Containment, not equality, and the same rule for `str` and `bytes` -- the two used
    to disagree, which is how a longer string embedding the secret would have slipped
    through. Also looks one level into containers and into function defaults.
    """
    encoded = secret.encode()

    def check(value: object) -> None:
        if isinstance(value, str):
            assert secret not in value, f"secret reachable inside {value[:40]!r}..."
        elif isinstance(value, (bytes, bytearray)):
            assert encoded not in bytes(value)

    for item in items:
        check(item)
        if isinstance(item, (list, tuple, set, frozenset)):
            for element in item:
                check(element)
        for name in ("password", "username", "email"):
            value = peek(item, name)
            check(value)
            assert value != secret
        for name in ("__defaults__", "__kwdefaults__"):
            container = peek(item, name)
            values = container.values() if isinstance(container, dict) else (container or ())
            for element in values:
                check(element)


def traceback_frame_locals(error: BaseException) -> list[dict[str, object]]:
    frames: list[dict[str, object]] = []
    traceback = error.__traceback__
    while isinstance(traceback, types.TracebackType):
        frames.append(dict(traceback.tb_frame.f_locals))
        traceback = traceback.tb_next
    return frames


def test_a_login_failure_leaks_no_credentials_in_message_or_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    _install_fake_library(monkeypatch, FakeGarmin)
    with pytest.raises(UnofficialFetchError) as raised:
        login_read_only_source(tmp_path / "tokens")
    failure = raised.value
    assert SECRET_PASSWORD not in str(failure)
    assert SECRET_EMAIL not in str(failure)
    assert failure.__context__ is None
    for locals_ in traceback_frame_locals(failure):
        assert SECRET_PASSWORD not in repr(locals_)
    # Walk the exception's own retention paths (frame locals, __context__, __cause__)
    # and look for the SECRET VALUE itself, not merely a `.password` attribute.
    # `module_globals` is deliberately off: this test module's own globals hold the
    # constant, so following them could never support a negative claim.
    assert_secret_absent(reachable(failure, depth=8, frame_locals=True), SECRET_PASSWORD)


def test_an_interrupt_during_login_clears_the_credential_locals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Interrupting(FakeGarmin):
        def login(self, tokenstore: str | None = None) -> None:
            raise KeyboardInterrupt

    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    _install_fake_library(monkeypatch, Interrupting)
    with pytest.raises(KeyboardInterrupt) as raised:
        login_read_only_source(tmp_path / "tokens")
    for locals_ in traceback_frame_locals(raised.value):
        assert SECRET_PASSWORD not in repr(locals_)
    assert_secret_absent(reachable(raised.value, depth=8, frame_locals=True), SECRET_PASSWORD)


def test_an_interrupt_logs_a_sanitized_location(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class Interrupting(FakeGarmin):
        def login(self, tokenstore: str | None = None) -> None:
            raise KeyboardInterrupt

    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    _install_fake_library(monkeypatch, Interrupting)
    with (
        caplog.at_level("WARNING", logger="workout_manager.garmin_fetch"),
        pytest.raises(KeyboardInterrupt),
    ):
        login_read_only_source(tmp_path / "tokens")
    located = [text for text in caplog.messages if "Login stopped at" in text]
    assert located, caplog.messages
    # File, line and function only: the hang site stays diagnosable, locals do not leak.
    assert "test_garmin_fetch.py:" in located[0]
    assert SECRET_PASSWORD not in located[0]


def test_a_successful_login_still_verifies_the_token_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Working(FakeGarmin):
        def login(self, tokenstore: str | None = None) -> None:
            self.logged_in = True
            self.password = None  # The real library clears it on success.

    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    _install_fake_library(monkeypatch, Working)
    store = tmp_path / "tokens"
    source = login_read_only_source(store)
    try:
        assert source.list_activities(0, 20) == []
        assert os.stat(token_file(store)).st_mode & 0o777 == 0o600
    finally:
        source.release()


def test_our_login_path_does_not_retry_after_a_429(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Our side attempts login once.

    The library's OWN retry across impersonations and strategies after a 429 happens
    inside `Garmin.login()` and is not exercised here; see the progress document.
    """
    attempts: list[int] = []

    class Limited(FakeGarmin):
        def login(self, tokenstore: str | None = None) -> None:
            attempts.append(1)
            raise GarminConnectTooManyRequestsError("429 from Garmin")

    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    _install_fake_library(monkeypatch, Limited)
    with pytest.raises(UnofficialFetchError, match="login failed"):
        login_read_only_source(tmp_path / "tokens")
    assert attempts == [1]


def test_a_symlinked_parent_in_the_token_path_is_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    # The final component is a plain directory; only the parent is a symlink.
    with pytest.raises(UnofficialFetchError, match="symlink"):
        prepare_token_store(link / "tokens")


def test_credentials_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", SECRET_PASSWORD)
    assert read_credentials() == (SECRET_EMAIL, SECRET_PASSWORD)


def test_credentials_fall_back_to_prompts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GARMIN_EMAIL", raising=False)
    monkeypatch.delenv("GARMIN_PASSWORD", raising=False)
    assert read_credentials(lambda _: "a@b.co", lambda _: "long-enough-secret") == (
        "a@b.co",
        "long-enough-secret",
    )


def test_a_password_too_short_to_scrub_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GARMIN_EMAIL", SECRET_EMAIL)
    monkeypatch.setenv("GARMIN_PASSWORD", "ab")
    with pytest.raises(UnofficialFetchError, match="at least 8 characters"):
        read_credentials()


def test_missing_credentials_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GARMIN_EMAIL", raising=False)
    monkeypatch.delenv("GARMIN_PASSWORD", raising=False)
    with pytest.raises(UnofficialFetchError, match="credentials are required"):
        read_credentials(lambda _: "", lambda _: "")


# ------------------------------------------------------------------------------- CLI


FETCH_ARGS = [
    "fetch",
    "--output-dir",
    "out",
    "--start",
    "2026-09-01",
    "--end",
    "2026-09-10",
    "--limit",
    "5",
]


def test_fetch_requires_the_execute_opt_in(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(FETCH_ARGS)
    assert raised.value.code == 2
    message = capsys.readouterr().err
    assert "NOT the official Garmin integration" in message
    assert "--execute" in message


def test_fetch_is_disabled_in_ci(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CI", "1")
    with pytest.raises(SystemExit) as raised:
        main([*FETCH_ARGS, "--execute"])
    assert raised.value.code == 2
    assert "disabled in CI" in capsys.readouterr().err


def test_fetch_help_states_the_unofficial_path(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        main(["fetch", "--help"])
    text = capsys.readouterr().out
    assert "UNOFFICIAL" in text
    assert "NOT the official Garmin integration" in text
    assert "Terms of Service" in text


def test_fetch_rejects_a_malformed_date(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(
            ["fetch", "--output-dir", "out", "--start", "2026/09/01", "--end", "x", "--limit", "1"]
        )
    assert raised.value.code == 2


def test_bounds_are_rejected_before_any_credential_work(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sys

    monkeypatch.delenv("CI", raising=False)
    # The optional extra is unavailable: reaching login would report the install
    # command instead, so a range error here proves validation ran first.
    monkeypatch.setitem(sys.modules, "garminconnect", None)
    with pytest.raises(SystemExit) as raised:
        main(
            [
                "fetch",
                "--output-dir",
                "out",
                "--start",
                "2026-09-01",
                "--end",
                "2026-09-10",
                "--limit",
                "9999",
                "--execute",
            ]
        )
    assert raised.value.code == 2
    message = capsys.readouterr().err
    assert "Activity limit must be between" in message
    assert INSTALL_COMMAND not in message


@pytest.mark.parametrize("flag", ["--password", "--email", "--token", "--tok"])
def test_fetch_takes_no_credential_arguments(
    flag: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Run from a scratch directory: a rejected flag must not create anything at all.
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as raised:
        main([*FETCH_ARGS, "--execute", flag, "x"])
    assert raised.value.code == 2
    # `--token` must be rejected outright, never abbreviated into `--token-store`.
    assert "unrecognized arguments" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == []


def test_notice_names_every_required_risk() -> None:
    for phrase in (
        "UNOFFICIAL",
        "NOT the official Garmin integration",
        "undocumented",
        "your own account only",
        "Terms of Service",
        "rate limit or act against the account",
        "breaks whenever Garmin changes",
        "GCM_ANDROID_DARK",
        "curl_cffi",
        "Read-only",
    ):
        assert phrase in UNOFFICIAL_NOTICE
