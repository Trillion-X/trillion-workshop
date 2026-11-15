/**
 * file: packages/media-composition/do-work/stage-reuse.mjs
 *
 * PURPOSE: Decides whether an existing render-stage output may be reused on --resume.
 * An output file alone is not proof it came from the current inputs: a changed EDL, input
 * file, or argument list would silently reuse a stale stage. So every stage that ff() writes
 * gets a sidecar `<out>.made-from.json` holding the identity of the exact ffmpeg argument list
 * plus the bytes of each input file. A stage is reusable only when that sidecar
 * exists and equals the identity computed now.
 *
 * Kept as its own module (not inside video-compose.mjs) because video-compose.mjs runs its CLI
 * at import time, so it cannot be imported by tests.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { makeHashCodeHasher, makeHashCodeHexFromBytes, makeHashCodeHexFromChunks } from '../../content-identity/read-data/identity.mjs';

const sidecarOf = out => `${out}.made-from.json`;

/** Bounded source reads. A chunk is consumed before the reusable buffer advances. */
export function* stageInputChunks(path, chunkBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new TypeError('A positive whole chunk size is required.');
  const descriptor = openSync(path, 'r'), buffer = Buffer.allocUnsafe(chunkBytes);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      yield buffer.subarray(0, count);
    }
  } finally { closeSync(descriptor); }
}

const fileVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

/** Per-render bounded digest reuse. Every lookup verifies the opened file still matches the path version. */
export function createStageHashSession({ maxEntries = 64, chunkBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('A positive whole cache bound is required.');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new TypeError('A positive whole chunk size is required.');
  const cache = new Map();
  const versionOf = stat => fileVersion(stat);
  const changed = path => new Error(`Stage input changed while its identity was checked: ${path}`);
  const assertStable = (path, before, opened, afterOpened, afterPath) => {
    const expected = versionOf(before);
    if (versionOf(opened) !== expected || versionOf(afterOpened) !== expected || versionOf(afterPath) !== expected)
      throw changed(path);
  };

  return {
    identity(path) {
      const before = statSync(path, { bigint: true });
      if (!before.isFile()) throw new TypeError(`A stage input must be a regular file: ${path}`);
      const version = versionOf(before);
      const descriptor = openSync(path, 'r');
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        const entry = cache.get(path);
        if (entry?.version === version) {
          const afterOpened = fstatSync(descriptor, { bigint: true });
          const afterPath = statSync(path, { bigint: true });
          assertStable(path, before, opened, afterOpened, afterPath);
          cache.delete(path); cache.set(path, entry);
          return { bytes: entry.bytes, reused: true };
        }

        cache.delete(path);
        if (versionOf(opened) !== version) throw changed(path);
        const hasher = makeHashCodeHasher(), buffer = Buffer.allocUnsafe(chunkBytes);
        for (;;) {
          const count = readSync(descriptor, buffer, 0, buffer.length, null);
          if (!count) break;
          hasher.update(buffer.subarray(0, count));
        }
        const afterOpened = fstatSync(descriptor, { bigint: true });
        const afterPath = statSync(path, { bigint: true });
        assertStable(path, before, opened, afterOpened, afterPath);
        const bytes = hasher.identity();
        cache.set(path, { version, bytes });
        if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return { bytes, reused: false };
      } finally { closeSync(descriptor); }
    },
    clear() { cache.clear(); },
  };
}

/** Identity of exact arguments and input bytes, including ordered image-pattern inputs. */
export function stageIdentity(args, hashSession = null) {
  const inputs = [];
  const binding = new Set();
  const keep = path => {
    if (binding.has(path)) throw new Error('A stage input reference cycle cannot be bound.');
    const stat = statSync(path);
    if (stat.isFile()) inputs.push({ path, bytes: hashSession
      ? hashSession.identity(path).bytes : makeHashCodeHexFromChunks(stageInputChunks(path)) });
  };
  let inputFormat = null;
  args.forEach((arg, index) => {
    if (args[index - 1] === '-f') inputFormat = arg;
    if (args[index - 1] !== '-i' || typeof arg !== 'string') return;
    const format = inputFormat; inputFormat = null;
    let files = existsSync(arg) ? [arg] : [];
    if (!files.length && /%0?\d*d/.test(basename(arg)) && existsSync(dirname(arg))) {
      const escaped = basename(arg).split(/(%0?\d*d)/).map(part => /^%0?\d*d$/.test(part)
        ? '\\d+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      const pattern = new RegExp(`^${escaped}$`);
      files = readdirSync(dirname(arg)).filter(file => pattern.test(file)).sort().map(file => join(dirname(arg), file));
    }
    for (const path of files) keep(path);
    if (format === 'concat' && files.length === 1) {
      binding.add(arg);
      for (const line of readFileSync(arg, 'utf8').split(/\r?\n/)) {
        if (!/^\s*file\s/.test(line)) continue;
        const text = line.replace(/^\s*file\s+/, '');
        let quoted = false, reference = '', at = 0;
        for (; at < text.length; at++) {
          const character = text[at];
          if (character === "'") quoted = !quoted;
          else if (character === '\\' && !quoted && at + 1 < text.length) reference += text[++at];
          else if (!quoted && /\s/.test(character)) break;
          else reference += character;
        }
        if (quoted || !reference || text.slice(at).trim() && !text.slice(at).trim().startsWith('#'))
          throw new Error('A concat stage input reference cannot be bound.');
        keep(resolve(dirname(arg), reference));
      }
      binding.delete(arg);
    }
  });
  return makeHashCodeHexFromBytes(Buffer.from(JSON.stringify({ args, inputs })));
}

/** The BLAKE3 identity of the bytes `out` holds now, read in bounded chunks (the same owner as the inputs). */
function outputIdentity(out) {
  return makeHashCodeHexFromChunks(stageInputChunks(out));
}

/**
 * Write the sidecar for `out`: the recipe identity (`identity`, the args and input bytes that made it) and the BLAKE3 of
 * the output bytes (`output`). Pass identity null before a run so a failed run cannot leave a sidecar vouching for the
 * clobbered file.
 */
export function markStage(out, identity) {
  const made = identity === null ? { identity } : { identity, output: outputIdentity(out) };
  writeFileSync(sidecarOf(out), JSON.stringify(made) + '\n');
}

/**
 * True only when `out` is non-empty, its sidecar identity equals the identity of these exact args and inputs now, and its
 * bytes still hash to the sidecar's `output` (a damaged or swapped output is never reused).
 */
export function reusable(out, args, hashSession = null) {
  try {
    const made = JSON.parse(readFileSync(sidecarOf(out), 'utf8'));
    return statSync(out).size > 0 && typeof made.identity === 'string' && made.identity === stageIdentity(args, hashSession)
      && typeof made.output === 'string' && made.output === outputIdentity(out);
  } catch {
    return false;
  }
}
