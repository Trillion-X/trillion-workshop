// packages/ui/read-data/reexport-binding-lint.ts
//
// Structural guard for the b277 crash class (2026-07-10): `export { x } from '…'`
// is a PURE re-export — it creates NO local binding, so a module that also USES
// `x` in its own code throws ReferenceError at runtime. esbuild bundles this
// silently; full tsc catches it but scoped tsc greps hide it; the crash is often
// content-gated so empty-state probes pass. This pure scanner finds the class in
// SOURCE TEXT so a vitest suite fails the moment anyone reintroduces it (L063 —
// the category dies structurally, not by review vigilance).
//
// Pure text analysis: no filesystem, no AST dependency. The caller feeds file
// text; heuristics are deliberately conservative (comments/strings/import-export
// lines stripped before counting uses) so barrels with descriptive headers never
// false-positive.

export interface ReexportBindingViolation {
  /** The symbol re-exported without a local binding. */
  readonly name: string;
  /** How many times the module's own CODE references it. */
  readonly uses: number;
}

const RE_EXPORT_CLAUSE = /export\s*\{([^}]+)\}\s*from\s*['"]/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Names re-exported via `export { … } from '…'` clauses (local-side names). */
function reexportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(RE_EXPORT_CLAUSE)) {
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim();
      if (!part || part.startsWith('type ')) continue;
      const local = part.split(' as ')[0].trim();
      if (IDENT.test(local)) names.add(local);
    }
  }
  return names;
}

/** The module's CODE text: comments, string/template literals, and import/export
 *  lines removed — what remains is where a bare identifier is a real reference. */
function codeText(source: string): string {
  let body = source.replace(/\/\/[^\n]*/g, '');
  body = body.replace(/\/\*[\s\S]*?\*\//g, '');
  body = body.replace(/'[^'\n]*'/g, "''");
  body = body.replace(/"[^"\n]*"/g, '""');
  body = body.replace(/`[^`]*`/g, '``');
  return body
    .split('\n')
    .filter((line) => !/^\s*(import|export)\b/.test(line))
    .join('\n');
}

/** True when the module IMPORTS `name` (any clause form), i.e. has a real binding. */
function importsName(source: string, name: string): boolean {
  const inBraces = new RegExp(`import\\s*(type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`);
  const asDefault = new RegExp(`import\\s+${name}\\b`);
  return inBraces.test(source) || asDefault.test(source);
}

/**
 * Scan one module's source for the b277 class: symbols the module re-exports,
 * USES in its own code, but never imports. Empty array = clean. A file with no
 * real code (a pure barrel) can never violate — its only lines are import/export.
 */
export function findReexportBindingViolations(source: string): ReexportBindingViolation[] {
  const names = reexportedNames(source);
  if (names.size === 0) return [];
  const code = codeText(source);
  // A pure barrel has no executable statements left after stripping — skip fast.
  if (!/\b(function|const|let|class|return|=>)\b/.test(code)) return [];
  const violations: ReexportBindingViolation[] = [];
  for (const name of names) {
    const uses = (code.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) ?? []).length;
    if (uses > 0 && !importsName(source, name)) violations.push({ name, uses });
  }
  return violations;
}
