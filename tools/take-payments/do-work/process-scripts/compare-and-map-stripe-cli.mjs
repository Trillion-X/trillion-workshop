// packages/stripe-payment-provider/do-work/process-scripts/compare-and-map-stripe-cli.mjs
//
// compute.process script — Phase 2 of the Stripe webhook ingest workflow-def, run
// AFTER the credentials-vault `sign` step. Timing-safe compares the vault-computed
// expected signature against the header v1 candidates, then — only on a match —
// DATA-maps the event into the generic revenue PaymentEvent records[] and emits
// them as the workflow `write` step's `{ writes: [...] }` contract.
//
// NO secret here (the secret stayed in the vault). The eventMap arrives as INPUT
// DATA (not bundled) so changing the Stripe→PaymentEvent rules is a DATA edit, not
// a script rebuild (L090). Fail-closed: any reject → { writes: [] } (write nothing).
//
// Input  JSON: { expected_signature: string, signatures: string[], raw_body: string, event_map: object }
// Output JSON: { writes: PaymentEvent[] }   (empty on any verification/decode/map failure)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareAndMapStripeWebhook } from '../admit-a-webhook.mjs';

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

/** Map the workflow input → compareAndMapStripeWebhook, then adapt to { writes }. */
export function runCompareAndMap(input) {
  const result = compareAndMapStripeWebhook({
    expectedSignature: input ? input.expected_signature : undefined,
    signatures: input ? input.signatures : undefined,
    rawBody: input ? input.raw_body : undefined,
    eventMap: input ? input.event_map : undefined,
  });
  if (!result.admitted) {
    // Fail-closed: write nothing. Surface the reason to stderr for observability only.
    process.stderr.write(`[stripe-ingest] not admitted: ${result.reason}\n`);
    return { writes: [] };
  }
  // Adapt each generic PaymentEvent into the workflow `write` step's item contract
  // ({ address, path, payload }) — exactly like traffic-attribution's toWorkflowWriteItem.
  // The pure compareAndMap returns domain records; the CLI owns the workflow shape.
  //
  // Address: this provider's OWN output namespace — `package::stripe-payment-provider
  // ::payment-event::<event_id>`. A producer always owns the address it writes; it
  // must NEVER name a specific consumer (writing `package::revenue-ledger::…` here
  // would couple the generic Stripe package to one consumer = Society-leak / god-
  // package, L098/L090). Cross-package data flows by ADDRESS: any consumer (revenue-
  // ledger today, an accounting package tomorrow) reads these records via ITS OWN
  // input-descriptor DATA that lists the provider namespaces to aggregate — so the
  // provider→ledger binding lives in app/consumer wiring DATA, and revenue-ledger's
  // code stays provider-blind. Matches traffic-attribution, which writes only to
  // `package::traffic-attribution::…`. `event_id` (= Stripe event.id) makes the
  // address idempotent: re-delivery overwrites the same record.
  return {
    writes: result.records.map((event) => ({
      address: `package::stripe-payment-provider::payment-event::${event.event_id}`,
      path: ['current-item', 'published-record'],
      payload: event,
    })),
  };
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  let rawInput;
  if (flags['input-json'] != null) {
    rawInput = JSON.parse(flags['input-json']);
  } else if (flags['expected-signature'] != null || flags['raw-body'] != null) {
    // WORKFLOW form: each value arrives as its OWN argv flag (each a single-select
    // binding — no object-construction needed in the workflow DSL). `signatures-json`
    // is a JSON-array string (parsed.signatures stringified upstream).
    rawInput = {
      expected_signature: flags['expected-signature'],
      raw_body: flags['raw-body'],
      signatures: flags['signatures-json'] != null ? JSON.parse(flags['signatures-json']) : [],
    };
  } else if (positional[0]) {
    try {
      rawInput = JSON.parse(readFileSync(positional[0], 'utf8'));
    } catch {
      rawInput = JSON.parse(positional[0]);
    }
  } else {
    process.stderr.write('usage: compare-and-map-stripe-cli --input-json <json> | --expected-signature <hex> --signatures-json <arr> --raw-body <str> [--event-map <path>] [--output-json <path>]\n');
    process.exit(2);
  }
  // The Stripe→PaymentEvent rules are DATA (L090). The workflow mounts the event-map
  // file (default `event-map.json`) into the compute step rather than bundling it, so
  // changing the rules is a DATA edit, not a script rebuild. Inline `event_map` (tests)
  // takes precedence.
  if (rawInput && rawInput.event_map == null) {
    const mapPath = flags['event-map'] || 'event-map.json';
    try {
      rawInput.event_map = JSON.parse(readFileSync(mapPath, 'utf8'));
    } catch {
      /* leave absent → mapStripeWebhookEvent fail-closes → { writes: [] } */
    }
  }
  const out = JSON.stringify(runCompareAndMap(rawInput));
  if (flags['output-json']) writeFileSync(flags['output-json'], out, 'utf8');
  else process.stdout.write(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
