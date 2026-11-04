// parts/judge-words/do-work/judge-words.mjs
//
// Purpose
//   Reads words a person will see and says which ones break the rules they are held to, with why and what to say
//   instead. The rules are DATA a caller hands in (Trillion's are records/copy-rules.json); this file knows no
//   product, no word list and no file. The same judge runs at commit (scripts/check-copy.mjs), when an AI saves a tour
//   (src/tours.mjs), as the Workshop tool tool:check-copy, and in tests, so a sentence is judged the same way
//   wherever it is written.
//
// Non-negotiable invariants
//   1. A rule is one row: `words` (whole words or phrases, any case), `pattern` (a regular expression with `flags`),
//      `exact` (the whole text is one of these), or `check` (one of the named grammar checks in CHECKS below). A rule
//      may narrow itself to some keys (`fields`) or to text somewhere under a key (`under`). Adding a rule is adding
//      a row; no rule is named in code.
//   2. `wordsIn` walks any JSON value and returns every string a person reads, with the path it sits at. Which keys
//      hold words is the owner's DATA (`fields`, a list of keys, or "strings" for every string but `skip_keys` and
//      exact `skip_paths`, which may use `*` for one array element or key).
//   3. Findings are machine-readable: { rule, says, text, found, path?, suggest? }. Nothing is thrown for a finding;
//      callers decide whether it refuses a write.
//   4. A text containing one of a rule's `allow` phrases is never flagged by that rule.
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

// One rule compiled once: a function from text to the pieces it found.
function compile(rule) {
  const allow = (rule.allow ?? []).map(lower);
  const allowed = text => allow.some(phrase => lower(text).includes(phrase));
  let find;
  if (Array.isArray(rule.words) && rule.words.length) {
    const pattern = new RegExp(`(?<![\\w-])(?:${rule.words.map(escape).join('|')})(?![\\w-])`, 'gi');
    find = text => [...text.matchAll(pattern)].map(match => match[0]);
  } else if (typeof rule.pattern === 'string') {
    const pattern = new RegExp(rule.pattern, (rule.flags ?? '').includes('g') ? rule.flags : `${rule.flags ?? ''}g`);
    find = text => [...text.matchAll(pattern)].map(match => match[0]);
  } else if (Array.isArray(rule.exact)) {
    const exact = new Set(rule.exact.map(value => lower(value.trim())));
    find = text => (exact.has(lower(text.trim())) ? [text.trim()] : []);
  } else if (typeof rule.check === 'string') {
    const check = CHECKS[rule.check];
    if (!check) throw new Error(`Rule ${rule.id} names the check ${rule.check}; the checks are ${CHECK_NAMES.join(', ')}.`);
    find = text => check(text, rule);
  } else {
    throw new Error(`Rule ${rule.id} needs words, pattern, exact or check.`);
  }
  return text => (allowed(text) ? [] : find(text));
}

// A rule applies to a text when its `fields` (if any) name the text's key and its `under` (if any) is in the path.
export function ruleApplies(rule, item) {
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
  const matches = (parts, path) => {
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
  };
  const found = [];
  const walk = (node, path, field) => {
    if (skipPaths.some(parts => parts.length === path.length && parts.every((part, at) => part === '*' || part === String(path[at])))) return;
    if (typeof node === 'string') {
      if ((keys ? keys.has(field) : true) && (!paths || paths.some(parts => matches(parts, path)))) {
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

/** Compile `rules` once; the judge takes [{ text, field?, path? }] or plain strings and returns findings. */
export function makeJudge(rules) {
  const compiled = rules.map(rule => ({ rule, find: compile(rule) }));
  return items => {
    const findings = [];
    for (const item of items.map(entry => (typeof entry === 'string' ? { text: entry, field: null, path: [] } : entry))) {
      for (const { rule, find } of compiled) {
        if (!ruleApplies(rule, item)) continue;
        for (const found of find(item.text)) {
          findings.push({
            rule: rule.id,
            says: rule.says,
            text: item.text,
            found,
            ...(item.path?.length ? { path: item.path.join('.') } : {}),
            ...(rule.suggest ? { suggest: rule.suggest } : {}),
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
  return findings.map(finding => `${finding.path ? `${finding.path}: ` : ''}"${finding.found}" in "${finding.text.length > 90 ? `${finding.text.slice(0, 87)}...` : finding.text}". ${finding.says}${finding.suggest ? ` Say ${finding.suggest}.` : ''}`);
}

/**
 * The Workshop tool tool:check-copy (src/engine-tools.mjs runs it in the Worker): words in, findings out.
 * input: { text?, texts?: [string], value?: any JSON, fields?: [key] | "strings", rules?: [rule rows] }. Without
 * `rules` the caller's `defaults` (Trillion's records/copy-rules.json rows) judge; any account may hand its own.
 */
export function checkCopy(input = {}, defaults = []) {
  const rules = input.rules === undefined ? defaults : input.rules;
  if (!Array.isArray(rules)) throw new TypeError('Copy rules must be a list.');
  const supplied = [
    ...(typeof input.text === 'string' ? [input.text] : []),
    ...(Array.isArray(input.texts) ? input.texts.filter(text => typeof text === 'string') : []),
    ...(input.value === undefined ? [] : wordsIn(input.value, {
      fields: input.fields ?? 'strings', paths: input.paths,
      skip_keys: input.skip_keys, skip_paths: input.skip_paths,
    })),
  ];
  const items = supplied.map(item => typeof item === 'string' ? { text: item, field: null, path: [] } : item)
    .filter(item => item.text.trim());
  const uncovered = items.filter(item => !rules.some(rule => ruleApplies(rule, item)));
  const findings = makeJudge(rules)(items);
  const status = !items.length ? 'no-input' : uncovered.length ? 'no-applicable-rule' : findings.length ? 'failed' : 'passed';
  return {
    passed: status === 'passed',
    status,
    coverage: { extracted_units: items.length, evaluated_units: items.length - uncovered.length,
      uncovered_paths: uncovered.map(item => item.path) },
    findings,
    lines: findingsInWords(findings),
    said: status === 'no-input' ? 'No words were supplied; nothing was checked.'
      : status === 'no-applicable-rule' ? `${uncovered.length} text unit(s) have no applicable rule; no pass is established.`
      : findings.length ? `${findings.length} thing${findings.length === 1 ? '' : 's'} to rewrite before a person reads it.` : 'Every supplied text unit passes the applicable word rules; meaning was not judged.',
  };
}
