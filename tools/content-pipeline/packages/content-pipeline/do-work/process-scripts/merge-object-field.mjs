#!/usr/bin/env node
/**
 * file: packages/content-pipeline/do-work/process-scripts/merge-object-field.mjs
 *
 * PURPOSE: Generic single-key null-coalescing merge into an arbitrary-shape
 * object, invoked via CLI args (not a mounted JSON envelope) so each piece
 * of data can be independently sourced/transformed by the calling workflow
 * step's own binding chain (--base, --key, --value each resolve their own
 * $kind:"binding" transform chain before this process ever starts — see
 * workflow-core's resolve_value_recursive, which resolves every argv array
 * element independently). Returns base with base[key] = base[key] ?? value
 * applied — only fills the key when the base object doesn't already carry
 * a non-null, non-undefined value there. ZERO knowledge of what the object
 * or key represents (caption, title, anything) — reusable anywhere a
 * workflow needs to inject one field into an opaque, destination-owned
 * object without clobbering an explicit value the caller already set.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. ZERO domain vocabulary — no "caption", no "metadata", no destination
 *    concept anywhere in this file; those are all workflow-DATA choices
 *    made by the calling step's argv bindings, never by this script.
 * 2. Null-coalescing only — never overwrites a key the base object already
 *    sets to a non-null, non-undefined value.
 * 3. Boundary contract: --base (JSON string), --key (string), --value
 *    (string) in; merged object as JSON out (via --out).
 */
import fs from 'node:fs';

const arg = (key, fallback = null) => {
  const index = process.argv.indexOf(key);
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback;
};

const OUT = arg('--out', 'merged.json');
const base = JSON.parse(arg('--base', '{}'));
const key = arg('--key');
const value = arg('--value');

const source = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
const merged = { ...source, [key]: source[key] ?? value };

fs.writeFileSync(OUT, JSON.stringify(merged));
console.log(`[merge-object-field] key=${key} filled=${source[key] == null}`);
