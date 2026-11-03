// tools/how-someone-does-their-thing/read-data/edits.mjs
//
// Turns a writer's edits into candidate style rules. Each pair is a draft as written and the same draft as the person
// left it; the words that changed are found mechanically, and a change becomes a candidate only when it recurs in
// at least `min_distinct_drafts` different drafts. Invariants:
//   - It asks no model and keeps nothing. A candidate is a proposal for the person to approve; one draft never makes a rule.
//   - It names no phrase, writer or topic. Every phrase comes from the pairs it is given.
//   - It refuses what it cannot judge and says what to fix.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const need = (condition, message) => { if (!condition) throw new Error(message); };

export const DEFAULT_MIN_DISTINCT_DRAFTS = 3;
export const MAX_WORDS = 5000;

const words = (body) => body.split(/\s+/).filter(Boolean);
const bare = (word) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// The runs of words removed, added or replaced between two word lists, by their longest common run of (case- and edge-punctuation-blind) words.
function changes(before, after) {
  const left = before.map(bare);
  const right = after.map(bare);
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const found = [];
  let i = 0;
  let j = 0;
  let from = [];
  let to = [];
  const flush = () => {
    if (from.length || to.length) found.push({ from, to });
    from = [];
    to = [];
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { flush(); i += 1; j += 1; } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) { to.push(after[j]); j += 1; } else { from.push(before[i]); i += 1; }
  }
  flush();
  return found.map(({ from: removed, to: added }) => ({ from: removed.map(bare).filter(Boolean).join(' '), to: added.map(bare).filter(Boolean).join(' ') })).filter((change) => change.from || change.to);
}

/** Candidate rules from repeated edits. */
export function findRepeatedEdits(request) {
  need(isObject(request), 'give a request object');
  const minimum = request.min_distinct_drafts ?? DEFAULT_MIN_DISTINCT_DRAFTS;
  need(Number.isInteger(minimum) && minimum >= 2, 'min_distinct_drafts must be a whole number of at least 2: one draft never makes a rule');
  const pairs = request.pairs;
  need(Array.isArray(pairs) && pairs.every(isObject), 'pairs must be a list of { id, original, edited }');
  const ids = new Set();
  for (const [index, pair] of pairs.entries()) {
    need(text(pair.id), `pairs[${index}].id must name the draft, so a change counted in two pairs of one draft counts once`);
    need(typeof pair.original === 'string' && typeof pair.edited === 'string', `pairs[${index}] needs original and edited as text`);
    need(words(pair.original).length <= MAX_WORDS && words(pair.edited).length <= MAX_WORDS, `pairs[${index}] is over ${MAX_WORDS} words: send it in parts`);
    ids.add(text(pair.id));
  }
  need(ids.size >= minimum, `${ids.size} different draft${ids.size === 1 ? '' : 's'} sent, and a rule needs the same change in at least ${minimum}: send more edited drafts or lower min_distinct_drafts (not below 2)`);
  const seen = new Map();
  for (const pair of pairs) {
    for (const change of changes(words(pair.original), words(pair.edited))) {
      const key = `${change.from}\u0000${change.to}`;
      if (!seen.has(key)) seen.set(key, { ...change, drafts: new Map() });
      const entry = seen.get(key);
      if (!entry.drafts.has(text(pair.id))) entry.drafts.set(text(pair.id), pair);
    }
  }
  const candidates = [];
  let below = 0;
  for (const entry of seen.values()) {
    if (entry.drafts.size < minimum) { below += 1; continue; }
    const rule = entry.from && entry.to ? 'replace' : entry.from ? 'avoid' : 'add';
    const [id, pair] = entry.drafts.entries().next().value;
    candidates.push({ rule, from: entry.from, to: entry.to, distinct_drafts: entry.drafts.size, draft_ids: [...entry.drafts.keys()], example: { id, original: pair.original, edited: pair.edited } });
  }
  candidates.sort((a, b) => b.distinct_drafts - a.distinct_drafts || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    drafts: ids.size,
    min_distinct_drafts: minimum,
    candidates,
    below_threshold: below,
    said: candidates.length
      ? 'These are candidates only: show each to the person with its example and keep one as a rule only when they approve it, for example in their person layer.'
      : 'No change recurred in enough drafts to propose a rule.',
  };
}
