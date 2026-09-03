import { describe, expect, test, vi } from 'vitest';
import { main, parseArgs, USAGE, type CliIo } from '../src/cli.js';
import { VERSION, type ValidationResult } from '../src/index.js';

const VALID: ValidationResult = {
  valid: true,
  syntax: 'cii',
  profile: 'urn:cen.eu:en16931:2017',
  errors: [],
  warnings: [],
};

const INVALID: ValidationResult = {
  valid: false,
  syntax: 'cii',
  profile: 'urn:cen.eu:en16931:2017',
  errors: [
    {
      rule: 'BR-CO-15',
      message: '[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...',
      path: '/Q{urn:x}CrossIndustryInvoice[1]',
    },
  ],
  warnings: [{ rule: 'BR-FR-15', message: 'Le SIREN ...', path: null }],
};

/** One canned answer per call, in order; the last one repeats. */
function fakeFetch(answers: { status: number; body: unknown }[]) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)] as {
      status: number;
      body: unknown;
    };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

function io(fetch: typeof globalThis.fetch, files: Record<string, string> = {}, env = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return new TextEncoder().encode(content);
    },
    env,
    fetch,
    formatInstant: (iso) => `<${iso}>`,
  };
  return { cli, out, err };
}

describe('parseArgs', () => {
  test('collects files and options in any order', () => {
    expect(parseArgs(['a.xml', '--target', 'france', 'b.pdf', '--json', '--key', 'k'])).toEqual({
      files: ['a.xml', 'b.pdf'],
      target: 'france',
      warnings: false,
      json: true,
      key: 'k',
      help: false,
      version: false,
    });
  });

  test.each([
    [['--target'], '--target needs a value'],
    [['--target', 'de'], "unknown target 'de'; supported: france"],
    [['--key', '--json'], '--key needs a value'],
    [['--wat'], 'unknown option --wat'],
  ])('rejects %j', (argv, error) => {
    expect(parseArgs(argv)).toEqual({ error });
  });
});

