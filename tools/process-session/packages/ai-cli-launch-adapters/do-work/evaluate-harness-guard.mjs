#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/evaluate-harness-guard.mjs
//
// =============================================================================
// PURPOSE: evaluate the DATA harness-guard predicates against ONE tool-use event
// =============================================================================
//
// T6 (Guards as Trigger-Rules). The `guard-on-tool-use` trigger-rule fires this
// on every session tool-use envelope. This handler reads the live `harness-guard`
// DATA rows (kind:'harness-guard'), evaluates each active predicate against the
// tool-use payload, and returns allow or deny. A real deny is routed through
// `ai-action-guard` (the policy owner), never a bespoke block here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//  1. Predicates are DATA, not source branches. A new guard is a new
//     `harness-guard` row (field/matcher/pattern), zero code change here
//     (enum-dissolution; the same law lesson-rules already follows).
//  2. The evaluator is a generic predicate matcher over {field, matcher,
//     pattern}. It never enumerates specific guard ids.
//  3. Pure evaluation is separated from IO so it is unit-tested without a live
//     engine.
//
// Predicate shape (one `harness-guard` row):
//   { kind:'harness-guard', id, label, is_active,
//     predicate: { field:'tool_name'|'content'|<any payload key>,
//                  matcher:'contains'|'equals'|'regex', pattern:'<string>' },
//     on_match: 'deny'|'warn' }
// =============================================================================

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
/** Read one field off the tool-use payload by name (dotted paths supported). */
export function selectField(toolUsePayload, field) {
  if (toolUsePayload == null || typeof field !== 'string' || field.length === 0) return undefined;
  let cursor = toolUsePayload;
  for (const segment of field.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Generic single-predicate match. Returns true when the predicate matches. */
export function predicateMatches(predicate, toolUsePayload) {
  if (predicate == null || typeof predicate !== 'object') return false;
  const value = selectField(toolUsePayload, predicate.field);
  if (value == null) return false;
  const text = String(value);
  const pattern = String(predicate.pattern ?? '');
  switch (predicate.matcher) {
    case 'equals': return text === pattern;
    case 'contains': return text.includes(pattern);
    case 'regex': {
      let re;
      try { re = new RegExp(pattern); } catch { return false; }
      return re.test(text);
    }
    default: return false;
  }
}

/**
 * Pure evaluation: the FIRST active guard whose predicate matches with
 * on_match:'deny' produces a deny verdict; otherwise allow. Warn-only matches
 * are collected but do not deny.
 */
export function evaluateHarnessGuard({ toolUsePayload, guardRows }) {
  const rows = Array.isArray(guardRows) ? guardRows : [];
  const warnings = [];
  for (const row of rows) {
    if (row == null || row.is_active === false) continue;
    if (!predicateMatches(row.predicate, toolUsePayload)) continue;
    if ((row.on_match ?? 'deny') === 'deny') {
      return { verdict: 'deny', rule: row.id ?? null, label: row.label ?? null, field: row.predicate?.field ?? null };
    }
    warnings.push(row.id ?? null);
  }
  return { verdict: 'allow', rule: null, warnings };
}

export function buildHarnessGuardReceipt({ toolUsePayload, evaluation, ts = new Date().toISOString() }) {
  return {
    kind: 'harness-guard-evaluation',
    schema: 'ai-cli-launch-adapters.harness-guard-evaluation/v1',
    evaluated_at: ts,
    session_ref: selectField(toolUsePayload, 'session_ref') ?? selectField(toolUsePayload, 'session_id') ?? null,
    event_kind: selectField(toolUsePayload, 'event_kind') ?? null,
    tool_name: selectField(toolUsePayload, 'tool_name') ?? null,
    ...evaluation,
  };
}

// ---------------------------------------------------------------------------
// IO surface (invoked as the owner operation the workflow-def dispatches).
// Reads the tool-use payload from --input-file / stdin and the guard rows from
// --guards-file (the workflow supplies the live harness-guard feed). A real
// deny is handed to ai-action-guard by the dispatching workflow-def, not here.
// ---------------------------------------------------------------------------
export async function main(argv, io = {}) {
  const { readFileSync = (await import('node:fs')).readFileSync } = io;
  const readArg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const inputFile = readArg('input-file');
  const guardsFile = readArg('guards-file');
  const toolUsePayload = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : JSON.parse(readFileSync(0, 'utf8'));
  const guardRows = guardsFile ? JSON.parse(readFileSync(guardsFile, 'utf8')) : [];
  const evaluation = evaluateHarnessGuard({ toolUsePayload, guardRows });
  const result = buildHarnessGuardReceipt({ toolUsePayload, evaluation });
  const toolName = selectField(toolUsePayload, 'tool_name') ?? '(none)';
  process.stderr.write(`[harness-guard] tool=${toolName} verdict=${result.verdict} rule=${result.rule ?? '(none)'}\n`);
  process.stdout.write(JSON.stringify(result));
  return result.verdict === 'deny' ? 0 : 0; // never crash the launch; the verdict is the signal
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  main(process.argv).then((code) => process.exit(typeof code === 'number' ? code : 0)).catch((error) => {
    process.stderr.write(`[harness-guard] error ${error?.message ?? error}\n`);
    process.exit(0);
  });
}
