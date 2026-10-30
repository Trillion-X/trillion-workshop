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
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromChunks } from '../../content-identity/read-data/identity.mjs';

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

/** Identity of exact arguments and input bytes, including ordered image-pattern inputs. */
export function stageIdentity(args) {
  const inputs = [];
  const binding = new Set();
  const keep = path => {
    if (binding.has(path)) throw new Error('A stage input reference cycle cannot be bound.');
    const stat = statSync(path);
    if (stat.isFile()) inputs.push({ path, bytes: makeHashCodeHexFromChunks(stageInputChunks(path)) });
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

/** Write the sidecar for `out`. Pass identity null before a run so a failed run cannot leave a sidecar vouching for the clobbered file. */
export function markStage(out, identity) {
  writeFileSync(sidecarOf(out), JSON.stringify({ identity }) + '\n');
}

/** True only when `out` is non-empty and its sidecar identity equals the identity of these exact args and inputs now. */
export function reusable(out, args) {
  try {
    const made = JSON.parse(readFileSync(sidecarOf(out), 'utf8'));
    return statSync(out).size > 0 && typeof made.identity === 'string' && made.identity === stageIdentity(args);
  } catch {
    return false;
  }
}
