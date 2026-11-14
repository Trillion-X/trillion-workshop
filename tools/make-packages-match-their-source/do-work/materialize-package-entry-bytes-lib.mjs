// packages/make-packages-match-their-source/do-work/materialize-package-entry-bytes-lib.mjs
//
// The materializer as a function. `materialize-package-entry-bytes.mjs` is its CLI for a
// whole set or an env-selected subset; `make-packages-match-their-source` calls it with
// an explicit package list. One implementation, two front doors, so a selection expressed
// as flags and a selection expressed as an env var cannot drift apart.
//
// For every `bitfield-package-entry` in each chosen package: esbuild the entry through the
// canonical `buildPackageEntryArtifact`, write the bytes to
// `<pkg>/built-stored-bytes/<entry_bytes.stored_bytes>`, and make sure a `stored_bytes` row
// references them, so the Rust admit finds them with zero live app.
//
// PASS 1 normalizes the manifest completely before PASS 2 builds anything. Receipts bind the
// manifest hash, so a manifest write after the first receipt would invalidate every earlier
// receipt (BRTK2013). Pass 2 never edits the manifest: a build failure leaves a
// declared-but-missing artifact that fails the compile loudly instead of silently unbinding
// receipts. That is also why a failed build leaves a dangling declaration behind, and why
// the declared-but-absent census exists at all.

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeHashCodeHexFromBytes } from '@bitfield/slot-protocol';
import {
  buildPackageEntryArtifact,
  entryByteBuilderSourceIdentity,
  packageEntryArtifactPublicationDecision,
  resolvePackageEntryBuilderInputs,
} from './package-entry-byte-build-lib.mjs';

/** True only when every input the last build recorded is still byte-identical.
 *
 *  WHY A PRE-BUILD CHECK IS NEEDED AT ALL. `make-packages-match-their-source` now materializes
 *  before it compiles, so this runs on every submitting convergence rather than when a human
 *  chose to run a builder. Without a check, converging one package rebuilds bundles that did not
 *  change, and converging a whole set pays that cost hundreds of times.
 *
 *  WHY IT IS SOUND AND NOT AN APPROXIMATION. The recorded input list comes from the esbuild
 *  metafile, so it cannot be computed without building, and a first reading is that no pre-build
 *  check is possible. It is, by inverting the question. If EVERY recorded input is byte-identical,
 *  then no file in the closure changed; an import statement lives inside one of those files, so no
 *  import changed; so the closure cannot have gained or lost a member. A new dependency is only
 *  reachable through an edit to a file already in the list, and that edit is exactly what this
 *  detects. A deleted or unreadable input returns false and rebuilds.
 *
 *  EVERY UNCERTAINTY RETURNS FALSE. An unknown label, a receipt that will not parse, a missing
 *  root, any read error: rebuild. A wrong skip ships stale bytes, while a wrong rebuild costs
 *  seconds, so the asymmetry decides the default.
 *
 *  A FIRST VERSION CHECKED ONLY `package_local_inputs` AND CALLED THAT SOUND. It is not. The
 *  builder splits the metafile at `package-entry-byte-build-lib.mjs:172-173` into
 *  `kind === 'package-source'` and everything else, so a receipt with `build_input_count: 5` holds
 *  2 local inputs and 2 `external_input_closures` covering the other 3. Nothing was ever dropped
 *  and the field name says exactly what it holds; that version simply read half of it. Checking the
 *  local half alone skips a rebuild when a file in ANOTHER package changed, which is silent
 *  staleness, and it removes the exact byte comparison that used to catch it.
 *
 *  BOTH HALVES ARE CHECKED NOW, which became possible once the builder started enumerating closure
 *  members. A receipt written before that has no members, which is indistinguishable from a member
 *  list that was dropped, so it rebuilds.
 *
 *  PROVEN BEFORE WIRING, because the reasoning above is not proof and the failure mode is silent.
 *  `packages/make-packages-match-their-source/tests/recorded-build-inputs-are-still-current.test.mjs`
 *  covers a changed CROSS-PACKAGE member, a truncated `inputs` list, a receipt with no `inputs` key,
 *  an untouched closure that may skip, and a control showing a temp receipt path does not by itself
 *  force a rebuild. That control matters: without it the three rebuild cases differ from the skip
 *  case in two ways at once and could pass for a reason nobody checked. */
