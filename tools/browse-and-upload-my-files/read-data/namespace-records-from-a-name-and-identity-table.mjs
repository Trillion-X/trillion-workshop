// packages/live-namespace/read-data/namespace-records-from-a-name-and-identity-table.mjs
//
// PURPOSE
// Turn rows that pair a HUMAN NAME with a CONTENT IDENTITY and a STORED PATH into the two
// record shapes this package already owns: one `live-namespace.locator` per distinct identity
// (HOW to read the bytes) and one `live-namespace.name` per name (WHAT it is called and WHERE
// it sits). Nothing here reaches the network, opens a file, or knows what a drive is.
//
// WHY A TABLE AND NOT A DIRECTORY WALK
// The native file target implements exactly one operation, `read_file_range`. There is no
// directory listing anywhere below this, so names cannot be discovered at read time; they have
// to be stated. Any producer that can emit `name, identity, stored path` triples feeds this:
// a drive scan, an export from another store, a remote index. The word "manifest" does not
// appear in this module on purpose, because the file that happens to hold those triples today
// is one instance of the input, not the input's meaning.
//
// NON-NEGOTIABLE INVARIANTS
//  1. An identity is written `<multihash-code>:<hex>`. The raw hex alone addresses nothing, so
//     a caller that forgets the code produces records that resolve to no bytes. Encoded once,
//     here, and pinned by test.
//  2. A name address carries an ABSOLUTE path, and its collection is ONE path label holding the
//     whole slash-joined parent. One label per level would make listing a shallow collection
//     cost its entire descendant subtree.
//  3. A row this cannot express FAILS CLOSED into `rejected`. It is never skipped silently,
//     because a population that quietly drops rows cannot answer the only question anyone asks
//     of it: is all of my stuff here?
//  4. Many names may share one identity. That is the ordinary case, not an error, and it is
//     why a name is never a field on a locator.
//  5. A name payload uses the CONSUMER'S field names, which are `name`, `identity`,
//     `byte_length`, `modified_at_ms` (`background-runner-shell` `NamespaceName`). This is not a
//     style preference. `identity` ABSENT is how that reader distinguishes a place from bytes,
//     so a name that spells it anything else is silently served as an empty folder, and an
//     absent `byte_length` is reported to the mount as `getcontentlength: 0`, which Finder shows
//     as a zero-byte file and Premiere refuses to open. Both failures look like a successful
//     publish from the producer's side. Read the reader.
//  6. This works on a CHUNK of rows, never on a whole corpus. Holding every record before
//     writing any of them makes memory grow with the drive, which is the one thing a namespace
//     meant to cover every file a person owns can never do.

/** The multihash code every locator address in this package already uses for a sha256. */
export const SHA256_MULTIHASH_CODE = "12";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `12:<hex>`. The one place the code is joined to the hex. */
export function identityFromSha256Hex(sha256Hex) {
  if (typeof sha256Hex !== "string" || !SHA256_HEX.test(sha256Hex)) {
    throw new Error(`sha256 must be 64 lowercase hex characters, received ${JSON.stringify(sha256Hex)}`);
  }
  return `${SHA256_MULTIHASH_CODE}:${sha256Hex}`;
}

export function locatorAddressFor(identity) {
  return `live-namespace::locator::${identity}`;
}

export function nameAddressFor(absolutePath) {
  return `live-namespace::name::${absolutePath}`;
}

/**
 * The collection is the PARENT path as ONE label, never one label per level.
 * The root is "/", never an empty string.
 */
export function namePathLabelsFor(absolutePath) {
  const cut = absolutePath.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : absolutePath.slice(0, cut);
  return ["live-namespace", "name", parent];
}

/**
 * Join a stated root to a root-relative name, CLEANING UP the result.
 *
 * A producer states names however it likes: `a/b.mp4`, `./a/b.mp4`, `/a/b.mp4`, `a//b.mp4`.
 * Those are the SAME name and must produce the SAME address, or one file acquires several
 * addresses and a listing shows a phantom `.` folder. Learned the expensive way: 88,163 of
 * 95,047 rows in the first real table carried a `./` prefix, which the first version of this
 * function passed straight into the address. The tests missed it because the fixtures were
 * invented instead of sampled from the real producer, so they only ever proved the spellings I
 * had already thought of.
 */
