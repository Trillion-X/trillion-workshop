// parts/stripe-payment-provider/process/read-cli-input.mjs
//
// Shared CLI-input resolver for this part's command-line workers: `--input-json '<json>'` (argv), then a
// positional JSON value or file, then a file named by PROCESS_INPUT_FILE, then stdin. One definition so every
// script parses its input identically (L100).
import { readFileSync } from 'node:fs';

export function readCliInput(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input-json') return JSON.parse(argv[i + 1]);
  }
  const positional = argv.find((a) => !a.startsWith('--'));
  if (positional) {
    try {
      return JSON.parse(readFileSync(positional, 'utf8'));
    } catch {
      return JSON.parse(positional);
    }
  }
  const envPath = process.env.PROCESS_INPUT_FILE;
  if (envPath) return JSON.parse(readFileSync(envPath, 'utf8'));
  return JSON.parse(readFileSync(0, 'utf8'));
}
