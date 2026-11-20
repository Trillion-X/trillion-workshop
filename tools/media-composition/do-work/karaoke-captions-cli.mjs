import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { karaokeAss } from "./author-karaoke-captions.mjs";

// CLI: node karaoke-captions-cli.mjs --lines '<json>' [--highlight #hex --base #hex --size N --width W --height H]
// Prints the ASS string. `--lines` is the caption-lines output ([{start,end,words:[{text,start,end}]}]).
// The page imports the author (author-karaoke-captions.mjs) too, where there is no command line to read, so the command
// line lives here, outside the page bundle.
if (globalThis.process?.argv && import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const args = process.argv.slice(2);
  const opt = {}; let lines = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i], v = args[i + 1];
    if (k === '--lines') lines = JSON.parse(v);
    else if (k === '--highlight') opt.highlight = v;
    else if (k === '--base') opt.base = v;
    else if (k === '--size') opt.size = Number(v);
    else if (k === '--width') opt.playResX = Number(v);
    else if (k === '--height') opt.playResY = Number(v);
    else if (k === '--align') opt.alignment = Number(v);
  }
  if (!Array.isArray(lines) || !lines.length) { console.error('usage: author-karaoke-captions.mjs --lines \'[{"start":0,"end":2,"words":[{"text":"hi","start":0,"end":1}]}]\' [--highlight #hex --base #hex --size N --width W --height H]'); process.exit(2); }
  process.stdout.write(karaokeAss(lines, opt));
}
