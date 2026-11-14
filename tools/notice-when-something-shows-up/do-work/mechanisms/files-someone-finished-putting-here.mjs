#!/usr/bin/env node
/**
 * packages/notice-when-something-shows-up/do-work/mechanisms/files-someone-finished-putting-here.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for somebody outside this system to FINISH putting
 *   a unit in the place this process was handed, and report it. A camera pushing a
 *   clip over the network, a drone, a scanner, a colleague's sync folder, a build
 *   farm dropping an artifact, and a device invented next year are all this one
 *   mechanism with different DATA.
 *
 * Non-negotiable invariants
 *   - This leaf knows nothing about any protocol, any device, any media type, and
 *     anything that will react to what it reports. It never writes to the log,
 *     never opens a socket, and never dispatches.
 *   - Completeness is the COMPLETION NOTE and nothing else. A unit still arriving
 *     has no note, so it does not exist to this leaf. There is no timer, no size
 *     comparison, and no guess. Whoever finishes putting a unit here writes the
 *     note LAST, and that is the whole contract between them and this leaf.
 *   - The note carries the identity. This leaf never reads a unit's bytes to learn
 *     what it is; the party that streamed those bytes already knows, and a fifty
 *     gigabyte original is never read twice. The note's fields travel verbatim
 *     into observed_identity, so a producer that learns a new fact about a unit
 *     adds a field to its note and no code here changes.
 *   - On start it reports every note it can currently see. A missed arrival is
 *     unrecoverable and a repeated one is absorbable, so repetition is the only
 *     failure mode this leaf has. Nothing here remembers across restarts.
 *   - The handover place is DATA and is relative to this process's working
 *     directory, which is its private volume root. Nothing here ever holds an
 *     absolute host path.
 *
 * Key concepts
 *   describeMechanism()    declared identity plus contributed payload fields.
 *   watchForTransitions()  the resident wait, event driven through the host's own
 *                          directory notifications with a periodic rescan as the
 *                          floor, so a notification the host dropped is a delay
 *                          and never a loss.
 *
 * Security
 *   Reads a directory listing and one small note file per unit, both inside the
 *   process's own writable root. Holds no credential, spawns nothing, evaluates
 *   nothing. A note that is not valid JSON, or that does not describe a unit that
 *   exists beside it, is reported as a refused note rather than silently skipped,
 *   because silence here is indistinguishable from a quiet host.
 */

import { readdirSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::files-someone-finished-putting-here";

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: [],
    conditions: ["became-reachable"],
  };
}

/** Read this leaf's settings from a descriptor row, with declared fallbacks.
 *
 *  handover_place          where finished units land, relative to the working directory.
 *  completion_note_suffix  what a note is called: `<unit name><suffix>`.
 *  rescan_milliseconds     floor under the directory watcher; 0 disables the floor. */
/** Resolve the declared place.
 *
 *  A place is either exact text or a machine-readable reference to one
 *  environment key, because the only correct place is a private volume whose
 *  host path the owner resolves after admission and package DATA may never name.
 *
 *  There is no fallback. A "." here would resolve to this process's ephemeral
 *  working directory, which is readable, listable and permanently empty, so the
 *  waiter would report nothing forever while every health signal read green. An
 *  unresolvable place THROWS, and the emitter turns that into a refused fact. */
function resolvePlace(declared, environment) {
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  if (declared && typeof declared === "object" && declared.from === "environment") {
    const key = typeof declared.key === "string" ? declared.key.trim() : "";
    if (!key) throw new Error("handover_place names the environment but carries no key");
    const value = environment[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `handover_place reads ${key} from the environment and it is absent or empty; ` +
          "the owner did not resolve a readable private volume root for this process",
      );
    }
    return value.trim();
  }
  throw new Error("handover_place is required: exact text, or {from: environment, key}");
}

