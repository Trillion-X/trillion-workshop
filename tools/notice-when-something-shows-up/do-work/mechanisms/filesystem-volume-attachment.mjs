#!/usr/bin/env node
/**
 * packages/notice-when-something-shows-up/do-work/mechanisms/filesystem-volume-attachment.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for a storage volume to become reachable at a
 *   declared attachment place, or to stop being reachable there, and report it.
 *
 * Non-negotiable invariants
 *   - This leaf knows nothing about any other leaf, about any source, about any
 *     app, and about anything that will react to what it reports.
 *   - It never writes to the log, never opens a socket, and never dispatches.
 *   - The attachment place is DATA. Nothing here assumes a host, and nothing
 *     here names a device or a volume.
 *   - When it starts it reports everything it can currently see. A missed
 *     arrival is unrecoverable and a repeated one is absorbable, so repetition
 *     is deliberately the only failure mode this leaf has. This is structural
 *     and there is no setting that turns it off.
 *   - The visible name of a volume is carried as evidence and is NEVER the thing
 *     matched on. Two volumes can share a visible name. They cannot share a
 *     filesystem identity.
 *
 * Key concepts
 *   describeMechanism()    declared identity plus contributed payload fields.
 *   watchForTransitions()  the resident wait, event driven through the host's
 *                          own directory notifications rather than a poll, so it
 *                          costs nothing while nothing is happening.
 *
 * Security
 *   Reads a directory listing and one identity file per volume. Holds no
 *   credential. Spawns nothing, so it runs under leaf containment, which denies
 *   child processes; the host's volume-information command would not.
 */

import { readdirSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::filesystem-volume-attachment";

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: [],
    conditions: ["became-reachable", "became-unreachable"],
  };
}

/** Read this leaf's settings from a descriptor row, with declared fallbacks.
 *
 *  attachment_place is the directory under which this host makes volumes
 *  reachable. It is DATA precisely so that a host which uses a different place
 *  is a row edit rather than a code edit. */
export function readSettings(settings = {}) {
  const place = typeof settings.attachment_place === "string" && settings.attachment_place.trim()
    ? settings.attachment_place.trim()
    : "/Volumes";
  const settleMs = Number(settings.settle_milliseconds);
  return {
    attachment_place: place,
    settle_milliseconds: Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : 750,
  };
}

/** List the volumes currently reachable at the attachment place.
 *
 *  Returns visible names only. Identity is read separately, because identity is
 *  what gets matched and a listing is only how the set is discovered. */
export function listReachableNames(attachmentPlace, { readdir = readdirSync, stat = statSync } = {}) {
  let entries;
  try {
    entries = readdir(attachmentPlace);
  } catch (error) {
    // The attachment place does not exist on this host. That is not an error and
    // not a crash: it means nothing is reachable there, which is a true answer.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    // Any other failure is NOT "nothing is there". A process that is forbidden to
    // look (EACCES, EPERM under containment) must say so, because an empty answer
    // here is indistinguishable from a healthy quiet host and would report
    // success forever.
    throw new Error(`cannot list ${attachmentPlace}: ${error?.code ?? error?.message ?? error}`);
  }
  const names = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    try {
      if (stat(path.join(attachmentPlace, entry)).isDirectory()) names.push(entry);
    } catch {
      // Vanished between listing and inspection. It is not reachable, so it is
      // simply not in the answer.
    }
  }
  return names.sort();
}

/** The file, relative to a volume's root, in which the host's own file-event
 *  daemon stores that volume's persistent identity. It is written once when the
 *  volume is first seen and survives unmount, rename, and remount. Reading it is a
 *  plain file read, so it works under process containment that forbids child
 *  processes, which the host's volume-information command does not. */
export const VOLUME_IDENTITY_FILE = ".fseventsd/fseventsd-uuid";

/** Pull a filesystem identity out of the identity file's bytes.
 *
 *  Pure and exported so the parse is tested without touching a volume. */
export function filesystemIdentityFromFileText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(trimmed) ? trimmed : null;
}

