// Read the file named by a source rule without letting filesystem aliases choose a different
// owner or a nonregular descriptor block the checker. Policy still belongs to rule DATA.
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs';
import path from 'node:path';

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameBytes = (a, b) => sameFile(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Content custody may not follow aliases. A name-only rule can inspect a terminal
 * entry without opening its target, which does not admit that target as source. */
function inspectPath(root, relative, allowTerminalAlias = false) {
  const parts = relative.split('/');
  let absolute = root;
  const entries = [];
  for (const part of parts) {
    absolute = path.join(absolute, part);
    let stat;
    try { stat = lstatSync(absolute, {bigint: true}); } catch (error) {
      if (missing(error)) return {status: 'missing'};
      return {status: 'refused', reason: 'source-path-unreadable'};
    }
    if (stat.isSymbolicLink() && !(allowTerminalAlias && entries.length === parts.length - 1)) {
      try { realpathSync(absolute); } catch (error) {
        if (missing(error)) return {status: 'dangling', reason: 'dangling-source-link'};
      }
      return {status: 'refused', reason: 'source-path-is-an-alias'};
    }
    entries.push(stat);
  }
  return {status: 'present', absolute, entries, stat: entries.at(-1)};
}

/** No source text is returned for missing, dangling, changed, aliased or special inputs.
 * Name-only inspection never opens the payload and reports content_read:false.
 * Descriptor checks cover replacements at open and during the read. This is a source
 * snapshot check, not an OS sandbox against arbitrary concurrent filesystem attackers. */
export function readSourceFileInRepository(repoRoot, relative, {contentRequired = true, regularRequired = true} = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    return {status: 'refused', reason: 'source-path-not-repository-relative'};
  }
  let root;
  try { root = realpathSync(repoRoot); } catch {
    return {status: 'refused', reason: 'source-root-unavailable'};
  }
  const nameOnly = !contentRequired && !regularRequired;
  const before = inspectPath(root, relative, nameOnly);
  if (before.status !== 'present') return before;
  if (!nameOnly && !before.stat.isFile()) return {status: 'refused', reason: 'source-is-not-regular'};
  if (nameOnly) {
    const after = inspectPath(root, relative, true);
    if (after.status !== 'present' || !sameBytes(before.stat, after.stat)
        || before.entries.length !== after.entries.length
        || before.entries.some((stat, index) => !sameFile(stat, after.entries[index]))) {
      return {status: 'refused', reason: 'source-name-changed-during-inspection'};
    }
    return {status: 'read', text: '', content_read: false};
  }
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    return {status: 'refused', reason: 'safe-source-open-unsupported'};
  }
  let fd;
  try {
    fd = openSync(before.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, {bigint: true});
    if (!opened.isFile() || !sameBytes(before.stat, opened)) {
      return {status: 'refused', reason: 'source-changed-before-read'};
    }
    const text = contentRequired ? readFileSync(fd, 'utf8') : '';
    const after = inspectPath(root, relative);
    if (after.status !== 'present' || !sameBytes(opened, fstatSync(fd, {bigint: true}))
        || !sameBytes(opened, after.stat) || before.entries.length !== after.entries.length
        || before.entries.some((stat, index) => !sameFile(stat, after.entries[index]))) {
      return {status: 'refused', reason: 'source-changed-during-read'};
    }
    return {status: 'read', text, content_read: contentRequired};
  } catch {
    return {status: 'refused', reason: 'source-open-or-read-refused'};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