export function readSettings(settings = {}, environment = process.env) {
  const place = resolvePlace(settings.handover_place, environment);
  const suffix = typeof settings.completion_note_suffix === "string" && settings.completion_note_suffix.trim()
    ? settings.completion_note_suffix.trim()
    : ".handover-finished.json";
  const rescan = Number(settings.rescan_milliseconds);
  return {
    handover_place: place,
    completion_note_suffix: suffix,
    rescan_milliseconds: Number.isFinite(rescan) && rescan >= 0 ? rescan : 2000,
  };
}

/** List completion notes currently under the handover place, recursively.
 *
 *  Returns note paths relative to the place, sorted. Only notes are returned:
 *  units without a note do not exist yet, and that is the design. */
export function listCompletionNotes(place, suffix, { readdir = readdirSync, stat = statSync } = {}) {
  const found = [];
  const walk = (relativeDir) => {
    const absoluteDir = path.join(place, relativeDir);
    let entries;
    try {
      entries = readdir(absoluteDir);
    } catch (error) {
      // A subdirectory that vanished mid-walk is ordinary. The PLACE ITSELF
      // vanishing is not: an empty answer there is indistinguishable from a
      // quiet host and would report success forever.
      if (relativeDir !== "") return;
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new Error(`the handover place is not a directory: ${place} (${error.code})`);
      }
      // Forbidden to look at the place itself. An empty answer here would look
      // exactly like a quiet host and would report success forever.
      throw new Error(`cannot list ${place}: ${error?.code ?? error?.message ?? error}`);
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const relative = relativeDir ? `${relativeDir}/${entry}` : entry;
      let info;
      try {
        info = stat(path.join(place, relative));
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(relative);
      else if (info.isFile() && entry.endsWith(suffix) && entry.length > suffix.length) found.push(relative);
    }
  };
  walk("");
  return found.sort();
}

/** The unit a note describes, by the naming contract: `<unit><suffix>` sits beside `<unit>`. */
export function unitNameForNote(noteRelativePath, suffix) {
  return noteRelativePath.slice(0, -suffix.length);
}

/** Turn one note into the observed identity this leaf contributes.
 *
 *  Pure. The note's own fields are carried verbatim and three facts this leaf can
 *  vouch for are added: the unit's relative name, the note's name, and the byte
 *  length actually on disk. A note whose declared byte_length disagrees with the
 *  bytes beside it is a refusal, because the producer's claim and the disk
 *  disagree and a reader must never be handed a hash for the wrong bytes. */
export function observedIdentityFromNote({ noteRelativePath, suffix, noteText, unitByteLength }) {
  let note;
  try {
    note = JSON.parse(noteText);
  } catch (error) {
    return { refused: true, refusal_reason: "completion-note-not-json", refusal_detail: String(error?.message ?? error) };
  }
  if (!note || typeof note !== "object" || Array.isArray(note)) {
    return { refused: true, refusal_reason: "completion-note-not-an-object", refusal_detail: typeof note };
  }
  if (unitByteLength === null) {
    return { refused: true, refusal_reason: "unit-missing-beside-its-note", refusal_detail: unitNameForNote(noteRelativePath, suffix) };
  }
  if (Number.isFinite(Number(note.byte_length)) && Number(note.byte_length) !== unitByteLength) {
    return {
      refused: true,
      refusal_reason: "completion-note-byte-length-disagrees-with-disk",
      refusal_detail: `note says ${note.byte_length}, disk has ${unitByteLength}`,
    };
  }
  return {
    ...note,
    relative_name: unitNameForNote(noteRelativePath, suffix),
    handover_note_name: noteRelativePath,
    byte_length: unitByteLength,
  };
}

