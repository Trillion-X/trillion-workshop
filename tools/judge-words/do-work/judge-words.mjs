// tools/judge-words/do-work/judge-words.mjs
//
// Purpose
//   Judges words a person will read, and any JSON a person makes (a plan, a take's measures, a report), against rule
//   rows, and says which rows it breaks, with why and what to do instead. The rules are DATA the caller hands in; this
//   file knows no product, no person, no word list, no kind and no file. The Workshop tool `tool:judge-against-rules`
//   (do-work/judge-against-rules.mjs) runs it, and any check may import it (part.json), so one row is judged the same
//   way wherever it is used.
//
// Non-negotiable invariants
//   1. A rule is one row: `words` (whole words or phrases, any case), `pattern` (a regular expression with `flags`),
//      `exact` (the whole text is one of these), `check` (one of the named grammar checks in CHECKS below) or `path`
//      (invariant 6). A rule may narrow itself to some keys (`fields`) or to text somewhere under a key (`under`).
//      Adding a rule is adding a row; no rule is named in code.
//   2. `wordsIn` walks any JSON value and returns every string a person reads, with the path it sits at. Which keys
//      hold words is the owner's DATA (`fields`, a list of keys, or "strings" for every string but `skip_keys` and
//      exact `skip_paths`, which may use `*` for one array element or key).
//   3. Findings are machine-readable: { rule, says, text?, found, path?, kind?, test?, limit?, suggest?, because?,
//      at_most? }. Nothing is thrown for a finding; callers decide what it refuses.
//   4. A text containing one of a rule's `allow` phrases is never flagged by that rule.
//   5. A rule with `kinds` applies only to an item whose `kind` it lists; an item of no kind is of no listed kind. A
//      kind is a caller's DATA word, never named here.
//   6. A rule may select values instead of words: `path` (a dot path, `*` for one segment, `**` for any depth) picks
//      every value at that path in an item's `value` (any JSON). Word rules read an item's `text`; `path` rules read
//      its `value`. `where` (a value or a list of values) keeps only the selected pieces equal to one of them.
//      `when` (one { path, where } or a list of them) chooses the items a rule is for by the same selection: the rule
//      applies only to an item whose `value` holds, at every `when` path, a value equal to one of its `where` (a plan
//      whose format field is one format). An item with no `value` meets no `when`.
//   7. A rule may name tests from TESTS below over the pieces it selects; each says what must hold, and its finding
//      says what was found instead. A rule without a test flags every piece it selects. A value test that selects
//      nothing is a finding: nothing passes on silence.
//   8. A finding carries its rule's `because` (the records the rule came from) and `at_most` (the most an inferred
//      rule's finding may decide) unchanged. `judge` never lets a capped finding fail: when every finding is capped,
//      the answer holds (status "held"), and it passes only with no finding at all.
//   9. A rule may select named groups instead of single matches: `groups` (a list of { id, label?, words?,
//      patterns?, weight?, apart_at_least? }) picks each group one of whose markers (a whole word, or a regular
//      expression with the row's `flags`) is in the text, once per group. Which groups, which markers, what share
//      must be found and what weight each carries are the row's DATA; no framework, feeling or protocol is named here.
//   10. A rule with `across: true` is judged once over every item it applies to, as one whole (a script of many
//      lines), instead of once per item: its tests hold or fail for the whole. A group with `apart_at_least` is found
//      only when one of its markers is in two items at least that many items apart (said again later), so it needs
//      `across`.
//   11. A rule may name an evidence check (`evidence`, one of EVIDENCE_CHECKS in do-work/evidence-checks.mjs) over an
//      item's `value`: the reason codes it returns are what it selects. Evidence checks never mint or authenticate.
//   12. Each rule that applies scores 100 when it found nothing, its share found when a share test did not hold
//      (`percent_found_at_least`, `includes_all`), and 0 otherwise; `judge` gives the weighted mean as `score` (each
//      row's `weight`, 1 when it names none), and fails when the request's `min_score` is above it, even when every
//      finding is capped. The minimum is the caller's; nothing here has one.
//   13. A word finding carries the `offset` of its match in the item's text, unless the row's `normalize` (NFKC,
//      whitespace) changed the text, when there is no offset to give.
//
// Ported in part from bitfield-packages packages/content-gate (its pattern, required-kinds, kind-order, length-bound,
// emotion, framework, retention, voice, humor and evidence evaluators): each of those is now a row of this judge, a
// group, a test or an evidence check, so there is one judge.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { EVIDENCE_CHECKS, EVIDENCE_CHECK_NAMES } from './evidence-checks.mjs';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lower = value => value.toLowerCase();

