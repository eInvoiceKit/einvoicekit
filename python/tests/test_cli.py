from __future__ import annotations

import json
import urllib.request

import pytest

from einvoicekit import __version__
from einvoicekit.cli import USAGE, ArgError, main, parse_args

VALID = {
    "valid": True,
    "syntax": "cii",
    "profile": "urn:cen.eu:en16931:2017",
    "errors": [],
    "warnings": [],
}

INVALID = {
    "valid": False,
    "syntax": "cii",
    "profile": "urn:cen.eu:en16931:2017",
    "errors": [
        {
            "rule": "BR-CO-15",
            "message": "[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...",
            "path": "/Q{urn:x}CrossIndustryInvoice[1]",
        }
    ],
    "warnings": [{"rule": "BR-FR-15", "message": "Le SIREN ...", "path": None}],
}

POOL_SPENT = {
    "error": "pool_exhausted",
    "message": "10 free validations a day per IP address without a key. "
    "A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool",
    "resetsAt": "2026-09-04T00:00:00.000Z",
    "upgrade": "https://einvoicekit.com/get-started?from=api-pool",
}


class Answers:
    """One canned answer per call, in order; the last one repeats."""

    def __init__(self, *answers: tuple[int, object]) -> None:
        self.answers = answers
        self.seen: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
        self.seen.append(request)
        status, body = self.answers[min(len(self.seen) - 1, len(self.answers) - 1)]
        return status, json.dumps(body).encode()


class Run:
    def __init__(self, files: dict[str, bytes] | None = None, env: dict[str, str] | None = None):
        self.files = files or {}
        self.env = env or {}
        self.out: list[str] = []
        self.err: list[str] = []

    def read_file(self, path: str) -> bytes:
        if path not in self.files:
            raise FileNotFoundError(2, "No such file or directory", path)
        return self.files[path]

    def __call__(self, argv: list[str], opener: Answers) -> int:
        return main(
            argv,
            stdout=self.out.append,
            stderr=self.err.append,
            read_file=self.read_file,
            env=self.env,
            opener=opener,
            format_instant=lambda iso: f"<{iso}>",
        )


def test_parse_args_collects_files_and_options_in_any_order():
    args = parse_args(["a.xml", "--target", "france", "b.pdf", "--json", "--key", "k"])
    assert args.files == ["a.xml", "b.pdf"]
    assert args.target == "france"
    assert args.json is True
    assert args.key == "k"
    assert args.warnings is False


@pytest.mark.parametrize(
    ("argv", "error"),
    [
        (["--target"], "--target needs a value"),
        (["--target", "de"], "unknown target 'de'; supported: france"),
        (["--key", "--json"], "--key needs a value"),
        (["--wat"], "unknown option --wat"),
    ],
)
def test_parse_args_rejects(argv: list[str], error: str):
    with pytest.raises(ArgError, match=error.replace("(", r"\(")):
        parse_args(argv)


def test_a_valid_file_one_line_exit_0():
    run = Run({"invoice.xml": b"<Invoice/>"})
    assert run(["invoice.xml"], Answers((200, VALID))) == 0
    assert run.out == ["invoice.xml  VALID  (cii, urn:cen.eu:en16931:2017)"]
    assert run.err == []


def test_an_invalid_file_the_findings_the_warning_count_exit_1():
    run = Run({"invoice.pdf": b"%PDF"})
    assert run(["invoice.pdf"], Answers((200, INVALID))) == 1
    assert run.out == [
        "invoice.pdf  INVALID  (cii, urn:cen.eu:en16931:2017)",
        "  BR-CO-15  /Q{urn:x}CrossIndustryInvoice[1]",
        "            [BR-CO-15]-Invoice total amount with VAT (BT-112) = ...",
        "  1 warning (show with --warnings)",
    ]


def test_warnings_flag_lists_the_warnings():
    run = Run({"invoice.pdf": b"%PDF"})
    run(["invoice.pdf", "--warnings"], Answers((200, INVALID)))
    assert run.out[-2:] == ["  BR-FR-15  warning", "            Le SIREN ..."]


def test_json_prints_the_raw_verdict_for_one_file_an_array_for_several():
    single = Run({"a.xml": b"<a/>"})
    assert single(["a.xml", "--json"], Answers((200, VALID))) == 0
    assert json.loads("\n".join(single.out)) == VALID

    several = Run({"a.xml": b"<a/>", "b.xml": b"<b/>"})
    assert several(["a.xml", "b.xml", "--json"], Answers((200, VALID), (200, INVALID))) == 1
    assert json.loads("\n".join(several.out)) == [VALID, INVALID]


