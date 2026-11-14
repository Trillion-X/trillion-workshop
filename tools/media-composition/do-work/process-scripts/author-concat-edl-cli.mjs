// packages/media-composition/do-work/process-scripts/author-concat-edl-cli.mjs
//
// Standalone CLI for the LIVE "windows → base_span concat EDL" `compute.process` step
// (the CJ-B.4 highlight-reel author step). Reads the mounted inputs, calls the pure
// `authorConcatEdl` (bundled into this script at deploy via esbuild, NOT reimplemented —
// single SSOT), and prints the result as clean JSON to stdout. A downstream media-
// composition RENDER step consumes `.edl`; a `write` step records the reel.
//
// Two invocation forms (both produce { edl, segmentCount, skipped, totalDurationS }):
//   LOCAL/TEST (positional):  author-concat-edl-cli <windows.json> <base-artifact>
//   WORKFLOW (compute.process — JSON passed as argv strings, result to an output FILE):
//     author-concat-edl-cli --windows-json <json> --base-artifact <path> \
//        [--encode-json <json>] [--id-prefix <str>] [--output-json out.json]
// The workflow form mirrors measure-compute-cli exactly: upstream step outputs are
// stringified into argv, the result is written to an output FILE so a `return` step can
// bind outputs.0.bytes.base64 → decode → json_parse.
//
// `windows` is exactly the `constrained-span-pack` output `.selected`
// ([{id,start,end,score,category}]) — authorConcatEdl reads only start/end (+ optional
// overlaySource), so the reel author consumes the selection output with no reshaping.

import { readFileSync, writeFileSync } from 'node:fs';

import { authorConcatEdl } from '../author-concat-edl.mjs';

// stdout is the compute.process result channel and MUST be clean JSON — route any
// diagnostic output to stderr so it never corrupts the stdout JSON contract.
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = console.log;
console.debug = console.log;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i += 1; }
    else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));

let windows;
let baseArtifact;
let encode;
let idPrefix;

if (flags['windows-json'] !== undefined || flags['base-artifact'] !== undefined) {
  windows = JSON.parse(flags['windows-json'] ?? '[]');
  baseArtifact = flags['base-artifact'];
  if (flags['encode-json']) encode = JSON.parse(flags['encode-json']);
  if (flags['id-prefix']) idPrefix = flags['id-prefix'];
} else {
  // positional: <windows.json> <base-artifact>
  windows = JSON.parse(readFileSync(positional[0], 'utf8'));
  baseArtifact = positional[1];
}

const result = authorConcatEdl({ baseArtifact, windows, ...(encode ? { encode } : {}), ...(idPrefix ? { idPrefix } : {}) });
const json = JSON.stringify(result);

if (flags['output-json']) writeFileSync(flags['output-json'], json);
else process.stdout.write(json + '\n');
