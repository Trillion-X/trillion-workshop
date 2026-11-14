#!/usr/bin/env node
// packages/check-source-files-against-declared-rules/do-work/lift-reader-notes-out-of-package-data.mjs
//
// Removes human-facing note fields from package DATA and PRINTS THEIR TEXT, so the reasoning can be
// put where the rule says it belongs (the README, the commit message, the knowledge leaf) instead
// of being destroyed on its way out.
//
// WHY THIS EXISTS AS AN OWNER RATHER THAN AS A ONE-OFF. The rule beside it,
// a-record-payload-may-not-carry-a-note-to-the-reader, reports these across the whole corpus, and
// they sit in manifests nobody reads end to end and that somebody else is usually editing. The live
// count is whatever that checker prints, and it is deliberately not written here, because a figure
// in a comment cannot be corrected by the change that invalidates it. Two things follow. Hand-editing at that scale corrupts files, because a note is
// often the LAST key in its object and deleting the line leaves a dangling comma that a reader does
// not see until something fails to parse. And a throwaway script cannot be reviewed, so the repair
// for a rule about durable reasoning would itself be undurable.
//
// THE PATTERN IS NOT WRITTEN HERE. It is read from the rule record, so this cannot drift away from
// what the checker actually reports. The rule's own `why` records that this pattern was widened once
// already, from six enumerated words to the underscore convention, and a second copy of it here
// would have been the thing that failed to be widened.
//
// WHAT IT REFUSES TO DO, on purpose:
//   - a note whose value is not a single-line string (an object, an array, a wrapped string) is
//     REPORTED AND LEFT ALONE. Those need a human decision about structure, and a tool that guesses
//     at them is how a manifest silently loses a real field.
//   - nothing is written unless the result parses AND deep-equals the original document with only
//     those fields removed. A textual edit that changes anything else is a defect, not a repair.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULE_SOURCE = join(HERE, "..", "things-to-store-and-run.json");
const RULE_ID = "a-record-payload-may-not-carry-a-note-to-the-reader";

/** The forbidden patterns the named rule declares, read from the rule record itself. */
export function forbiddenPatternsFromRule(document, ruleId) {
  const found = [];
  const goOver = (node) => {
    if (Array.isArray(node)) return node.forEach(goOver);
    if (!node || typeof node !== "object") return;
    if (node.kind === "source-file-rule" && node.id === ruleId) {
      for (const entry of node.violation?.forbidden ?? []) {
        if (typeof entry.pattern === "string") found.push(entry.pattern);
      }
      return;
    }
    Object.values(node).forEach(goOver);
  };
  goOver(document);
  if (found.length === 0) throw new Error(`the rule ${ruleId} declares no forbidden pattern`);
  return found;
}

/** The same document with every underscore-prefixed string field removed, at any depth. */
export function withoutReaderNotes(node) {
  if (Array.isArray(node)) return node.map(withoutReaderNotes);
  if (!node || typeof node !== "object") return node;
  const kept = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("_") && typeof value === "string") continue;
    kept[key] = withoutReaderNotes(value);
  }
  return kept;
}

/** The nearest identity above a line, so a lifted note can be placed back against what it described. */
function whatThisLineIsUnder(lines, index) {
  for (let at = index; at >= 0; at -= 1) {
    const named = /^\s*"(address|id|name)"\s*:\s*"([^"]+)"/.exec(lines[at]);
    if (named) return named[2];
  }
  return "(no enclosing address, id or name)";
}

/**
 * The whole edit, as data. Returns what would be removed, what it refuses to touch, and the
 * resulting text, WITHOUT writing anything, so the caller can prove it before it lands.
 */
export function liftReaderNotes(text, patterns) {
  const matchers = patterns.map((pattern) => new RegExp(pattern));
  const wholeStringField = /^(\s*)"(_[a-z][a-z0-9_]*)"\s*:\s*("(?:[^"\\]|\\.)*")(,?)\s*$/;
  const lines = text.split("\n");
  const kept = [];
  const lifted = [];
  const refused = [];

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    if (!matchers.some((matcher) => matcher.test(line))) {
      kept.push(line);
      continue;
    }
    const field = wholeStringField.exec(line);
    if (!field) {
      refused.push({
        line: at + 1,
        why: "not a note field holding a single-line string, so it may be an ordinary value that merely mentions one",
        text: line.trim(),
      });
      kept.push(line);
      continue;
    }
    lifted.push({
      line: at + 1,
      field: field[2],
      under: whatThisLineIsUnder(lines, at),
      text: JSON.parse(field[3]),
    });
    // No trailing comma means this was the LAST key in its object, so the comma that used to
    // separate it from the previous key has to go with it or the document stops parsing.
    if (!field[4]) {
      for (let back = kept.length - 1; back >= 0; back -= 1) {
        if (!kept[back].trim()) continue;
        kept[back] = kept[back].replace(/,\s*$/, "");
        break;
      }
    }
  }

  return { lifted, refused, text: kept.join("\n") };
}

function main(argv) {
  const write = argv.includes("--write");
  const files = argv.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    console.error("name at least one package DATA file to lift notes out of");
    return 2;
  }
  const patterns = forbiddenPatternsFromRule(JSON.parse(readFileSync(RULE_SOURCE, "utf8")), RULE_ID);

  let refusedAnywhere = 0;
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const { lifted, refused, text } = liftReaderNotes(before, patterns);

    // The proof, and the reason this is safe to run against a manifest somebody else has open: the
    // result must parse, and it must equal the original document minus exactly those fields.
    const after = JSON.parse(text);
    if (JSON.stringify(after) !== JSON.stringify(withoutReaderNotes(JSON.parse(before)))) {
      console.error(`${file}: the edit changed something other than the notes, so nothing was written`);
      return 1;
    }

    const distinct = new Map();
    for (const note of lifted) {
      const seen = distinct.get(note.text) ?? { fields: new Set(), under: new Set() };
      seen.fields.add(note.field);
      seen.under.add(note.under);
      distinct.set(note.text, seen);
    }

    console.log(`${file}: ${lifted.length} note field(s), ${distinct.size} distinct text(s)`);
    for (const [noteText, seen] of distinct) {
      console.log(`\n  ${[...seen.fields].join(", ")} under ${[...seen.under].join("; ")}`);
      console.log(`  ${noteText}`);
    }
    for (const entry of refused) {
      refusedAnywhere += 1;
      console.log(`\n  LEFT ALONE line ${entry.line}: ${entry.why}\n  ${entry.text}`);
    }
    if (write && lifted.length > 0) {
      writeFileSync(file, text);
      console.log(`\n  written`);
    }
  }
  if (!write) console.log("\nnothing was written; pass --write to apply");
  return refusedAnywhere > 0 ? 3 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
