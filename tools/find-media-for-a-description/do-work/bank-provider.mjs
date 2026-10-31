#!/usr/bin/env node
/**
 * file: tools/find-media-for-a-description/do-work/bank-provider.mjs
 *
 * PURPOSE: The `bank` provider executable for find_media.mjs —
 * tagged lookup over the user's OWN media bank. The bank is a directory whose
 * media carry sidecar tag files (<file>.tags.json, written by whatever
 * tags the media); the request description is matched against tags + filenames, the
 * best match is copied to the requested output path.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Reads only the named bank directory — no global filesystem scanning
 * 2. Matching is plain word overlap over tags + filename — deterministic
 * 3. kind filtering by extension class (still: png/jpg/webp; clip: mp4/mov/webm)
 * 4. Copies bytes; the bank file is never modified
 *
 * Usage: node bank-provider.mjs --describe "<text>" --kind still|clip --bank <dir> --out <file>
 */
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const DESCRIBE = (args.get('describe') ?? '').toLowerCase();
const KIND = args.get('kind') ?? 'clip';
const BANK = args.get('bank');
const OUT = args.get('out');
if (!BANK || !OUT || !existsSync(BANK)) {
  console.error('usage: bank-provider.mjs --describe <text> --kind still|clip --bank <existing dir> --out <file>');
  process.exit(2);
}

const KIND_EXTENSIONS = {
  still: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  clip: new Set(['.mp4', '.mov', '.webm']),
};
const allowed = KIND_EXTENSIONS[KIND];
if (!allowed) {
  console.error(`unknown kind "${KIND}" (still | clip)`);
  process.exit(3);
}

const queryWords = DESCRIBE.split(/[^a-z0-9]+/).filter(Boolean);

function scoreFor(file) {
  const tagFile = join(BANK, `${file}.tags.json`);
  const tags = existsSync(tagFile)
    ? JSON.parse(readFileSync(tagFile, 'utf8')).tags ?? []
    : [];
  const haystack = `${file.toLowerCase()} ${tags.join(' ').toLowerCase()}`;
  return queryWords.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

const candidates = readdirSync(BANK)
  .filter((file) => allowed.has(extname(file).toLowerCase()))
  .map((file) => ({ file, score: scoreFor(file) }))
  .sort((left, right) => right.score - left.score);

const best = candidates[0];
if (!best || (queryWords.length > 0 && best.score === 0)) {
  console.error(`no ${KIND} in the bank matches "${DESCRIBE}" (${candidates.length} candidates)`);
  process.exit(4);
}

copyFileSync(join(BANK, best.file), OUT);
console.log(`[find-media:bank] "${DESCRIBE}" -> ${best.file} (score ${best.score})`);