/** Read a reachable volume's filesystem identity from the volume itself.
 *
 *  Injected in tests so no test ever touches a volume. When the volume carries no
 *  identity file, the identity is null and the caller still reports the
 *  appearance, carrying the visible name as evidence. Refusing to report an
 *  appearance because identity was unavailable would lose the arrival, and losing
 *  an arrival is the one failure this package exists to make impossible.
 */
export async function readFilesystemIdentity(mountPath, { readIdentityFile = defaultReadIdentityFile } = {}) {
  try {
    return filesystemIdentityFromFileText(await readIdentityFile(path.join(mountPath, VOLUME_IDENTITY_FILE)));
  } catch {
    return null;
  }
}

function defaultReadIdentityFile(filePath) {
  return readFile(filePath, "utf8");
}

/** Build the observed identity for one reachable volume.
 *
 *  filesystem_identity is the only field a predicate may match on. The other two
 *  are evidence for a human reading the fact later, and a predicate that matches
 *  on them is matching on something two different volumes can share. */
export async function observeVolume(attachmentPlace, visibleName, options = {}) {
  const mountPath = path.join(attachmentPlace, visibleName);
  const identity = await readFilesystemIdentity(mountPath, options);
  return {
    filesystem_identity: identity,
    attachment_path: mountPath,
    visible_name: visibleName,
  };
}

/**
 * Wait for volumes to become reachable or stop being reachable, and report each.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<void>} handlers.onTransition
 * @param {AbortSignal} handlers.signal
 * @param {(place:string)=>string[]} [handlers.listNames] injected listing, for tests
 * @param {object} [handlers.identityOptions] injected identity reader, for tests
 * @param {(place:string, onChange:()=>void)=>{close:()=>void}} [handlers.watchPlace] injected watcher, for tests
 */
export async function watchForTransitions(settings, handlers) {
  const resolved = readSettings(settings);
  const listNames = handlers.listNames ?? ((place) => listReachableNames(place));
  const identityOptions = handlers.identityOptions ?? {};
  const watchPlace = handlers.watchPlace ?? defaultWatchPlace;
  const signal = handlers.signal;

  // The set this leaf believes is reachable. It starts empty on purpose, so the
  // first pass reports everything currently there. A restart therefore repeats
  // rather than skips, which is the direction this package is allowed to fail in.
  let reachable = new Map();

  const reconcile = async () => {
    const names = listNames(resolved.attachment_place);
    const seen = new Map();
    for (const name of names) {
      const known = reachable.get(name);
      seen.set(name, known ?? (await observeVolume(resolved.attachment_place, name, identityOptions)));
    }
    for (const [name, observed] of seen) {
      if (reachable.has(name)) continue;
      await handlers.onTransition({
        condition: "became-reachable",
        observed_identity: observed,
        detail: {},
      });
    }
    for (const [name, observed] of reachable) {
      if (seen.has(name)) continue;
      await handlers.onTransition({
        condition: "became-unreachable",
        observed_identity: observed,
        detail: {},
      });
    }
    reachable = seen;
  };

  await reconcile();
  if (signal?.aborted) return;

  await new Promise((resolve) => {
    let settleTimer = null;
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
        // A single failed reconcile must never end the resident wait. The next
        // notification, or the next attachment, reconciles again.
        console.error(
          "notice-when-something-shows-up: volume reconcile failed (continuing):",
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

    const onChange = () => {
      // A volume appears as a directory before it is fully usable. Settling
      // avoids reading identity from a half attached volume, and the window is
      // DATA rather than a constant.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { void runReconcile(); }, resolved.settle_milliseconds);
    };

    const watcher = watchPlace(resolved.attachment_place, onChange);

    const stop = () => {
      if (settleTimer) clearTimeout(settleTimer);
      try { watcher?.close?.(); } catch { /* already closed */ }
      resolve();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

function defaultWatchPlace(attachmentPlace, onChange) {
  try {
    return watch(attachmentPlace, { persistent: true }, onChange);
  } catch (error) {
    // A place this process is not allowed to watch is a waiter that is not
    // waiting. Say so by throwing, so the emitter records it as a fact, rather
    // than sitting on a null watcher that looks exactly like a quiet host.
    throw new Error(`cannot watch ${attachmentPlace}: ${error?.code ?? error?.message ?? error}`);
  }
}
