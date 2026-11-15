// tools/read-what-is-on-screen/read-data/snapshot-triggers.mjs (moved from Trillion computer/snapshot-triggers.mjs)
//
// Purpose
//   The policy half of an accessibility-snapshot reader, as one generic engine: which events ask for a snapshot, when to
//   say no (debounce, global and per-app spacing with backoff, locked screen, memory pressure), how an app's elements
//   become fields (declarative parser rows delivered as data), what is removed on the device, and counted outcomes.
//
// Non-negotiable invariants
//   1. Triggers, gaps, parsers, redaction patterns and outcome names are DATA (snapshot-triggers.json); this file names no app.
//   2. Every ask ends in exactly one counted outcome; `counts()` therefore shows silence as skipped or throttled, not as nothing.
//   3. An app whose snapshots keep coming back unchanged is read less often (gap doubles to backoff_most) and returns to
//      the normal gap as soon as one changes.
//   4. Redaction runs on every extracted field before the result is returned; there is no way to get an unredacted field out.
//   5. Parsing is declarative: a row selects and cuts with patterns; it runs no code.
//
// The event half (watching the accessibility tree and asking the governor) stays in the Mac app, macos/App/ComputerReader.swift
// (Trillion-X/trillion-apps). This file is the policy half, and `parse` is the row tool:parse-snapshot.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/read-what-is-on-screen/read-data/snapshot-triggers.mjs parse
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const triggerSettings = () => JSON.parse(readFileSync(path.join(HERE, 'snapshot-triggers.json'), 'utf8'));
const lower = value => String(value ?? '').toLowerCase();

export function redact(text, settings = triggerSettings()) {
  return settings.redact.reduce((out, rule) => out.replace(new RegExp(rule.pattern, 'g'), settings.replacement), String(text ?? ''));
}

/** The first parser row matching the app (by app_contains), else the one without it. */
export const parserFor = (settings, app) => settings.parsers.find(row => row.app_contains?.some(part => lower(app).includes(lower(part)))) ?? settings.parsers.find(row => !row.app_contains) ?? null;

/** Elements [{ role, label }] as redacted fields rows [{ field: value }] through the app's parser row. */
export function parseSnapshot(settings, app, elements) {
  const row = parserFor(settings, app);
  if (!row) return [];
  const roles = (row.select.roles ?? []).map(lower); const matches = new RegExp(row.select.label_matches ?? '.');
  const rows = [];
  for (const element of elements ?? []) {
    if (roles.length && !roles.includes(lower(String(element.role ?? '').replace(/^AX/, '')))) continue;
    if (!matches.test(String(element.label ?? ''))) continue;
    const out = {};
    for (const [name, rule] of Object.entries(row.fields)) {
      const found = new RegExp(rule.regex).exec(String(element[rule.from] ?? ''));
      if (found) out[name] = redact(found[1] ?? found[0], settings);
    }
    if (Object.keys(out).length) rows.push(out);
  }
  return rows;
}

/** The trigger governor: ask({ trigger, app, at }, facts) -> { outcome }, then report(app, changed) after the snapshot. */
export function createGovernor(settings = triggerSettings()) {
  const counts = Object.fromEntries(settings.outcomes.map(name => [name, 0]));
  let lastGlobal = -Infinity; const last = new Map(); const pendingDebounce = new Map(); const factor = new Map();
  const count = outcome => { counts[outcome] = (counts[outcome] ?? 0) + 1; return { outcome }; };
  return {
    ask({ trigger, app, at }, facts = {}) {
      const row = settings.triggers.find(entry => entry.id === trigger) ?? (trigger === 'periodic' ? { debounce_ms: 0 } : null);
      if (!row) return count('unknown-trigger');
      for (const fact of settings.skip_when) if (facts[fact]) return count(`skipped-${fact}`);
      const key = `${app}\u0000${trigger}`;
      if (at - (pendingDebounce.get(key) ?? -Infinity) < row.debounce_ms) { pendingDebounce.set(key, at); return count('debounced'); }
      pendingDebounce.set(key, at);
      if (at - lastGlobal < settings.throttle.global_gap_ms) return count('throttled-global');
      if (at - (last.get(app) ?? -Infinity) < settings.throttle.app_gap_ms * (factor.get(app) ?? 1)) return count('throttled-app');
      lastGlobal = at; last.set(app, at);
      return count('taken');
    },
    /** Tells the governor whether the snapshot just taken for `app` differed from the one before. */
    report(app, changed) { factor.set(app, changed ? 1 : Math.min(settings.throttle.backoff_most, (factor.get(app) ?? 1) * 2)); if (!changed) counts.unchanged += 1; },
    counts: () => ({ ...counts }),
    factor: app => factor.get(app) ?? 1,
  };
}

export const triggerTools = {
  /** { app, elements } -> { rows }: the app's snapshot as redacted fields. */
  async parse(input) { return { rows: parseSnapshot(triggerSettings(), input.app, input.elements) }; },
};

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { parse } = triggerTools;
