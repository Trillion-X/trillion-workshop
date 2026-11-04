// parts/ai-tool-catalog/read-data/declared-effects.ts
//
// PURPOSE
//   What a tool's run changes on the screens that show it, declared once on the tool's own row (`effects`), so every
//   place that runs the tool (the web, the native apps, an AI over MCP) refreshes or patches the same reads the same way,
//   and no screen hand-writes what a run changed.
//
// SHAPE (DATA on the tool row, machine readable, no string templates)
//   effects: [{ on: "mutate" | "success", action: "update" | "invalidate", read: Part[], merge?: Merge }]
//   Part   = "literal text" | { from: "input" | "output", path: ["key", ...] }   joined into the read's address, each
//            value part address-encoded.
//   Merge  = { at: ["key", ...], op: "set" | "append" | "replace" | "remove", match?: "key", value: Part-like ref | { value } }
//   `mutate` effects are what a caller may show as soon as the call starts; `success` effects hold once it completed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One reader: `declaredEffectsProblem` (the catalog decoder refuses a malformed row with it) and `effectsAt` (every
//      runner resolves a phase's effects from it) are the only code that reads `effects`.
//   2. An effect whose read names a value the call does not have is left out, never sent to a half-built address.
//   3. `applyMerge` never changes what it is given: it answers a new value, or the same value when the path is not there.
//   4. Blind: nothing here names a tool, a read or a screen.

export type EffectPart = string | { from: 'input' | 'output'; path: string[] };
export type EffectValue = { from: 'input' | 'output'; path: string[] } | { value: unknown };
export type EffectMerge = { at: string[]; op: 'set' | 'append' | 'replace' | 'remove'; match?: string; value: EffectValue };
export type DeclaredEffect = { on: 'mutate' | 'success'; action: 'update' | 'invalidate'; read: EffectPart[]; merge?: EffectMerge };
/** One effect resolved for one call: the read's address and, for an update, the merge with its value filled. */
export type ResolvedEffect = { action: 'update' | 'invalidate'; read: string; merge?: { at: string[]; op: EffectMerge['op']; match?: string; value: unknown } };

const PHASES = new Set(['mutate', 'success']);
const ACTIONS = new Set(['update', 'invalidate']);
const OPS = new Set(['set', 'append', 'replace', 'remove']);
const SOURCES = new Set(['input', 'output']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every(key => typeof key === 'string' && key.length > 0);
const isRef = (value: unknown) => isRecord(value) && Object.keys(value).length === 2 && SOURCES.has(value.from as string) && isPath(value.path) && (value.path as string[]).length > 0;

/** What is wrong with a row's `effects`, or null when it is absent or well formed. */
export function declaredEffectsProblem(effects: unknown, most = 20): string | null {
  if (effects === undefined) return null;
  if (!Array.isArray(effects) || !effects.length || effects.length > most) return `effects must be a list of 1 to ${most} effects`;
  for (const effect of effects) {
    if (!isRecord(effect) || !PHASES.has(effect.on as string) || !ACTIONS.has(effect.action as string)) return 'each effect needs on (mutate or success) and action (update or invalidate)';
    if (!Array.isArray(effect.read) || !effect.read.length || !effect.read.every(part => (typeof part === 'string' && part.length > 0) || isRef(part))) return 'each effect read is a list of literal text and { from, path } values';
    if (typeof effect.read[0] !== 'string' || !effect.read[0].startsWith('/')) return 'each effect read starts with the literal address of a read, beginning with /';
    if (effect.action === 'invalidate' && effect.merge !== undefined) return 'an invalidate effect has no merge';
    if (effect.action === 'update') {
      const merge = effect.merge;
      if (!isRecord(merge) || !isPath(merge.at) || !OPS.has(merge.op as string)) return 'an update effect needs merge { at, op (set, append, replace or remove), value }';
      if (!(isRef(merge.value) || (isRecord(merge.value) && Object.keys(merge.value).length === 1 && 'value' in merge.value))) return 'merge.value is { from, path } or { value }';
      if ((merge.op === 'replace' || merge.op === 'remove') && (typeof merge.match !== 'string' || !merge.match)) return 'a replace or remove merge names the key it matches items by (match)';
    }
  }
  return null;
}

const valueAt = (value: unknown, path: string[]): unknown => path.reduce<unknown>((at, key) => (isRecord(at) || Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined), value);

/** A phase's effects of one call, resolved from its input (and output, once it has one); invariant 2. */
export function effectsAt(effects: readonly DeclaredEffect[] | undefined, phase: 'mutate' | 'success', call: { input?: unknown; output?: unknown }): ResolvedEffect[] {
  const resolved: ResolvedEffect[] = [];
  for (const effect of effects ?? []) {
    if (effect.on !== phase) continue;
    const parts = effect.read.map(part => (typeof part === 'string' ? part : valueAt(call[part.from], part.path)));
    if (parts.some(part => part === undefined || part === null || (typeof part === 'object'))) continue;
    const read = parts.map((part, index) => (typeof effect.read[index] === 'string' ? String(part) : encodeURIComponent(String(part)))).join('');
    if (effect.action === 'invalidate' || !effect.merge) { resolved.push({ action: 'invalidate', read }); continue; }
    const source = effect.merge.value;
    const value = 'value' in source ? source.value : valueAt(call[source.from], source.path);
    if (value === undefined) continue;
    resolved.push({ action: 'update', read, merge: { at: effect.merge.at, op: effect.merge.op, ...(effect.merge.match ? { match: effect.merge.match } : {}), value } });
  }
  return resolved;
}

/** The reads a call's resolved effects name, once each. */
export const effectReads = (effects: readonly ResolvedEffect[] | undefined) => [...new Set((effects ?? []).map(effect => effect.read))];

/** A read's answer with one resolved merge laid on it (invariant 3). */
export function applyMerge<T>(answer: T, merge: NonNullable<ResolvedEffect['merge']>): T {
  const place = (at: unknown, path: string[]): unknown => {
    if (!path.length) return change(at);
    if (!isRecord(at)) return at;
    const [key, ...rest] = path;
    if (!(key in at) && rest.length) return at;
    return { ...at, [key]: place(at[key], rest) };
  };
  // An item is the merge's own when its `match` key holds the merge value's (or the merge value itself, a bare key).
  const key = isRecord(merge.value) && merge.match !== undefined ? merge.value[merge.match] : merge.value;
  const same = (item: unknown) => isRecord(item) && merge.match !== undefined && item[merge.match] === key;
  const change = (at: unknown): unknown => {
    if (merge.op === 'set') return merge.value;
    const list = Array.isArray(at) ? at : at === undefined ? [] : null;
    if (!list) return at;
    if (merge.op === 'append') return [...list, merge.value];
    if (merge.op === 'replace') return list.map(item => (same(item) ? merge.value : item));
    return list.filter(item => !same(item));
  };
  return place(answer, merge.at) as T;
}
