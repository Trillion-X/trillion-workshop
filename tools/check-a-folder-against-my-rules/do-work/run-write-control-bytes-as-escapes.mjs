#!/usr/bin/env node
// do-work/run-write-control-bytes-as-escapes.mjs
//
// Runs write-control-bytes-as-escapes over the files a caller NAMES, and reports what each one did.
//
// It takes paths rather than discovering them, on the same reasoning the sibling rule-checker uses:
// discovery is where every environment difference lives, so it belongs to the caller (L136). Finding
// the subjects is one search the caller already has:
//
//   grep -r -a -l -P "[\x00-\x08\x0b\x0c\x0e-\x1f]" --include="*.mjs" --include="*.ts" \
//     --include="*.tsx" --include="*.js" <folder>/ | grep -v node_modules
//
// ⚠️ THE `-a` IS NOT OPTIONAL AND IT IS THE WHOLE POINT. Without it grep classifies exactly these
// files as binary and answers with SILENCE, so the search for the defect is silenced by the defect.

import { writeControlBytesAsEscapesIn } from "./write-control-bytes-as-escapes.mjs";

// ⛔ THIS USED TO SILENTLY DROP ANYTHING STARTING WITH `--`, which takes this owner's ONE
// dangerous property, that it names its subjects rather than discovering them, and hands it back:
// a caller writing `--dry-run` out of habit would get a real rewrite and a report that looks
// exactly like the dry one. It takes no flags, so the honest answer to any flag is to refuse and
// say so. The same shape was repaired in the folder checker earlier the same day, where a
// repeated `--under` silently kept the last and answered about half the folder.
const given = process.argv.slice(2);
const flags = given.filter((one) => one.startsWith("-"));
if (flags.length > 0) {
  process.stderr.write(
    "this takes file paths and no flags, and it was given " + flags.join(" ") + ".\n"
    + "Ignoring a flag would be worse than refusing it: it names the files it rewrites rather\n"
    + "than discovering them, so a flag that looks like it narrows the run would not.\n",
  );
  process.exit(2);
}
const paths = given;
if (paths.length === 0) {
  process.stderr.write(
    "name the files to rewrite. Find them with:\n"
    + "  grep -r -a -l -P \"[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]\" --include=\"*.mjs\" \\\n"
    + "    --include=\"*.ts\" --include=\"*.tsx\" --include=\"*.js\" <folder>/ | grep -v node_modules\n"
    + "The -a is required; without it grep reports these files as binary and prints nothing.\n",
  );
  process.exit(2);
}

const said = paths.map((path) => {
  try {
    return writeControlBytesAsEscapesIn(path);
  } catch (error) {
    return { path, changed: false, why: String(error.message ?? error) };
  }
});

process.stdout.write(JSON.stringify({
  rewritten: said.filter((one) => one.changed).length,
  left_alone: said.filter((one) => !one.changed).length,
  each: said,
}, null, 2) + "\n");

// Anything left alone that HAD a raw byte is a refusal a person must read, so it must not exit 0.
process.exit(said.some((one) => !one.changed && one.found) ? 1 : 0);
