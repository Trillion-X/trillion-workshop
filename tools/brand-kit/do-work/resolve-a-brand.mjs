// tools/brand-kit/do-work/resolve-a-brand.mjs
//
// Picks the logo variants a light or a dark page draws from a brand's list rows. Run by the Workshop row
// `tool:resolve-a-brand` on the person's own computer:
//
//   node tools/brand-kit/do-work/resolve-a-brand.mjs <request.json>
//
// request.json: { rows: [{ id, values | value }] (the brand list's rows, as the list or the record store answers them),
// tone?: "light" | "dark", files_at?: a folder holding a copy of each asset under its url's file name, relative to
// request.json }. With files_at, each chosen variant also names its local `file` when that copy is there, so a
// document can carry the bytes without reaching the address. Prints one JSON line: { family, tone, variants, chosen }.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { presentationFromBrand } from '../read-data/brand-assets.mjs';

function fail(message) {
  process.stderr.write(`resolve-a-brand: ${message}\n`);
  process.exit(2);
}

process.on('uncaughtException', error => fail(error.message));

const requestPath = process.argv[2];
if (!requestPath) fail('give the request file: node do-work/resolve-a-brand.mjs <request.json>');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
if (!Array.isArray(request.rows) || !request.rows.length) fail('the request needs rows: the brand list\'s rows.');
const tone = request.tone ?? 'light';
if (tone !== 'light' && tone !== 'dark') fail('tone is light or dark.');

const presentation = presentationFromBrand(request.rows, tone);
if (!presentation.family) fail('no row has role "selection": add one naming the family in use.');
if (request.files_at) {
  const folder = resolve(dirname(resolve(requestPath)), request.files_at);
  const withFile = asset => {
    if (!asset) return asset;
    const file = resolve(folder, basename(new URL(asset.url).pathname));
    return existsSync(file) ? { ...asset, file } : asset;
  };
  for (const group of [presentation.chosen, presentation.variants.light, presentation.variants.dark]) {
    for (const key of Object.keys(group)) group[key] = withFile(group[key]);
  }
}
console.log(JSON.stringify(presentation));
