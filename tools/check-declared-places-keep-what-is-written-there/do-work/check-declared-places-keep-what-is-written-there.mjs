// Several places are declared writable on the promise that something keeps what is written there.
// Report which of them keep nothing.
//
// THE JOB, with no instance in it. A declaration saying "you may write here" usually rests on a
// second, unstated promise: that a write here is not the last word, because something retains prior
// versions and a wrong write can be seen, diffed and undone. When that promise fails nothing reports
// it, because a place with no retention behaves exactly like a place with retention right up until
// somebody needs the previous version.
//
// The generator, in the words of the declaration this was first run against: "an unguarded runtime
// can still write a file, but it cannot get it into the history, and the history is what outlives
// the session and what the next agent finds and runs." That is stated per place, in prose, and
// verified nowhere, so a place added on a Tuesday inherits an assumption nobody re-tested. The
// failure mode is a false all-clear, which is the expensive direction: a false absence is disproved
// the moment somebody looks, while a false all-clear stops anybody looking.
//
// EVERYTHING EXTENSIBLE IS DATA. The places come from whoever declares them, read live rather than
// copied, because a copy of somebody else's fact is a snapshot with a hidden expiry. The retention
// KINDS are rows, so a project on another version control system, a snapshotting filesystem or an
// append-only archive is a row and not a branch here. The EXEMPTIONS are rows carrying a reason,
// because a scratch directory that keeps nothing is correct and silence about it would train a
// reader to skim the whole report.
//
// NO FILESYSTEM HERE. Every function takes what it needs, so every behaviour is testable with plain
// values and the same engine answers for a subject that has no directories at all.

// A place row as its owner writes it, reduced to what this needs. Found by KEY at any depth rather
// than at a fixed path, because the owner may reorganise their document and a path into somebody
// else's file is a second thing to keep in sync. Nothing here parses the identifier: parsing another
// owner's identifier is how a checker acquires an opinion about their format.
export function placesIn(declaration, { placesKey, idKey }) {
  if (!placesKey || !idKey) throw new Error('placesIn needs placesKey and idKey');
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === placesKey && Array.isArray(value)) {
        for (const row of value) {
          const id = row?.[idKey];
          if (typeof id === 'string' && id) found.push({ id, declared: row });
        }
        continue;
      }
      visit(value);
    }
  };
  visit(declaration);
  return found;
}

// A place is an identifier, not a path, so turning it into somewhere on disk is the caller's
// knowledge and arrives as DATA. Bases are RELATIVE and resolved against a home supplied at run
// time, so no host's directory layout is frozen into this package.
//
// Directories are DEDUPED: two bases can name the same directory, and a place examined twice
// inflates both counts in the report while looking like two independent observations.
export function resolvedPlaces(places, { bases, home, join, isDirectory }) {
  if (!Array.isArray(bases) || bases.length === 0) throw new Error('resolvedPlaces needs bases');
  return places.map((place) => {
    const seen = new Set();
    for (const base of bases) {
      const candidate = join(home, base, place.id);
      if (!seen.has(candidate) && isDirectory(candidate)) seen.add(candidate);
    }
    return { ...place, directories: [...seen] };
  });
}

// Which retention kinds hold at a directory. A kind is `{kind, marker}` and the marker is a child
// NAME: present at the directory, or at any ancestor, because a subdirectory of a covered tree is
// covered by every retention system this has met.
//
// Presence is of ANY TYPE on purpose. The first marker this ran against is a directory in an
// ordinary repository and a FILE in a worktree, so requiring a directory would report a covered
// worktree as uncovered.
//
// The ancestor walk is BOUNDED by the caller, and the bound is the same home the places resolve
// against rather than a second fact to keep in sync. Unbounded, the walk reaches the filesystem root
// and can find an unrelated marker, marking an uncovered place as covered, which is the false
// all-clear this whole package exists to end.
export function retentionAt(directory, { kinds, marker, ancestorsOf }) {
  const chain = [directory, ...ancestorsOf(directory)];
  return kinds
    .filter((kind) => chain.some((step) => marker(step, kind.marker)))
    .map((kind) => kind.kind);
}

// The whole answer, structured, never a boolean. A caller wanting pass or fail reads `keepsNothing`
// and takes its length; a caller wanting to explain the result has every part already.
//
// THE DENOMINATOR TRAVELS WITH THE COUNT. A report of zero findings means nothing without the number
// examined, and the two must arrive together or a reader supplies the missing one from memory. A
// probe whose input silently emptied reports zero findings, which is otherwise indistinguishable
// from a clean corpus.
export function retentionReport(places, { kinds, marker, ancestorsOf, exemptions = [] }) {
  const exemptById = new Map(exemptions.map((row) => [row.place, row]));
  const examined = [];
  const keepsNothing = [];
  const unresolved = [];
  for (const place of places) {
    if (place.directories.length === 0) {
      // NOT a finding. A declared place with no directory HERE is a place this machine has not
      // needed yet, and calling that a defect makes the check red on every fresh clone, which is how
      // a check gets switched off.
      unresolved.push(place.id);
      continue;
    }
    for (const directory of place.directories) {
      const kept = retentionAt(directory, { kinds, marker, ancestorsOf });
      const exempt = exemptById.get(place.id);
      examined.push({ place: place.id, directory, kept, exemptFor: exempt?.why ?? null });
      if (kept.length === 0 && !exempt) {
        keepsNothing.push({ place: place.id, directory, kept, exemptFor: null });
      }
    }
  }
  return {
    examined,
    keepsNothing,
    unresolved,
    examinedCount: examined.length,
    keepsNothingCount: keepsNothing.length,
    unresolvedCount: unresolved.length,
  };
}
