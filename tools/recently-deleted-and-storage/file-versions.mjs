// src/file-versions.mjs
//
// Purpose: tell which files in one folder are versions of the same file (the same name with a copy number, a version
// number, an export time or a backup mark on its end, file-versions.json) and which of them is the latest, so a
// folder lists one current file per family and keeps the older ones reachable, never deleted.
//
// Invariants:
// - A family is the folder, the name with every mark taken off its end, and the extension. Marks are DATA
//   (file-versions.json); a new kind of mark is one row there and no code here.
// - The latest is the member with no never_current mark (when any has none), then one whose version number (a mark
//   with orders "number") no other member's number is above, then the latest modified time, then the fewest marks
//   (the plain name wins a tie), then the name. A saved time says when a copy was made, not which version it is, so a
//   higher version number wins over a later download. The same inputs always give the same answer.
// - A family of one is no family: a lone file carries no version field.
// - Exact copies (the same bytes under two names) are already one stored file (content identity); this only groups
//   names, so nothing here stores, moves or removes a file.
import versionMarks from './file-versions.json' with { type: 'json' };

const MARKS = versionMarks.marks.map(mark => ({ ...mark, test: new RegExp(mark.pattern, mark.flags ?? '') }));

const baseName = name => name.slice(name.lastIndexOf('/') + 1);

/** The name's family: its stem with every version mark taken off the end, its extension, the marks taken off, and
 *  the version number an ordering mark carried ("v5_3" gives [5, 3]; null when none did). */
export function familyOf(name) {
  const marks = [];
  let number = null;
  const strip = text => {
    for (let changed = true; changed;) {
      changed = false;
      for (const mark of MARKS) {
        const found = mark.test.exec(text);
        const shorter = found ? text.slice(0, found.index) : text;
        if (found && shorter.trim()) {
          text = shorter; marks.push(mark); changed = true;
          if (mark.orders === 'number' && number === null && found[1]) number = found[1].split(/[._]/).map(Number);
        }
      }
    }
    return text;
  };
  // A mark can follow the extension too ("pottery-knowledge.db.bak-localfiles"), so the whole name loses its marks first.
  const base = strip(baseName(name));
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : '';
  const stem = strip(dot > 0 ? base.slice(0, dot) : base);
  return { stem, extension, marks, number, key: `${stem}\u0000${extension}` };
}

const whenOf = row => (Number.isSafeInteger(row.modified_at_ms) ? row.modified_at_ms : 0);
const neverCurrent = family => family.marks.some(mark => mark.never_current);
/** Compare two version numbers part by part (5.10 is above 5.9; a missing part counts as 0). */
const compareNumbers = (left, right) => {
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

/**
 * Group the names of one folder into version families. `rows` are listing rows ({ name, modified_at_ms, ... }) all
 * in the same folder. Returns a Map from each grouped name to { family, latest, latest_name, versions } where
 * `family` is the family's plain name ("Modular_Instruction_Blocks.md"). Names in no family are not in the map.
 */
export function versionFamilies(rows) {
  const groups = new Map();
  for (const row of rows) {
    const family = familyOf(row.name);
    if (!groups.has(family.key)) groups.set(family.key, []);
    groups.get(family.key).push({ row, family });
  }
  const versions = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const highest = members.reduce((top, { family }) => (family.number && (!top || compareNumbers(family.number, top) > 0) ? family.number : top), null);
    const outranked = ({ family }) => Number(Boolean(family.number && compareNumbers(family.number, highest) < 0));
    const ordered = [...members].sort((left, right) => (neverCurrent(left.family) - neverCurrent(right.family))
      || (outranked(left) - outranked(right))
      || (whenOf(right.row) - whenOf(left.row))
      || (left.family.marks.length - right.family.marks.length)
      || (left.row.name < right.row.name ? -1 : left.row.name > right.row.name ? 1 : 0));
    const latest = ordered[0];
    const { stem, extension } = latest.family;
    const family = extension ? `${stem}.${extension}` : stem;
    for (const { row } of members) versions.set(row.name, { family, latest: row === latest.row, latest_name: latest.row.name, versions: members.length });
  }
  return versions;
}

/** The leading part every member of the name's family starts with: a folder listing reads a family by this prefix. */
export const familyPrefix = name => `${name.slice(0, name.lastIndexOf('/') + 1)}${familyOf(name).stem}`;