export async function recordedBuildInputsAreStillCurrent({ packageRoot, receiptAbs, artifactAbs }) {
  try {
    if (!existsSync(receiptAbs) || !existsSync(artifactAbs)) return false;
    const receipt = JSON.parse(await readFile(receiptAbs, 'utf8'));
    const artifactBytes = await readFile(artifactAbs);
    if (
      makeHashCodeHexFromBytes(artifactBytes) !== receipt?.artifact_multihash
      || artifactBytes.byteLength !== receipt?.artifact_byte_length
    ) return false;
    const recorded = receipt?.package_local_inputs;
    if (!Array.isArray(recorded) || recorded.length === 0) return false;

    const resolved = await resolvePackageEntryBuilderInputs({ packageRoot });
    const rootByLabel = new Map([
      ['package', packageRoot],
      ['runtime-kit', resolved.runtimeKitRoot],
      ['external-dependency-store', resolved.dependencyRoot],
      ['package-set', resolved.packageSetRoot],
      ...Object.entries(resolved.externalAliases).map(([name, root]) => [`peer/${name}`, root]),
    ]);

    // One recorded input is still byte-identical on disk. The label prefixes the path and names
    // which root it is relative to, and `peer/<name>/<rest>` carries two segments, so the longer
    // label is tried first.
    const inputIsUnchanged = async (input) => {
      const recordedPath = String(input?.path ?? '');
      const separator = recordedPath.indexOf('/');
      if (separator < 0) return false;
      let label = recordedPath.slice(0, separator);
      let relative = recordedPath.slice(separator + 1);
      if (label === 'peer') {
        const second = relative.indexOf('/');
        if (second < 0) return false;
        label = `peer/${relative.slice(0, second)}`;
        relative = relative.slice(second + 1);
      }
      const root = rootByLabel.get(label);
      if (!root || typeof input?.multihash !== 'string') return false;
      const absolute = path.join(root, relative);
      if (!existsSync(absolute)) return false;
      const bytes = await readFile(absolute);
      return makeHashCodeHexFromBytes(bytes) === input.multihash;
    };

    for (const input of recorded) {
      if (!(await inputIsUnchanged(input))) return false;
    }

    // BOTH HALVES OR NOTHING. `package_local_inputs` is only the inputs whose kind is
    // `package-source`; everything else, including every cross-package import, is grouped into
    // `external_input_closures`. An earlier version of this function checked the local half alone
    // and called that sound. It is not: a file in ANOTHER package can change while every local
    // input stays byte-identical, and the skip would then ship stale bytes with no error, having
    // removed the exact byte comparison that used to catch exactly that.
    //
    // A closure's hashes are computed FROM its members, so re-deriving it needs the members. They
    // were not recorded until `package-entry-byte-build-lib.mjs` began emitting `inputs`. A receipt
    // written before that has no members to check, which is indistinguishable from a closure whose
    // members were dropped, so it rebuilds. Every uncertainty rebuilds.
    const closures = receipt?.external_input_closures;
    if (!Array.isArray(closures)) return false;
    for (const closure of closures) {
      const members = closure?.inputs;
      if (!Array.isArray(members)) return false;
      if (members.length !== closure?.input_count) return false;
      // The enumeration must be the one the recorded hash was taken over, otherwise a truncated or
      // edited member list would verify happily against files that are not the real closure.
      const canonical = new TextEncoder().encode(JSON.stringify(members));
      if (makeHashCodeHexFromBytes(canonical) !== closure?.multihash) return false;
      for (const member of members) {
        if (!(await inputIsUnchanged(member))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Write bytes so a reader sees the old file or the new one, never half of either.
 *
 *  WHY THIS EXISTS. `make-packages-match-their-source` now materializes before compiling, and it
 *  runs one build per package across many places, so two runs against different engines can reach
 *  the same package at the same moment. A plain `writeFile` truncates and then fills, which leaves
 *  a window where the file on disk is short. The Rust loader reads and hashes these files without
 *  a lock, so a torn read is not an error there, it is a WRONG HASH that admits cleanly and
 *  produces bytes nothing can explain later. `rename` within one filesystem is atomic, so the
 *  reader's view goes from old to new in a single step and the window closes.
 *
 *  The temp name carries the process id so two writers do not collide on the temp file itself,
 *  which would merely move the tear one level down. */
async function writeFileAtomically(destination, contents) {
  const temporary = `${destination}.writing-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, destination);
}

/**
 * @param {{ setRoot: string, packageNames?: Iterable<string> | null, log?: (line: string) => void }} input
 * @returns {Promise<{ materialized: number, skippedRecordedInputsCurrent: number, skippedRebuiltIdentical: number, failed: number, failures: Array<{ package: string, entry: string, message: string }> }>}
 */
export async function materializePackageEntryBytes({ setRoot, packageNames = null, log = console.log }) {
  const packagesRoot = path.join(setRoot, 'packages');
  if (!existsSync(packagesRoot)) {
    throw new Error(`no packages/ under package-set root ${setRoot}`);
  }
  const selectedPackages = packageNames ? new Set([...packageNames].map((name) => name.trim()).filter(Boolean)) : null;
  const names = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && (!selectedPackages || selectedPackages.has(e.name)))
    .map((e) => e.name).sort();
  if (selectedPackages && names.length !== selectedPackages.size) {
    const found = new Set(names);
    throw new Error(`unknown package materialization selection: ${[...selectedPackages].filter((name) => !found.has(name)).join(', ')}`);
  }

  // Two skips, counted apart, because they answer different questions and one number could not
  // tell them apart. `skippedRecordedInputsCurrent` means the recorded inputs were still current so
  // nothing was built; `skippedRebuiltIdentical` means it WAS built and the bytes came out identical.
  // A reader asking whether the pre-build skip fires at all, which is what a whole open lead in
  // `the-build-step-that-deletes-its-own-instructions.md` was about, could not answer it from
  // `skipped(existing)=3`: that label suggests the first and silently includes the second.
  //
  // The summed `skipped` is GONE rather than kept beside them. It was carried for one edit as a
  // compatibility field, and a sweep for its readers found none: the sum that made this question
  // unanswerable has no consumer to be compatible with. Anyone wanting "did not change" adds two
  // named numbers and knows which one moved.
  let materialized = 0; let skippedRecordedInputsCurrent = 0; let skippedRebuiltIdentical = 0; let failed = 0;
  const failures = [];

  // WHICH BUILDER WROTE EACH ARTIFACT ON DISK. `recordedBuildInputsAreStillCurrent` answers whether
  // the package's inputs changed, and that question is silent about a BUILDER that changed what it
  // emits while reading identical inputs. Both halves of that silence have already been paid for.
  // The loud half: every one of 322 receipts carried a `sha256` field beside its `multihash`, the
  // builder stopped emitting it, the compiler's reader declares `deny_unknown_fields`, and a
  // fourteen-minute projection died on the first package it reached (BRTK2013, `access-rule`) with
  // every input hash still perfectly current. The quiet half is worse: an edit to a byte-shaping
  // module under `scripts/` changes the artifact this builder produces while no package input moves,
  // so the skip ships stale bytes and nothing reports it.
  //
  // ONE MAP AT THE SET ROOT, KEYED BY ENTRY, rather than one stamp for the whole tree. The tree-wide
  // stamp is the obvious shape and it is wrong here: the only front door that materializes
  // (`build-entry-bytes-for-chosen-packages.mjs`) demands an explicit package list and refuses an
  // empty one, so a stamp that may only be written after a clean pass over the WHOLE set would never
  // be written at all, and the skip would be permanently off. Per entry, a selected-package run
  // records exactly what it proved and nothing else.
  //
  // The identity does not live in the receipt, and cannot. It would land inside the hashed basis,
  // and the Rust verifier reconstructs that basis from its own copy of the builder-id constant, so
  // the hash would have to be hand-copied into Rust: a snapshot with a hidden expiry (L216) in the
  // one place a mismatch is silent.
  const builderIdentity = await entryByteBuilderSourceIdentity();
  const builderStampPath = path.join(setRoot, 'built-stored-bytes-builder-identity.json');
  const builderStamp = await (async () => {
    try {
      const stamp = JSON.parse(await readFile(builderStampPath, 'utf8'));
      return stamp?.entry_byte_builder_source_identity_by_entry ?? {};
    } catch {
      // Every uncertainty over-invalidates: no map, or a map that will not parse, means nothing on
      // disk is known to have come from today's builder, so nothing may skip.
      return {};
    }
  })();
  let builderStampChanged = false;
  for (const pkg of names) {
    const packageRoot = path.join(packagesRoot, pkg);
    const dataPath = path.join(packageRoot, 'things-to-store-and-run.json');
    if (!existsSync(dataPath)) continue;
    const data = JSON.parse(await readFile(dataPath, 'utf8'));
    const storedBytesRows = new Map(
      (data.things ?? []).filter((t) => t?.type === 'stored_bytes').map((t) => [t.name, t]),
    );
    const entryThings = (data.things ?? []).filter(
      (thing) => thing?.payload?.kind === 'bitfield-package-entry',
    );

    let changed = false;
    for (const [storedName, storedBytes] of storedBytesRows) {
      const relOut = `built-stored-bytes/${storedName}`;
      // Point the row at the built output. The `build` block that declares the producer
      // is left alone: it answers "what makes these bytes", which nothing else records,
      // and deleting it here would re-strand rows that the sibling converter now keeps.
      if (existsSync(path.join(packageRoot, relOut)) && storedBytes.source_path !== relOut) {
        storedBytes.source_path = relOut;
        changed = true;
      }
    }
    for (const thing of entryThings) {
      const entryName = thing.payload.entry_name;
      const storedName = thing.payload.entry_bytes?.stored_bytes ?? `entry-bytes-${entryName}`;
      const relOut = `built-stored-bytes/${storedName}`;
      const receiptRel = `${relOut}.source-closure.json`;
      if (thing.payload.entry_bytes?.stored_bytes !== storedName) {
        thing.payload.entry_bytes = { stored_bytes: storedName };
        changed = true;
      }
      if (!storedBytesRows.has(storedName)) {
        const row = {
          type: 'stored_bytes',
          name: storedName,
          source_path: relOut,
          source_closure_receipt_path: receiptRel,
        };
        data.things.push(row);
        storedBytesRows.set(storedName, row);
        changed = true;
      } else {
        const row = storedBytesRows.get(storedName);
        if (
          row.source_path !== relOut
          || row.source_closure_receipt_path !== receiptRel
        ) {
          row.source_path = relOut;
          row.source_closure_receipt_path = receiptRel;
          changed = true;
        }
      }
    }
    // The manifest is the most dangerous of the three writes: the loader reads it to decide what
    // a package even contains, and receipts bind its hash, so a torn read here is not a missing
    // file, it is a package that appears to declare something else.
    if (changed) await writeFileAtomically(dataPath, `${JSON.stringify(data, null, 2)}\n`);

    for (const thing of entryThings) {
      const entryName = thing.payload.entry_name;
      const storedName = thing.payload.entry_bytes.stored_bytes;
      const relOut = `built-stored-bytes/${storedName}`;
      const absOut = path.join(packageRoot, relOut);
      const receiptAbs = `${absOut}.source-closure.json`;
      try {
        // PRE-BUILD SKIP. Everything below this point compiles the entry with esbuild and only
        // then compares bytes, so the decision downstream saves a WRITE and never the build. This
        // check is what saves the build, and it is the whole cost when a convergence walks the set.
        //
        // It withdrew once, and the reason it withdrew is worth stating because it was not the
        // reason recorded at the time. The first version compared `package_local_inputs` and called
        // that the closure. It is not: the builder splits the metafile into `package-source` and
        // everything else, and every cross-package import lands in `external_input_closures`. So a
        // sibling package could change while every local input stayed byte-identical, and the skip
        // would ship stale bytes with no error, having removed the exact byte comparison that used
        // to catch precisely that. Nothing was missing from the receipt; the reader read half of it.
        //
        // Two things had to be true before rewiring, and both now are. The receipt enumerates
        // external closure members, so the external half is re-derivable rather than merely
        // attested. And the predicate is proven on five cases in
        // `packages/make-packages-match-their-source/tests/recorded-build-inputs-are-still-current.test.mjs`,
        // including a changed CROSS-PACKAGE member, which is the exact case the first version got
        // wrong, and a control proving a temp receipt path does not by itself force a rebuild.
        //
        // Every uncertainty still rebuilds: no artifact, no receipt, a receipt written before
        // enumeration, a member that will not read, any hash that disagrees. A wrong rebuild costs
        // seconds and a wrong skip costs bytes nobody can explain later, so the asymmetry decides
        // the default.
        const builderStampKey = `${pkg}/${entryName}`;
        if (builderStamp[builderStampKey] === builderIdentity
          && existsSync(absOut) && existsSync(receiptAbs)
          && await recordedBuildInputsAreStillCurrent({ packageRoot, receiptAbs, artifactAbs: absOut })) {
          skippedRecordedInputsCurrent++;
          continue;
        }
        const artifact = await buildPackageEntryArtifact({
          packageRoot,
          entryName,
          storedBytesName: storedName,
        });
        const currentBytes = existsSync(absOut) ? await readFile(absOut) : null;
        const currentReceipt = existsSync(receiptAbs) ? await readFile(receiptAbs, 'utf8') : null;
        const decision = packageEntryArtifactPublicationDecision({
          currentBytes,
          currentReceipt,
          nextArtifact: artifact,
        });
        await mkdir(path.dirname(absOut), { recursive: true });
        if (decision.disposition === 'publish') {
          // Bytes before receipt, and each atomically. The receipt names the bytes it describes,
          // so the only safe interleaving is one where a reader can never find a receipt that
          // points at bytes which are not yet whole.
          await writeFileAtomically(absOut, artifact.bytes);
          await writeFileAtomically(receiptAbs, decision.receiptText);
          materialized++;
        } else {
          skippedRebuiltIdentical++;
        }
        // Reached only when the artifact was built and its bytes and receipt now agree with what
        // is on disk, either because they were just written or because they already matched. Both
        // outcomes prove today's builder produced what is there, which is exactly the claim.
        if (builderStamp[builderStampKey] !== builderIdentity) {
          builderStamp[builderStampKey] = builderIdentity;
          builderStampChanged = true;
        }
      } catch (error) {
        failed++;
        // Esbuild puts the file, line, and cause after its first summary line.
        // Keep the bounded diagnostic so a failed package can be repaired before
        // the publisher is retried; the old first-line-only report hid the cause.
        const message = String(error?.message ?? error).slice(0, 16384);
        failures.push({ package: pkg, entry: entryName, message });
        log(`  FAIL ${pkg}/${entryName}: ${message}`);
      }
    }
  }
  // Written once at the end rather than per entry, because it is one small file rewritten whole
  // and a run materializing hundreds of entries would otherwise rewrite it hundreds of times. A
  // run that dies before this point simply records nothing, and the next run rebuilds what it
  // would have skipped, which is the safe direction.
  if (builderStampChanged) {
    await writeFileAtomically(builderStampPath, `${JSON.stringify({
      schema: 'bitfield.entry-byte-builder-identity/source-hash-by-entry',
      entry_byte_builder_source_identity_by_entry: Object.fromEntries(
        Object.entries(builderStamp).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    }, null, 2)}\n`);
  }
  log(`materialized=${materialized} skipped-recorded-inputs-current=${skippedRecordedInputsCurrent} `
    + `skipped-rebuilt-identical=${skippedRebuiltIdentical} failed=${failed}`);
  return { materialized, skippedRecordedInputsCurrent, skippedRebuiltIdentical, failed, failures };
}
