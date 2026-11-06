// Lists the longest still holds of a video, each with the second it starts, read with the same measure as check-motion.mjs
// (read-data/measure-motion.mjs: its frame changes, its cut level and its still level), so a hold the check counts can be
// found and cut. Ported from a film's hold list (ports/list-holds.json); the hold-listing lines below are that list's own.
// usage: node list-holds.mjs --video VIDEO.mp4 [--seconds S] [--still LEVEL] [--top N]
//   --seconds  measure the video from 0 to there (all of it when left out or 0)
//   --still    the still level to read it at, for example a reference's still_threshold (read from this video when left out)
//   --top      how many holds to list, longest first (12 when left out)
// The last line printed is {"result": {"video", "seconds", "still_threshold", "holds": [{"seconds", "at"}], "text"}} or
// {"error": "what to change"}. `text` is the list on one line, `<seconds>s@<at>` per hold.
import { existsSync, readFileSync } from 'node:fs';
import { frameChanges, probe, stillLevelOf } from '../read-data/measure-motion.mjs';

const USAGE = 'usage: node list-holds.mjs --video VIDEO.mp4 [--seconds S] [--still LEVEL] [--top N]';
const FLAGS = ['--video', '--seconds', '--still', '--top'];
const CUT = JSON.parse(readFileSync(new URL('../read-data/motion-measure.json', import.meta.url), 'utf8')).cut_level;
const round = n => Math.round(n * 100) / 100;

const fail = (message, code = 2) => {
  console.log(JSON.stringify({ error: message }));
  process.exit(code);
};

const given = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!FLAGS.includes(argv[i]) || argv[i + 1] === undefined) fail(`${USAGE}. Could not read ${argv[i]}.`);
  given[argv[i].slice(2)] = argv[i + 1];
}
if (!given.video) fail(USAGE);
if (!existsSync(given.video)) fail(`The video file ${given.video} is not there. Give the path of a video file.`);
const number = (name, fallback, ok, need) => {
  if (given[name] === undefined) return fallback;
  const value = Number(given[name]);
  if (!ok(value)) fail(`--${name} ${given[name]} is not ${need}.`);
  return value;
};
const secs = number('seconds', 0, value => Number.isFinite(value) && value >= 0, 'a number of seconds, 0 or more');
const asked = number('still', null, value => Number.isFinite(value) && value > 0, 'a still level above 0 (a change in grey, 0 to 255)');
const top = number('top', 12, value => Number.isInteger(value) && value > 0, 'a whole number above 0');

let p, d;
try {
  p = probe(given.video);
  d = frameChanges(given.video, secs || p.duration, p);
} catch (error) {
  fail(`${error.message} The measure needs ffmpeg and ffprobe on the PATH and a video file that has a picture.`);
}
const STILL = asked ?? stillLevelOf(d);
const moving = d.map((_, i) => [d[i - 1], d[i], d[i + 1]].some((v) => v > STILL && v <= CUT));
const holds = [];
for (let i = 0, run = 0, s = 0; i <= moving.length; i++) {
  if (i < moving.length && !moving[i] && d[i] <= CUT) { if (!run) s = i; run++; }
  else { if (run) holds.push([run / p.fps, s / p.fps]); run = 0; }
}
holds.sort((a, b) => b[0] - a[0]);
const listed = holds.slice(0, top);
console.log(JSON.stringify({ result: {
  video: given.video,
  seconds: round(secs || p.duration),
  still_threshold: round(STILL),
  holds: listed.map(([h, s]) => ({ seconds: round(h), at: round(s) })),
  text: listed.map(([h, s]) => h.toFixed(2) + 's@' + s.toFixed(2)).join('  '),
} }));
