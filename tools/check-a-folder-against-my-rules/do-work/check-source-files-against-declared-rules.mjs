// Check source files against rules that are DATA, not code.
//
// A rule says three things: WHICH files it looks at, WHEN it applies to one of them, and
// WHAT counts as a violation. All three are regular expressions and small logical
// combinators carried in a record, so adding a rule is a DATA row and never an edit here.
// This file names no rule, no product, no package, and no path.
//
// The combinators are a closed logical algebra (all, any, matches, absent), the way Option
// and Result are closed. They are not an open set a caller might want to extend with a new
// member tomorrow, so having them here is not the enum defect: a caller extends the RULES,
// never the algebra.
//
// Two things were deliberately REFUSED, and the reasons matter more than the code:
//
//   1. No order finder. A rule cannot prove which of two things is consulted first by
//      comparing where they appear in the text. `return fromFile || explicit` names the
//      explicit source first and still lets the file win. Precedence is semantic, so it is
//      proven by CALLING the thing, in the package that owns it. A check that claims a
//      proof it cannot perform is worse than no check, because it stops the next person
//      looking.
//   2. No autofix. Rewriting source needs a stronger correctness argument than a regular
//      expression can carry.

/** Every pattern in a rule, from one place.
 *
 *  A pattern is either a plain string, or `{pattern, flags}` when it needs a flag. Flags are
 *  a separate FIELD rather than an inline `(?i)` prefix on purpose: the inline form is the
 *  compact string encoding that has to be parsed to be understood, and it is also PCRE
 *  syntax that JavaScript does not accept, so a rule written that way fails at match time
 *  with a message about the character class rather than about the flag. Naming the field
 *  makes both problems impossible.
 *
 *  Found by a failing test rather than by design: the brand rule wanted case-insensitivity
 *  and there was no way to say so. */
export function toRegExp(pattern, subject = null, slot = 'a pattern', given = {}, mustNotBeEmpty = false) {
  if (typeof pattern === 'string') return new RegExp(pattern);
  if (isCollected(pattern)) return collectedMatcher(pattern.collected, subject, slot, given, mustNotBeEmpty);
  if (pattern && typeof pattern.pattern === 'string') return new RegExp(pattern.pattern, pattern.flags ?? '');
  throw new Error(`a pattern is a string, or {pattern, flags}: ${JSON.stringify(pattern)}`);
}

const isCollected = (value) => value != null && typeof value === 'object' && value.collected != null;

const isPattern = (value) =>
  typeof value === 'string' || isCollected(value) || (value != null && typeof value.pattern === 'string');

/** Regex-special characters, including the backslash itself.
 *
 *  Missing the backslash is not a smaller version of this bug: a value ending in one escapes
 *  the alternation delimiter and silently changes what the NEXT branch means. */
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher built from values found in the SUBJECT rather than written in the rule.
 *
 *  This is the whole second pattern source. A rule cannot write down the names a document
 *  declares, because they differ per document, so a check of the form "every reference also
 *  appears as a declaration" was previously sayable only at whole-file scope, where the engine
 *  can report one existential finding carrying no line and the entire file as its evidence.
 *
 *  Four decisions here are load-bearing, and each one was a measured defect rather than a
 *  precaution:
 *
 *  1. NO SUBJECT IS A THROW, NOT AN EMPTY SET. `scope`, `unit.split` and `applies_when` are
 *     evaluated where no subject exists or where collection has no meaning. Returning a
 *     never-matching matcher there would mean "covers no file" or "one unit", silently, forever.
 *  2. AN EMPTY SET NEVER MATCHES. An alternation built from nothing is `()`, which matches at
 *     every position. In `exempt` that would spare the whole corpus and report it clean. This
 *     is the reason `collected` is legal ONLY in `exempt`: see violationsInFile.
 *  3. AN EMPTY OR ABSENT CAPTURE IS A THROW. `''` produces a branch matching everywhere;
 *     `undefined` stringifies to the literal word "undefined" and exempts every line containing
 *     it. Both are silent, so both fail loudly instead.
 *  4. TOKEN BOUNDARIES, WITH THE HYPHEN IN THE CLASS. Without them a declared `carrier-mjs`
 *     spares a reference to the undeclared `carrier-mjs-old`, which is exactly the failure the
 *     rule exists to catch. Every name in this corpus is hyphenated, so a boundary class that
 *     omits `-` is inert here. `before` and `after` let a rule anchor precisely instead, because
 *     "token" is a convention and this engine names none. */