async function observeNote(place, noteRelativePath, suffix, { readNote = defaultReadNote, stat = statSync } = {}) {
  let noteText;
  try {
    noteText = await readNote(path.join(place, noteRelativePath));
  } catch (error) {
    return { refused: true, refusal_reason: "completion-note-unreadable", refusal_detail: String(error?.code ?? error?.message ?? error), handover_note_name: noteRelativePath };
  }
  let unitByteLength = null;
  try {
    const info = stat(path.join(place, unitNameForNote(noteRelativePath, suffix)));
    if (info.isFile()) unitByteLength = info.size;
  } catch {
    unitByteLength = null;
  }
  const identity = observedIdentityFromNote({ noteRelativePath, suffix, noteText, unitByteLength });
  return identity.refused ? { ...identity, handover_note_name: noteRelativePath } : identity;
}

function defaultReadNote(filePath) {
  return readFile(filePath, "utf8");
}

/**
 * Wait for units somebody finished putting here, and report each one once per run.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<void>} handlers.onTransition
 * @param {AbortSignal} handlers.signal
 * @param {(place:string, suffix:string)=>string[]} [handlers.listNotes] injected listing, for tests
 * @param {object} [handlers.noteOptions] injected note reader and stat, for tests
 * @param {(place:string, onChange:()=>void)=>{close:()=>void}} [handlers.watchPlace] injected watcher, for tests
 * @param {(fn:()=>void, ms:number)=>any} [handlers.setInterval] injected timer, for tests
 * @param {Record<string,string>} [handlers.environment] injected environment, for tests
 */
export async function watchForTransitions(settings, handlers) {
  const resolved = readSettings(settings, handlers.environment ?? process.env);
  const listNotes = handlers.listNotes ?? ((place, suffix) => listCompletionNotes(place, suffix));
  const noteOptions = handlers.noteOptions ?? {};
  const watchPlace = handlers.watchPlace ?? defaultWatchPlace;
  const schedule = handlers.setInterval ?? setInterval;
  const signal = handlers.signal;

  // Notes already reported in THIS run. It starts empty on purpose so a restart
  // repeats rather than skips, which is the only direction this leaf may fail in.
  const reported = new Set();

  const reconcile = async () => {
    const notes = listNotes(resolved.handover_place, resolved.completion_note_suffix);
    for (const note of notes) {
      if (reported.has(note)) continue;
      const observed = await observeNote(resolved.handover_place, note, resolved.completion_note_suffix, noteOptions);
      // A refused note is still reported, carrying why, and is remembered so the
      // same broken note is not re-reported every rescan. A producer that fixes
      // it writes a NEW note (the name changes with the unit), or the process
      // restarts and reports it again, which is the repetition the design allows.
      await handlers.onTransition({
        condition: "became-reachable",
        observed_identity: observed,
        detail: {},
      });
      reported.add(note);
    }
  };

  await reconcile();
  if (signal?.aborted) return;

  await new Promise((resolve) => {
    let reconciling = false;
    let queued = false;

    const runReconcile = async () => {
      if (reconciling) {
        queued = true;
        return;
      }
      reconciling = true;
      try {
        await reconcile();
      } catch (error) {
        console.error(
          "notice-when-something-shows-up: handover reconcile failed (continuing):",
          error?.message ?? error,
        );
      } finally {
        reconciling = false;
        if (queued) {
          queued = false;
          void runReconcile();
        }
      }
    };

    let watcher = null;
    try {
      watcher = watchPlace(resolved.handover_place, () => { void runReconcile(); });
    } catch (error) {
      // A place that cannot be watched can still be rescanned. The floor below
      // carries the wait; without a floor this is a waiter that is not waiting.
      if (resolved.rescan_milliseconds === 0) throw error;
    }
    const timer = resolved.rescan_milliseconds > 0
      ? schedule(() => { void runReconcile(); }, resolved.rescan_milliseconds)
      : null;

    const stop = () => {
      if (timer) clearInterval(timer);
      try { watcher?.close?.(); } catch { /* already closed */ }
      resolve();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

function defaultWatchPlace(place, onChange) {
  try {
    return watch(place, { persistent: true, recursive: true }, onChange);
  } catch (error) {
    throw new Error(`cannot watch ${place}: ${error?.code ?? error?.message ?? error}`);
  }
}
