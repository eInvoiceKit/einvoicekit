/**
 * The package version, written down once here and pinned to package.json by
 * a test, so the User-Agent the API logs (`facturx-js/<version>`) cannot
 * drift from what npm publishes. It lives in this file rather than its own
 * so the emitted `index.d.ts` imports nothing and can be copied verbatim to
 * `index.d.cts` for the CommonJS consumers.
 */
export const VERSION = '0.1.0';

/** One failed or advisory rule, exactly as the API reports it. */
export interface Finding {
  /** The rule id: an EN 16931 `BR-*` id, a BR-FR id, or `XSD` for a schema error. */
  rule: string;
  /** The official rule message, naming the business terms (BT-x) involved. */
  message: string;
  /** XPath of the offending element, or null when the finding has no location. */
  path: string | null;
}

/** The verdict. This is the API's JSON, field for field, never reshaped. */
export interface ValidationResult {
  valid: boolean;
  /** `ubl` or `cii`. */
  syntax: string;
  /** The profile URN the document declares, or null when it declares none. */
  profile: string | null;
  /** Echoed only when the call opted into a country layer. */
  target?: 'france';
  errors: Finding[];
  /** Same shape as `errors`; warnings do not affect `valid`. */
  warnings: Finding[];
}

/**
 * Why a call produced no verdict. `valid: false` is never one of these: an
 * invalid invoice is a result, not an error.
 */
export type FacturxErrorCode =
  /** 400: the request itself was wrong (bad target, missing multipart field, empty body). */
  | 'bad_request'
  /** 401: an Authorization header was sent and the key is unknown, malformed or disabled. */
  | 'unauthorized'
  /** 413: over the 5 MB limit. */
  | 'too_large'
  /** 422: the API read the file and cannot assess it (a plain PDF, an unsupported profile, unreadable bytes). */
  | 'unreadable_document'
  /** 429 without a key: this IP address has used its free daily runs. `resetsAt` and `upgrade` are set. */
  | 'pool_exhausted'
  /** 429: too many calls in a short window; slow down and retry. */
  | 'rate_limited'
  /** 429 with a key: the account's monthly allowance is spent. `upgrade` is set. */
  | 'quota_exceeded'
  /** 5xx: the service answered but could not validate. Nothing was charged. */
  | 'service_unavailable'
  /** No response at all: DNS, TLS, timeout, abort. */
  | 'network';

export interface FacturxErrorDetails {
  code: FacturxErrorCode;
  /** HTTP status of the refusal, or 0 when no response arrived. */
  status: number;
  /** ISO 8601 instant at which the free pool resets (pool_exhausted only). */
  resetsAt?: string;
  /** Where more allowance can be had (pool_exhausted and quota_exceeded). */
  upgrade?: string;
}

/**
 * Thrown for every outcome that is not a verdict. The service never answers
 * a green verdict it did not compute: when it cannot be reached, you get
 * this error, not `valid: true`.
 */
export class FacturxError extends Error {
  readonly code: FacturxErrorCode;
  readonly status: number;
  readonly resetsAt: string | undefined;
  readonly upgrade: string | undefined;

  constructor(message: string, details: FacturxErrorDetails) {
    super(message);
    this.name = 'FacturxError';
    this.code = details.code;
    this.status = details.status;
    this.resetsAt = details.resetsAt;
    this.upgrade = details.upgrade;
  }
}

export interface ValidateOptions {
  /**
   * An einvoicekit API key (`eik_live_...`). Defaults to the
   * `EINVOICEKIT_API_KEY` environment variable. With neither, the call runs
   * on the free anonymous pool: 10 validations a day per IP address.
   */
  apiKey?: string;
  /** `'france'` adds the BR-FR rules French platforms apply. Opt-in per call. */
  target?: 'france';
  /** Where the API lives. The escape hatch for proxies and tests. */
  baseUrl?: string;
  /** The transport. Defaults to the global `fetch` (Node 20 and later). */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const DEFAULT_BASE_URL = 'https://api.einvoicekit.com';

/** The bytes of one invoice: an XML file, or a Factur-X / ZUGFeRD PDF. */
export type InvoiceInput = Uint8Array | ArrayBuffer | Blob;

function toBlob(input: InvoiceInput): Blob {
  if (input instanceof Blob) return input;
  // A fresh copy: a view over a shared or resizable buffer is not a valid
  // Blob part in every runtime, and the copy is the size of one invoice.
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  return new Blob([Uint8Array.from(bytes)]);
}

function envApiKey(): string | undefined {
  // The library also runs where `process` does not exist (a Worker, a
  // browser bundle); the default is only ever read when it does.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const key = env?.['EINVOICEKIT_API_KEY'];
  return key && key.length > 0 ? key : undefined;
}

interface RefusalBody {
  error?: string;
  message?: string;
  resetsAt?: string;
  upgrade?: string;
}

async function readRefusal(response: Response): Promise<RefusalBody> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === 'object' ? (body as RefusalBody) : {};
  } catch {
    return {};
  }
}

function codeFor(status: number, body: RefusalBody): FacturxErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 413) return 'too_large';
  if (status === 422) return 'unreadable_document';
  if (status === 429) {
    if (body.error === 'pool_exhausted') return 'pool_exhausted';
    if (body.error === 'rate_limited') return 'rate_limited';
    return 'quota_exceeded';
  }
  return 'service_unavailable';
}

/**
 * Validates one invoice against the full official EN 16931 rule set
 * (EN 16931, XRechnung 3.0.2, Factur-X 1.09, Peppol BIS 3.0) and, with
 * `target: 'france'`, the BR-FR rules.
 *
 * The bytes are sent over HTTPS to einvoicekit's validator, processed in
 * memory to produce the verdict and dropped. What comes back is the API's
 * own JSON. A PDF is unwrapped first and its embedded XML is what gets
 * validated; the PDF container's own PDF/A conformance is not checked.
 *
 * Resolves with the verdict, `valid` true or false. Rejects with a
 * `FacturxError` for everything else: a document the API cannot assess, a
 * spent allowance, a refused key, or a service that could not be reached.
 * No retries: a retry policy is yours, and a hidden one would burn the free
 * pool silently.
 */
export async function validate(
  input: InvoiceInput,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/v1/validate`);
  if (options.target !== undefined) url.searchParams.set('target', options.target);

  const apiKey = options.apiKey ?? envApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'User-Agent': `facturx-js/${VERSION}`,
  };
  if (apiKey !== undefined) headers['Authorization'] = `Bearer ${apiKey}`;

  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new FacturxError('no fetch available: pass options.fetch or run on Node 20 or later', {
      code: 'network',
      status: 0,
    });
  }

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers,
      body: toBlob(input),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new FacturxError(`could not reach ${url.host}: ${reason}`, {
      code: 'network',
      status: 0,
    });
  }

  if (response.ok) {
    return (await response.json()) as ValidationResult;
  }

  const body = await readRefusal(response);
  const code = codeFor(response.status, body);
  const text =
    body.message ?? body.error ?? `${url.host} answered ${response.status} with no explanation`;
  throw new FacturxError(text, {
    code,
    status: response.status,
    ...(body.resetsAt !== undefined ? { resetsAt: body.resetsAt } : {}),
    ...(body.upgrade !== undefined ? { upgrade: body.upgrade } : {}),
  });
}