def test_the_key_travels_from_flag_or_environment_and_target_reaches_the_url():
    via_flag = Answers((200, VALID))
    Run({"a.xml": b"<a/>"})(["a.xml", "--key", "eik_live_flag", "--target", "france"], via_flag)
    assert via_flag.seen[0].get_header("Authorization") == "Bearer eik_live_flag"
    assert via_flag.seen[0].full_url == "https://api.einvoicekit.com/v1/validate?target=france"

    via_env = Answers((200, VALID))
    Run({"a.xml": b"<a/>"}, {"EINVOICEKIT_API_KEY": "eik_live_env"})(["a.xml"], via_env)
    assert via_env.seen[0].get_header("Authorization") == "Bearer eik_live_env"

    keyless = Answers((200, VALID))
    Run({"a.xml": b"<a/>"}, {"EINVOICEKIT_API_KEY": ""})(["a.xml"], keyless)
    assert keyless.seen[0].get_header("Authorization") is None


def test_base_url_points_the_call_elsewhere():
    answers = Answers((200, VALID))
    Run({"a.xml": b"<a/>"})(["a.xml", "--base-url", "http://localhost:8787"], answers)
    assert answers.seen[0].full_url == "http://localhost:8787/v1/validate"


def test_a_spent_pool_reset_time_and_free_key_once_remaining_files_skipped_exit_2():
    answers = Answers((429, POOL_SPENT))
    run = Run({"a.xml": b"<a/>", "b.xml": b"<b/>"})
    assert run(["a.xml", "b.xml"], answers) == 2
    assert run.out == []
    assert run.err == [
        "a.xml  ERROR  pool_exhausted: 10 free validations a day per IP address without a key. "
        "A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool",
        "  the free pool resets at <2026-09-04T00:00:00.000Z>",
        "  a free key gives 100 validations a month, no card: "
        "https://einvoicekit.com/get-started?from=api-pool",
    ]
    assert len(answers.seen) == 1


def test_a_spent_monthly_quota_prints_the_upgrade_door_and_stops_exit_2():
    answers = Answers(
        (429, {"error": "monthly quota exceeded", "upgrade": "https://einvoicekit.com/pricing"})
    )
    run = Run({"a.xml": b"<a/>", "b.xml": b"<b/>"}, {"EINVOICEKIT_API_KEY": "eik_live_k"})
    assert run(["a.xml", "b.xml"], answers) == 2
    assert run.err == [
        "a.xml  ERROR  quota_exceeded: monthly quota exceeded",
        "  more allowance: https://einvoicekit.com/pricing",
    ]
    assert len(answers.seen) == 1


def test_json_keeps_one_slot_per_file_when_the_pool_stops_the_run_early():
    run = Run({"a.xml": b"<a/>", "b.xml": b"<b/>", "c.xml": b"<c/>"})
    code = run(["a.xml", "b.xml", "c.xml", "--json"], Answers((200, VALID), (429, POOL_SPENT)))
    assert code == 2
    assert json.loads("\n".join(run.out)) == [VALID, None, None]


def test_a_document_the_api_cannot_assess_other_files_still_run_exit_2():
    run = Run({"plain.pdf": b"%PDF", "ok.xml": b"<a/>"})
    answers = Answers((422, {"error": "this PDF carries no embedded XML invoice"}), (200, VALID))
    assert run(["plain.pdf", "ok.xml"], answers) == 2
    assert run.err == [
        "plain.pdf  ERROR  unreadable_document: this PDF carries no embedded XML invoice"
    ]
    assert run.out == ["ok.xml  VALID  (cii, urn:cen.eu:en16931:2017)"]


def test_an_error_outranks_an_invalid_verdict():
    run = Run({"a.xml": b"<a/>", "b.xml": b"<b/>"})
    answers = Answers((200, INVALID), (502, {"error": "validation service unavailable"}))
    assert run(["a.xml", "b.xml"], answers) == 2


def test_a_missing_file_is_reported_without_touching_the_network():
    answers = Answers((200, VALID))
    run = Run()
    assert run(["nope.xml"], answers) == 2
    assert run.err[0].startswith("nope.xml  ERROR  cannot read file: ")
    assert answers.seen == []


def test_no_files_help_and_version():
    none = Run()
    assert none([], Answers()) == 2
    assert none.err == [USAGE]

    helped = Run()
    assert helped(["--help"], Answers()) == 0
    assert helped.out == [USAGE]

    version = Run()
    assert version(["--version"], Answers()) == 0
    assert version.out == [__version__]


def test_a_bad_option_prints_the_reason_and_the_usage_exit_2():
    run = Run()
    assert run(["a.xml", "--target", "de"], Answers()) == 2
    assert run.err == ["facturx: unknown target 'de'; supported: france", USAGE]