/** Matchers already built, keyed on the exact string they were collected from.
 *
 *  A collected matcher is a pure function of (spec, subject text), so scanning the same subject
 *  again cannot produce a different answer. Without this, a CORPUS-scale subject is rescanned once
 *  per file per rule, which is the difference between one scan and 7,760 of them, and it is the
 *  cost that would otherwise make corpus-wide reference rules unaffordable and push the next
 *  author back to a hand-rolled walk. A WeakMap on the subject string is impossible (strings are
 *  not objects), so the outer key is the subject itself and the map is cleared per run by being a
 *  module-level Map that only ever holds the handful of corpus subjects a run supplies. Per-FILE
 *  subjects are not cached, because caching one entry per file is the leak this avoids. */
const collectedMatcherCache = new Map();

function collectedMatcher(spec, subject, slot, given = {}, mustNotBeEmpty = false) {
  if (spec == null || typeof spec !== 'object') {
    throw new Error(`${slot}: collected must be an object, got ${JSON.stringify(spec)}`);
  }

  // WHERE to collect from, named by the rule. Absent means the subject being judged, which is
  // every rule written before this and is the only thing that can answer "declared in this same
  // document". Naming another subject is what answers reference integrity ACROSS documents, and
  // that class had no expression at all: a package address like
  // `package::<name>::stored-bytes::<x>` sits in one file while the set of real package names
  // lives in three hundred others. On 2026-09-05 a rename retracted an identity, two such
  // addresses went dead, and nothing could see it, because a static reader cannot tell a dead
  // address from a live one without the set.
  //
  // A named subject the caller did not supply THROWS rather than collecting nothing, for the
  // reason the whole `collected` design already turns on: an empty collected set in `exempt`
  // leaves the rule fully armed and looks like a working rule, so silence here would report every
  // reference in the corpus as a finding, or none, depending on polarity.
  const collectFrom = spec.from_subject == null ? subject : given[spec.from_subject];
  if (spec.from_subject != null && typeof collectFrom !== 'string') {
    throw new Error(
      `${slot}: collected names subject "${spec.from_subject}", which the caller did not supply. `
      + `Available: ${Object.keys(given).join(', ') || 'nothing'}`,
    );
  }
  if (typeof collectFrom !== 'string') {
    throw new Error(`${slot}: a collected pattern has no subject to collect from here`);
  }
  if (!Number.isInteger(spec.capture) || spec.capture < 1) {
    throw new Error(`${slot}: collected needs an explicit capture group number, 1 or greater`);
  }
  if (typeof spec.pattern !== 'string') {
    throw new Error(`${slot}: collected needs a pattern string`);
  }

  // Only a NAMED subject is cached. That is the one that is corpus-scale and identical for every
  // file; the default subject is the file's own text, and caching one entry per file would be the
  // leak this exists to avoid.
  const cacheKey = spec.from_subject == null ? null : `${spec.from_subject}\u0000${spec.pattern}\u0000${spec.flags ?? ''}\u0000${spec.capture}\u0000${JSON.stringify(spec.before ?? null)}\u0000${JSON.stringify(spec.after ?? null)}\u0000${collectFrom.length}`;
  if (cacheKey !== null) {
    const hit = collectedMatcherCache.get(cacheKey);
    // The length is in the key, and the stored subject is compared in full, because two different
    // corpora of the same size would otherwise share a matcher and the wrong one would be silent.
    if (hit && hit.subject === collectFrom) return hit.matcher;
  }

  // The SCAN carries `g` so it walks the whole subject; the produced matcher must NOT, because
  // matchers are built once per file and reused across every unit, and a `g` matcher is
  // stateful through lastIndex, so `.test` would alternate true and false down the units.
  const declared = new RegExp(spec.pattern, spec.flags ?? '');
  const scan = new RegExp(declared.source, declared.flags.includes('g') ? declared.flags : `${declared.flags}g`);

  // Both `exec` calls read `collectFrom`, and that is not a style note. When `from_subject` was
  // added, the loop's second call was left reading the old subject, so the scan found the first
  // name and then searched the FILE for the next one, found nothing, and stopped. The set had
  // exactly one member, every rule still ran, and the corpus-wide result was a plausible pile of
  // findings that named real packages. Three of nine tests caught it only because their corpus put
  // the exempt name second; a suite that always listed it first would have shipped this.
  const values = new Set();
  let match = scan.exec(collectFrom);
  while (match !== null) {
    const value = match[spec.capture];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `${slot}: collected capture ${spec.capture} produced ${JSON.stringify(value)}, which would match everywhere`,
      );
    }
    values.add(value);
    if (match[0].length === 0) scan.lastIndex += 1;
    match = scan.exec(collectFrom);
  }

  // An empty set is fine in `exempt`, where OR-composition means it spares nothing and leaves the
  // rule fully armed. In a REQUIRED slot it is fatal and silent, so it throws instead. That
  // asymmetry IS the reason `collected` used to be banned outside `exempt`; naming the hazard
  // exactly, rather than banning the mechanism that carries it, is what makes the mechanism
  // reusable. The message says which subject came up empty, because the usual cause is a rule
  // pointed at the wrong one.
  if (values.size === 0 && mustNotBeEmpty) {
    throw new Error(
      `${slot}: collected nothing from ${spec.from_subject ?? 'the judged text'}, and an empty set here `
      + 'cannot be evaluated. In forbidden it would report the whole corpus clean; in required it '
      + 'would make every unit a finding. Neither is an answer, so this is refused.',
    );
  }

  // Nothing collected means nothing is exempt. Never `()`, which matches at every position.
  const alternation = Array.from(values, escapeForRegExp).join('|');
  const before = isPattern(spec.before) ? toRegExp(spec.before).source : '(?<![0-9A-Za-z_-])';
  const after = isPattern(spec.after) ? toRegExp(spec.after).source : '(?![0-9A-Za-z_-])';
  const matcherFlags = spec.match_flags ?? '';
  if (typeof matcherFlags !== 'string' || /[^dgimsuvy]/.test(matcherFlags)) {
    throw new Error(`${slot}: collected match_flags must contain only regular-expression flags`);
  }
  // A matcher is reused across units, so stateful flags would make alternate
  // calls disagree. Collection may be global; the produced matcher may not.
  const stableMatcherFlags = matcherFlags.replace(/[dgy]/g, '');
  const matcher = values.size === 0
    ? /(?!)/
    : new RegExp(`${before}(?:${alternation})${after}`, stableMatcherFlags);

  if (cacheKey !== null) collectedMatcherCache.set(cacheKey, { subject: collectFrom, matcher });
  return matcher;
}

