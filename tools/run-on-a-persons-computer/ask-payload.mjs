// computer/ask-payload.mjs
//
// Purpose
//   The person's redaction for what the AI reads off this Mac's screen: `redactor` applies the DATA patterns to every
//   string of a screen read computer/drive-the-screen.mjs answers with, once the person has turned redaction on.
//
// Non-negotiable invariants
//   1. Redaction patterns and words are DATA (computer/ask-payload.json). Redaction is the person's choice (their own
//      file) and off until they choose.
//
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const askSettings = () => JSON.parse(readFileSync(path.join(HERE, 'ask-payload.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

const askPrefs = (settings, home = os.homedir()) => ({ ...settings.defaults, ...(readJson(expand(settings.prefs_file, home)) ?? {}) });

/** `text` with every pattern applied: { text, count }. */
export function redactText(settings, text) {
  let count = 0; let out = String(text);
  for (const row of settings.patterns) {
    let expression;
    try { expression = new RegExp(row.regex, 'g'); } catch { throw fail(fill(settings.words.bad_pattern, { id: row.id }), 500); }
    out = out.replace(expression, () => { count += 1; return row.replace; });
  }
  return { text: out, count };
}

/** A function that redacts every string inside a value when the person turned redaction on; the value itself when off. */
export function redactor(settings = askSettings(), home = os.homedir()) {
  if (askPrefs(settings, home).redact !== true) return value => value;
  const walk = value => typeof value === 'string' ? redactText(settings, value).text
    : Array.isArray(value) ? value.map(walk)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)])) : value;
  return walk;
}
