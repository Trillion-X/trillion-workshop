// packages/stripe-payment-provider/do-work/process-scripts/parse-stripe-signature-cli.mjs
//
// compute.process script — Phase 1 of the Stripe webhook ingest workflow-def.
// The generic /ingest/{connection_id} route dispatches slot::workflow
// execute_definition with input { connection_id, body, raw_body, headers }. This
// script parses the Stripe-Signature header + enforces the timestamp-tolerance
// window + builds the exact signed message (base64). NO secret — the HMAC is done
// by the credentials-vault `sign` op over `messageB64` in the NEXT workflow step.
//
// Invocation (mirrors traffic-attribution/ingest-transform-cli):
//   WORKFLOW: parse-stripe-signature-cli --input-json '<json>' --output-json out.json
//   LOCAL:    parse-stripe-signature-cli '<json-or-file>'
//
// Input  JSON: { raw_body: string, headers: { "stripe-signature": string }, tolerance_seconds?, now_seconds? }
// Output JSON: { ok, timestamp, signatures, message, messageB64 } | { ok:false, reason }
// Fail-closed: a malformed/expired/absent signature → { ok:false, reason } (the
// next steps gate on ok / the empty compare result), never throws past main().
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStripeSignature } from '../parse-webhook-signature.mjs';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** Map the workflow input shape → parseStripeSignature args. The signature header
 *  is read from the DATA-allow-listed `headers` the route forwarded. */
export function runParse(input) {
  const headers = (input && input.headers) || {};
  const header = headers['stripe-signature'] ?? headers['Stripe-Signature'];
  return parseStripeSignature({
    payload: input ? input.raw_body : undefined,
    header,
    ...(input && typeof input.tolerance_seconds === 'number' ? { toleranceSeconds: input.tolerance_seconds } : {}),
    ...(input && typeof input.now_seconds === 'number' ? { nowSeconds: input.now_seconds } : {}),
  });
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  let rawInput;
  if (flags['input-json'] != null) {
    rawInput = JSON.parse(flags['input-json']);
  } else if (positional[0]) {
    try {
      rawInput = JSON.parse(readFileSync(positional[0], 'utf8'));
    } catch {
      rawInput = JSON.parse(positional[0]);
    }
  } else {
    process.stderr.write('usage: parse-stripe-signature-cli <json|file> | --input-json <json> [--output-json <path>]\n');
    process.exit(2);
  }
  const out = JSON.stringify(runParse(rawInput));
  if (flags['output-json']) writeFileSync(flags['output-json'], out, 'utf8');
  else process.stdout.write(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
