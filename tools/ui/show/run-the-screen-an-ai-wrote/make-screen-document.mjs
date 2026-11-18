// Writes the one page an AI app loads to run the screen an AI wrote: the runner and the bridge in one script inside the
// page, and the owner's words (which requests find, keep and write screens) as JSON beside it, so the page reads nothing
// from anywhere to start. Usage: node make-screen-document.mjs <owner-words.json> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { aiAppViewDocument } from '../ai-app-bridge/ai-app-view-document.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [wordsFile, out] = process.argv.slice(2);
if (!wordsFile || !out) throw new Error('Give the owner words file and the page to write: node make-screen-document.mjs <words.json> <out.html>');
const words = JSON.parse(readFileSync(wordsFile, 'utf8'));
const bundled = await build({ entryPoints: [join(here, 'boot.mjs')], bundle: true, format: 'iife', minify: true, write: false, logLevel: 'warning' });
// The page wears the owner's look whatever the code draws: its own background, text and type are the look's (the words'
// `css`, such as look.css, names them), so a screen that sets none still looks like the rest of the owner's screens.
const wearsTheLook = 'html,body{margin:0;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);font-family:var(--font-primary,system-ui)}';
const page = aiAppViewDocument({ hostId: words.host ?? 'screen', wordsId: 'screen-words', words: { title: words.title ?? 'Screen', ...words }, inlineScript: bundled.outputFiles[0].text, inlineCss: `${words.css ?? ''}\n${wearsTheLook}` });
writeFileSync(out, page);
process.stdout.write(`wrote ${out}: ${page.length} bytes\n`);
