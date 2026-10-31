#!/usr/bin/env node
// do-work/write-control-bytes-as-escapes.mjs
//
// Rewrites a LITERAL control byte in source as the escape that means the same thing, so the file
// stays exactly the program it was and becomes searchable again.
//
// WHY THIS EXISTS, and it is not the reason it first looked like. A sweep found 15 source files in
// this corpus carrying a raw 0x00, and the first reading was corruption. It is the opposite: every
// one of them joins fields into a composite key with a NUL separator, an old and correct technique
// because the separator cannot occur inside any field, and one of them names it outright
// (`const EDGE_SEP` in group/do-work/board-order.ts). Stripping the byte would have silently
// COLLIDED keys, since joining {a:"x",b:"yz"} and {a:"xy",b:"z"} with nothing produces one string.
// The idiom is right. Its REPRESENTATION in the file is what costs.
//
// WHAT IT COSTS, measured. A file containing one 0x00 is classified as binary by `file`, by `grep`
// and by every tool built on the same heuristic, and this grep answers with SILENCE rather than
// "binary file matches". So `grep -c "const" <file>` prints NOTHING while `grep -a -c "const"`
// prints 14. Every search over those files returns a confident absence. That lands directly under
// the rule that says to grep before claiming something does not exist (L049), which means the
// instrument this corpus relies on to avoid false negatives was manufacturing them, on 15 files
// including the runner that executes every declared check and the source-rule checker itself.
//
// Git does not see it either: git's binary heuristic reads only the first 8000 bytes, and every one
// of these sits past that, so the diffs looked like ordinary text diffs the whole time.
//
// THE TRANSFORM IS MEANING-PRESERVING BY CONSTRUCTION. A control byte in a file that PARSES can
// only be inside a string, a template, a regex or a comment, because a bare control byte anywhere
// else is a syntax error. The escape means the same character in all four. It is written in the
// \\uXXXX form rather than the short \\0 deliberately: \\0 followed by a digit is a legacy octal
// escape and changes meaning, so the short form would be correct almost always, which is the worst
// kind of correct.
//
// THIS FILE IS ITS OWN FIRST SUBJECT. Its first draft carried two raw control bytes, put there by
// writing the character class the obvious way, so the owner for this defect shipped with the defect
// and could not be searched for the name of its own export. That is why the class below is built
// from an ASCII STRING rather than typed as a literal range: a rule about what source may contain
// has to be expressible without containing it.
//
// WHAT IT REFUSES TO DO:
//   - it writes nothing unless the result ROUND-TRIPS, so putting every escape back yields the
//     original file byte for byte. A textual edit that changes anything else is a defect.
//   - for a file node can parse, it writes nothing unless `node --check` accepts the result. That
//     is what catches a control byte that was NOT inside a literal, which would be real corruption
//     wearing this defect's clothes and must not be escaped into silence.
//   - tab, newline and carriage return are left alone. They are how a text file is structured
//     rather than something hiding in it, and escaping them would rewrite every file here.

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// The control characters a text file may not carry RAW. Closed by the ENCODING rather than by
// convention: C0 is fixed at 32 code points and no user, package or project can add a member, which
// is the one condition under which enumerating a set is legal here. Tab (09), newline (0a) and
// carriage return (0d) are excluded because they ARE the text structure.
const RAW_CONTROL_CLASS = "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]";
const RAW_CONTROL = new RegExp(RAW_CONTROL_CLASS, "g");
// A SEPARATE non-global copy for asking about one character. A `g` regex carries `lastIndex`
// between calls, so `test` on a shared instance answers differently depending on what was asked
// before it, and the repair for that is resetting a field by hand at every call site, which is a
// convention rather than a structure. Two objects cost nothing and cannot be got wrong.
const ONE_RAW_CONTROL = new RegExp(RAW_CONTROL_CLASS);

/**
 * Where the candidate for one file goes: beside it, KEEPING ITS EXTENSION.
 *
 * Exported so a caller can clean one up, and so the naming is testable on its own rather than only
 * through a rewrite that happens to fail.
 */
export function candidateBeside(path) {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return dot > slash
    ? path.slice(0, dot) + ".checking" + path.slice(dot)
    : path + ".checking";
}

/** How this owner spells one control character. One place, so a writer and a reverser agree. */
export function escapeFor(code) {
  return "\\u" + code.toString(16).padStart(4, "0");
}

/**
 * The code of every raw control character in the text, in the order they appear.
 *
 * It used to return `{at, code}` per hit, and NOTHING EVER READ `at`. An offset looked useful
 * because a reporter might want it, and no reporter exists: the rule engine finds these by line and
 * this owner rewrites all of them at once, so the position was information nobody could act on,
 * kept alive only by being plausible. Once it went, the object was a wrapper around one number,
 * which is why this returns the numbers rather than a smaller object. A caller wanting how many
 * asks the length and a caller wanting which asks for the set, and both are the array itself.
 */
