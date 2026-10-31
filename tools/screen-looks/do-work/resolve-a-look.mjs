// tools/screen-looks/do-work/resolve-a-look.mjs
//
// Resolves one look into the concrete values and the stylesheet a page, an email or a slide carries. Run by the
// Workshop row `tool:resolve-a-look` on the person's own computer:
//
//   node tools/screen-looks/do-work/resolve-a-look.mjs <request.json> [--css <out.css>]
//
// request.json: { look: { tokens: [{ key, value, ... }] } (a look record as its owner keeps it), faces?: [{ family,
// weight?, style?, file }] }. A face's `file` is a font file on this computer, relative to request.json; the look's
// font variables decide which of them are written. Prints one JSON line: { palette, families, faces_written,
// faces_missing, css_bytes }, and writes the stylesheet to --css when given.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { resolveScreenLookPalette } from '../read-data/resolve-screen-look-palette.js';
import { familiesNamedBy, lookDocumentCss } from '../read-data/look-document-css.js';

const FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

function fail(message) {
  process.stderr.write(`resolve-a-look: ${message}\n`);
  process.exit(2);
}

process.on('uncaughtException', error => fail(error.message));

const args = process.argv.slice(2);
const requestPath = args[0];
if (!requestPath) fail('give the request file: node do-work/resolve-a-look.mjs <request.json> [--css <out.css>]');
const cssAt = args.indexOf('--css');
const cssPath = cssAt >= 0 ? args[cssAt + 1] : undefined;
if (cssAt >= 0 && !cssPath) fail('--css needs a file to write the stylesheet to.');

const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const look = request.look?.payload ?? request.look;
if (!look || !Array.isArray(look.tokens)) fail('the request needs look.tokens: the look record as its owner keeps it.');

const palette = resolveScreenLookPalette(look);
const named = familiesNamedBy(palette);
const base = dirname(resolve(requestPath));
const faces = [];
const missing = [];
for (const face of request.faces ?? []) {
  if (!face?.family || !face?.file) fail('each face needs a family and a file.');
  if (!named.has(face.family)) continue;
  const format = FORMATS[extname(face.file).toLowerCase()];
  if (!format) fail(`${face.file}: a face file is .woff2, .woff, .ttf or .otf.`);
  let bytes;
  try { bytes = readFileSync(resolve(base, face.file)); } catch { missing.push(face.file); continue; }
  faces.push({ family: face.family, weight: face.weight ?? 400, style: face.style ?? 'normal', format, data: bytes.toString('base64') });
}

const css = lookDocumentCss(palette, faces);
if (cssPath) writeFileSync(cssPath, css);
console.log(JSON.stringify({
  palette,
  // The size and weight variables share the font- prefix; a family name never starts with a digit.
  families: [...named].filter(name => !/^\d/.test(name)),
  faces_written: faces.map(face => `${face.family} ${face.weight} ${face.style}`),
  faces_missing: missing,
  css_bytes: Buffer.byteLength(css),
}));
