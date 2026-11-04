// tools/take-pictures-out-of-a-zip-archive/do-work/take-pictures-out.mjs
//
// tool:take-pictures-out-of-a-zip-archive. The row's request ({ zip_base64, profile?, limits? }) handed to the moved
// archiveEntries (src/archive-entries.mjs): the archive's admitted entries, in archive order, each as { title,
// media_type, bytes_base64, byte_count }. An entry's name is never used as a path. A limit passed refuses the whole
// archive in the words the module gives.
import { ArchiveRefused, archiveEntries, profile } from '../src/archive-entries.mjs';
import rules from '../src/archive-entries.json' with { type: 'json' };

export function takePicturesOut({ zip_base64, profile: named, limits } = {}) {
  if (typeof zip_base64 !== 'string' || !zip_base64) throw new Error('Give zip_base64: the zip archive\'s bytes as base64.');
  if (named !== undefined && !rules.profiles?.[named]) throw new Error(`profile is one of ${Object.keys(rules.profiles ?? {}).join(', ')}; leave it out for the default limits.`);
  const base = named ? profile(named) : rules;
  try {
    const entries = archiveEntries(new Uint8Array(Buffer.from(zip_base64, 'base64')), { ...base, ...(limits ?? {}) });
    return { entries: entries.map(entry => ({ title: entry.title, media_type: entry.media_type, byte_count: entry.bytes.length, bytes_base64: Buffer.from(entry.bytes).toString('base64') })), count: entries.length };
  } catch (error) {
    if (error instanceof ArchiveRefused) throw new Error(`${error.message} Send a smaller archive, or split it.`);
    throw error;
  }
}