export function rawControlCharacterCodes(text) {
  return [...text.matchAll(RAW_CONTROL)].map((hit) => hit[0].codePointAt(0));
}

/** The same text with every raw control character written as the escape that means it. */
export function withControlBytesAsEscapes(text) {
  return text.replace(RAW_CONTROL, (one) => escapeFor(one.codePointAt(0)));
}

/**
 * Whether `after` is `before` with every raw control character replaced by its escape, and NOTHING
 * else changed. Walks both in parallel, so it is exact about POSITION.
 *
 * ⛔ THE FIRST VERSION REVERSED THE ESCAPES GLOBALLY AND COMPARED, and that is subtly wrong in a way
 * that only a real file showed: `group/read-data/board-crosstab.ts` already contained the six
 * characters `\\u0000` as ORDINARY TEXT, so putting escapes back turned that pre-existing escape
 * into a raw byte, the comparison failed, and a correct rewrite was refused. The refusal was the
 * right outcome from a wrong test, which is the most expensive kind of passing guard: on a file
 * where the same coincidence ran the other way it would have approved instead.
 *
 * A global replace cannot tell an escape this owner just wrote from one that was always there.
 * Position can, and it needs no cleverness: at each step the two texts either match, or `before` has
 * a control character and `after` has exactly its escape.
 */
export function theOnlyChangeIsTheseEscapes(before, after) {
  let here = 0;
  let there = 0;
  while (here < before.length) {
    const one = before[here];
    if (ONE_RAW_CONTROL.test(one)) {
      const escape = escapeFor(one.codePointAt(0));
      if (after.slice(there, there + escape.length) !== escape) return false;
      here += 1;
      there += escape.length;
      continue;
    }
    if (after[there] !== one) return false;
    here += 1;
    there += 1;
  }
  return there === after.length;
}

/**
 * Rewrite one file, or say exactly why it was left alone. Never writes a file it cannot prove.
 *
 * The parse check runs against a SIBLING rather than the destination, so a file that fails it is
 * never the file on disk even for an instant.
 */
export function writeControlBytesAsEscapesIn(
  path,
  { parseWith = nodeCanParse, escapeWith = withControlBytesAsEscapes } = {},
) {
  const before = readFileSync(path, "utf8");
  const found = rawControlCharacterCodes(before);
  if (found.length === 0) return { path, changed: false, why: "no raw control character" };

  // The transform is a parameter so the ROUND-TRIP REFUSAL below can be executed rather than
  // described. A guard whose failing direction has never run is a comment.
  const after = escapeWith(before);
  if (!theOnlyChangeIsTheseEscapes(before, after)) {
    return {
      path, changed: false, found: found.length,
      why: "putting the escapes back did not reproduce the file, so the rewrite is not lossless",
    };
  }

  // The candidate KEEPS THE ORIGINAL EXTENSION, so it is named `x.checking.mjs` and never
  // `x.mjs.checking`. Node decides module mode from the extension, so the second form is rejected
  // as an unknown extension before it is ever parsed, and every file would then report "does not
  // parse" for a reason that has nothing to do with its contents. That is a refusal firing for the
  // wrong reason, which is worse than not firing: the guard looks like it works.
  const building = candidateBeside(path);
  writeFileSync(building, after);
  const parsed = parseWith(building, path);
  if (parsed !== true) {
    return {
      path, changed: false, found: found.length,
      why: "the result does not parse, so at least one control byte was NOT inside a literal and "
        + "escaping it would hide real corruption: " + parsed,
    };
  }
  renameSync(building, path);
  return {
    path, changed: true, found: found.length,
    codes: [...new Set(found)].map(escapeFor),
  };
}

/**
 * Whether node accepts the file as a program. A file node has no parser for is NOT called broken:
 * this answers true and the caller's own declared checks are what prove those, which is the honest
 * split, since a checker that guessed at TypeScript would be a second TypeScript.
 */
export function nodeCanParse(building, originalPath) {
  if (!/\.(mjs|cjs|js)$/.test(originalPath)) return true;
  try {
    execFileSync(process.execPath, ["--check", building], { stdio: "pipe" });
    return true;
  } catch (error) {
    // The excerpt with node's caret AND the line naming the error. Taking a fixed slice off the
    // front dropped the second, so the reason read as a location with no diagnosis, and a test
    // asserting the refusal names a syntax error could not tell that from the guard misfiring on
    // the file name.
    const said = String(error.stderr ?? error.message).split("\n");
    const named = said.find((line) => /Error(:|\b)/.test(line));
    return [...said.slice(0, 3), ...(named && !said.slice(0, 3).includes(named) ? [named] : [])]
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }
}
