// Checks that a render moves about as much as the video it copies. A motion measure that sets its "still" threshold from
// whatever window it is given moves the bar when a piece is trimmed. Here the threshold always comes from the WHOLE
// reference, and the piece is measured from 0 to its end card at that threshold. How much the piece must move is not in
// this file: the person passes their own bar (--bar FILE, a record of kind motion-bar; see the README).
// usage: node check-motion.mjs --reference REF.mp4 --render RENDER.mp4 --end-card-start SECONDS --bar BAR.json
// The last line printed is {"result": {...}} or {"error": "what to change"}.
import { existsSync, readFileSync } from 'node:fs';
import { measureMotion } from '../read-data/measure-motion.mjs';
import { barFor, judge, rowsOf } from '../read-data/motion-bar.mjs';

const USAGE = 'usage: node check-motion.mjs --reference REF.mp4 --render RENDER.mp4 --end-card-start SECONDS --bar BAR.json';
const FLAGS = ['--reference', '--render', '--end-card-start', '--bar'];

const fail = (message, code = 2) => {
  console.log(JSON.stringify({ error: message }));
  process.exit(code);
};

function options(argv) {
  const found = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!FLAGS.includes(name) || argv[i + 1] === undefined) fail(`${USAGE}. Could not read ${name}.`);
    found[name.slice(2)] = argv[i + 1];
  }
  return found;
}

const given = options(process.argv.slice(2));
const { reference, render } = given;
const endCard = Number(given['end-card-start']);
if (!reference || !render || given['end-card-start'] === undefined || !given.bar) fail(USAGE);
if (!(endCard > 0)) fail('--end-card-start is the second the end card begins, above 0; the piece is measured from 0 to there.');
for (const [name, path] of [['reference', reference], ['render', render], ['bar', given.bar]]) {
  if (!existsSync(path)) fail(`The ${name} file ${path} is not there. Give the path of ${name === 'bar' ? 'a motion-bar JSON file' : 'a video file'}.`);
}
let record;
try {
  record = JSON.parse(readFileSync(given.bar, 'utf8'));
} catch {
  fail(`The bar file ${given.bar} is not JSON. Give a motion-bar record as JSON.`);
}
const rows = rowsOf(record);
if (rows instanceof Error) fail(rows.message);

let ref, draft;
try {
  ref = measureMotion(reference, 0);
  draft = measureMotion(render, endCard, ref.still_threshold);
} catch (error) {
  fail(`${error.message} The measure needs ffmpeg and ffprobe on the PATH and a video file that has a picture.`);
}
for (const row of rows) {
  for (const [who, measured] of [['reference', ref], ['piece', draft]]) {
    if (!Number.isFinite(measured[row.measure])) fail(`The measure gives no number ${row.measure} for the ${who}; bar row ${row.name} names a measure it does not give (it gives moving_share, longest_hold_s, holds_over_1s_per_min, seconds, still_threshold).`);
  }
}
const bar = barFor(ref, rows);
const { pass, verdict } = judge(draft, bar, rows);
const result = {
  still_threshold: ref.still_threshold,
  reference: { path: reference, seconds: ref.seconds, moving_share: ref.moving_share, longest_hold_s: ref.longest_hold_s },
  draft: { path: render, seconds: draft.seconds, moving_share: draft.moving_share, longest_hold_s: draft.longest_hold_s,
    holds_over_1s_per_min: draft.holds_over_1s_per_min },
  bar, pass, verdict,
};
console.log(JSON.stringify({ result }));
