import { readFile } from 'node:fs/promises';
import { main } from './cli.js';

const code = await main(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  env: process.env,
});
process.exitCode = code;
