# @einvoicekit/einvoicekit

Validate any EN 16931 e-invoice (Factur-X, ZUGFeRD, XRechnung, UBL or CII)
against the full official rule set, from one command or one function call.
No Java, no Saxon, no rule files to download.

```sh
npx @einvoicekit/einvoicekit invoice.pdf
```

```
invoice.pdf  INVALID  (cii, urn:cen.eu:en16931:2017)
  BR-CO-15  /Q{urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100}CrossIndustryInvoice[1]
            [BR-CO-15]-Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110).
```

Exit code 0 means every file is valid, 1 means at least one is not, 2 means
at least one could not be validated. That is the whole integration for a CI
pipeline.

## What this package is, honestly

It is a thin client. Each call sends the invoice over HTTPS to
[einvoicekit](https://einvoicekit.com)'s validator, which processes it in
memory to produce the verdict and drops it; nothing is stored. What you get
in exchange is the real thing: the official rule sets, EN 16931, XRechnung
3.0.2, Factur-X 1.09 and Peppol BIS 3.0, run by the reference validator, not
a hand-written subset of them.

Two promises follow from that:

- **A verdict is a verdict.** `valid: false` lists every broken rule with its
  official id, the official message and the XPath of the element at fault.
- **No silent green.** If the service cannot be reached, you get an error,
  never `valid: true`. The package has no fallback and no retry; a retry
  policy is yours to write.

## Install

```sh
npm install @einvoicekit/einvoicekit
```

Node 20 or later. No dependencies.

Renamed in 0.2.0: the package was `@einvoicekit/facturx`, the command
`facturx` and the error class `FacturxError`. Nothing else changed.

## Use it from code

```js
import { readFile } from 'node:fs/promises';
import { validate, EinvoicekitError } from '@einvoicekit/einvoicekit';

const result = await validate(await readFile('invoice.pdf'));

result.valid; // true or false
result.errors; // [{ rule, message, path }, ...]
result.warnings; // same shape, never change the verdict
result.syntax; // 'cii' or 'ubl'
result.profile; // the profile URN the document declares, or null
```

`validate(bytes, options?)` takes a `Uint8Array`, an `ArrayBuffer` or a
`Blob`: an XML invoice, or a Factur-X / ZUGFeRD PDF, which is unwrapped
first so its embedded XML is what gets validated. The result is the API's
JSON, field for field.

Options:

| option    | meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `apiKey`  | an einvoicekit key; defaults to `EINVOICEKIT_API_KEY`; with neither, the free pool is used |
| `target`  | `'france'` adds the BR-FR rules French platforms apply, opt-in per call                    |
| `baseUrl` | the API to call, default `https://api.einvoicekit.com`                                     |
| `fetch`   | your own transport, default the global `fetch`                                             |
| `signal`  | an `AbortSignal`                                                                           |

## Use it from the command line

```sh
npx @einvoicekit/einvoicekit invoice.pdf
npx @einvoicekit/einvoicekit a.xml b.pdf --target france
npx @einvoicekit/einvoicekit invoice.pdf --json
npx @einvoicekit/einvoicekit invoice.pdf --warnings
EINVOICEKIT_API_KEY=eik_live_... npx @einvoicekit/einvoicekit invoice.pdf
```

`--json` prints the API's verdict as JSON on stdout, an array when several
files are given, and nothing else there; refusals go to stderr. `--help`
lists every option.

## Limits, plainly

- **Without a key**: 10 validations a day per IP address, shared with the
  free tools on einvoicekit.com. The eleventh call is refused with the time
  the pool resets (midnight UTC) and a link to the free key.
- **With a free key**: 100 validations a month, plus 20 generated invoices
  in an allowance of their own. No card.
  [Get one](https://einvoicekit.com/get-started?from=facturx-npm) by signing
  in with GitHub.
- **Pro**: 29 € a month for 1,000 pooled credits, a validation spending one.
  [Details](https://einvoicekit.com/pricing).

Only a delivered verdict counts. A document the API cannot assess, a refused
call and an error on the service's side cost nothing.

## Errors

Everything that is not a verdict throws an `EinvoicekitError` with a stable
`code`:

| code                  | HTTP | meaning                                                                         |
| --------------------- | ---- | ------------------------------------------------------------------------------- |
| `bad_request`         | 400  | the request itself was wrong (bad target, empty body)                           |
| `unauthorized`        | 401  | a key was sent and it is unknown, malformed or disabled                         |
| `too_large`           | 413  | over 5 MB                                                                       |
| `unreadable_document` | 422  | the API read the file and cannot assess it: a plain PDF, an unsupported profile |
| `pool_exhausted`      | 429  | the free daily pool is spent; `resetsAt` and `upgrade` say when and where       |
| `rate_limited`        | 429  | too many calls in a short window; slow down                                     |
| `quota_exceeded`      | 429  | the key's monthly allowance is spent; `upgrade` says where to get more          |
| `service_unavailable` | 5xx  | the service answered but could not validate                                     |
| `network`             | 0    | no response at all                                                              |

A wrong key is never a fallback into the free pool: send no key at all to
use it.

## Scope

Validation checks the invoice XML: the schema and every business rule of the
profile the document declares. It does not check the PDF container's own
PDF/A conformance; that check runs on the generation side of the API.

Full API documentation, the French rules and the generation endpoint:
[einvoicekit.com/docs](https://einvoicekit.com/docs/).

## Licence

MIT.