/** One pattern or several, as a list of matchers.
 *
 *  Several means AND, never OR. A rule author who wants OR already has one, inside a single
 *  pattern: `a|b`. There is no way to spell AND inside one regular expression without fixing
 *  the order the two things appear in, which is exactly the accident this avoids. */
function patternList(value, subject = null, slot = 'a pattern', given = {}, mustNotBeEmpty = false) {
  if (value == null) return [];
  // NEVER `value.map(toRegExp)`. Array.prototype.map passes the element, the INDEX and the
  // array, so the bare reference hands every pattern in a list its array position as the
  // subject. Literals ignore a subject, so all fifteen other cases in this package pass with
  // that bug present and only the list case sees it. Measured, not guessed: it failed exactly
  // once when this line was left bare on purpose before being fixed.
  if (Array.isArray(value)) return value.map((pattern) => toRegExp(pattern, subject, slot, given, mustNotBeEmpty));
  return [toRegExp(value, subject, slot, given, mustNotBeEmpty)];
}

/** A predicate over a whole file's text. Self-describing: the shape says which test to run,
 *  so there is no `kind` discriminator string and no registry of names to keep in sync. */
export function fileConditionHolds(condition, text) {
  if (condition == null) return true;
  if (Array.isArray(condition.all)) return condition.all.every((c) => fileConditionHolds(c, text));
  if (Array.isArray(condition.any)) return condition.any.some((c) => fileConditionHolds(c, text));
  if (isPattern(condition.content_matches)) return toRegExp(condition.content_matches).test(text);
  if (isPattern(condition.content_absent)) return !toRegExp(condition.content_absent).test(text);
  throw new Error(`unrecognised condition, expected all/any/content_matches/content_absent: ${JSON.stringify(condition)}`);
}

