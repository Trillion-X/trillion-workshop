// scripts/one-copy-of-each-rule.mjs
//
// One copy of each rule in a joined stylesheet. The workspace stylesheet is many looks joined (scripts/build-workspace.mjs):
// a library stylesheet a screen imports arrives once per bundle chunk that imports it, and the minifier drops a rule
// repeated later only when it can prove the copies equal, which it cannot for a rule holding url(...) (so a colour
// picker's five rules arrived 21 times, 56 KB). This pass keeps the last copy of every byte-identical top-level rule
// or rule block and drops the earlier ones.
//
// Invariants:
//  1. The cascade is unchanged: of identical copies the last one already decides, and the last one stays where it was.
//  2. Statements (@layer a, b; @import ...; @charset ...) are kept as they are, every copy: the first @layer naming a
//     layer fixes the layers' order, so dropping one could reorder them. A whole @layer block is kept every copy too.
//  3. It reads minified CSS: quotes, escapes and comments are skipped when finding where a rule ends, so a brace inside
//     a string (content: "}") never ends one.
//  4. It names no library, file or rule: any repeat from anywhere goes.

/** The top-level units of `css` in order: each `{ text, block }`, block true for a rule or at-rule with a body. */
export function topLevelUnits(css) {
  const units = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '"' || char === "'") {
      for (index += 1; index < css.length && css[index] !== char; index += 1) if (css[index] === '\\') index += 1;
      continue;
    }
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      index = end === -1 ? css.length : end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { units.push({ text: css.slice(start, index + 1), block: true }); start = index + 1; }
    } else if (char === ';' && depth === 0) {
      units.push({ text: css.slice(start, index + 1), block: false });
      start = index + 1;
    }
  }
  if (start < css.length) units.push({ text: css.slice(start), block: false });
  return units;
}

/** `css` with every byte-identical top-level rule or rule block kept only at its last place (invariant 1). */
export function oneCopyOfEachRule(css) {
  const units = topLevelUnits(css);
  const last = new Map();
  units.forEach((unit, index) => {
    if (unit.block && !/^\s*@layer\b/i.test(unit.text)) last.set(unit.text.trim(), index);
  });
  return units
    .filter((unit, index) => !unit.block || /^\s*@layer\b/i.test(unit.text) || last.get(unit.text.trim()) === index)
    .map(unit => unit.text)
    .join('');
}
