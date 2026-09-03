from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

import pytest

from einvoicekit import (
    DEFAULT_BASE_URL,
    FacturxError,
    Finding,
    ValidationResult,
    __version__,
    validate,
)

VALID = {
    "valid": True,
    "syntax": "cii",
    "profile": "urn:cen.eu:en16931:2017",
    "errors": [],
    "warnings": [],
}

INVALID = {
    "valid": False,
    "syntax": "ubl",
    "profile": None,
    "errors": [
        {
            "rule": "BR-CO-15",
            "message": "[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...",
            "path": "/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]",
        }
    ],
    "warnings": [],
}

BYTES = b"<Invoice/>"


class Transport:
    """A fake opener: records the request, answers with one canned response."""

    def __init__(self, status: int, body: object) -> None:
        self.status = status
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.requests: list[urllib.request.Request] = []
        self.timeouts: list[float] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
        self.requests.append(request)
        self.timeouts.append(timeout)
        return self.status, self.body


def test_posts_the_bytes_and_returns_the_verdict_untouched(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)
    transport = Transport(200, INVALID)
    result = validate(BYTES, opener=transport)

    assert result == ValidationResult(
        valid=False,
        syntax="ubl",
        profile=None,
        errors=[
            Finding(
                rule="BR-CO-15",
                message="[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...",
                path="/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]",
            )
        ],
        warnings=[],
    )
    assert result.raw == INVALID
    request = transport.requests[0]
    assert request.full_url == f"{DEFAULT_BASE_URL}/v1/validate"
    assert request.get_method() == "POST"
    assert request.data == BYTES
    assert request.get_header("Content-type") == "application/octet-stream"
    assert request.get_header("User-agent") == f"facturx-py/{__version__}"
    assert request.get_header("Authorization") is None
    assert transport.timeouts == [30.0]


def test_explicit_key_wins_and_environment_is_the_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EINVOICEKIT_API_KEY", "eik_live_env")
    from_env = Transport(200, VALID)
    validate(BYTES, opener=from_env)
    assert from_env.requests[0].get_header("Authorization") == "Bearer eik_live_env"

    explicit = Transport(200, VALID)
    validate(BYTES, opener=explicit, api_key="eik_live_given")
    assert explicit.requests[0].get_header("Authorization") == "Bearer eik_live_given"


def test_empty_environment_key_means_no_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EINVOICEKIT_API_KEY", "")
    transport = Transport(200, VALID)
    validate(BYTES, opener=transport)
    assert transport.requests[0].get_header("Authorization") is None


def test_target_and_base_url_and_timeout(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)
    transport = Transport(200, {**VALID, "target": "france"})
    result = validate(
        BYTES, opener=transport, target="france", base_url="http://localhost:8787/", timeout=5
    )
    assert transport.requests[0].full_url == "http://localhost:8787/v1/validate?target=france"
    assert transport.timeouts == [5]
    assert result.target == "france"


def test_invalid_is_a_return_never_a_raise(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)
    assert validate(BYTES, opener=Transport(200, INVALID)).valid is False


@pytest.mark.parametrize(
    ("status", "body", "code", "message"),
    [
        (400, {"error": "empty body"}, "bad_request", "empty body"),
        (
            401,
            {"error": "unknown or disabled API key"},
            "unauthorized",
            "unknown or disabled API key",
        ),
        (
            413,
            {"error": "document too large (max 5 MB)"},
            "too_large",
            "document too large (max 5 MB)",
        ),
        (
            422,
            {"error": "this PDF carries no embedded XML invoice"},
            "unreadable_document",
            "this PDF carries no embedded XML invoice",
        ),
        (
            429,
            {"error": "rate_limited", "message": "too many keyless calls; slow down"},
            "rate_limited",
            "too many keyless calls; slow down",
        ),
        (
            429,
            {"error": "monthly quota exceeded", "upgrade": "https://einvoicekit.com/pricing"},
            "quota_exceeded",
            "monthly quota exceeded",
        ),
        (500, {"error": "generation_failed"}, "service_unavailable", "generation_failed"),
        (
            502,
            {"error": "validation service unavailable"},
            "service_unavailable",
            "validation service unavailable",
        ),
        (
            503,
            b"not json at all",
            "service_unavailable",
            "api.einvoicekit.com answered 503 with no explanation",
        ),
    ],
)
def test_maps_a_refusal_to_a_facturx_error(
    monkeypatch: pytest.MonkeyPatch, status: int, body: object, code: str, message: str
):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)
    with pytest.raises(FacturxError) as raised:
        validate(BYTES, opener=Transport(status, body))
    assert raised.value.code == code
    assert raised.value.status == status
    assert str(raised.value) == message


def test_a_spent_pool_carries_resets_at_and_upgrade(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)
    body = {
        "error": "pool_exhausted",
        "message": "10 free validations a day per IP address without a key. "
        "A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool",
        "resetsAt": "2026-09-04T00:00:00.000Z",
        "upgrade": "https://einvoicekit.com/get-started?from=api-pool",
    }
    with pytest.raises(FacturxError) as raised:
        validate(BYTES, opener=Transport(429, body))
    assert raised.value.code == "pool_exhausted"
    assert raised.value.resets_at == "2026-09-04T00:00:00.000Z"
    assert raised.value.upgrade == "https://einvoicekit.com/get-started?from=api-pool"
    assert "A free key gives 100 a month" in str(raised.value)


def test_no_response_at_all_is_a_network_error(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EINVOICEKIT_API_KEY", raising=False)

    def down(request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
        raise OSError("connection refused")

    with pytest.raises(FacturxError) as raised:
        validate(BYTES, opener=down)
    assert raised.value.code == "network"
    assert raised.value.status == 0
    assert str(raised.value) == "could not reach api.einvoicekit.com: connection refused"


def test_the_default_transport_turns_a_refusal_into_status_and_body(
    monkeypatch: pytest.MonkeyPatch,
):
    """urllib raises on 4xx/5xx; the default opener must hand back the body, not the exception."""
    import io
    import urllib.error

    from einvoicekit import _urllib_opener

    def urlopen(request: urllib.request.Request, timeout: float):
        raise urllib.error.HTTPError(
            request.full_url, 422, "Unprocessable", {}, io.BytesIO(b'{"error":"nope"}')
        )

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    status, body = _urllib_opener(urllib.request.Request("https://x/v1/validate"), 1.0)
    assert (status, body) == (422, b'{"error":"nope"}')


def test_version_is_the_one_pyproject_publishes():
    # A regex rather than tomllib: that module only exists from 3.11, and the
    # package claims 3.10.
    pyproject = (Path(__file__).parents[1] / "pyproject.toml").read_text()
    match = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE)
    assert match is not None
    assert __version__ == match.group(1)
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__)