/** Does this rule look at this file at all? Path only, so a caller can skip reading a file
 *  no rule can care about.
 *
 *  `predicate_from` names a resolved file set the CALLER supplied. It exists because
 *  `path_matches` is a hand-typed enumeration standing in for a predicate an OWNER already
 *  computes (which files ship to installations, which are admitted DATA, which run in
 *  production). Every time such a predicate widened, the two identity rules stayed narrow and
 *  reported clean about the exact file the widening added. The category fix is to let a rule
 *  say "the answer to this scope is a predicate the projector already knows", and the caller
 *  resolves the name to a Set<filePath> once per run. Names of predicates are Society, added
 *  by DATA on the rule row; the handler stays generic and knows no predicate names.
 *
 *  An absent provider for a NAMED predicate THROWS, matching the `collected` design: silence
 *  would report the whole corpus clean or report every file, depending on polarity, which is
 *  the exact failure this seam exists to remove. */
export function ruleCoversPath(rule, filePath, predicateProviders = {}) {
  const scope = rule.scope ?? {};
  if (isPattern(scope.path_matches) && !toRegExp(scope.path_matches).test(filePath)) return false;
  if (isPattern(scope.path_excludes) && toRegExp(scope.path_excludes).test(filePath)) return false;
  if (typeof scope.predicate_from === 'string') {
    const files = predicateProviders[scope.predicate_from];
    if (files == null) {
      const available = Object.keys(predicateProviders).join(', ') || 'nothing';
      throw new Error(
        `scope.predicate_from="${scope.predicate_from}" names a predicate the caller did not supply. Available: ${available}`,
      );
    }
    if (!files.has(filePath)) return false;
  }
  return true;
}

/** The units of text one rule judges, described by DATA rather than named here.
 *
 *  This used to be `unit: "file" | "line"`, matched by name and throwing on anything else,
 *  which is a closed enum in a handler: a rule author wanting paragraphs, blocks, or records
 *  would have had to edit this file. So the unit says HOW TO DIVIDE instead of WHAT IT IS
 *  CALLED. Lines are `{split: "\\n"}` and nothing here knows the word "line".
 *
 *  A whole-file requirement is the absence of a division, which is why there is one finder
 *  rather than two, and why the whole file is the DEFAULT: the least a rule can say is that
 *  it judges what it was given.
 *
 *  A whole-file unit carries `line: null`, never 0. In a 1-based system 0 is not "no line",
 *  it is a line that does not exist, and a caller printing `path:line` would send a reader
 *  somewhere that is not there. Every divided unit carries the line it starts on, so the
 *  report is findable no matter what the rule divided by. */
function unitsOf(unit, text) {
  if (unit == null) return [{ line: null, content: text }];
  if (!isPattern(unit.split)) {
    throw new Error(`a unit is absent for the whole file, or {split: <pattern>}: ${JSON.stringify(unit)}`);
  }

  const declared = toRegExp(unit.split);
  const separator = new RegExp(declared.source, declared.flags.includes('g') ? declared.flags : `${declared.flags}g`);

  // One pass. The line a unit STARTS on is carried forward through the text it consumed plus
  // the separator that ended it, so a finding always points where a reader can look, whatever
  // the rule divided the file by. Slicing the prefix per unit to count newlines would be the
  // same answer in O(n^2), and this file is handed whole repositories.
  const units = [];
  let line = 1;
  let start = 0;
  let match = separator.exec(text);
  const countNewlines = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') n += 1;
    return n;
  };

  while (match !== null) {
    const content = text.slice(start, match.index);
    units.push({ line, content });
    line += countNewlines(content) + countNewlines(match[0]);
    start = match.index + match[0].length;
    // A zero-width separator would match the same position forever.
    if (match[0].length === 0) separator.lastIndex += 1;
    match = separator.exec(text);
  }
  units.push({ line, content: text.slice(start) });
  return units;
}

/** What one rule judges, NAMED by the rule rather than assumed to be the text.
 *
 *  Every rule used to judge the file's contents, which made a whole class of rule
 *  inexpressible: anything about the NAME. A folder had accumulated 116 copies called
 *  `.sequence-14-kept-20260714`, `.previous-20260618162448` and `.FAILED-BOOT`, and no rule
 *  could say so, because the only string this judge could see was what was inside them.
 *
 *  The lazy fix is `if (rule.judges === 'path')`, which is the closed enum this package
 *  already refused once for units. So the rule NAMES A KEY and the handler looks it up in
 *  what the caller supplied. Nothing here knows the word "path" or the word "text"; a caller
 *  that later supplies `{path, text, mode, owner}` gets rules over all four for free, and
 *  adding one costs no edit to this file.
 *
 *  Absent means the text, because the least a rule can say is that it judges what it was
 *  given. A named subject that is not there THROWS, matching invariant 1: a missing subject
 *  is never an empty set, because a rule that cannot be evaluated has no finding value and
 *  silently covering nothing is how a guard reports clean forever. */