// The normalizations a row may name in `normalize`, applied in the row's order before its words are read.
const NORMALIZERS = {
  nfkc: text => text.normalize('NFKC'),
  whitespace: text => text.replace(/\s+/gu, ' ').trim(),
};

export const NORMALIZE_NAMES = Object.freeze(Object.keys(NORMALIZERS));

// The grammar checks a rule may name. Each takes the text and its rule and returns the pieces it found wrong.
const CHECKS = {
  // A sentence starts with a capital letter after a full stop, question mark or exclamation mark. The full stop of an
  // abbreviation (e.g., i.e., etc., vs.) or of a list marker at the start of a line (digits or one letter, then "." or ")":
  // "1. open the box", "b. close it") ends no sentence, and a marker letter that starts a new line ("the lid.\nc. rest") starts none.
  'capital-after-stop': text => [...text.matchAll(/[.!?]\s+([a-z])/g)]
    .filter(match => !/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(text.slice(0, match.index + 1)))
    .filter(match => !/(?:^|\n)[ \t]*(?:\d+|[A-Za-z])[.)]$/.test(text.slice(0, match.index + 1)))
    .filter(match => !(match[0].includes('\n') && /^[a-z][.)]\s/.test(text.slice(match.index + match[0].length - 1))))
    .map(match => match[0]),
  // A sentence starts with a capital letter.
  'starts-with-capital': text => (/^[\s"“(]*[a-z]/.test(text) ? [text.trim().slice(0, 24)] : []),
  // A sentence ends with a full stop, a question mark or an exclamation mark (a closing quote or bracket may follow).
  'ends-with-stop': text => (/[.!?…]["'”)\]]?$/.test(text.trim()) ? [] : [text.trim().slice(-24)]),
  // The same word twice in a row ("the the").
  'doubled-word': text => [...text.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)].filter(match => !/^(?:that|had)$/i.test(match[1])).map(match => match[0]),
  // "a" before a vowel sound; the rule's `allow` lists word starts that sound like a consonant (one, use, user).
  'a-before-vowel': (text, rule) => [...text.matchAll(/\b[Aa] ([AaEeIiOoUu][\w'-]*)/g)]
    .filter(match => !(rule.vowel_letters_with_consonant_sound ?? []).some(start => lower(match[1]).startsWith(lower(start))))
    .map(match => match[0]),
  // Every opening bracket or curly quote has its closing one, and straight double quotes come in pairs.
  'balanced-brackets': text => {
    const pairs = { '(': ')', '[': ']', '“': '”' };
    const closers = new Set(Object.values(pairs));
    const stack = [];
    for (const char of text) {
      if (pairs[char]) stack.push(pairs[char]);
      else if (closers.has(char) && stack.pop() !== char) return [char];
    }
    const straight = (text.match(/"/g) ?? []).length;
    return [...stack, ...(straight % 2 ? ['"'] : [])];
  },
  // No space before a comma, full stop, colon, semicolon, question or exclamation mark.
  'space-before-punctuation': text => [...text.matchAll(/\w\s+[,.;:!?](?=\s|$)/g)].map(match => match[0]),
  // One space between words.
  'double-space': text => [...text.matchAll(/\S {2,}\S/g)].map(match => match[0]),
};

export const CHECK_NAMES = Object.freeze(Object.keys(CHECKS));

const same = (one, other) => one === other || JSON.stringify(one) === JSON.stringify(other);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const shown = value => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));
// The selected pieces that break a value test; selecting nothing breaks it once, found as null.
const outside = (pieces, holds) => (pieces.length ? pieces.filter(piece => !holds(piece.value)) : [{ value: null }]);

// The tests a rule may name over the pieces it selects. `find` returns what was found instead of what must hold, as
// pieces { value, path? } (one finding each); `said` puts one finding in words. `limit` is the rule's own value.
const TESTS = {
  // At least one piece is selected: the positive form of a rule ("use one of these").
  required: {
    valid: limit => typeof limit === 'boolean',
    find: (pieces, limit) => (limit && !pieces.length ? [{ value: 0 }] : []),
    said: () => 'none found',
  },
  count_at_least: {
    valid: isNumber,
    find: (pieces, limit) => (pieces.length < limit ? [{ value: pieces.length }] : []),
    said: (found, limit) => `${found} found, at least ${limit} needed`,
  },
  count_at_most: {
    valid: isNumber,
    find: (pieces, limit) => (pieces.length > limit ? [{ value: pieces.length }] : []),
    said: (found, limit) => `${found} found, at most ${limit} allowed`,
  },
  value_at_least: {
    valid: isNumber,
    find: (pieces, limit) => outside(pieces, value => isNumber(value) && value >= limit),
    said: (found, limit) => (found === null ? 'no value found' : `${shown(found)} is not a number of at least ${limit}`),
  },
  value_at_most: {
    valid: isNumber,
    find: (pieces, limit) => outside(pieces, value => isNumber(value) && value <= limit),
    said: (found, limit) => (found === null ? 'no value found' : `${shown(found)} is not a number of at most ${limit}`),
  },
  equals: {
    valid: Array.isArray,
    find: (pieces, limit) => outside(pieces, value => limit.some(one => same(one, value))),
    said: (found, limit) => (found === null ? 'no value found' : `${shown(found)} is not one of ${limit.map(shown).join(', ')}`),
  },
  // Every listed value is among the selected values ("each of these parts is there"); one finding for each one that
  // is not, scored by the share that is.
  includes_all: {
    valid: limit => Array.isArray(limit) && limit.length > 0,
    find: (pieces, limit) => {
      const missing = limit.filter(one => !pieces.some(piece => same(piece.value, one)));
      return missing.map(value => ({ value, score: ((limit.length - missing.length) / limit.length) * 100 }));
    },
    said: found => `${shown(found)} not found`,
  },
  // The selected values that are in the list come in the list's order; a value may repeat, and values not in the list
  // are passed over. Selecting nothing is a finding.
  in_order: {
    valid: limit => Array.isArray(limit) && limit.length > 0,
    find: (pieces, limit) => {
      if (!pieces.length) return [{ value: null }];
      const listed = pieces.map(piece => piece.value).filter(value => limit.some(one => same(one, value)));
      let cursor = 0;
      for (const value of listed) {
        const at = limit.findIndex((one, index) => index >= cursor && same(one, value));
        if (at === -1) return [{ value: listed }];
        cursor = at;
      }
      return [];
    },
    said: (found, limit) => (found === null ? 'no value found'
      : `${found.map(shown).join(', ')} is not in the order ${limit.map(shown).join(', ')}`),
  },
  // Some one selected value (any case) is found at least this many times.
  repeated_at_least: {
    valid: isNumber,
    find: (pieces, limit) => {
      const counts = new Map();
      for (const piece of pieces) {
        const key = typeof piece.value === 'string' ? lower(piece.value) : JSON.stringify(piece.value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const most = Math.max(0, ...counts.values());
      return most < limit ? [{ value: most }] : [];
    },
    said: (found, limit) => `the most anything is said is ${found} time${found === 1 ? '' : 's'}, at least ${limit} needed`,
  },
  // At least this share (0 to 100) of the row's groups is found, each group counting by its weight. Scored by the share.
  percent_found_at_least: {
    valid: isNumber,
    groups: true,
    find: (pieces, limit, rule) => {
      const found = new Set(pieces.map(piece => piece.value));
      const weightOf = group => group.weight ?? 1;
      const total = rule.groups.reduce((sum, group) => sum + weightOf(group), 0);
      const share = total === 0 ? 100 : (rule.groups.filter(group => found.has(group.id)).reduce((sum, group) => sum + weightOf(group), 0) / total) * 100;
      return share < limit ? [{ value: share, score: share, missing: rule.groups.filter(group => !found.has(group.id)).map(group => group.label ?? group.id) }] : [];
    },
    said: (found, limit, finding) => `${Math.round(found * 10) / 10}% found, at least ${limit}% needed`
      + (finding.missing?.length ? `; not found: ${finding.missing.join(', ')}` : ''),
  },
  // At least this many of the row's groups are found together in one item (some line holds them at once).
  together_at_least: {
    valid: isNumber,
    groups: true,
    across: true,
    find: (pieces, limit) => {
      const perItem = new Map();
      for (const piece of pieces) for (const item of piece.items) perItem.set(item, (perItem.get(item) ?? 0) + 1);
      const most = Math.max(0, ...perItem.values());
      return most < limit ? [{ value: most }] : [];
    },
    said: (found, limit) => `at most ${found} found together in one item, at least ${limit} needed`,
  },
};

export const TEST_NAMES = Object.freeze(Object.keys(TESTS));
export const SELECTOR_NAMES = Object.freeze(['words', 'pattern', 'exact', 'check', 'groups', 'path', 'evidence']);

// A dot path as its segments; `*` is one segment and `**` any depth.
function dotPath(path, what) {
  if (typeof path !== 'string' || !path || path.split('.').some(part => !part)) throw new TypeError(`${what} must be a nonempty dot path.`);
  return path.split('.');
}

// Whether a path pattern's segments select a concrete path.
function pathMatches(parts, path) {
  const memo = new Map();
  const visit = (pi, at) => {
    const key = `${pi}:${at}`;
    if (memo.has(key)) return memo.get(key);
    const found = pi === parts.length ? at === path.length
      : parts[pi] === '**' ? visit(pi + 1, at) || (at < path.length && visit(pi, at + 1))
      : at < path.length && (parts[pi] === '*' || parts[pi] === String(path[at])) && visit(pi + 1, at + 1);
    memo.set(key, found);
    return found;
  };
  return visit(0, 0);
}

/** Every value in `value` (any JSON node, not only leaves) whose path a dot path selects, as { value, path }. */
export function valuesAt(value, path) {
  const parts = Array.isArray(path) ? path : dotPath(path, 'A value path');
  const found = [];
  const walk = (node, at) => {
    if (pathMatches(parts, at)) found.push({ value: node, path: at });
    if (Array.isArray(node)) node.forEach((child, index) => walk(child, [...at, index]));
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, [...at, key]);
  };
  walk(value, []);
  return found;
}

// A whole-word matcher for a list of words or phrases, any case.
const wordsPattern = (words, flags) => new RegExp(`(?<![\\w-])(?:${words.map(escape).join('|')})(?![\\w-])`, flags);
const withoutG = flags => (flags ?? '').replace(/g/g, '');

// One group of a `groups` row compiled once: its markers, each a regular expression that finds it in a text.
function compileGroup(group, rule) {
  const named = `Rule ${rule.id} group ${group?.id}`;
  if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id) throw new Error(`Rule ${rule.id} groups need an id each.`);
  const words = Array.isArray(group.words) ? group.words : [];
  const patterns = Array.isArray(group.patterns) ? group.patterns : [];
  if (![...words, ...patterns].length || [...words, ...patterns].some(marker => typeof marker !== 'string' || !marker)) {
    throw new Error(`${named} needs words or patterns.`);
  }
  if (group.weight !== undefined && !(isNumber(group.weight) && group.weight >= 0)) throw new Error(`${named} weight must be a number of at least 0.`);
  if (group.apart_at_least !== undefined && !(isNumber(group.apart_at_least) && group.apart_at_least >= 1)) {
    throw new Error(`${named} apart_at_least must be a number of at least 1.`);
  }
  if (group.apart_at_least !== undefined && rule.across !== true) throw new Error(`${named} apart_at_least needs the row to be across: true.`);
  return { ...group, markers: [...words.map(word => wordsPattern([word], 'i')), ...patterns.map(source => new RegExp(source, withoutG(rule.flags)))] };
}

// The groups a `groups` row found, from pieces of single items: one piece per group, the items it was found in, and
// for a group with `apart_at_least`, only when one marker is in two items that far apart.
function mergeGroups(pieces, groups) {
  const byId = new Map();
  for (const piece of pieces) {
    const merged = byId.get(piece.value) ?? { value: piece.value, items: [], markers: new Map() };
    merged.items.push(...piece.items);
    for (const marker of piece.markers) merged.markers.set(marker, [...(merged.markers.get(marker) ?? []), ...piece.items]);
    byId.set(piece.value, merged);
  }
  // Two consecutive items holding one marker are at least `limit` items apart.
  const apartBy = limit => items => [...new Set(items)].sort((one, other) => one - other)
    .some((item, at, sorted) => at > 0 && item - sorted[at - 1] >= limit);
  return groups.filter(group => byId.has(group.id)
    && (group.apart_at_least === undefined || [...byId.get(group.id).markers.values()].some(apartBy(group.apart_at_least))))
    .map(group => ({ value: group.id, items: [...new Set(byId.get(group.id).items)] }));
}

// One rule compiled once: `pieces` selects from one item (its index given), `findings` judges selected pieces (one
// item's, or every item's for a rule `across`), each finding { found, path?, offset?, index?, test?, limit?, missing?,
// score? }.
function compile(rule) {
  const allow = (rule.allow ?? []).map(lower);
  const allowed = text => allow.some(phrase => lower(text).includes(phrase));
  if (rule.normalize !== undefined && (!Array.isArray(rule.normalize) || rule.normalize.some(name => !NORMALIZERS[name]))) {
    throw new Error(`Rule ${rule.id} normalize must be a list of ${NORMALIZE_NAMES.join(', ')}.`);
  }
  const normalizers = (rule.normalize ?? []).map(name => NORMALIZERS[name]);
  const textOf = item => normalizers.reduce((text, normalize) => normalize(text), item.text);
  // Offsets are in the item's own text; a normalized text has none to give.
  const matched = (item, pattern) => [...textOf(item).matchAll(pattern)]
    .map(match => ({ value: match[0], ...(normalizers.length ? {} : { offset: match.index }) }));
  const pieces = matches => matches.map(found => ({ value: found }));
  let select;
  let groups = null;
  if (Array.isArray(rule.words) && rule.words.length) {
    const pattern = wordsPattern(rule.words, 'gi');
    select = item => matched(item, pattern);
  } else if (typeof rule.pattern === 'string') {
    const pattern = new RegExp(rule.pattern, (rule.flags ?? '').includes('g') ? rule.flags : `${rule.flags ?? ''}g`);
    select = item => matched(item, pattern);
  } else if (Array.isArray(rule.exact)) {
    const exact = new Set(rule.exact.map(value => lower(value.trim())));
    select = item => pieces(exact.has(lower(textOf(item).trim())) ? [textOf(item).trim()] : []);
  } else if (typeof rule.check === 'string') {
    const check = CHECKS[rule.check];
    if (!check) throw new Error(`Rule ${rule.id} names the check ${rule.check}; the checks are ${CHECK_NAMES.join(', ')}.`);
    select = item => pieces(check(textOf(item), rule));
  } else if (Array.isArray(rule.groups) && rule.groups.length) {
    groups = rule.groups.map(group => compileGroup(group, rule));
    select = (item, index) => {
      const text = textOf(item);
      return groups.flatMap(group => {
        const markers = group.markers.flatMap((marker, at) => (marker.test(text) ? [at] : []));
        return markers.length ? [{ value: group.id, items: [index], markers }] : [];
      });
    };
  } else if (rule.path !== undefined) {
    const parts = dotPath(rule.path, `Rule ${rule.id} path`);
    select = item => valuesAt(item.value, parts).map(piece => ({ value: piece.value, path: [...(item.path ?? []), ...piece.path] }));
  } else if (typeof rule.evidence === 'string') {
    const check = EVIDENCE_CHECKS[rule.evidence];
    if (!check) throw new Error(`Rule ${rule.id} names the evidence check ${rule.evidence}; the evidence checks are ${EVIDENCE_CHECK_NAMES.join(', ')}.`);
    select = item => check(item.value, rule);
  } else {
    throw new Error(`Rule ${rule.id} needs ${SELECTOR_NAMES.slice(0, -1).join(', ')} or ${SELECTOR_NAMES.at(-1)}.`);
  }
  if (rule.kinds !== undefined && (!Array.isArray(rule.kinds) || !rule.kinds.length || rule.kinds.some(kind => typeof kind !== 'string'))) {
    throw new Error(`Rule ${rule.id} kinds must be a nonempty list of kind words.`);
  }
  if (rule.across !== undefined && typeof rule.across !== 'boolean') throw new Error(`Rule ${rule.id} across must be true or false.`);
  if (rule.weight !== undefined && !(isNumber(rule.weight) && rule.weight >= 0)) throw new Error(`Rule ${rule.id} weight must be a number of at least 0.`);
  whenOf(rule);
  const wanted = rule.where === undefined ? null : Array.isArray(rule.where) ? rule.where : [rule.where];
  if (rule.where_pattern !== undefined && typeof rule.where_pattern !== 'string') throw new Error(`Rule ${rule.id} where_pattern must be a regular expression.`);
  const wherePattern = typeof rule.where_pattern === 'string' ? new RegExp(rule.where_pattern, withoutG(rule.flags)) : null;
  const tests = TEST_NAMES.filter(name => rule[name] !== undefined).map(name => {
    if (!TESTS[name].valid(rule[name])) throw new Error(`Rule ${rule.id} ${name} has the wrong kind of value.`);
    if (TESTS[name].groups && !groups) throw new Error(`Rule ${rule.id} ${name} needs groups.`);
    if (TESTS[name].across && rule.across !== true) throw new Error(`Rule ${rule.id} ${name} needs the row to be across: true.`);
    return { name, limit: rule[name], find: TESTS[name].find };
  });
  return {
    across: rule.across === true,
    // An item holding one of the row's `allow` phrases is out of the row altogether.
    skips: item => typeof item.text === 'string' && allowed(item.text),
    pieces: (item, index) => select(item, index).filter(piece => (!wanted || wanted.some(one => same(one, piece.value)))
      && (!wherePattern || (typeof piece.value === 'string' && wherePattern.test(piece.value)))),
    findings: raw => {
      const selected = groups ? mergeGroups(raw, groups) : raw;
      const located = piece => ({ path: piece.path, offset: piece.offset, index: piece.index });
      if (!tests.length) return selected.map(piece => ({ found: piece.value, ...located(piece) }));
      return tests.flatMap(test => test.find(selected, test.limit, rule).map(piece => ({ found: piece.value, ...located(piece),
        test: test.name, limit: test.limit, missing: piece.missing, score: piece.score })));
    },
  };
}

// A rule's `when` as a list of { parts, wanted }; a `when` that is not one { path, where } or a nonempty list of them throws.
function whenOf(rule) {
  if (rule.when === undefined) return [];
  const list = Array.isArray(rule.when) ? rule.when : [rule.when];
  if (!list.length || list.some(one => !one || typeof one !== 'object' || Array.isArray(one) || one.where === undefined)) {
    throw new TypeError(`Rule ${rule.id} when must be one { path, where } or a nonempty list of them.`);
  }
  return list.map(one => ({ parts: dotPath(one.path, `Rule ${rule.id} when path`), wanted: Array.isArray(one.where) ? one.where : [one.where] }));
}

// A rule applies to an item when its `kinds` (if any) list the item's kind, its `when` (if any) holds in the item's
// `value`, it reads what the item carries (a `path` rule needs a `value`; a word rule is not for an item that carries a
// `value` and no `text`), its `fields` (if any) name the item's key and its `under` (if any) is in the item's path.
// An `evidence` rule reads a `value` as a `path` rule does.
export function ruleApplies(rule, item) {
  if (Array.isArray(rule.kinds) && !rule.kinds.includes(item.kind)) return false;
  if (!whenOf(rule).every(({ parts, wanted }) => item.value !== undefined
    && valuesAt(item.value, parts).some(piece => wanted.some(one => same(one, piece.value))))) return false;
  const readsValue = rule.path !== undefined || rule.evidence !== undefined;
  if (readsValue ? item.value === undefined : item.value !== undefined && typeof item.text !== 'string') return false;
  if (Array.isArray(rule.fields) && rule.fields.length && !rule.fields.includes(item.field)) return false;
  if (typeof rule.under === 'string' && !(item.path ?? []).includes(rule.under)) return false;
  return true;
}

/**
 * Every raw string leaf in `value`, as { text, field, path }. `owner.fields` is a list of keys to select, or
 * "strings" for every string not under one of `owner.skip_keys` or `owner.skip_paths`. Optional `paths` narrows
 * those strings to declared dot paths: `*` selects one segment and `**` selects any depth. Source quotes and IDs
 * need not be submitted merely because an authored label elsewhere uses the same key.
 */
export function stringsIn(value, owner = { fields: 'strings' }) {
  const keys = Array.isArray(owner.fields) ? new Set(owner.fields) : null;
  const skip = new Set(owner.skip_keys ?? []);
  const skipPaths = (owner.skip_paths ?? []).map(path => path.split('.'));
  if (owner.paths !== undefined && (!Array.isArray(owner.paths)
      || owner.paths.some(path => typeof path !== 'string' || !path || path.split('.').some(part => !part)))) {
    throw new TypeError('Word owner paths must be a list of nonempty dot paths.');
  }
  const paths = owner.paths?.map(path => path.split('.')) ?? null;
  const found = [];
  const walk = (node, path, field) => {
    if (skipPaths.some(parts => parts.length === path.length && parts.every((part, at) => part === '*' || part === String(path[at])))) return;
    if (typeof node === 'string') {
      if ((keys ? keys.has(field) : true) && (!paths || paths.some(parts => pathMatches(parts, path)))) {
        found.push({ text: node, field, path });
      }
      return;
    }
    if (Array.isArray(node)) node.forEach((child, at) => walk(child, [...path, at], field));
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) if (!skip.has(key)) walk(child, [...path, key], key);
    }
  };
  walk(value, [], null);
  return found;
}

/** Words are the nonempty-text projection of the same owner-selected raw strings. */
export function wordsIn(value, owner = { fields: 'strings' }) {
  return stringsIn(value, owner).filter(item => item.text.trim());
}

/**
 * Compile `rules` once; the judge takes items and returns findings. An item is plain text, { text, field?, path?,
 * kind? } for words, or { value, path?, kind? } for any JSON that `path` and `evidence` rules read. Findings of rules
 * judged per item come item by item; findings of rules `across` come after them, rule by rule.
 */
export function makeJudge(rules) {
  const compiled = rules.map(rule => ({ rule, ...compile(rule) }));
  return items => {
    const list = items.map(entry => (typeof entry === 'string' ? { text: entry, field: null, path: [] } : entry));
    const findings = [];
    const finding = (rule, item, { found, path = item?.path, offset, index, test, limit, missing, score }) => ({
      rule: rule.id,
      says: rule.says,
      ...(typeof item?.text === 'string' ? { text: item.text } : {}),
      found,
      ...(path?.length ? { path: path.join('.') } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(item?.kind !== undefined ? { kind: item.kind } : {}),
      ...(test ? { test, limit } : {}),
      ...(missing ? { missing } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(rule.suggest ? { suggest: rule.suggest } : {}),
      ...(rule.because !== undefined ? { because: rule.because } : {}),
      ...(rule.at_most !== undefined ? { at_most: rule.at_most } : {}),
    });
    list.forEach((item, index) => {
      for (const { rule, across, skips, pieces, findings: judged } of compiled) {
        if (across || !ruleApplies(rule, item) || skips(item)) continue;
        for (const found of judged(pieces(item, index))) findings.push(finding(rule, item, found));
      }
    });
    for (const { rule, across, skips, pieces, findings: judged } of compiled) {
      if (!across) continue;
      const applicable = list.map((item, index) => ({ item, index })).filter(({ item }) => ruleApplies(rule, item) && !skips(item));
      if (!applicable.length) continue;
      for (const found of judged(applicable.flatMap(({ item, index }) => pieces(item, index)))) findings.push(finding(rule, null, found));
    }
    return findings;
  };
}

/**
 * The weighted score (0 to 100) of the rules that apply to some item: a rule that found nothing scores 100, one whose
 * findings all carry a share scores the smallest share, any other 0; each counts by its `weight` (1 when it names
 * none). Null when no rule applies or every weight is 0.
 */
export function scoreOf(rules, items, findings) {
  const list = items.map(entry => (typeof entry === 'string' ? { text: entry, field: null, path: [] } : entry));
  let weights = 0;
  let total = 0;
  for (const rule of rules.filter(row => list.some(item => ruleApplies(row, item)))) {
    const own = findings.filter(found => found.rule === rule.id);
    const score = own.length ? Math.min(...own.map(found => found.score ?? 0)) : 100;
    const weight = rule.weight ?? 1;
    weights += weight;
    total += score * weight;
  }
  return weights === 0 ? null : total / weights;
}

/** Judge the words of one JSON value as `owner` describes them. */
export function judgeValue(value, owner, rules) {
  return makeJudge(rules)(wordsIn(value, owner));
}

/** The findings as lines a person reads: where, what was found, why, and what to say instead. */
export function findingsInWords(findings) {
  const short = text => (text.length > 90 ? `${text.slice(0, 87)}...` : text);
  return findings.map(finding => {
    const what = finding.test ? TESTS[finding.test].said(finding.found, finding.limit, finding) : shown(finding.found);
    const at = finding.index !== undefined ? ` at ${finding.index}` : '';
    const where = typeof finding.text === 'string' ? `${what}${at} in "${short(finding.text)}"` : `${what}${at}`;
    return `${finding.path ? `${finding.path}: ` : ''}${where}. ${finding.says}${finding.suggest ? ` Say ${finding.suggest}.` : ''}`;
  });
}

// The items one request names: its words (`text`, `texts`, the words of `value`) and its `items`, each of `kind` unless
// it names its own, and its `artifact`, any JSON that `path` rules read.
function itemsOf(input) {
  const words = [
    ...(typeof input.text === 'string' ? [{ text: input.text, field: null, path: [] }] : []),
    ...(Array.isArray(input.texts) ? input.texts.filter(text => typeof text === 'string').map(text => ({ text, field: null, path: [] })) : []),
    ...(input.value === undefined ? [] : wordsIn(input.value, {
      fields: input.fields ?? 'strings', paths: input.paths, skip_keys: input.skip_keys, skip_paths: input.skip_paths,
    })),
  ].filter(item => item.text.trim());
  const given = (Array.isArray(input.items) ? input.items : []).filter(item => item && typeof item === 'object'
    && (typeof item.text === 'string' ? item.text.trim() : item.value !== undefined));
  const kind = typeof input.kind === 'string' ? { kind: input.kind } : {};
  return [
    ...words.map(item => ({ ...item, ...kind })),
    ...(input.artifact === undefined ? [] : [{ value: input.artifact, path: [], ...kind }]),
    ...given.map(item => ({ ...kind, ...item })),
  ];
}

/**
 * The Workshop tool tool:judge-against-rules: words and JSON in, findings out.
 * input: { rules: [rule rows], text?, texts?: [string], value?: any JSON (its words, chosen by fields / paths /
 * skip_keys / skip_paths), artifact?: any JSON (read by `path` rules), items?: [{ text | value, kind?, field?, path? }],
 * kind?: the kind of every item that names none, min_score?: the least `score` (0 to 100) that passes }.
 * status: no-input, no-applicable-rule (some item has no row that applies: no pass is established), failed (a finding
 * whose row is not capped, or a score under min_score), held (every finding comes from a capped row), passed (no
 * finding). `score` is the weighted score of the rows that apply (scoreOf).
 */
export function judge(input = {}) {
  const rules = input.rules;
  if (!Array.isArray(rules) || !rules.length) throw new TypeError('rules must be a nonempty list of rule rows.');
  if (input.min_score !== undefined && !(isNumber(input.min_score) && input.min_score >= 0 && input.min_score <= 100)) {
    throw new TypeError('min_score must be a number from 0 to 100.');
  }
  const items = itemsOf(input);
  const uncovered = items.filter(item => !rules.some(rule => ruleApplies(rule, item)));
  const findings = makeJudge(rules)(items);
  const score = scoreOf(rules, items, findings);
  const under = input.min_score !== undefined && score !== null && score < input.min_score;
  const status = !items.length ? 'no-input' : uncovered.length ? 'no-applicable-rule'
    : under || findings.some(finding => finding.at_most === undefined) ? 'failed' : findings.length ? 'held' : 'passed';
  const things = `${findings.length} thing${findings.length === 1 ? '' : 's'}`;
  const said = {
    'no-input': 'Nothing was supplied; nothing was checked.',
    'no-applicable-rule': `${uncovered.length} item(s) have no rule that applies; no pass is established.`,
    failed: under ? `The score ${Math.round(score * 10) / 10} is under the least that passes, ${input.min_score}; ${things} found.`
      : `${things} to change.`,
    held: `${findings.length} thing${findings.length === 1 ? '' : 's'} to look at; the rows that found them can only hold, never fail.`,
    passed: 'Every item passes the rules that apply to it; meaning was not judged.',
  }[status];
  return {
    passed: status === 'passed',
    status,
    score,
    coverage: { items: items.length, evaluated: items.length - uncovered.length, uncovered_paths: uncovered.map(item => item.path ?? []) },
    findings,
    lines: findingsInWords(findings),
    said,
  };
}
