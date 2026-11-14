#!/usr/bin/env node
/**
 * file: packages/content-production/do-work/media-classify.mjs
 *
 * PURPOSE: The media.classify capability (plan §9/§15 T06) — selects the
 * workflow-definition (the style) for a set of inputs. Three DATA-driven
 * modes, zero style names in code:
 *   manual — the caller already names a definition; passed through verbatim
 *   rule   — the classify-rules.json table maps input-shape → definition id
 *   ai     — the local CLI picks among the published definitions (no API key)
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. This file never names a style — rules and the AI prompt carry the ids
 * 2. Rules are data; first match wins; adding selection logic = one rule row
 * 3. AI mode runs the LOCAL CLI from the rules file's argv — never an HTTP key
 * 4. Output is machine-readable JSON on stdout: {definition, mode, shape}
 *
 * Usage: node media-classify.mjs --shape '{"video":true,"audio":true}'
 *        [--rules classify-rules.json] [--mode rule|ai|manual]
 *        [--definition action:x] [--definitions 'action:a,action:b']
 *        [--out classify.json]   (declared-output file for the workflow boundary)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const RULES_PATH = args.get('rules') ?? join(here, '..', 'classify-rules.json');
const shape = JSON.parse(args.get('shape') ?? '{}');
const rulesDoc = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
const execution = rulesDoc.execution ?? {};
const MODE = args.get('mode') ?? execution.default_mode;
if (!MODE) {
  console.error(JSON.stringify({ error: 'missing_execution_mode', required: 'execution.default_mode or --mode' }));
  process.exit(2);
}

function emit(definition, mode) {
  console.log(`[media.classify] inputs=${JSON.stringify(shape)} -> def=${definition} mode=${mode}`);
  const result = JSON.stringify({ definition, mode, shape });
  console.log(result);
  // Declared-output file: the workflow boundary reads THIS (a binding can't
  // parse a log-prefixed stdout) — same contract as every proven capability.
  const outFile = args.get('out');
  if (outFile) writeFileSync(outFile, result + '\n');
}

// manual — pass-through
if (MODE === 'manual') {
  const definition = args.get('definition');
  if (!definition) {
    console.error('manual mode requires --definition');
    process.exit(2);
  }
  emit(definition, 'manual');
  process.exit(0);
}

// rule — first rule whose every `when` key matches the shape wins
function matchRule() {
  for (const rule of rulesDoc.rules ?? []) {
    const matches = Object.entries(rule.when ?? {}).every(([key, expected]) => (shape[key] ?? false) === expected);
    if (matches) return rule.definition;
  }
  return null;
}

if (MODE === 'rule') {
  const definition = matchRule();
  if (definition) {
    emit(definition, 'rule');
    process.exit(0);
  }
  // No rule matched — fall through to AI mode (the rules file declares how).
}

// ai — the local CLI picks among the published definitions
const definitions = (args.get('definitions') ?? '').split(',').map((d) => d.trim()).filter(Boolean);
if (definitions.length === 0) {
  console.error('no rule matched and no --definitions provided for ai mode');
  process.exit(3);
}
const ai = rulesDoc.ai_mode;
if (!ai?.argv || !Array.isArray(ai.argv) || ai.argv.length === 0 || typeof ai.argv[0] !== 'string') {
  console.error(JSON.stringify({ error: 'missing_ai_argv', required: 'ai_mode.argv' }));
  process.exit(5);
}
if (!ai.prompt_template || typeof ai.prompt_template !== 'string') {
  console.error(JSON.stringify({ error: 'missing_ai_prompt_template', required: 'ai_mode.prompt_template' }));
  process.exit(5);
}
const prompt = ai.prompt_template
  .replace('{shape}', JSON.stringify(shape))
  .replace('{definitions}', definitions.join(', '));
const timeoutMs = Number(execution.timeout_ms);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(JSON.stringify({ error: 'missing_timeout_ms', required: 'execution.timeout_ms' }));
  process.exit(5);
}
const reply = execFileSync(ai.argv[0], [...ai.argv.slice(1), prompt], { encoding: 'utf8', timeout: timeoutMs });
const picked = definitions.find((d) => reply.includes(d));
if (!picked) {
  console.error(`ai mode reply named no known definition: ${reply.slice(-200)}`);
  process.exit(4);
}
emit(picked, 'ai');
