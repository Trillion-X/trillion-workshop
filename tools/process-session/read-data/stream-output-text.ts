// packages/process-session/read-data/stream-output-text.ts
//
// GENERIC, data-driven extraction of DISPLAY TEXT from a process's raw stdout
// stream. A process streams raw JSONL in ITS OWN wire format; this module knows
// NOTHING about any specific CLI/agent/provider/format. A `StreamTextSpec` — pure
// DATA authored by whoever owns the source adapter — says, per raw line, WHEN it
// carries assistant text and WHERE that text lives. `extractStreamText` walks the
// lines and concatenates the matched text in order (L090: self-describing data,
// generic handler; the handler never names what it handles).
//
// This is the process-session-owned home of the stream-parse primitive. Feature
// packages (chat, documents, group) reuse it instead of each carrying
// their own JSONL decoder (L069). chat layers its richer AgentMessage mapping on
// top of the SAME spec shape + helpers exported here.
//
// INVARIANT: no literal agent/provider/format name appears in this file (no
// "text_delta", "assistant", "claude", "codex"). Those live ONLY in DATA specs.
// Pure: no React, no DOM, no I/O. Deterministic input -> output.


/** A condition tested against one raw event object, by explicit field path. */
export interface StreamMatchCondition {
  /** Field path into the raw event, e.g. ["event", "delta", "type"]. */
  readonly path: readonly string[];
  /** Require the value at `path` to equal this string. */
  readonly equals?: string;
  /** Require the value at `path` to be present (non-null/undefined). */
  readonly exists?: boolean;
}

/** One rule: when all conditions hold for a raw line, contribute the text found
 *  at the first non-empty of `textPaths`. Rules are matched in order; the first
 *  whose conditions all hold wins for that line. */
export interface StreamTextRule {
  readonly when: readonly StreamMatchCondition[];
  /** Where the display text lives. Tried in order; first non-empty wins. */
  readonly textPaths: readonly (readonly string[])[];
}

/** The DATA that drives text extraction for one source's stream. A superset spec
 *  (e.g. chat's StreamParseSpec, which also carries tool/thinking rules + an
 *  `emit.kind`) is structurally compatible: this reader looks only at
 *  `events[].when` + `events[].emit.textPaths`, ignoring non-text emits. */
export interface StreamTextSpec {
  readonly lineFormat: 'jsonl';
  readonly events: readonly StreamTextRule[];
}

// ---------------------------------------------------------------------------
// SHARED JSON HELPERS (the generic-owner copy — chat re-imports these)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Flatten a string | {text|content} | array-of-those into one string. */
export function firstText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(firstText).filter((p): p is string => p !== null && p.trim().length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return firstText(record.text) ?? firstText(record.content) ?? null;
}

// The formula engine decides every condition (rule-operators.json: is_known, is_unknown, equals); this module compares
// nothing itself. The host gives the loaded engine with `setStreamConditionEngine` (the shape of filter-rows-by-rules.mjs
// holdsNow); until then a condition throws rather than guess.
type FactsHold = (tree: unknown, facts: (field: string) => unknown) => boolean;
let holdsFacts: FactsHold | null = null;

export const streamConditionsLoaded = (): boolean => holdsFacts !== null;

export function setStreamConditionEngine(holds: FactsHold): void {
  holdsFacts = holds;
}

/** Whether every part of one condition holds for a raw event: the value at `path` equals `equals`, is present
 *  (`exists: true`) or is absent (`exists: false`). Shared by every reader of the spec shape (chat's included). */
export function conditionHolds(event: unknown, cond: StreamMatchCondition): boolean {
  if (!holdsFacts) throw new Error('The condition engine is not loaded: call setStreamConditionEngine first.');
  const field = JSON.stringify(cond.path);
  const rules: { kind: 'rule'; field: string; operator: string; params: Record<string, unknown> }[] = [];
  if (cond.exists !== undefined) rules.push({ kind: 'rule', field, operator: cond.exists ? 'is_known' : 'is_unknown', params: {} });
  if (cond.equals !== undefined) rules.push({ kind: 'rule', field, operator: 'equals', params: { value: cond.equals } });
  return holdsFacts({ kind: 'group', combinator: 'and', negate: false, rules }, (id) => readPath(event, JSON.parse(id) as string[]));
}

function ruleTextPaths(rule: StreamTextRule): readonly (readonly string[])[] {
  // A superset rule carries its text paths under `emit.textPaths`; a minimal rule
  // carries them at the top level. Read whichever is present (DATA-shape tolerant).
  if (Array.isArray(rule.textPaths)) return rule.textPaths;
  const emit = asRecord((rule as { emit?: unknown }).emit);
  const paths = emit?.textPaths;
  return Array.isArray(paths) ? (paths as (readonly string[])[]) : [];
}

/** Extract concatenated assistant display text from a raw JSONL stream using only
 *  the DATA `spec`. Each line that matches a text rule contributes its text in
 *  stream order — so an incremental delta stream (each line a new fragment)
 *  concatenates into the growing answer, and a partial trailing line (not yet
 *  newline-terminated / not valid JSON) is skipped until it completes. */
export function extractStreamText(rawText: string, spec: StreamTextSpec): string {
  let out = '';
  for (const line of rawText.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // partial or non-JSON terminal noise — skip until complete
    }
    const rule = spec.events.find((r) => r.when.every((c) => conditionHolds(event, c)));
    if (!rule) continue;
    for (const path of ruleTextPaths(rule)) {
      const text = firstText(readPath(event, path));
      if (text && text.length > 0) { out += text; break; }
    }
  }
  return out;
}
