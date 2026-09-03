import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASE_URL,
  FacturxError,
  validate,
  VERSION,
  type ValidationResult,
} from '../src/index.js';

const VALID: ValidationResult = {
  valid: true,
  syntax: 'cii',
  profile: 'urn:cen.eu:en16931:2017',
  errors: [],
  warnings: [],
};

const INVALID: ValidationResult = {
  valid: false,
  syntax: 'ubl',
  profile: null,
  errors: [
    {
      rule: 'BR-CO-15',
      message: '[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...',
      path: '/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]',
    },
  ],
  warnings: [],
};

/** A fake transport that records the request and answers with one canned response. */
function transport(status: number, body: unknown, headers?: Record<string, string>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const bytes = new TextEncoder().encode('<Invoice/>');

describe('validate', () => {
  test('posts the bytes to /v1/validate and returns the verdict untouched', async () => {
    const { fetch, calls } = transport(200, INVALID);
    const result = await validate(bytes, { fetch });
    expect(result).toEqual(INVALID);
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/validate`);
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers['User-Agent']).toBe(`facturx-js/${VERSION}`);
    expect(init.body).toBeInstanceOf(Blob);
    expect(await (init.body as Blob).text()).toBe('<Invoice/>');
  });

  test('sends no Authorization header when there is no key anywhere', async () => {
    const saved = process.env['EINVOICEKIT_API_KEY'];
    delete process.env['EINVOICEKIT_API_KEY'];
    try {
      const { fetch, calls } = transport(200, VALID);
      await validate(bytes, { fetch });
      const headers = (calls[0]?.init as { headers: Record<string, string> }).headers;
      expect('Authorization' in headers).toBe(false);
    } finally {
      if (saved !== undefined) process.env['EINVOICEKIT_API_KEY'] = saved;
    }
  });

  test('an explicit key wins over the environment, and the environment is the default', async () => {
    const saved = process.env['EINVOICEKIT_API_KEY'];
    process.env['EINVOICEKIT_API_KEY'] = 'eik_live_env';
    try {
      const fromEnv = transport(200, VALID);
      await validate(bytes, { fetch: fromEnv.fetch });
      expect(
        (fromEnv.calls[0]?.init as { headers: Record<string, string> }).headers['Authorization'],
      ).toBe('Bearer eik_live_env');

      const explicit = transport(200, VALID);
      await validate(bytes, { fetch: explicit.fetch, apiKey: 'eik_live_given' });
      expect(
        (explicit.calls[0]?.init as { headers: Record<string, string> }).headers['Authorization'],
      ).toBe('Bearer eik_live_given');
    } finally {
      if (saved === undefined) delete process.env['EINVOICEKIT_API_KEY'];
      else process.env['EINVOICEKIT_API_KEY'] = saved;
    }
  });

  test('target=france goes on the query string, and baseUrl replaces the host', async () => {
    const { fetch, calls } = transport(200, { ...VALID, target: 'france' });
    const result = await validate(bytes, {
      fetch,
      target: 'france',
      baseUrl: 'http://localhost:8787/',
    });
    expect(calls[0]?.url).toBe('http://localhost:8787/v1/validate?target=france');
    expect(result.target).toBe('france');
  });

  test.each([
    [Uint8Array.from(bytes), 'a Uint8Array'],
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'an ArrayBuffer'],
    [new Blob([bytes]), 'a Blob'],
  ])('accepts %s', async (input: Uint8Array | ArrayBuffer | Blob, _label: string) => {
    const { fetch, calls } = transport(200, VALID);
    await validate(input as Uint8Array | ArrayBuffer | Blob, { fetch });
    expect(await ((calls[0]?.init as { body: Blob }).body as Blob).text()).toBe('<Invoice/>');
  });

  test('valid: false is a return, never a throw', async () => {
    const { fetch } = transport(200, INVALID);
    await expect(validate(bytes, { fetch })).resolves.toMatchObject({ valid: false });
  });

  test.each([
    [400, { error: 'empty body' }, 'bad_request', 'empty body'],
    [401, { error: 'unknown or disabled API key' }, 'unauthorized', 'unknown or disabled API key'],
    [413, { error: 'document too large (max 5 MB)' }, 'too_large', 'document too large (max 5 MB)'],
    [
      422,
      { error: 'this PDF carries no embedded XML invoice' },
      'unreadable_document',
      'this PDF carries no embedded XML invoice',
    ],
    [
      429,
      { error: 'rate_limited', message: 'too many keyless calls; slow down' },
      'rate_limited',
      'too many keyless calls; slow down',
    ],
    [
      429,
      { error: 'monthly quota exceeded', upgrade: 'https://einvoicekit.com/pricing' },
      'quota_exceeded',
      'monthly quota exceeded',
    ],
    [500, { error: 'generation_failed' }, 'service_unavailable', 'generation_failed'],
    [
      502,
      { error: 'validation service unavailable' },
      'service_unavailable',
      'validation service unavailable',
    ],
    [
      503,
      'not json at all',
      'service_unavailable',
      'api.einvoicekit.com answered 503 with no explanation',
    ],
  ])('maps a %i refusal to a FacturxError', async (status, body, code, message) => {
    const { fetch } = transport(status, body);
    const error = await validate(bytes, { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacturxError);
    const fx = error as FacturxError;
    expect(fx.code).toBe(code);
    expect(fx.status).toBe(status);
    expect(fx.message).toBe(message);
    expect(fx.name).toBe('FacturxError');
  });

  test('a spent pool carries resetsAt and upgrade', async () => {
    const { fetch } = transport(429, {
      error: 'pool_exhausted',
      message:
        '10 free validations a day per IP address without a key. A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool',
      resetsAt: '2026-09-04T00:00:00.000Z',
      upgrade: 'https://einvoicekit.com/get-started?from=api-pool',
    });
    const error = (await validate(bytes, { fetch }).catch((e: unknown) => e)) as FacturxError;
    expect(error.code).toBe('pool_exhausted');
    expect(error.resetsAt).toBe('2026-09-04T00:00:00.000Z');
    expect(error.upgrade).toBe('https://einvoicekit.com/get-started?from=api-pool');
    expect(error.message).toContain('A free key gives 100 a month');
  });

  test('a quota refusal keeps the upgrade door and has no resetsAt', async () => {
    const { fetch } = transport(429, {
      error: 'monthly quota exceeded',
      upgrade: 'https://einvoicekit.com/pricing',
    });
    const error = (await validate(bytes, { fetch }).catch((e: unknown) => e)) as FacturxError;
    expect(error.code).toBe('quota_exceeded');
    expect(error.upgrade).toBe('https://einvoicekit.com/pricing');
    expect(error.resetsAt).toBeUndefined();
  });

  test('no response at all is a network error, never a verdict', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const error = (await validate(bytes, { fetch }).catch((e: unknown) => e)) as FacturxError;
    expect(error).toBeInstanceOf(FacturxError);
    expect(error.code).toBe('network');
    expect(error.status).toBe(0);
    expect(error.message).toBe('could not reach api.einvoicekit.com: fetch failed');
  });

  test('an abort signal is passed through to the transport', async () => {
    const { fetch, calls } = transport(200, VALID);
    const controller = new AbortController();
    await validate(bytes, { fetch, signal: controller.signal });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});

describe('the version', () => {
  test('is the one package.json publishes', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
