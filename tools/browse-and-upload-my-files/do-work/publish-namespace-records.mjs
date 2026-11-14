// packages/live-namespace/do-work/publish-namespace-records.mjs
//
// PURPOSE
// Publish `live-namespace` locator and name records into one selected running app's live log,
// in bounded groups, from rows that pair a name with a content identity.
//
// WHAT IT DOES NOT OWN
// Transport (composed from `send-requests-to-an-engine`), record shape (composed from this
// package's own `read-data` module), which app, which partition, which table, and where the
// names are rooted. All of those are caller-selected DATA. This file contains no drive, no
// path, and no product name.
//
// WHY IT STREAMS
// The first corpus was 95,047 files. The job this exists for is every file a person owns,
// forever, on a namespace meant to be given away. Reading the whole table into an array and
// building every record before writing any of them makes memory grow with the drive, so the
// thing would work on the corpus that was measured and fail on the one it is for. Rows arrive
// as a stream, records are built one group at a time, and each group is forgotten once written.
// The only thing that grows with the corpus is the set of identities already written, which
// holds identities rather than records and is what stops one locator being written 95,047 times.
//
// WHY GROUPED AND RESUMABLE
// One request carrying everything is a single point of total failure and an unbounded
// allocation on both sides. Groups are ordered and the run reports the last row it completed,
// so a failure at row 60,000 resumes from 60,000 instead of from zero. Writes are ADDRESSED, so
// re-publishing the same row is a no-op rather than a duplicate; that is what makes resume safe
// rather than merely fast.

import { groupsOfRows, namespaceRecordsFrom } from "../read-data/namespace-records-from-a-name-and-identity-table.mjs";

/**
 * @param {object} input
 * @param {() => AsyncIterable<object>} input.openRows  a FRESH row stream each call. A factory
 *   rather than an iterable because taking back an older addressing needs a second pass, and a
 *   consumed stream cannot be replayed.
 * @param {string} input.partitionLabel
 * @param {string} input.nameRootAbsolutePath root the names hang from
 * @param {string} input.readTargetName       the target that answers a byte-range read
 * @param {(row:object)=>object} input.buildReadRequest
 * @param {{response_bytes_pointer:string,response_encoding:string}} input.readReplyContract  how that target's reply carries bytes
 * @param {{target_path:string[],template:string}} [input.rangeRender]  how the target SPELLS a byte window, when it takes one formatted value rather than two loose numeric keys. Absent means the local two-key form.
 * @param {string} [input.durability]          where the bytes survive; required by the shaper whenever rangeRender is supplied, because the local default would be a false claim about an origin
 * @param {(writes:object[])=>Promise<unknown>} input.writeBatch  ONE bounded write
 * @param {(row:object)=>object} [input.fileFactsFor]  size and modified time of the bytes
 * @param {number} [input.batchSize]
 * @param {number} [input.startRow]           resume point, 0-based into the row stream
 * @param {number} [input.maxRows]            bounded slice; absent means all rows
 * @param {string[]} [input.publishKinds]     record kinds to write; absent means all
 * @param {(root:string,name:string)=>string} [input.olderAbsolutePathFrom]
 * @param {string} [input.olderNameRootAbsolutePath]
 * @param {(progress:object)=>void} [input.onProgress]
 */
