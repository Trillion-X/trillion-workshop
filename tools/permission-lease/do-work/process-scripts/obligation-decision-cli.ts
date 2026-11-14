// packages/permission-lease/do-work/process-scripts/obligation-decision-cli.ts
//
// Standalone CLI for the `action:permission-lease.evaluate-capability`
// compute.process step. Reads obligation records + measure facts (JSON passed
// as argv strings by workflow bindings, or positional file paths for local
// runs), runs the pure `decideCapability` leaf — BUNDLED into this script at
// build via esbuild, not reimplemented — and emits the resulting
// obligation-decision fact as clean JSON to stdout and to --output-json.
//
// Invocation forms (both produce the CapabilityDecision JSON):
//   LOCAL/TEST (positional file paths):
//     obligation-decision-cli <obligations.json> <measures.json> --capability-ref <ref>
//   WORKFLOW (compute.process — JSON as argv strings, result also to an output file):
//     obligation-decision-cli --obligations-json <json> --measures-json <json> \
//       --capability-ref <ref> [--now <iso>] --output-json decision.json
//
// --now is optional: omitted, the CLI stamps the wall clock; probes pass it
// explicitly for deterministic transcripts.
import { readFileSync, writeFileSync } from 'node:fs';

import {
  decideCapability,
  type CapabilityObligation,
  type FactRecord,
} from '../../read-data/obligation-decision.ts';
// The OWNER composes the capability pack (node families + verbs) and injects
// it — the dispatcher owns none of them. This CLI is one such owner
// composition; a different deployment bundles a different pack.
import { conditionPack } from '../../read-data/condition-node-pack.ts';

// stdout is the compute.process result channel and MUST be clean JSON — route
// diagnostics to stderr so they never corrupt the stdout JSON contract.
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = console.log;
console.debug = console.log;

function parseArgs(argv: readonly string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[obligation-decision] invalid ${label} JSON: ${String(e)}\n`);
    process.exit(2);
  }
}

/** Items may arrive bare or as { payload } / { fields } rows from find-current-items. */
function unwrap(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((r) => {
    if (r && typeof r === 'object') {
      const rec = r as Record<string, unknown>;
      if (rec.payload && typeof rec.payload === 'object') return rec.payload as Record<string, unknown>;
      if (rec.fields && typeof rec.fields === 'object') return rec.fields as Record<string, unknown>;
      return rec;
    }
    return {};
  });
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray((v as { items?: unknown[] }).items)) {
    return (v as { items: unknown[] }).items;
  }
  return [];
}

const { flags, positional } = parseArgs(process.argv.slice(2));

const obligationsRaw = flags['obligations-json'] !== undefined
  ? parseJson(flags['obligations-json'], 'obligations')
  : positional[0] !== undefined
    ? parseJson(readFileSync(positional[0], 'utf8'), 'obligations file')
    : [];
const measuresRaw = flags['measures-json'] !== undefined
  ? parseJson(flags['measures-json'], 'measures')
  : positional[1] !== undefined
    ? parseJson(readFileSync(positional[1], 'utf8'), 'measures file')
    : [];

const capabilityRef = flags['capability-ref'] ?? '';
if (!capabilityRef) {
  process.stderr.write('[obligation-decision] --capability-ref is required\n');
  process.exit(2);
}
const nowIso = flags['now'] && flags['now'] !== '' ? flags['now'] : new Date().toISOString();

const obligations = unwrap(asArray(obligationsRaw)).filter(
  (o) => o.kind === 'capability-obligation',
) as CapabilityObligation[];
const measures = unwrap(asArray(measuresRaw)) as FactRecord[];

const decision = decideCapability(capabilityRef, obligations, measures, nowIso, conditionPack);

process.stderr.write(
  `[obligation-decision] capability=${capabilityRef} allowed=${decision.allowed} verdicts=${decision.verdicts.length}\n`,
);

const json = JSON.stringify(decision, null, 1);
if (flags['output-json']) writeFileSync(flags['output-json'], json);
process.stdout.write(json + '\n');
