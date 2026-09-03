# facturx

Check a Factur-X, ZUGFeRD, XRechnung, UBL or CII invoice against the full
official EN 16931 rule set, from one command or one function call. No Java,
no Saxon, no rule files to download.

Two packages, one behaviour:

- **npm**: [`js/`](js/README.md), `npx facturx invoice.pdf`
- **PyPI**: [`python/`](python/README.md), `pipx run facturx invoice.pdf`

Both are thin, honest clients for [einvoicekit](https://einvoicekit.com)'s
validator: the invoice is sent over HTTPS, processed in memory to produce
the verdict and dropped. If the service cannot be reached you get an error,
never a green verdict. Each package's README says exactly what it does,
what it costs and where its limits are.

MIT licence.
