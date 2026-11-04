// src/tool-write-class.mjs
//
// PURPOSE
//   Whether a tool changes anything, derived from the tool's own operation (src/tool-write-class.json), so a space's rules
//   can refuse writes without every tool declaring a flag that can drift from what it does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Derived, not declared: `read_only: true` is the only declaration read; otherwise the operation's leading verb decides.
//   2. An operation not understood is a write.
//   3. Nothing here names a tool; the verbs are DATA.
import rules from './tool-write-class.json' with { type: 'json' };

const READ = new Set(rules.read_verbs);

/** 'read' or 'write' for a tool descriptor ({ id, read_only?, invoke?: { action? } }). */
export function writeClassOf(tool) {
  if (tool?.read_only === true) return 'read';
  const operation = String(tool?.invoke?.action ?? String(tool?.id ?? '').replace(/^tool:/, '')).toLowerCase();
  const verb = operation.split('-')[0];
  return operation.includes('-') && READ.has(verb) ? 'read' : 'write';
}
