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
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lower = value => value.toLowerCase();

// The grammar checks a rule may name. Each takes the text and its rule and returns the pieces it found wrong.
const CHECKS = {
  // A sentence starts with a capital letter after a full stop, question mark or exclamation mark.
  'capital-after-stop': text => [...text.matchAll(/[.!?]\s+([a-z])/g)]
    .filter(match => !/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(text.slice(0, match.index + 1)))
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
};

export const TEST_NAMES = Object.freeze(Object.keys(TESTS));

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

// One rule compiled once: a function from an item to its findings, each { found, path?, test?, limit? }.
function compile(rule) {
  const allow = (rule.allow ?? []).map(lower);
  const allowed = text => allow.some(phrase => lower(text).includes(phrase));
  const pieces = matches => matches.map(found => ({ value: found }));
  let select;
  if (Array.isArray(rule.words) && rule.words.length) {
    const pattern = new RegExp(`(?<![\\w-])(?:${rule.words.map(escape).join('|')})(?![\\w-])`, 'gi');
    select = item => pieces([...item.text.matchAll(pattern)].map(match => match[0]));
  } else if (typeof rule.pattern === 'string') {
    const pattern = new RegExp(rule.pattern, (rule.flags ?? '').includes('g') ? rule.flags : `${rule.flags ?? ''}g`);
    select = item => pieces([...item.text.matchAll(pattern)].map(match => match[0]));
  } else if (Array.isArray(rule.exact)) {
    const exact = new Set(rule.exact.map(value => lower(value.trim())));
    select = item => pieces(exact.has(lower(item.text.trim())) ? [item.text.trim()] : []);
  } else if (typeof rule.check === 'string') {
    const check = CHECKS[rule.check];
    if (!check) throw new Error(`Rule ${rule.id} names the check ${rule.check}; the checks are ${CHECK_NAMES.join(', ')}.`);
    select = item => pieces(check(item.text, rule));
  } else if (rule.path !== undefined) {
    const parts = dotPath(rule.path, `Rule ${rule.id} path`);
    select = item => valuesAt(item.value, parts).map(piece => ({ value: piece.value, path: [...(item.path ?? []), ...piece.path] }));
  } else {
    throw new Error(`Rule ${rule.id} needs words, pattern, exact, check or path.`);
  }
  if (rule.kinds !== undefined && (!Array.isArray(rule.kinds) || !rule.kinds.length || rule.kinds.some(kind => typeof kind !== 'string'))) {
    throw new Error(`Rule ${rule.id} kinds must be a nonempty list of kind words.`);
  }
  whenOf(rule);
  const wanted = rule.where === undefined ? null : Array.isArray(rule.where) ? rule.where : [rule.where];
  const tests = TEST_NAMES.filter(name => rule[name] !== undefined).map(name => {
    if (!TESTS[name].valid(rule[name])) throw new Error(`Rule ${rule.id} ${name} has the wrong kind of value.`);
    return { name, limit: rule[name], find: TESTS[name].find };
  });
  return item => {
    if (typeof item.text === 'string' && allowed(item.text)) return [];
    const selected = select(item).filter(piece => !wanted || wanted.some(one => same(one, piece.value)));
    if (!tests.length) return selected.map(piece => ({ found: piece.value, path: piece.path }));
    return tests.flatMap(test => test.find(selected, test.limit)
      .map(piece => ({ found: piece.value, path: piece.path, test: test.name, limit: test.limit })));
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
export function ruleApplies(rule, item) {
  if (Array.isArray(rule.kinds) && !rule.kinds.includes(item.kind)) return false;
  if (!whenOf(rule).every(({ parts, wanted }) => item.value !== undefined
    && valuesAt(item.value, parts).some(piece => wanted.some(one => same(one, piece.value))))) return false;
  if (rule.path !== undefined ? item.value === undefined : item.value !== undefined && typeof item.text !== 'string') return false;
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
 * kind? } for words, or { value, path?, kind? } for any JSON that `path` rules read.
 */
export function makeJudge(rules) {
  const compiled = rules.map(rule => ({ rule, judge: compile(rule) }));
  return items => {
    const findings = [];
    for (const item of items.map(entry => (typeof entry === 'string' ? { text: entry, field: null, path: [] } : entry))) {
      for (const { rule, judge } of compiled) {
        if (!ruleApplies(rule, item)) continue;
        for (const { found, path = item.path, test, limit } of judge(item)) {
          findings.push({
            rule: rule.id,
            says: rule.says,
            ...(typeof item.text === 'string' ? { text: item.text } : {}),
            found,
            ...(path?.length ? { path: path.join('.') } : {}),
            ...(item.kind !== undefined ? { kind: item.kind } : {}),
            ...(test ? { test, limit } : {}),
            ...(rule.suggest ? { suggest: rule.suggest } : {}),
            ...(rule.because !== undefined ? { because: rule.because } : {}),
            ...(rule.at_most !== undefined ? { at_most: rule.at_most } : {}),
          });
        }
      }
    }
    return findings;
  };
}

/** Judge the words of one JSON value as `owner` describes them. */
export function judgeValue(value, owner, rules) {
  return makeJudge(rules)(wordsIn(value, owner));
}

/** The findings as lines a person reads: where, what was found, why, and what to say instead. */
export function findingsInWords(findings) {
  const short = text => (text.length > 90 ? `${text.slice(0, 87)}...` : text);
  return findings.map(finding => {
    const what = finding.test ? TESTS[finding.test].said(finding.found, finding.limit) : shown(finding.found);
    const where = typeof finding.text === 'string' ? `${what} in "${short(finding.text)}"` : what;
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
 * kind?: the kind of every item that names none }.
 * status: no-input, no-applicable-rule (some item has no row that applies: no pass is established), failed (a finding
 * whose row is not capped), held (every finding comes from a capped row), passed (no finding).
 */
export function judge(input = {}) {
  const rules = input.rules;
  if (!Array.isArray(rules) || !rules.length) throw new TypeError('rules must be a nonempty list of rule rows.');
  const items = itemsOf(input);
  const uncovered = items.filter(item => !rules.some(rule => ruleApplies(rule, item)));
  const findings = makeJudge(rules)(items);
  const status = !items.length ? 'no-input' : uncovered.length ? 'no-applicable-rule'
    : findings.some(finding => finding.at_most === undefined) ? 'failed' : findings.length ? 'held' : 'passed';
  const said = {
    'no-input': 'Nothing was supplied; nothing was checked.',
    'no-applicable-rule': `${uncovered.length} item(s) have no rule that applies; no pass is established.`,
    failed: `${findings.length} thing${findings.length === 1 ? '' : 's'} to change.`,
    held: `${findings.length} thing${findings.length === 1 ? '' : 's'} to look at; the rows that found them can only hold, never fail.`,
    passed: 'Every item passes the rules that apply to it; meaning was not judged.',
  }[status];
  return {
    passed: status === 'passed',
    status,
    coverage: { items: items.length, evaluated: items.length - uncovered.length, uncovered_paths: uncovered.map(item => item.path ?? []) },
    findings,
    lines: findingsInWords(findings),
    said,
  };
}