export async function publishNamespaceRecords({
  openRows,
  partitionLabel,
  nameRootAbsolutePath,
  readTargetName,
  buildReadRequest,
  readReplyContract,
  rangeRender = null,
  durability = null,
  writeBatch,
  fileFactsFor,
  batchSize = 500,
  startRow = 0,
  maxRows,
  publishKinds = null,
  olderAbsolutePathFrom = null,
  olderNameRootAbsolutePath = null,
  onProgress = () => {},
  ...unknownOptions
}) {
  // An option this layer does not forward is INVISIBLE: the caller measured 95,047 files, the
  // record builder used its own default, every write succeeded, and the corpus published with
  // no sizes at all while the run reported zero problems. A pass-through that silently swallows
  // what it does not recognise turns a typo or a missed wire into a clean green run, so an
  // unrecognised option is refused rather than dropped.
  const unknownNames = Object.keys(unknownOptions);
  if (unknownNames.length > 0) throw new Error(`unknown option(s): ${unknownNames.join(", ")}`);

  const wanted = (entry) => publishKinds == null || publishKinds.includes(entry.payload.kind);
  const takingBackAnOlderAddressing = olderAbsolutePathFrom != null;

  const identitiesAlreadyWritten = new Set();
  const factsByIdentity = new Map();
  const identityByNameAddress = new Map();
  const nameConflicts = [];
  // Only built when an older addressing is being taken back, because that is the only case that
  // needs it, and it is one string per name.
  const publishedNameAddresses = takingBackAnOlderAddressing ? new Set() : null;

  const shared = {
    partitionLabel,
    nameRootAbsolutePath,
    readTargetName,
    buildReadRequest,
    readReplyContract,
    rangeRender,
    durability,
    fileFactsFor,
    identitiesAlreadyWritten,
    factsByIdentity,
    identityByNameAddress,
  };

  let rowsSelected = 0;
  let written = 0;
  let batches = 0;
  let rejectedCount = 0;
  const rejectedSample = [];

  const runOnePass = async (buildWrites) => {
    let rowIndex = 0;
    let selectedInPass = 0;
    for await (const group of groupsOfRows(openRows(), batchSize)) {
      // Slicing happens AFTER grouping so the row numbers a resume point refers to are the
      // producer's, not this function's.
      const from = Math.max(0, startRow - rowIndex);
      const upTo = maxRows == null ? group.length : Math.max(0, startRow + maxRows - rowIndex);
      rowIndex += group.length;
      const selected = group.slice(from, Math.min(group.length, upTo));
      if (selected.length === 0) {
        if (maxRows != null && rowIndex >= startRow + maxRows) break;
        continue;
      }
      selectedInPass += selected.length;

      const writes = buildWrites(selected);
      if (writes.length > 0) {
        await writeBatch(writes);
        written += writes.length;
        batches += 1;
        onProgress({ batches, written, rows_seen: rowIndex, last_row_completed: rowIndex });
      }
      if (maxRows != null && rowIndex >= startRow + maxRows) break;
    }
    return selectedInPass;
  };

  // PASS ONE: the records themselves.
  //  Locators before names, because a name whose identity has no locator resolves to nothing. A
  //  run that dies here leaves bytes reachable but unnamed, which re-running repairs.
  rowsSelected = await runOnePass((selected) => {
    const { locators, names, rejected, nameConflicts: conflicts } = namespaceRecordsFrom(selected, shared);
    rejectedCount += rejected.length;
    for (const entry of rejected) if (rejectedSample.length < 20) rejectedSample.push(entry);
    for (const conflict of conflicts) nameConflicts.push(conflict);
    if (publishedNameAddresses != null) {
      for (const entry of names) publishedNameAddresses.add(entry.address_label);
    }
    return [...locators, ...names].filter(wanted);
  });

  // PASS TWO: taking back the older addressing, and only ever after every new name exists.
  //  A retraction that lands on an address this run published would unname a file, and it would
  //  win by going last. Two addressings differ by a path step, so any row whose name already
  //  begins with that step spells the same address under both. That check needs EVERY name the
  //  run publishes, which is why it is a second pass here and not a filter inside the builder.
  let retracted = 0;
  let retractionsWithheld = 0;
  if (takingBackAnOlderAddressing) {
    await runOnePass((selected) => {
      const { retractions } = namespaceRecordsFrom(selected, {
        ...shared,
        // Facts and identities are already settled by pass one; this pass must not measure
        // files again or emit a locator a second time.
        fileFactsFor: () => ({}),
        olderAbsolutePathFrom,
        olderNameRootAbsolutePath,
      });
      const safe = retractions.filter((entry) => !publishedNameAddresses.has(entry.address_label));
      retractionsWithheld += retractions.length - safe.length;
      retracted += safe.length;
      return safe;
    });
  }

  return {
    rows_selected: rowsSelected,
    locators_published: publishKinds == null || publishKinds.includes("live-namespace.locator")
      ? identitiesAlreadyWritten.size
      : 0,
    names_published: publishKinds == null || publishKinds.includes("live-namespace.name")
      ? rowsSelected - rejectedCount
      : 0,
    older_addresses_retracted: retracted,
    retractions_withheld_to_avoid_deleting_a_new_name: retractionsWithheld,
    records_published: written,
    batches,
    batch_size: batchSize,
    start_row: startRow,
    next_start_row: startRow + rowsSelected,
    // One name given two identities: the later row wins the address and the earlier file
    // becomes unreachable by name. Which is right is not decidable here, so it is REPORTED.
    names_given_more_than_one_identity: nameConflicts.length,
    names_given_more_than_one_identity_sample: nameConflicts.slice(0, 20).map((conflict) => ({
      address_label: conflict.address_label,
      resolves_to: conflict.kept,
      no_longer_reachable_by_this_name: conflict.replaced,
    })),
    rejected_count: rejectedCount,
    rejected: rejectedSample,
  };
}
