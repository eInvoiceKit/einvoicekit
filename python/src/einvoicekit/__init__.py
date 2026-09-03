"""Check an e-invoice against the full official EN 16931 rule set.

A thin client for einvoicekit's ``POST /v1/validate``. The bytes are sent
over HTTPS, processed in memory to produce the verdict and dropped. What
comes back is the API's own JSON, field for field. If the service cannot be
reached you get :class:`FacturxError`, never ``valid=True``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = [
    "DEFAULT_BASE_URL",
    "FacturxError",
    "Finding",
    "ValidationResult",
    "__version__",
    "validate",
]

# Written down once here and pinned to pyproject.toml by a test, so the
# User-Agent the API logs (``facturx-py/<version>``) cannot drift from what
# PyPI publishes.
__version__ = "0.1.0"

DEFAULT_BASE_URL = "https://api.einvoicekit.com"

ErrorCode = Literal[
    "bad_request",
    "unauthorized",
    "too_large",
    "unreadable_document",
    "pool_exhausted",
    "rate_limited",
    "quota_exceeded",
    "service_unavailable",
    "network",
]


@dataclass(frozen=True)
class Finding:
    """One failed or advisory rule, exactly as the API reports it."""

    #: The rule id: an EN 16931 ``BR-*`` id, a BR-FR id, or ``XSD`` for a schema error.
    rule: str
    #: The official rule message, naming the business terms (BT-x) involved.
    message: str
    #: XPath of the offending element, or None when the finding has no location.
    path: str | None


@dataclass(frozen=True)
class ValidationResult:
    """The verdict. Every field is the API's, never reshaped."""

    valid: bool
    #: ``ubl`` or ``cii``.
    syntax: str
    #: The profile URN the document declares, or None when it declares none.
    profile: str | None
    errors: list[Finding]
    #: Same shape as ``errors``; warnings do not affect ``valid``.
    warnings: list[Finding]
    #: Echoed only when the call opted into a country layer.
    target: str | None = None
    #: The response as the API sent it, for anything the fields above do not carry.
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ValidationResult:
        def findings(key: str) -> list[Finding]:
            return [
                Finding(rule=str(f["rule"]), message=str(f["message"]), path=f.get("path"))
                for f in data.get(key, [])
            ]

        return cls(
            valid=bool(data["valid"]),
            syntax=str(data["syntax"]),
            profile=data.get("profile"),
            errors=findings("errors"),
            warnings=findings("warnings"),
            target=data.get("target"),
            raw=data,
        )


class FacturxError(Exception):
    """Raised for every outcome that is not a verdict.

    ``valid=False`` is never one of these: an invalid invoice is a result,
    not an error. ``code`` is stable:

    - ``bad_request`` (400): the request itself was wrong.
    - ``unauthorized`` (401): a key was sent and it is unknown, malformed or disabled.
    - ``too_large`` (413): over the 5 MB limit.
    - ``unreadable_document`` (422): the API read the file and cannot assess it.
    - ``pool_exhausted`` (429, no key): the free daily runs of this IP address are
      spent; ``resets_at`` and ``upgrade`` are set.
    - ``rate_limited`` (429): too many calls in a short window.
    - ``quota_exceeded`` (429, with a key): the monthly allowance is spent;
      ``upgrade`` is set.
    - ``service_unavailable`` (5xx): the service answered but could not validate.
    - ``network`` (status 0): no response at all.
    """

    def __init__(
        self,
        message: str,
        *,
        code: ErrorCode,
        status: int,
        resets_at: str | None = None,
        upgrade: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.status = status
        self.resets_at = resets_at
        self.upgrade = upgrade


#: The transport: takes a prepared request and a timeout, returns
#: ``(status, body_bytes)``. Injectable so tests never touch the network.
Opener = Callable[[urllib.request.Request, float], tuple[int, bytes]]


def _urllib_opener(request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as refused:
        # A refusal is an answer: status and body, same as a success.
        return refused.code, refused.read()


def _code_for(status: int, body: dict[str, Any]) -> ErrorCode:
    if status == 400:
        return "bad_request"
    if status == 401:
        return "unauthorized"
    if status == 413:
        return "too_large"
    if status == 422:
        return "unreadable_document"
    if status == 429:
        if body.get("error") == "pool_exhausted":
            return "pool_exhausted"
        if body.get("error") == "rate_limited":
            return "rate_limited"
        return "quota_exceeded"
    return "service_unavailable"


def _env_api_key() -> str | None:
    key = os.environ.get("EINVOICEKIT_API_KEY")
    return key if key else None


def validate(
    data: bytes,
    *,
    api_key: str | None = None,
    target: Literal["france"] | None = None,
    base_url: str | None = None,
    timeout: float = 30.0,
    opener: Opener | None = None,
) -> ValidationResult:
    """Validate one invoice: an XML file, or a Factur-X / ZUGFeRD PDF.

    A PDF is unwrapped first and its embedded XML is what gets validated;
    the PDF container's own PDF/A conformance is not checked.

    :param api_key: an einvoicekit key. Defaults to ``EINVOICEKIT_API_KEY``.
        With neither, the call runs on the free anonymous pool: 10 a day per
        IP address.
    :param target: ``"france"`` adds the BR-FR rules. Opt-in per call.
    :param base_url: where the API lives; the escape hatch for proxies and tests.
    :param timeout: seconds to wait for the answer.
    :param opener: the transport, for tests.
    :raises FacturxError: for everything that is not a verdict. No retries:
        a retry policy is yours, and a hidden one would burn the free pool
        silently.
    """
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base}/v1/validate"
    if target is not None:
        url += f"?target={target}"

    headers = {
        "Content-Type": "application/octet-stream",
        "User-Agent": f"facturx-py/{__version__}",
    }
    key = api_key if api_key is not None else _env_api_key()
    if key is not None:
        headers["Authorization"] = f"Bearer {key}"

    request = urllib.request.Request(url, data=bytes(data), headers=headers, method="POST")
    send = opener or _urllib_opener
    try:
        status, body = send(request, timeout)
    except Exception as cause:  # noqa: BLE001 - every transport failure is one outcome
        host = urllib.request.urlparse(url).netloc
        raise FacturxError(f"could not reach {host}: {cause}", code="network", status=0) from cause

    if 200 <= status < 300:
        return ValidationResult.from_json(json.loads(body))

    try:
        parsed: Any = json.loads(body)
    except ValueError:
        parsed = None
    refusal: dict[str, Any] = parsed if isinstance(parsed, dict) else {}
    host = urllib.request.urlparse(url).netloc
    message = (
        refusal.get("message")
        or refusal.get("error")
        or f"{host} answered {status} with no explanation"
    )
    raise FacturxError(
        str(message),
        code=_code_for(status, refusal),
        status=status,
        resets_at=refusal.get("resetsAt"),
        upgrade=refusal.get("upgrade"),
    )
