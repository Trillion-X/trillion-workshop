// bitfield/packages/adaptive-program-landing/read-data/weave-proof-items.ts
//
// Purpose
// -------
// Turn package-set DATA into the flat, self-describing proof list the shared
// marquee renders.
//
// Non-negotiable invariants
// -------------------------
// - NO SOURCE FIELD NAME APPEARS IN THIS FILE. A descriptor says which DATA
//   array a proof kind reads and which of that array's keys carry the generic
//   fields, so a package set whose records call a quote something else is a
//   DATA edit, never a code edit (machine-readable-over-shorthand: each mapping
//   is its own field, never an encoded path string).
// - THE WEAVE IS DATA. `pattern` states the repeating order, e.g. two quotes
//   then one clip. Changing the mix, or adding a third kind, is a DATA edit.
// - THE WEAVE ENDS WHEN THE LONGEST SOURCE RUNS OUT, and shorter sources cycle
//   underneath it until then. That is the only rule that needs no hand-tuned
//   count: add twenty quotes and they all appear; add one clip and it simply
//   recurs more often. A hardcoded length would silently drop new rows.
//
//   The stop matters as much as the start. An earlier draft ran whole pattern
//   cycles, so with two quote slots per cycle and an ODD number of quotes the
//   last cycle over-ran and wrapped, printing the first testimonial a second
//   time while claiming every row appeared once. Ending on the longest
//   source's last row instead of on a cycle boundary is what makes "consumed
//   exactly once" true for every count rather than only for even ones.

export type ProofSourceDescriptor = {
  /** Which proof kind the rendered item declares itself to be. */
  readonly as: 'media' | 'quote';
  /** Generic field name -> key to read from each row of the source array. */
  readonly fields: Readonly<Record<string, string>>;
  /** Which DATA array this kind reads. */
  readonly from: string;
};

export type ProofWeaveDescriptor = {
  /** Repeating order of source names, e.g. ["quote", "quote", "media"]. */
  readonly pattern: readonly string[];
  readonly sources: Readonly<Record<string, ProofSourceDescriptor>>;
};

export type WovenProofItem = Record<string, unknown> & { readonly kind: 'media' | 'quote' };

function decodeRow(row: Record<string, unknown>, descriptor: ProofSourceDescriptor, id: string): WovenProofItem {
  const decoded: Record<string, unknown> = { id, kind: descriptor.as };
  for (const [generic, sourceKey] of Object.entries(descriptor.fields)) {
    decoded[generic] = row[sourceKey];
  }
  return decoded as WovenProofItem;
}

export function weaveProofItems(
  data: Readonly<Record<string, unknown>>,
  weave: ProofWeaveDescriptor,
): WovenProofItem[] {
  const pattern = weave.pattern.filter((name) => weave.sources[name]);
  if (pattern.length === 0) return [];

  const rowsByName: Record<string, readonly Record<string, unknown>[]> = {};
  const slotsPerCycle: Record<string, number> = {};
  for (const name of pattern) {
    const from = weave.sources[name].from;
    const value = data[from];
    rowsByName[name] = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    slotsPerCycle[name] = (slotsPerCycle[name] ?? 0) + 1;
  }

  // The source that takes the most slots to exhaust sets the length of the
  // weave. Every other source wraps underneath it.
  const names = Object.keys(slotsPerCycle).filter((name) => rowsByName[name].length > 0);
  if (names.length === 0) return [];
  const longest = names.reduce((best, name) => (
    rowsByName[name].length / slotsPerCycle[name] > rowsByName[best].length / slotsPerCycle[best] ? name : best
  ), names[0]);
  const totalSlots = Math.ceil(rowsByName[longest].length / slotsPerCycle[longest]) * pattern.length;

  const cursors: Record<string, number> = {};
  const woven: WovenProofItem[] = [];
  for (let slot = 0; slot < totalSlots; slot += 1) {
    const name = pattern[slot % pattern.length];
    const rows = rowsByName[name];
    if (rows.length === 0) continue;
    const cursor = cursors[name] ?? 0;
    // The longest source is never wrapped: reaching its end ends the weave,
    // rather than running to a cycle boundary and repeating its first rows.
    if (name === longest && cursor >= rows.length) break;
    cursors[name] = cursor + 1;
    woven.push(decodeRow(rows[cursor % rows.length], weave.sources[name], `${name}-${cursor}`));
  }
  return woven;
}