function subjectOf(rule, given) {
  if (rule.subject == null) return given.text;
  const named = rule.subject.named;
  if (typeof named !== 'string' || !named) {
    throw new Error(`rule ${rule.id} declares a subject without {named: <key>}: ${JSON.stringify(rule.subject)}`);
  }
  if (!Object.hasOwn(given, named)) {
    throw new Error(`rule ${rule.id} judges "${named}", which the caller did not supply. Available: ${Object.keys(given).join(', ')}`);
  }
  const value = given[named];
  if (typeof value !== 'string') {
    throw new Error(`rule ${rule.id} judges "${named}", which is ${typeof value} rather than text`);
  }
  return value;
}

/** Every violation one rule finds in one file. */
export function violationsInFile(rule, filePath, text, alsoGiven = {}) {
  if (!ruleCoversPath(rule, filePath)) return [];
  // Subjects that are the same for every file, supplied once by the caller. The set of live
  // package names is the first: it is a fact about the CORPUS rather than about any one file, so
  // no rule reading a single document could ever have it, and reference integrity across files was
  // therefore inexpressible rather than merely hard.
  const given = { path: filePath, text, ...alsoGiven };
  const subject = subjectOf(rule, given);
  if (!fileConditionHolds(rule.applies_when, subject)) return [];

  const violation = rule.violation;
  if (violation == null) return [];

  // A conjunction, because most real rules are one. "A brand in a machine path" is not "a
  // line with a brand": it is a line that is BOTH a machine path AND has a brand. Written as
  // a single pattern, that would be a fragile order-dependent regex; written as a file-level
  // condition, it flags every brand-bearing line in any file that happens to build a temp
  // path somewhere. The first run over the real tree produced 360 findings that way, almost
  // all of them environment variable names, which is precisely how a guard earns its own
  // deletion.
  // The subject is threaded ONLY into `exempt`, and that is the enforcement, not a convenience.
  //
  // `exempt` is OR-composed at the veto below, so a never-matching member contributes nothing
  // and an empty collected set leaves the rule fully armed. `forbidden` and `required` are
  // AND-composed through allMatch, where a never-matching member is catastrophic in opposite
  // directions: in `forbidden` the conjunction is false for every unit of every file, so the
  // run reports clean corpus-wide; in `required` it is false for every unit, so every unit
  // becomes a finding, which is 3,143 from one manifest.
  //
  // Flipping the polarity fixes neither, because an empty collected set means the rule could
  // not be EVALUATED, and that is not a finding value.
  //
  // Corrected later: the hazard above is entirely
  // the SILENCE of an empty collected set, not collection itself, so the fix is to make an empty
  // set in a REQUIRED slot throw instead of quietly matching nothing. With that, `collected` is
  // legal in `forbidden` too, and it unlocks the class the ban was blocking: "this document's own
  // declared name must not appear inside its own identifiers".
  //
  // That class is not academic. Five packages each invented a private state kind, and the tell for
  // a private fork of a shared concept is a kind named after its own owner. No rule could say so,
  // because saying it requires the package's OWN name, which only the document holds, on the
  // forbidden side. A ban written from one measured failure had quietly outlawed a whole family of
  // self-reference rules for years.
  const forbidden = patternList(violation.forbidden, subject, `rule ${rule.id} violation.forbidden`, given, true);
  const required = patternList(violation.required, subject, `rule ${rule.id} violation.required`, given, true);
  const exempt = patternList(violation.exempt, subject, `rule ${rule.id} violation.exempt`, given);
  if (forbidden.length === 0 && required.length === 0) {
    throw new Error(`rule ${rule.id} declares a violation with neither forbidden nor required`);
  }

  const allMatch = (patterns, content) => patterns.length > 0 && patterns.every((p) => p.test(content));

  const found = [];
  for (const unit of unitsOf(violation.unit, subject)) {
    if (exempt.some((p) => p.test(unit.content))) continue;
    if (allMatch(forbidden, unit.content)) {
      found.push({ rule_id: rule.id, path: filePath, line: unit.line, evidence: unit.content.trim() });
      continue;
    }
    if (required.length > 0 && !allMatch(required, unit.content)) {
      found.push({ rule_id: rule.id, path: filePath, line: unit.line, evidence: rule.message ?? '' });
    }
  }
  return found;
}