describe('main', () => {
  test('a valid file: one line, exit 0', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: VALID }]);
    const { cli, out, err } = io(fetch, { 'invoice.xml': '<Invoice/>' });
    expect(await main(['invoice.xml'], cli)).toBe(0);
    expect(out).toEqual(['invoice.xml  VALID  (cii, urn:cen.eu:en16931:2017)']);
    expect(err).toEqual([]);
  });

  test('an invalid file: the findings, the warning count, exit 1', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: INVALID }]);
    const { cli, out } = io(fetch, { 'invoice.pdf': '%PDF' });
    expect(await main(['invoice.pdf'], cli)).toBe(1);
    expect(out).toEqual([
      'invoice.pdf  INVALID  (cii, urn:cen.eu:en16931:2017)',
      '  BR-CO-15  /Q{urn:x}CrossIndustryInvoice[1]',
      '            [BR-CO-15]-Invoice total amount with VAT (BT-112) = ...',
      '  1 warning (show with --warnings)',
    ]);
  });

  test('--warnings lists the warnings instead of counting them', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: INVALID }]);
    const { cli, out } = io(fetch, { 'invoice.pdf': '%PDF' });
    await main(['invoice.pdf', '--warnings'], cli);
    expect(out.slice(-2)).toEqual(['  BR-FR-15  warning', '            Le SIREN ...']);
  });

  test('--json prints the raw verdict for one file, an array for several', async () => {
    const one = fakeFetch([{ status: 200, body: VALID }]);
    const single = io(one.fetch, { 'a.xml': '<a/>' });
    expect(await main(['a.xml', '--json'], single.cli)).toBe(0);
    expect(JSON.parse(single.out.join('\n'))).toEqual(VALID);

    const two = fakeFetch([
      { status: 200, body: VALID },
      { status: 200, body: INVALID },
    ]);
    const several = io(two.fetch, { 'a.xml': '<a/>', 'b.xml': '<b/>' });
    expect(await main(['a.xml', 'b.xml', '--json'], several.cli)).toBe(1);
    expect(JSON.parse(several.out.join('\n'))).toEqual([VALID, INVALID]);
  });

  test('the key travels from --key or the environment, and --target reaches the URL', async () => {
    const viaFlag = fakeFetch([{ status: 200, body: VALID }]);
    await main(
      ['a.xml', '--key', 'eik_live_flag', '--target', 'france'],
      io(viaFlag.fetch, { 'a.xml': '<a/>' }).cli,
    );
    expect(viaFlag.seen[0]?.headers['Authorization']).toBe('Bearer eik_live_flag');
    expect(viaFlag.seen[0]?.url).toBe('https://api.einvoicekit.com/v1/validate?target=france');

    const viaEnv = fakeFetch([{ status: 200, body: VALID }]);
    await main(
      ['a.xml'],
      io(viaEnv.fetch, { 'a.xml': '<a/>' }, { EINVOICEKIT_API_KEY: 'eik_live_env' }).cli,
    );
    expect(viaEnv.seen[0]?.headers['Authorization']).toBe('Bearer eik_live_env');

    const keyless = fakeFetch([{ status: 200, body: VALID }]);
    await main(['a.xml'], io(keyless.fetch, { 'a.xml': '<a/>' }).cli);
    expect(keyless.seen[0]?.headers['Authorization']).toBeUndefined();

    // `--key "$UNSET_VAR"` is a real shape; it must not send an empty token.
    const emptyFlag = fakeFetch([{ status: 200, body: VALID }]);
    await main(['a.xml', '--key', ''], io(emptyFlag.fetch, { 'a.xml': '<a/>' }).cli);
    expect(emptyFlag.seen[0]?.headers['Authorization']).toBeUndefined();
  });

  test('--base-url points the call elsewhere', async () => {
    const { fetch, seen } = fakeFetch([{ status: 200, body: VALID }]);
    await main(
      ['a.xml', '--base-url', 'http://localhost:8787'],
      io(fetch, { 'a.xml': '<a/>' }).cli,
    );
    expect(seen[0]?.url).toBe('http://localhost:8787/v1/validate');
  });

  test('a spent pool: the reset time and the free key once, remaining files skipped, exit 2', async () => {
    const { fetch, seen } = fakeFetch([
      {
        status: 429,
        body: {
          error: 'pool_exhausted',
          message:
            '10 free validations a day per IP address without a key. A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool',
          resetsAt: '2026-09-04T00:00:00.000Z',
          upgrade: 'https://einvoicekit.com/get-started?from=api-pool',
        },
      },
    ]);
    const { cli, out, err } = io(fetch, { 'a.xml': '<a/>', 'b.xml': '<b/>' });
    expect(await main(['a.xml', 'b.xml'], cli)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'a.xml  ERROR  pool_exhausted: 10 free validations a day per IP address without a key. A free key gives 100 a month: https://einvoicekit.com/get-started?from=api-pool',
      '  the free pool resets at <2026-09-04T00:00:00.000Z>',
      '  a free key gives 100 validations a month, no card: https://einvoicekit.com/get-started?from=api-pool',
    ]);
    expect(seen).toHaveLength(1);
  });

  test('a spent monthly quota: the upgrade door is printed, remaining files skipped, exit 2', async () => {
    const { fetch, seen } = fakeFetch([
      {
        status: 429,
        body: { error: 'monthly quota exceeded', upgrade: 'https://einvoicekit.com/pricing' },
      },
    ]);
    const { cli, err } = io(
      fetch,
      { 'a.xml': '<a/>', 'b.xml': '<b/>' },
      { EINVOICEKIT_API_KEY: 'eik_live_k' },
    );
    expect(await main(['a.xml', 'b.xml'], cli)).toBe(2);
    expect(err).toEqual([
      'a.xml  ERROR  quota_exceeded: monthly quota exceeded',
      '  more allowance: https://einvoicekit.com/pricing',
    ]);
    expect(seen).toHaveLength(1);
  });

  test('--json keeps one slot per file even when the pool stops the run early', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: VALID },
      { status: 429, body: { error: 'pool_exhausted', resetsAt: 'x', upgrade: 'y' } },
    ]);
    const { cli, out } = io(fetch, { 'a.xml': '<a/>', 'b.xml': '<b/>', 'c.xml': '<c/>' });
    expect(await main(['a.xml', 'b.xml', 'c.xml', '--json'], cli)).toBe(2);
    expect(JSON.parse(out.join('\n'))).toEqual([VALID, null, null]);
  });

  test('a document the API cannot assess: error line, the other files still run, exit 2', async () => {
    const { fetch } = fakeFetch([
      { status: 422, body: { error: 'this PDF carries no embedded XML invoice' } },
      { status: 200, body: VALID },
    ]);
    const { cli, out, err } = io(fetch, { 'plain.pdf': '%PDF', 'ok.xml': '<a/>' });
    expect(await main(['plain.pdf', 'ok.xml'], cli)).toBe(2);
    expect(err).toEqual([
      'plain.pdf  ERROR  unreadable_document: this PDF carries no embedded XML invoice',
    ]);
    expect(out).toEqual(['ok.xml  VALID  (cii, urn:cen.eu:en16931:2017)']);
  });

  test('an error outranks an invalid verdict in the exit code', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: INVALID },
      { status: 502, body: { error: 'validation service unavailable' } },
    ]);
    const { cli } = io(fetch, { 'a.xml': '<a/>', 'b.xml': '<b/>' });
    expect(await main(['a.xml', 'b.xml'], cli)).toBe(2);
  });

  test('a missing file is reported without touching the network', async () => {
    const { fetch, seen } = fakeFetch([{ status: 200, body: VALID }]);
    const { cli, err } = io(fetch, {});
    expect(await main(['nope.xml'], cli)).toBe(2);
    expect(err[0]).toMatch(/^nope\.xml {2}ERROR {2}cannot read file: /);
    expect(seen).toHaveLength(0);
  });

  test('no files, --help and --version', async () => {
    const { fetch } = fakeFetch([]);
    const none = io(fetch);
    expect(await main([], none.cli)).toBe(2);
    expect(none.err).toEqual([USAGE]);

    const help = io(fetch);
    expect(await main(['--help'], help.cli)).toBe(0);
    expect(help.out).toEqual([USAGE]);

    const version = io(fetch);
    expect(await main(['--version'], version.cli)).toBe(0);
    expect(version.out).toEqual([VERSION]);
  });

  test('a bad option prints the reason and the usage, exit 2', async () => {
    const { fetch } = fakeFetch([]);
    const { cli, err } = io(fetch);
    expect(await main(['a.xml', '--target', 'de'], cli)).toBe(2);
    expect(err).toEqual(["facturx: unknown target 'de'; supported: france", USAGE]);
  });
});
