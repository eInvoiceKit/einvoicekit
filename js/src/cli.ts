import { FacturxError, validate, VERSION, type ValidationResult } from './index.js';

/**
 * Everything the command touches in the outside world, injectable so the
 * tests drive `main` directly with a fake transport and fake files.
 */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Formats the pool reset instant for a human; defaults to the machine's locale and zone. */
  formatInstant?: (iso: string) => string;
}

export const USAGE = `Usage: facturx <file>... [options]

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
could not be validated (unreadable, pool spent, no network).`;

interface Args {
  files: string[];
  target?: 'france';
  warnings: boolean;
  json: boolean;
  key?: string;
  baseUrl?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { files: [], warnings: false, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string | { error: string } => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      i++;
      return value;
    };
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--warnings':
        args.warnings = true;
        break;
      case '--target': {
        const value = next();
        if (typeof value !== 'string') return value;
        if (value !== 'france') return { error: `unknown target '${value}'; supported: france` };
        args.target = 'france';
        break;
      }
      case '--key': {
        const value = next();
        if (typeof value !== 'string') return value;
        args.key = value;
        break;
      }
      case '--base-url': {
        const value = next();
        if (typeof value !== 'string') return value;
        args.baseUrl = value;
        break;
      }
      default:
        if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
        args.files.push(arg);
    }
  }
  return args;
}

function describe(result: ValidationResult): string {
  const parts = [result.syntax];
  if (result.profile) parts.push(result.profile);
  return parts.join(', ');
}

function renderVerdict(file: string, result: ValidationResult, showWarnings: boolean): string[] {
  const lines = [`${file}  ${result.valid ? 'VALID' : 'INVALID'}  (${describe(result)})`];
  const findings = showWarnings ? [...result.errors, ...result.warnings] : result.errors;
  const width = Math.max(0, ...findings.map((f) => f.rule.length));
  for (const f of result.errors) {
    lines.push(`  ${f.rule.padEnd(width)}  ${f.path ?? ''}`.trimEnd());
    lines.push(`  ${' '.repeat(width)}  ${f.message}`);
  }
  if (showWarnings) {
    for (const f of result.warnings) {
      lines.push(`  ${f.rule.padEnd(width)}  warning  ${f.path ?? ''}`.trimEnd());
      lines.push(`  ${' '.repeat(width)}  ${f.message}`);
    }
  } else if (result.warnings.length > 0) {
    const n = result.warnings.length;
    lines.push(`  ${n} warning${n === 1 ? '' : 's'} (show with --warnings)`);
  }
  return lines;
}

function defaultFormatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Runs the command. Returns the exit code; never throws for a user-facing outcome. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    io.stderr(`facturx: ${parsed.error}`);
    io.stderr(USAGE);
    return 2;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (parsed.version) {
    io.stdout(VERSION);
    return 0;
  }
  if (parsed.files.length === 0) {
    io.stderr(USAGE);
    return 2;
  }

  const formatInstant = io.formatInstant ?? defaultFormatInstant;
  const apiKey = parsed.key ?? io.env['EINVOICEKIT_API_KEY'];
  let anyInvalid = false;
  let anyError = false;
  let poolNoteShown = false;
  const jsonOut: (ValidationResult | null)[] = [];

  for (const file of parsed.files) {
    let bytes: Uint8Array;
    try {
      bytes = await io.readFile(file);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      io.stderr(`${file}  ERROR  cannot read file: ${reason}`);
      anyError = true;
      jsonOut.push(null);
      continue;
    }

    try {
      const result = await validate(bytes, {
        ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
      if (!result.valid) anyInvalid = true;
      if (parsed.json) {
        jsonOut.push(result);
      } else {
        for (const line of renderVerdict(file, result, parsed.warnings)) io.stdout(line);
      }
    } catch (cause) {
      anyError = true;
      jsonOut.push(null);
      if (cause instanceof FacturxError) {
        io.stderr(`${file}  ERROR  ${cause.code}: ${cause.message}`);
        const wall = cause.code === 'pool_exhausted' || cause.code === 'quota_exceeded';
        if (wall && !poolNoteShown) {
          poolNoteShown = true;
          if (cause.resetsAt)
            io.stderr(`  the free pool resets at ${formatInstant(cause.resetsAt)}`);
          if (cause.upgrade) {
            io.stderr(
              cause.code === 'pool_exhausted'
                ? `  a free key gives 100 validations a month, no card: ${cause.upgrade}`
                : `  more allowance: ${cause.upgrade}`,
            );
          }
        }
        // Every other file would hit the same wall; stop burning attempts.
        if (wall) break;
      } else {
        const reason = cause instanceof Error ? cause.message : String(cause);
        io.stderr(`${file}  ERROR  ${reason}`);
      }
    }
  }

  if (parsed.json) {
    // Files skipped after a spent allowance still get their slot, so the
    // array always lines up with the arguments.
    while (jsonOut.length < parsed.files.length) jsonOut.push(null);
    const payload = parsed.files.length === 1 ? (jsonOut[0] ?? null) : jsonOut;
    io.stdout(JSON.stringify(payload, null, 2));
  }

  if (anyError) return 2;
  if (anyInvalid) return 1;
  return 0;
}
