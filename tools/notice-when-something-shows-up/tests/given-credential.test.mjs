// A mechanism reads its credential only from a descriptor the run was given (do-work/mechanisms/given-credential.mjs).
//
// On Nov 21 2026 from 7:27 AM CST three keep-noticing-row-changes copies were switched on with no credential_name: the
// engine mounted nothing on descriptor 4, row-changes read node's own descriptor 4 there (ENXIO on a Mac, EINVAL on
// Linux), told its database unreachable and exited 0, so the wake said "ran" while nothing was noticed.

import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONDITIONS, readWaiterRow, runResidentEmitter } from "../do-work/emit-arrival-fact.mjs";
import { NO_CREDENTIAL, readGivenCredential } from "../do-work/mechanisms/given-credential.mjs";
import * as rowChanges from "../do-work/mechanisms/row-changes.mjs";
import { tempFolder } from "../../../test-helpers/temp-folder.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const ROWS = JSON.parse(readFileSync(path.join(packageRoot, "what-this-tool-does-and-how-to-run-it.json"), "utf8"));
const WAKE = ROWS.records.map((record) => record.payload).find((row) => row?.id === "tool:notice-when-something-shows-up").wakes
  .find((wake) => wake.id === "keep-noticing-row-changes");
const ROW_CHANGES_WAITER = WAKE.input.waiters[0];

function carrierOf(waiters) {
  const writes = [];
  return {
    writes,
    async scanUnderPath() { return { entries: waiters.map((payload) => ({ payload })) }; },
    async readCurrent() { throw new Error("not found"); },
    async writeRecord(write) { writes.push(write); return { ok: true }; },
  };
}

function descriptorHolding(text) {
  const folder = tempFolder(path.join(tmpdir(), "given-credential-"));
  const file = path.join(folder, "credential");
  writeFileSync(file, `${text}\n`);
  return openSync(file, "r");
}

test("a run given no credential refuses the row-changes waiter by name, reads no descriptor, and ends non-zero", async () => {
  const carrier = carrierOf([ROW_CHANGES_WAITER]);
  let connected = false;
  const mechanism = {
    ...rowChanges,
    watchForTransitions: (settings, handlers) => rowChanges.watchForTransitions(settings, {
      ...handlers,
      connect: async () => { connected = true; throw new Error("never reached"); },
    }),
  };
  await assert.rejects(
    runResidentEmitter({ env: {}, carrier, loadModule: async () => mechanism, connection: null, nowMs: () => 1_800_000_000_000 }),
    (error) => error.noCredential === true && error.message === NO_CREDENTIAL,
  );
  assert.equal(connected, false, "nothing was read or opened");
  assert.equal(carrier.writes.length, 1);
  const told = carrier.writes[0].payload;
  assert.equal(told.condition, CONDITIONS.unreachable);
  assert.equal(told.observed_identity.refusal_reason, "no-credential");
  assert.equal(told.observed_identity.refusal_detail, NO_CREDENTIAL);
});

test("a run given its credential_name reads it from the run's descriptor", async () => {
  const fd = descriptorHolding("postgres://given");
  try {
    assert.equal(readGivenCredential({ credentialMounted: true }, fd), "postgres://given");
  } finally { closeSync(fd); }
});

test("a waiter's own credential is read from its own descriptor, whatever the run was given", () => {
  const fd = descriptorHolding("postgres://own");
  try {
    assert.equal(readGivenCredential({ credentialFd: fd, credentialMounted: true }, 4), "postgres://own");
    assert.equal(readWaiterRow({ ...ROW_CHANGES_WAITER, credential_name: "a-place-connection", credential_fd: fd }).credential_fd, fd);
  } finally { closeSync(fd); }
});

test("a caller that does not say whether a credential was mounted reads as before", () => {
  const fd = descriptorHolding("postgres://as-before");
  try {
    assert.equal(readGivenCredential({}, fd), "postgres://as-before");
  } finally { closeSync(fd); }
});

test("a mechanism told no credential was mounted refuses before any read, even with a descriptor number in its settings", () => {
  assert.throws(() => readGivenCredential({ credentialMounted: false }, 4), (error) => error.noCredential && error.reason === "no-credential");
});
