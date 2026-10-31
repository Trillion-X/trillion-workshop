/**
 * file: tools/check-a-folder-against-my-rules/test/a-unit-larger-than-a-line.test.mjs
 *
 * Can a declared rule judge a subject whose IDENTITY lives on a sibling line?
 *
 * Every rule shipped so far splits by `\n`, and that works because the subjects they judge name
 * their own kind in the same line they occur on: `"action_ref": "action:..."`, `['"`]~/`,
 * `partition_label:`. The key IS the kind.
 *
 * A `stored_bytes` declaration is not like that. It looks like this, and the only thing marking
 * the `"name"` line as a stored-bytes name is a DIFFERENT line above it:
 *
 *     {
 *       "type": "stored_bytes",
 *       "name": "entry-bytes-x",
 *       "source_path": "built-stored-bytes/entry-bytes-x"
 *     },
 *
 * Judged per line, `"name"` matches thousands of unrelated things and the rule is useless. This
 * was nearly written up as "the engine needs a parser-backed rule kind", which would have been a
 * new primitive built on an untested assumption. `unitsOf` already accepts ANY split pattern, so
 * the question is empirical: does a unit larger than a line actually work end to end, with the
 * AND-composed `forbidden` list identifying the subject across its own lines?
 *
 * ANSWER: the mechanism works, and the reach rule still could not ship as DATA. Both halves matter.
 *
 * A unit larger than a line does exactly what was hoped, proven below and cross-checked against
 * four real boundaries. So `unitsOf` was never the limitation and no parser-backed rule kind was
 * missing, which is what this was written to find out.
 *
 * The reach RULE was withdrawn anyway, for a reason found only by running it corpus-wide: there is
 * a FOURTH way a boundary reaches its bytes, and it does not use the name. A
 * `package-target-descriptor` names the SOURCE PATH it wants and the runtime matches that against
 * the stored_bytes registered for the same path
 * (`supabase-sign-in/things-to-store-and-run.json:174` reaching `:12`). Whole packages are wired
 * only this way, so a name-only rule called all 13 of that package's bytes dead.
 *
 * That mechanism is structurally inexpressible here, and the reason is precise: the reference
 * reuses the DECLARATION'S OWN KEY. A declaration carries `source_path` and so does the descriptor
 * that reaches it, so any pattern collected from the same text matches the declaration itself and
 * exempts every entry, leaving a rule that reports a clean corpus forever. The last test in this
 * file is that exact failure mode, written before the corpus proved it real.
 *
 * So the honest boundary is not "regex versus parser" in general. It is: a collected exempt can
 * separate a reference from a declaration ONLY when the two use different keys. When they share a
 * key, nothing collected from that text can tell them apart, and structure is required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violationsInFile } from '../do-work/check-source-files-against-declared-rules.mjs';


// A things array formatted the way the corpus formats it: entries at 4 spaces, fields at 6.
// `sound-script` is referenced by a workflow mount. `entry-bytes-app` is referenced by a package
// entry, BY NAME rather than by address. `orphan-script` is referenced by nothing, and is the
// only correct finding.
const BOUNDARY = `{
  "things": [
    {
      "type": "record",
      "payload": {
        "kind": "sample-entry",
        "entry_bytes": {
          "stored_bytes": "entry-bytes-app"
        }
      }
    },
    {
      "type": "record",
      "payload": {
        "steps": [
          {
            "from": "package::demo::stored-bytes::sound-script"
          }
        ]
      }
    },
    {
      "type": "stored_bytes",
      "name": "sound-script",
      "source_path": "do-work/sound-script.mjs"
    },
    {
      "type": "stored_bytes",
      "name": "entry-bytes-app",
      "source_path": "built-stored-bytes/entry-bytes-app"
    },
    {
      "type": "stored_bytes",
      "name": "orphan-script",
      "source_path": "do-work/orphan-script.mjs"
    }
  ]
}`;

// The boundary between two top-level things, which nested objects cannot reach because they are
// indented deeper. This is the whole trick, and it is DATA, not code.
const THING_BOUNDARY = '\\n    \\},?\\n    \\{\\n';

const reachRule = {
  id: 'a-declared-stored-bytes-is-reached-by-something',
  violation: {
    unit: { split: THING_BOUNDARY },
    // AND-composed: a unit is a stored_bytes declaration only when BOTH lines are present in it.
    // This is what a per-line unit cannot express, and it needs no parser.
    forbidden: [
      { pattern: '"type"\\s*:\\s*"stored_bytes"' },
      { pattern: '"name"\\s*:\\s*"' },
    ],
    // Collected from the whole file. Deliberately collects REFERENCE shapes only: a declaration
    // repeats its own name in `source_path`, so collecting `"name"` would exempt every entry from
    // itself and the rule would find nothing, forever, while looking healthy.
    exempt: [
      { collected: { pattern: '"stored_bytes"\\s*:\\s*"([a-z0-9-]+)"', capture: 1 } },
      { collected: { pattern: 'stored-bytes::([a-z0-9-]+)', capture: 1 } },
    ],
  },
  message: 'this stored_bytes is declared and nothing reaches it',
};

test('a unit larger than a line identifies a subject whose kind lives on a sibling line', () => {
  const found = violationsInFile(reachRule, 'things-to-store-and-run.json', BOUNDARY);
  assert.deepEqual(
    found.map((f) => f.evidence.match(/"name"\s*:\s*"([a-z0-9-]+)"/)[1]),
    ['orphan-script'],
    'only the unreferenced declaration is a finding',
  );
});

test('a reference by NAME exempts, not only a reference by address', () => {
  // entry-bytes-app is reached through `entry_bytes.stored_bytes`, which carries the bare name.
  // A rule that only collected `stored-bytes::<name>` addresses would report all 180 packages
  // that declare an entry bundle, which is exactly the wrong predicate this replaces.
  const found = violationsInFile(reachRule, 'x.json', BOUNDARY);
  assert.equal(
    found.some((f) => f.evidence.includes('entry-bytes-app')),
    false,
    'a bare-name reference must exempt its declaration',
  );
});

test('the finding points at the line the declaration starts on, not the file', () => {
  const [finding] = violationsInFile(reachRule, 'x.json', BOUNDARY);
  const lineText = BOUNDARY.split('\n')[finding.line - 1];
  assert.match(lineText, /\{|"type"/, 'the reported line is inside the offending unit');
});

test('collecting the declaration side instead of the reference side silently finds NOTHING', () => {
  // The failure mode worth a test of its own, because it looks identical to a clean corpus.
  const selfExempting = {
    ...reachRule,
    violation: {
      ...reachRule.violation,
      exempt: [{ collected: { pattern: '"name"\\s*:\\s*"([a-z0-9-]+)"', capture: 1 } }],
    },
  };
  assert.equal(
    violationsInFile(selfExempting, 'x.json', BOUNDARY).length,
    0,
    'every declaration exempts itself, so a real orphan is reported clean',
  );
});

test('a nested object at deeper indentation does not split a unit', () => {
  // If the split leaked into nested payloads, the `"type"` and `"name"` lines of one declaration
  // could land in different units and the AND would never hold.
  const found = violationsInFile(reachRule, 'x.json', BOUNDARY);
  assert.equal(found.length, 1, 'nested payload objects did not fragment the declarations');
});

// A synthetic fixture is formatted the way its author formats it, so agreement with a parser is
// the control: parse the same bytes with JSON.parse, compute the unreferenced set properly, and
// require the text-split rule to agree exactly. Disagreement in either direction is a failure,
// including the rule finding FEWER, which is the silent one (an AND-composed `forbidden` that
// stops holding reports a clean file, so zero findings would mean both healthy and blind).
//
// The parser and the rule look for the SAME two reference shapes, so this is not an independent
// check of which shapes count. It is an independent check of UNIT FINDING: the parser gets its
// declarations from JSON.parse and the rule gets them from a regex split.
const unreferencedByParser = (boundaryText, pkg) => {
  const things = JSON.parse(boundaryText).things;
  const consumers = JSON.stringify(things.filter((t) => t.type !== 'stored_bytes'));
  return things
    .filter((t) => t.type === 'stored_bytes')
    .filter((t) => {
      const byEntryKey = `"stored_bytes":${JSON.stringify(t.name)}`;
      const byAddress = JSON.stringify(`package::${pkg}::stored-bytes::${t.name}`);
      return !consumers.includes(byEntryKey) && !consumers.includes(byAddress);
    })
    .map((t) => t.name)
    .sort();
};

test('the declared rule agrees with a parser on a sample boundary', () => {
  const fromParser = unreferencedByParser(BOUNDARY, 'demo');
  const fromRule = violationsInFile(reachRule, 'sample/things.json', BOUNDARY)
    .map((f) => f.evidence.match(/"name"\s*:\s*"([^"]+)"/)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(fromRule, fromParser, 'text-split rule and parser must name the same set');
  assert.ok(fromParser.length > 0, 'the sample declares an unreferenced thing, so agreement is not agreement on nothing');
});

test('the rule CANNOT see source-path reach, proved rather than asserted', () => {
  // A consumer can reach bytes by naming the SOURCE PATH, never the name, and the declaration
  // carries that same `source_path` key. So a collected exempt cannot separate the two: collecting
  // source paths would match every declaration's own line and exempt the entire corpus. A parser
  // that knows source-path reach and the rule that cannot MUST disagree here, and the parser is
  // the one that is right.
  const text = `{
  "things": [
    {
      "type": "record",
      "payload": {
        "kind": "sample-entry",
        "source_path": "do-work/reached-by-path.mjs"
      }
    },
    {
      "type": "stored_bytes",
      "name": "reached-by-path",
      "source_path": "do-work/reached-by-path.mjs"
    },
    {
      "type": "stored_bytes",
      "name": "reached-by-nothing",
      "source_path": "do-work/reached-by-nothing.mjs"
    }
  ]
}`;
  const things = JSON.parse(text).things;
  const consumers = JSON.stringify(things.filter((t) => t.type !== 'stored_bytes'));
  const missedByTheRule = violationsInFile(reachRule, 'sample/things.json', text)
    .map((f) => f.evidence.match(/"name"\s*:\s*"([^"]+)"/)?.[1])
    .filter((name) => {
      const declaration = things.find((t) => t.type === 'stored_bytes' && t.name === name);
      return declaration && consumers.includes(JSON.stringify(declaration.source_path));
    });
  assert.deepEqual(missedByTheRule, ['reached-by-path'], 'it is reached by source path, and the rule reports it anyway');
});
