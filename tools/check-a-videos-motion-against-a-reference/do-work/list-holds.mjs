// Lists the longest still holds of a video, each with the second it starts, read with the same measure and still level as
// check-motion.mjs (read-data/measure-motion.mjs), so a hold the check counts can be found and cut.
// usage: node list-holds.mjs --video VIDEO.mp4 [--seconds S] [--still LEVEL] [--top N]
//   --seconds  measure the video from 0 to there (all of it when left out or 0)
//   --still    the still level to read it at, for example a reference's still_threshold (read from this video when left out)
//   --top      how many holds to list, longest first (12 when left out)
// The last line printed is {"result": {"video", "seconds", "still_threshold", "holds": [{"seconds", "at"}], "text"}} or {"error": "what to change"}.
import { existsSync } from 'node:fs';
import { longestHolds } from '../read-data/measure-motion.mjs';

const USAGE = 'usage: node list-holds.mjs --video VIDEO.mp4 [--seconds S] [--still LEVEL] [--top N]';
const FLAGS = ['--video', '--seconds', '--still', '--top'];

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
const seconds = number('seconds', 0, value => Number.isFinite(value) && value >= 0, 'a number of seconds, 0 or more');
const still = number('still', null, value => Number.isFinite(value) && value > 0, 'a still level above 0 (a change in grey, 0 to 255)');
const top = number('top', 12, value => Number.isInteger(value) && value > 0, 'a whole number above 0');

let measured;
try {
  measured = longestHolds(given.video, seconds, still, top);
} catch (error) {
  fail(`${error.message} The measure needs ffmpeg and ffprobe on the PATH and a video file that has a picture.`);
}
console.log(JSON.stringify({ result: { video: given.video, ...measured } }));