/** Run every rule over every file.
 *
 *  `files` is `[{path, text}]` because the caller owns discovery. Absorbing it would pull in
 *  every environment difference there is (git or not, worktrees, generated files, symlinks)
 *  and make this untestable without a disk. The runner beside this file does `git ls-files`
 *  for the common case, outside this contract. */
export function violationsAcrossFiles(rules, files, alsoGiven = {}) {
  return files.flatMap(({ path: filePath, text }) => rules.flatMap((rule) => violationsInFile(rule, filePath, text, alsoGiven)));
}

/** Findings as `{rule_id: {path: count}}`, which is the shape a recorded set is written in.
 *
 *  Counted by path rather than by line on purpose: a line number changes whenever anything
 *  above it does, so a recorded set keyed on lines churns on edits that have nothing to do
 *  with it, and a record that churns is one people regenerate instead of read. */
export function countByRuleAndPath(violations) {
  const counted = {};
  for (const found of violations) {
    counted[found.rule_id] ??= {};
    counted[found.rule_id][found.path] = (counted[found.rule_id][found.path] ?? 0) + 1;
  }
  return counted;
}

/** How a current finding set differs from one recorded earlier, in BOTH directions.
 *
 *  `appeared` is what is now worse than recorded. `fixed` is what is now better. Reporting
 *  `fixed` is what separates a ratchet from a permission slip: without it a recorded set
 *  quietly outlives the debt it describes and stops meaning anything, and the number can only
 *  ever go up. With it, paying a debt REQUIRES deleting its entry.
 *
 *  ⛔ A ZERO IS NOT EVIDENCE OF A REPAIR UNLESS THE FILE WAS ACTUALLY LOOKED AT. Reading no
 *  findings in a file and never opening the file produce the identical count, and the caller's
 *  advice on a `fixed` row is to delete its baseline entry, so the two outcomes are one
 *  keystroke apart with opposite meanings. Measured 2026-09-09: a baseline row reported `found 0,
 *  recorded 1, delete this entry`, and the file was not repaired at all, it was DELETED from the
 *  worktree while still tracked at HEAD. Deleting the entry there records a repair nobody made
 *  and drops the debt silently the moment the file returns.
 *
 *  So `scannedPaths` is the evidence that a look happened. Supply it and a recorded path that was
 *  never scanned is reported as `unverified` with the reason, never as `fixed`. Omit it and the
 *  behaviour is unchanged, because a caller that cannot say which paths it read should not have
 *  its silence turned into a claim either way.
 *
 *  The reason is a FIELD rather than another bucket, because why a file went unread (deleted,
 *  excluded by a changed scope, unreadable, renamed) is an open set owned by the world, while
 *  "did we look" is a yes or no that cannot grow a third member.
 *
 *  This decides nothing. It returns the difference and the caller decides whether a build
 *  fails, which is deliberately not this package's job. */
export function differenceFromRecorded(found, recorded, scannedPaths = null) {
  const appeared = [];
  const fixed = [];
  const unverified = [];
  const looked = scannedPaths === null ? null : new Set(scannedPaths);

  for (const [ruleId, byPath] of Object.entries(found ?? {})) {
    for (const [file, count] of Object.entries(byPath)) {
      const allowed = recorded?.[ruleId]?.[file] ?? 0;
      if (count > allowed) appeared.push({ rule_id: ruleId, path: file, found: count, recorded: allowed });
    }
  }

  for (const [ruleId, byPath] of Object.entries(recorded ?? {})) {
    for (const [file, count] of Object.entries(byPath)) {
      const actual = found?.[ruleId]?.[file] ?? 0;
      if (actual >= count) continue;
      if (looked !== null && !looked.has(file)) {
        unverified.push({
          rule_id: ruleId,
          path: file,
          recorded: count,
          reason: 'the recorded path was not among the files scanned, so this run has no evidence either way',
        });
        continue;
      }
      fixed.push({ rule_id: ruleId, path: file, found: actual, recorded: count });
    }
  }

  return { appeared, fixed, unverified };
}

/** Group findings under the rule that produced them, so a report leads with WHY. A list of
 *  paths means nothing until the reader knows what is wrong with them. */
export function reportByRule(rules, violations) {
  return rules
    .map((rule) => ({
      rule_id: rule.id,
      why: rule.why ?? '',
      message: rule.message ?? '',
      violations: violations.filter((v) => v.rule_id === rule.id),
    }))
    .filter((entry) => entry.violations.length > 0);
}
