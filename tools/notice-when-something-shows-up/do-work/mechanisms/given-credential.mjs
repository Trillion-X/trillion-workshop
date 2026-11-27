/**
 * The credential a mechanism reads, only from a descriptor the run was given.
 *
 * The engine mounts a waiter's credential on a descriptor only when the run's input names it (what-this-tool-does-and-how-to-run-it.json
 * key: `credential_name` on 4 only when present, each waiter's own `credential_name` on 5 + its place). A
 * descriptor the run was not given is still open in the process (node's own kqueue or epoll), so reading it fails with
 * a word that says nothing of the cause (ENXIO on a Mac, EINVAL on Linux): on Nov 21 2026 from 7:27 AM CST the three
 * keep-noticing-row-changes copies were switched on with no credential_name, read node's own descriptor 4, told their
 * database unreachable and exited 0, so nothing noticed a row change for hours while the wake said "ran".
 *
 * The watcher tells each mechanism whether a credential was mounted for it (`credentialMounted`, emit-arrival-fact.mjs
 * startWaiter). When it was not, this refuses before any read, naming what to change; the refusal is told as the
 * waiter's unreachable fact and the run ends non-zero (`noCredential`), so the wake shows it failed. A caller that says
 * nothing (`credentialMounted` undefined, as a test that hands a descriptor in) reads as before.
 *
 * A descriptor is read once per process and its text kept: the engine mounts a credential as a pipe, so a second read of
 * the same descriptor gets nothing. On Nov 21 2026 at 3:37 PM CST seven service-lists waiters of one switch shared the run's
 * credential_name on 4; the first waiter read the key and the other six sent an empty key and were refused (treg: 401).
 */
import { fstatSync, readFileSync } from "node:fs";

/** Each descriptor's text, read once: a mounted credential is a pipe that answers only its first read. Kept by the
 * descriptor and the identity of what it is open on (device and inode), so a number closed and opened again on another
 * file is read anew. */
const readOnce = new Map();

export const NO_CREDENTIAL = "no credential named: switch this wake on with credential_name";

/** The credential text on the waiter's own descriptor, else on `fallbackFd`, the one the run's credential_name is on. */
export function readGivenCredential(handlers, fallbackFd) {
  if (handlers.credentialFd == null && handlers.credentialMounted === false) {
    throw Object.assign(new Error(NO_CREDENTIAL), { reason: "no-credential", noCredential: true });
  }
  const fd = handlers.credentialFd ?? fallbackFd;
  const { dev, ino } = fstatSync(fd);
  const key = `${fd}:${dev}:${ino}`;
  if (!readOnce.has(key)) readOnce.set(key, readFileSync(fd, "utf8").trim());
  return readOnce.get(key);
}
