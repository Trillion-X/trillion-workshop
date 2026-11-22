#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * file: tools/generate-content-drafts/do-work/media-classify.mjs
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
import { fileURLToPath } from 'node:url';

export function chooseContentStyle(shape, rulesDoc, options = {}) {
if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new Error('shape must be an object');
if (!rulesDoc || typeof rulesDoc !== 'object' || Array.isArray(rulesDoc)) throw new Error('rules must be an object');
const execution = rulesDoc.execution ?? {};
const MODE = options.mode ?? execution.default_mode;
if (!MODE) {
  throw new Error('missing_execution_mode: execution.default_mode or --mode');
}
if (!['manual', 'rule', 'ai'].includes(MODE)) throw new Error(`unknown execution mode ${MODE}`);

function emit(definition, mode) {
  if (typeof definition !== 'string' || !definition.trim()) throw new Error('selected definition must be nonempty text');
  return { definition, mode, shape };
}

// manual — pass-through
if (MODE === 'manual') {
  const definition = options.definition;
  if (!definition) {
    throw new Error('manual mode requires --definition');
  }
  return emit(definition, 'manual');
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
    return emit(definition, 'rule');
  }
  // No rule matched — fall through to AI mode (the rules file declares how).
}

// ai — the local CLI picks among the published definitions
if (!options.allowAi) throw new Error('local_ai_required: no deterministic selection; use the local CLI with the authorized rules file');
const definitions = options.definitions ?? [];
if (definitions.length === 0) {
  throw new Error('no rule matched and no --definitions provided for ai mode');
}
const ai = rulesDoc.ai_mode;
if (!ai?.argv || !Array.isArray(ai.argv) || ai.argv.length === 0 || typeof ai.argv[0] !== 'string') {
  throw new Error('missing_ai_argv: ai_mode.argv');
}
if (!ai.prompt_template || typeof ai.prompt_template !== 'string') {
  throw new Error('missing_ai_prompt_template: ai_mode.prompt_template');
}
const prompt = ai.prompt_template
  .replace('{shape}', JSON.stringify(shape))
  .replace('{definitions}', definitions.join(', '));
const timeoutMs = Number(execution.timeout_ms);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error('missing_timeout_ms: execution.timeout_ms');
}
const reply = execFileSync(ai.argv[0], [...ai.argv.slice(1), prompt], { encoding: 'utf8', timeout: timeoutMs });
const picked = definitions.find((d) => reply.trim() === d);
if (!picked) {
  throw new Error('ai mode reply must name exactly one supplied definition');
}
return emit(picked, 'ai');
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const jsonMode = process.argv.includes('--json');
    const args = new Map();
    for (let i = 2; !jsonMode && i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
    const input = jsonMode ? JSON.parse(readFileSync(0, 'utf8')) : {};
    const RULES_PATH = args.get('rules');
    const shape = jsonMode ? input.shape : JSON.parse(args.get('shape') ?? '{}');
    if (!jsonMode && !RULES_PATH) throw new Error('--rules must name the authorized rules DATA file');
    const rulesDoc = jsonMode ? input.rules : JSON.parse(readFileSync(RULES_PATH, 'utf8'));
    const result = chooseContentStyle(shape, rulesDoc, {
      mode: input.mode ?? args.get('mode'), definition: input.definition ?? args.get('definition'),
      definitions: (args.get('definitions') ?? '').split(',').map((d) => d.trim()).filter(Boolean),
      allowAi: !jsonMode,
    });
    if (jsonMode) console.log(JSON.stringify({ result }));
    else {
      console.log(`[media.classify] inputs=${JSON.stringify(shape)} -> def=${result.definition} mode=${result.mode}`);
      console.log(JSON.stringify(result));
      const outFile = args.get('out');
      if (outFile) writeFileSync(outFile, JSON.stringify(result) + '\n');
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