export function absolutePathFrom(rootAbsolutePath, relativePath) {
  const root = rootAbsolutePath.endsWith("/") ? rootAbsolutePath.slice(0, -1) : rootAbsolutePath;
  const steps = [];
  for (const step of String(relativePath).split("/")) {
    if (step.length === 0 || step === ".") continue;
    if (step === "..") {
      if (steps.length === 0) throw new Error(`name escapes its root: ${relativePath}`);
      steps.pop();
      continue;
    }
    steps.push(step);
  }
  if (steps.length === 0) throw new Error(`name is empty after cleanup: ${JSON.stringify(relativePath)}`);
  return `${root}/${steps.join("/")}`;
}

/**
 * OLDER WAYS A NAME BECAME AN ADDRESS, chosen by DATA, supplied by this owner.
 *
 * An address is just a way of writing down a name. When that way is corrected, every record the
 * OLD way produced is still sitting in the log at an address nothing will ever ask for again.
 * Republishing alone does not remove it; it only puts the right one next to the wrong one.
 *
 * So correcting it is TWO acts, and the second is the one that gets forgotten: write the new
 * address, take back the old. Listing the older ways here makes that sayable for any future
 * correction instead of being re-improvised as a cleanup script every time. A key describes
 * WHAT THE OLD WAY DID, never the mistake that retired it.
 */
export const OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS = {
  /** Glued root and name together, stripping only a leading "/", so "." and "" steps survived. */
  "glued-the-parts-and-left-the-dots-in": (rootAbsolutePath, relativePath) => {
    const root = rootAbsolutePath.endsWith("/") ? rootAbsolutePath.slice(0, -1) : rootAbsolutePath;
    const relative = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
    return `${root}/${relative}`;
  },
};

/** One row out of one tab-separated line. Column meaning is caller DATA. */
export function rowFromTabSeparatedLine(line, lineNumber, { nameColumn, identityColumn, storedPathColumn }) {
  const cells = line.split("\t");
  return {
    lineNumber,
    name: cells[nameColumn],
    sha256Hex: cells[identityColumn],
    storedPath: cells[storedPathColumn],
  };
}

/**
 * Rows out of tab-separated text, addressed by COLUMN INDEX supplied by the caller.
 * Column meaning is caller DATA so a different producer's column order is a parameter,
 * never an edit here.
 */
export function rowsFromTabSeparatedText(text, { nameColumn, identityColumn, storedPathColumn, hasHeader = true }) {
  const lines = String(text).split("\n");
  const rows = [];
  for (let index = hasHeader ? 1 : 0; index < lines.length; index += 1) {
    if (lines[index].length === 0) continue;
    rows.push(rowFromTabSeparatedLine(lines[index], index + 1, { nameColumn, identityColumn, storedPathColumn }));
  }
  return rows;
}

/**
 * Rows in, fixed-size groups of rows out, WITHOUT ever holding them all.
 *
 * This is the seam that keeps memory flat: the caller streams lines off disk, this hands back
 * one group at a time, and the group is forgotten as soon as it has been written.
 */
export async function* groupsOfRows(rows, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error("group size must be a positive integer");
  let group = [];
  for await (const row of rows) {
    group.push(row);
    if (group.length === size) {
      yield group;
      group = [];
    }
  }
  if (group.length > 0) yield group;
}

/**
 * ONE GROUP of rows -> `{ locators, names, retractions, rejected }`.
 *
 * `identitiesAlreadyWritten` is passed in by the caller and carried ACROSS groups, so a locator
 * is written once per distinct identity over the whole run rather than once per group. It is
 * the only thing here that grows with the corpus, and it holds identities, not records.
 *
 * `retractions` are returned UNFILTERED. Deciding which of them are safe needs the set of every
 * name the whole run publishes, which only the caller streaming the whole table can know.
 */
