"""The ``einvoicekit`` command: files in, verdicts out, exit code 0 / 1 / 2."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import EinvoicekitError, Opener, ValidationResult, __version__, validate

USAGE = """Usage: einvoicekit <file>... [options]

Checks each file (an XML invoice or a Factur-X / ZUGFeRD PDF) against the
full official EN 16931 rule set and prints every broken rule.

Options:
  --target france   also apply the French BR-FR rules
  --warnings        list warnings too (they never change the verdict)
  --json            print the API's JSON verdict per file, an array for several
                    files, and nothing else on stdout; refusals go to stderr
  --key <key>       an einvoicekit API key; default: $EINVOICEKIT_API_KEY;
                    with neither, the free pool: 10 a day per IP address
  --base-url <url>  the API to call (default https://api.einvoicekit.com)
  --version         print the version
  --help            print this text

Exit code: 0 every file valid, 1 at least one invalid, 2 at least one file
could not be validated (unreadable, pool spent, no network)."""


@dataclass
class Args:
    files: list[str] = field(default_factory=list)
    target: str | None = None
    warnings: bool = False
    json: bool = False
    key: str | None = None
    base_url: str | None = None
    help: bool = False
    version: bool = False


class ArgError(Exception):
    pass


def parse_args(argv: list[str]) -> Args:
    args = Args()
    i = 0
    while i < len(argv):
        arg = argv[i]

        def value_after(flag: str = arg) -> str:
            nonlocal i
            if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                raise ArgError(f"{flag} needs a value")
            i += 1
            return argv[i]

        if arg in ("--help", "-h"):
            args.help = True
        elif arg in ("--version", "-v"):
            args.version = True
        elif arg == "--json":
            args.json = True
        elif arg == "--warnings":
            args.warnings = True
        elif arg == "--target":
            value = value_after()
            if value != "france":
                raise ArgError(f"unknown target '{value}'; supported: france")
            args.target = value
        elif arg == "--key":
            args.key = value_after()
        elif arg == "--base-url":
            args.base_url = value_after()
        elif arg.startswith("-"):
            raise ArgError(f"unknown option {arg}")
        else:
            args.files.append(arg)
        i += 1
    return args


def _describe(result: ValidationResult) -> str:
    parts = [result.syntax]
    if result.profile:
        parts.append(result.profile)
    return ", ".join(parts)


def render_verdict(file: str, result: ValidationResult, show_warnings: bool) -> list[str]:
    verdict = "VALID" if result.valid else "INVALID"
    lines = [f"{file}  {verdict}  ({_describe(result)})"]
    findings = result.errors + result.warnings if show_warnings else result.errors
    width = max((len(f.rule) for f in findings), default=0)
    for f in result.errors:
        lines.append(f"  {f.rule.ljust(width)}  {f.path or ''}".rstrip())
        lines.append(f"  {' ' * width}  {f.message}")
    if show_warnings:
        for f in result.warnings:
            lines.append(f"  {f.rule.ljust(width)}  warning  {f.path or ''}".rstrip())
            lines.append(f"  {' ' * width}  {f.message}")
    elif result.warnings:
        n = len(result.warnings)
        lines.append(f"  {n} warning{'' if n == 1 else 's'} (show with --warnings)")
    return lines


def _default_format_instant(iso: str) -> str:
    try:
        instant = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    return instant.astimezone().strftime("%Y-%m-%d %H:%M %Z")


def main(
    argv: list[str],
    *,
    stdout: Callable[[str], None],
    stderr: Callable[[str], None],
    read_file: Callable[[str], bytes],
    env: Mapping[str, str],
    opener: Opener | None = None,
    format_instant: Callable[[str], str] | None = None,
) -> int:
    """Run the command. Returns the exit code; never raises for a user-facing outcome."""
    try:
        args = parse_args(argv)
    except ArgError as bad:
        stderr(f"einvoicekit: {bad}")
        stderr(USAGE)
        return 2
    if args.help:
        stdout(USAGE)
        return 0
    if args.version:
        stdout(__version__)
        return 0
    if not args.files:
        stderr(USAGE)
        return 2

    fmt = format_instant or _default_format_instant
    # An empty --key (a script passing an unset variable) is "no key", the
    # same as the JS command: it must fall through to the pool, never send
    # an empty bearer token that the API refuses as malformed.
    api_key = args.key or env.get("EINVOICEKIT_API_KEY") or None
    any_invalid = False
    any_error = False
    pool_note_shown = False
    json_out: list[dict[str, Any] | None] = []

    for file in args.files:
        try:
            data = read_file(file)
        except OSError as cause:
            stderr(f"{file}  ERROR  cannot read file: {cause}")
            any_error = True
            json_out.append(None)
            continue

        try:
            result = validate(
                data,
                api_key=api_key,
                target="france" if args.target == "france" else None,
                base_url=args.base_url,
                opener=opener,
            )
        except EinvoicekitError as refused:
            any_error = True
            json_out.append(None)
            stderr(f"{file}  ERROR  {refused.code}: {refused}")
            wall = refused.code in ("pool_exhausted", "quota_exceeded")
            if wall and not pool_note_shown:
                pool_note_shown = True
                if refused.resets_at:
                    stderr(f"  the free pool resets at {fmt(refused.resets_at)}")
                if refused.upgrade:
                    stderr(
                        f"  a free key gives 100 validations a month, no card: {refused.upgrade}"
                        if refused.code == "pool_exhausted"
                        else f"  more allowance: {refused.upgrade}"
                    )
            # Every other file would hit the same wall; stop burning attempts.
            if wall:
                break
            continue

        if not result.valid:
            any_invalid = True
        if args.json:
            json_out.append(result.raw)
        else:
            for line in render_verdict(file, result, args.warnings):
                stdout(line)

    if args.json:
        # Files skipped after a spent allowance still get their slot, so the
        # array always lines up with the arguments.
        while len(json_out) < len(args.files):
            json_out.append(None)
        payload: Any = json_out[0] if len(args.files) == 1 else json_out
        stdout(json.dumps(payload, indent=2, ensure_ascii=False))

    if any_error:
        return 2
    if any_invalid:
        return 1
    return 0


def run() -> None:
    """The console-script entry point."""

    def read_file(path: str) -> bytes:
        with open(path, "rb") as handle:
            return handle.read()

    code = main(
        sys.argv[1:],
        stdout=lambda line: print(line),
        stderr=lambda line: print(line, file=sys.stderr),
        read_file=read_file,
        env=dict(os.environ),
    )
    sys.exit(code)
