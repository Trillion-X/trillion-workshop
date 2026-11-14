// packages/training-plan/do-work/process-scripts/next-session-cli.ts
//
// Standalone CLI for the LIVE adaptive-next-session `compute.process` step (WF-PROGRAM).
// Reads a structured training program + the just-finished session id + the measured
// signals, runs the PURE `decodeTrainingPlan` + `deriveNextSession` (training-plan's own
// progression brain — the generic evaluator over DATA `progression_rule`s) — BUNDLED into
// this script at deploy via esbuild, NOT reimplemented (single SSOT) — and prints the
// adapted next-session prescription + the decision (which rules fired) as clean JSON to
// stdout. This is the "WASM is the brain, OS is the executor" path: the adaptation is an
// OS `node` process orchestrated via process-engine, reusing the EXACT esbuild-bundle
// `compute.process` pattern proven by measure-compute-cli. It makes the program a LIVING
// adaptive product (the program actually changes for the next session), not a static PDF.
//
// Two invocation forms (both produce { current_id, next, decision }):
//   LOCAL/TEST (positional file paths, result to stdout):
//     next-session-cli <program.json> <current-session-id> [signals.json]
//   WORKFLOW (compute.process — JSON passed as argv strings, result to an OUTPUT FILE):
//     next-session-cli --program-json <json> --current-session-id <id> --signals-json <json> [--rules-json <json>] [--output-json next.json]
//   `--program-json` accepts either the full { plan, progressionRules } document OR a bare
//   plan { goals, phases, weeks, sessions }; if progressionRules are present they are used
//   as the rule set unless `--rules-json` overrides. The result is written to an output
//   FILE so a `return` step can bind outputs.0.bytes.base64 -> decode -> json_parse.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { decodeTrainingPlan, type TrainingSessionPrescription } from '@/packages/training-plan/read-data/training-plan';
import { deriveNextSession } from '@/packages/training-plan/read-data/derive-next-session';

// stdout is the compute.process result channel and MUST be clean JSON — route any
// diagnostic console output to stderr so it never corrupts the stdout JSON contract.
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = console.log;
console.debug = console.log;

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Minimal --flag value parser (positional args remain in order). */
function parseArgs(argv: readonly string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i += 1; }
    else positional.push(a);
  }
  return { flags, positional };
}

/** A program document is either { plan, progressionRules } or a bare plan. */
function readProgram(raw: any): { plan: any; rules: any[] } {
  const plan = raw?.plan ?? raw;
  const rules = Array.isArray(raw?.progressionRules) ? raw.progressionRules : [];
  return { plan, rules };
}

function main(): void {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  const programRaw = flags['program-json'] != null ? JSON.parse(flags['program-json'])
    : positional[0] ? readJson(positional[0]) : null;
  const currentId = flags['current-session-id'] ?? positional[1] ?? '';
  const signals = flags['signals-json'] != null ? JSON.parse(flags['signals-json'])
    : positional[2] ? readJson(positional[2]) : [];

  if (programRaw == null || !currentId) {
    process.stderr.write('usage: next-session-cli (<program.json> <current-session-id> [signals.json]) | (--program-json <json> --current-session-id <id> --signals-json <json> [--rules-json <json>] [--output-json <path>])\n');
    process.exit(2);
  }

  const { plan: planRaw, rules: embeddedRules } = readProgram(programRaw);
  const rules = flags['rules-json'] != null ? JSON.parse(flags['rules-json']) : embeddedRules;
  const plan = decodeTrainingPlan(planRaw);
  const current = plan.sessions.find((s: TrainingSessionPrescription) => s.id === currentId);
  if (!current) {
    process.stderr.write(`current-session-id '${currentId}' not found in the program (${plan.sessions.length} sessions)\n`);
    process.exit(3);
  }

  const { next, decision } = deriveNextSession({ current, signals: Array.isArray(signals) ? signals : [], ruleRecords: rules });
  const result = { current_id: currentId, next, decision };
  const out = JSON.stringify(result);
  if (flags['output-json']) writeFileSync(flags['output-json'], out);
  else process.stdout.write(out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