export function namespaceRecordsFrom(rows, {
  partitionLabel,
  nameRootAbsolutePath,
  readTargetName,
  buildReadRequest,
  // HOW the target answers: where the bytes sit in its reply and how they are encoded. This is
  // a fact about the TARGET, stated by the caller who chose it, and the resolver REFUSES a
  // locator without it. 75,869 locators once published without these two fields; every write
  // succeeded, the run reported 0 rejected, and every /cas read answered 500. A locator that
  // names a target but not how it replies is a promise the resolver cannot keep.
  readReplyContract,
  // HOW the target spells a byte window. A locator states its window in exactly ONE form and the
  // resolver refuses at parse a row carrying neither or both. `range_keys` puts two loose numeric
  // keys at the top of the request, which is what `local.files` takes; a source that carries its
  // window as ONE formatted value at a nested key declares a `range_render` instead, giving the
  // path and the spelling. Passing the spelling in keeps the split the runner already draws: it
  // owns the QUANTITIES a range has, the row owns how a protocol spells them, and no protocol
  // vocabulary belongs in this file.
  rangeRender = null,
  // Where the bytes SURVIVE. Defaulted only on the local path, because a default that is wrong for
  // a remote origin would publish a false claim at the moment it matters most.
  durability = null,
  // Facts about the BYTES, asked once per DISTINCT identity rather than once per name, because
  // identity to bytes is one to one and 19,177 of the first real corpus's names were duplicate
  // content. Returning `{}` is honest ignorance; it costs a zero-length listing, not a crash.
  fileFactsFor = () => ({}),
  identitiesAlreadyWritten = new Set(),
  factsByIdentity = new Map(),
  // What each name address was last given. Carried across groups so a name stated twice with
  // DIFFERENT identities is caught wherever the two rows sit in the table.
  identityByNameAddress = new Map(),
  olderAbsolutePathFrom = null,
  olderNameRootAbsolutePath = null,
}) {
  const locators = [];
  const names = [];
  const retractions = [];
  const rejected = [];
  const nameConflicts = [];

  if (typeof readReplyContract?.response_encoding !== "string" || readReplyContract.response_encoding.length === 0) {
    throw new Error("readReplyContract.response_encoding is required: a locator must say how its target's reply carries bytes");
  }
  if (typeof readReplyContract.response_bytes_pointer !== "string") {
    throw new Error("readReplyContract.response_bytes_pointer is required (empty string when the payload IS the bytes)");
  }

  // The resolver refuses at parse a locator carrying NEITHER range form, because without a window
  // the source answers with the whole representation, which is the unbounded read that took the
  // runtime to a 23 GB footprint. Refusing here too means the shaper cannot produce a row that dies
  // later at a distance from its cause; it mirrors the runner's rule rather than inventing a second.
  if (rangeRender !== null) {
    if (!Array.isArray(rangeRender.target_path) || rangeRender.target_path.length === 0
      || rangeRender.target_path.some((step) => typeof step !== "string" || step.length === 0)) {
      throw new Error("rangeRender.target_path must be a non-empty array of non-empty strings");
    }
    if (typeof rangeRender.template !== "string" || rangeRender.template.length === 0) {
      throw new Error("rangeRender.template is required: the row carries the spelling, the resolver substitutes the quantities");
    }
    // Only asked for on the remote path. `local-only` is a true default for a file on this machine
    // and a false claim about an origin, so the remote caller states it rather than inheriting it.
    if (typeof durability !== "string" || durability.length === 0) {
      throw new Error("durability is required when rangeRender is supplied: where the bytes survive is not a value to default");
    }
  }

  for (const row of rows) {
    let identity;
    try {
      identity = identityFromSha256Hex(row.sha256Hex);
    } catch (error) {
      rejected.push({ row, reason: error.message });
      continue;
    }
    if (typeof row.name !== "string" || row.name.length === 0) {
      rejected.push({ row, reason: "row has no name" });
      continue;
    }
    if (typeof row.storedPath !== "string" || !row.storedPath.startsWith("/")) {
      rejected.push({ row, reason: "stored path is not absolute" });
      continue;
    }

    let absolutePath;
    try {
      absolutePath = absolutePathFrom(nameRootAbsolutePath, row.name);
    } catch (error) {
      rejected.push({ row, reason: error.message });
      continue;
    }

    if (!identitiesAlreadyWritten.has(identity)) {
      identitiesAlreadyWritten.add(identity);
      const facts = fileFactsFor(row) ?? {};
      factsByIdentity.set(identity, facts);
      locators.push({
        partition_label: partitionLabel,
        address_label: locatorAddressFor(identity),
        address_mode: "identity_text",
        path_labels: ["current-item", "published-record"],
        payload: {
          kind: "live-namespace.locator",
          identity_grade: "content-hashed",
          // Whether the bytes are actually THERE, asked rather than asserted. A hardcoded
          // `true` is a claim the producer is in no position to make, and a locator that
          // promises bytes it cannot supply turns a missing file into a read error at the
          // moment someone opens it instead of a fact at the moment it was published.
          available: facts.exists !== false,
          durability: durability ?? "local-only",
          target: readTargetName,
          request: buildReadRequest(row),
          response_bytes_pointer: readReplyContract.response_bytes_pointer,
          response_encoding: readReplyContract.response_encoding,
          // Exactly one form, by construction. The resolver refuses a row carrying both, so the
          // shaper is built so it cannot express both rather than checked afterwards for having.
          ...(rangeRender === null
            ? { range_keys: { offset: "offset", length: "length" } }
            : { range_render: { target_path: [...rangeRender.target_path], template: rangeRender.template } }),
          ...(facts.byteLength == null ? {} : { byte_length: facts.byteLength }),
        },
      });
    }

    // Taken back ONLY where the older way actually produced a different address, so re-running
    // against an already-clean corpus produces nothing rather than churning the log.
    //
    // The older way is a ROOT and a SPELLING together, because the two go wrong independently
    // and the first time they went wrong together: names were spelled without cleanup AND hung
    // from the wrong root. Reproducing only the spelling would leave every wrongly-rooted
    // address in place while reporting a clean run.
    if (olderAbsolutePathFrom != null) {
      let olderPath = null;
      try {
        olderPath = olderAbsolutePathFrom(olderNameRootAbsolutePath ?? nameRootAbsolutePath, row.name);
      } catch {
        olderPath = null;
      }
      if (olderPath != null && olderPath !== absolutePath) {
        retractions.push({
          partition_label: partitionLabel,
          address_label: nameAddressFor(olderPath),
          address_mode: "identity_text",
          path_labels: namePathLabelsFor(olderPath),
          // NO `payload` key. `payload: null` writes the four bytes `null` and leaves the
          // address in the index and in the reclaim reachable set, which is a tombstone
          // wearing a retraction's clothes. Absence is the retraction.
        });
      }
    }

    // ONE NAME, TWO IDENTITIES is the quietest data loss available here. Both rows write the
    // same address, so the later one wins and the earlier file becomes unreachable by name with
    // nothing reported. Found in the first real corpus: 224 names carried two identities, and
    // one tennis clip resolved to a 1,067-byte zero-filled stub because the stub's row came
    // second. Which one is RIGHT is not decidable here, so this reports rather than invents a
    // rule; silently picking is what caused the loss.
    const nameAddress = nameAddressFor(absolutePath);
    const alreadyNamed = identityByNameAddress.get(nameAddress);
    if (alreadyNamed != null && alreadyNamed !== identity) {
      nameConflicts.push({ address_label: nameAddress, kept: identity, replaced: alreadyNamed, row });
    }
    identityByNameAddress.set(nameAddress, identity);

    const facts = factsByIdentity.get(identity) ?? {};
    names.push({
      partition_label: partitionLabel,
      address_label: nameAddress,
      address_mode: "identity_text",
      path_labels: namePathLabelsFor(absolutePath),
      payload: {
        kind: "live-namespace.name",
        name: absolutePath.slice(absolutePath.lastIndexOf("/") + 1),
        // `identity`, and no `path`. The field name is the reader's, and the path is already
        // the address, so carrying it twice creates two places one truth can live.
        identity,
        ...(facts.byteLength == null ? {} : { byte_length: facts.byteLength }),
        ...(facts.modifiedAtMs == null ? {} : { modified_at_ms: facts.modifiedAtMs }),
      },
    });
  }

  return { locators, names, retractions, rejected, nameConflicts };
}
