// packages/live-namespace/read-data/operation-pair-outcome.mjs
//
// PURPOSE
// Decide whether ONE executed operation-pair case met the predicate it declared BEFORE it ran.
// Pure: takes the case DATA that T12.8 compiled and the observations a runner collected, and
// returns a verdict record. It never runs anything, and it never decides what "should" have
// happened; that was decided in the census row, which is the whole point of declaring outcomes
// before execution. "Both operations returned 200" is not an oracle here, and cannot be.
//
// WHAT AN OBSERVATION IS
// The runner reports, per operation, whether it threw, the error text if it did, and the record
// state it read back AFTER both operations finished: `{found, payload_hash}` at every address the
// case touches. That is deliberately the SMALLEST set of facts a predicate can be judged on. A
// predicate that needs more than "did it throw, what did it say, what is current now" is asking
// the runner to interpret, and interpretation is where oracles go wrong.
//
// NON-NEGOTIABLE INVARIANTS
//  1. Every predicate the case declares must be JUDGED. An unknown predicate is a REFUSAL, not
//     a pass, because a predicate the judge cannot evaluate would otherwise pass silently on the
//     next census row that names it.
//  2. A verdict carries WHICH predicate failed and WHAT was observed. A bare fail is a puzzle.
//  3. Predicates are a capability map, so adding one is adding a row here, never editing the
//     judge loop.

const VERDICT_KIND = "live-namespace.operation-pair-verdict";

export class OperationPairOutcomeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OperationPairOutcomeError";
    this.details = details;
  }
}

function threw(observation) {
  return observation.error != null;
}

function sameState(states) {
  const first = states[0];
  return states.every((state) => state.found === first.found && state.payload_hash === first.payload_hash);
}

/**
 * Each predicate sees `{ a, b, after, before }`:
 *   a, b     the two operation observations `{ error?: string, reply?: object }`
 *   after    Map<address, {found, payload_hash}> read after both finished
 *   before   Map<address, {found, payload_hash}> read before either started
 *   addresses the address list the case declared, in order
 * and returns `{ holds: boolean, observed: string }`.
 */
const STATE_PREDICATES = {
  // P101 read/read: two reads of one address agree.
  "same-found-or-absent-state": ({ a, b }) => {
    const ra = a.reply ?? {};
    const rb = b.reply ?? {};
    const holds = !threw(a) && !threw(b) && ra.found === rb.found && ra.content_hash === rb.content_hash;
    return { holds, observed: `a.found=${ra.found} b.found=${rb.found} a.hash=${ra.content_hash} b.hash=${rb.content_hash}` };
  },
  "no-partial-bytes": ({ a, b }) => {
    const partial = [a, b].some((o) => !threw(o) && o.reply?.found === true && o.reply?.payload === undefined);
    return { holds: !partial, observed: partial ? "a found record carried no payload" : "every found record carried its payload" };
  },

  // P103 read/write: the read saw the old state or the new one, never a mix.
  "coherent-old-or-new-state": ({ a, before, after, addresses }) => {
    const address = addresses[0];
    const seen = a.reply ?? {};
    const old = before.get(address);
    const now = after.get(address);
    const matchesOld = seen.found === old.found && (seen.content_hash ?? null) === (old.payload_hash ?? null);
    const matchesNew = seen.found === now.found && (seen.content_hash ?? null) === (now.payload_hash ?? null);
    return { holds: !threw(a) && (matchesOld || matchesNew), observed: `read matched ${matchesOld ? "old" : matchesNew ? "new" : "NEITHER"} state` };
  },
  "no-mixed-bytes": ({ a }) => {
    const r = a.reply ?? {};
    const mixed = r.found === true && r.payload != null && r.content_hash == null;
    return { holds: !mixed, observed: mixed ? "payload without a content hash" : "payload and hash agree" };
  },

  // P151 write/write with the same expected_current: exactly one lands.
  "exactly-one-write-visible": ({ a, b, after, addresses }) => {
    const wins = [a, b].filter((o) => !threw(o)).length;
    const now = after.get(addresses[0]);
    return { holds: wins === 1 && now.found === true, observed: `${wins} write(s) succeeded; address found=${now.found}` };
  },
  // P151 under retry-replay. The runner sends `a` twice with the IDENTICAL guarded request, then
  // `b`. The FIRST attempt lands (current moves once), the replay is refused because current
  // already moved, and `b` is refused for the same reason. Observed on the real engine: two
  // FE_EXPECTED_CURRENT_MISMATCH, current moved exactly once off the seed, and neither the
  // replay nor `b` is visible. The judge only sees the SECOND `a` attempt, so `a.error` set and
  // current != seed is the correct shape, not a defect.
  "no-guarded-write-landed-twice": ({ a, b, before, after, addresses }) => {
    const firstLanded = a.first_attempt != null && !threw(a.first_attempt);
    const moved = after.get(addresses[0]).payload_hash !== before.get(addresses[0]).payload_hash;
    const replayRefused = threw(a) && threw(b);
    const holds = firstLanded && moved && replayRefused;
    return { holds, observed: `first landed=${firstLanded} replay refused=${threw(a)} b refused=${threw(b)}; current ${moved ? "moved once" : "did not move"}` };
  },
  "no-partial-mutation": ({ after, addresses }) => {
    const states = addresses.map((address) => after.get(address));
    const holds = states.every((s) => s.found === false || s.payload_hash != null);
    return { holds, observed: holds ? "every address is absent or wholly present" : "an address is present without a hash" };
  },

  // P152 write then replay of the identical batch: idempotent, batch atomic.
  "batch-wholly-visible-or-absent": ({ after, addresses }) => {
    const states = addresses.map((address) => after.get(address));
    const allFound = states.every((s) => s.found === true);
    const noneFound = states.every((s) => s.found === false);
    return { holds: allFound || noneFound, observed: `${states.filter((s) => s.found).length}/${states.length} addresses found` };
  },
  "replay-idempotent": ({ a, b, after, addresses }) => {
    const hashesAfterA = a.reply?.hashes_after ?? null;
    const now = addresses.map((address) => after.get(address).payload_hash);
    const same = hashesAfterA != null && hashesAfterA.length === now.length && hashesAfterA.every((h, i) => h === now[i]);
    return { holds: !threw(b) && same, observed: same ? "replay changed nothing" : `state after replay differs: ${JSON.stringify(now)} vs ${JSON.stringify(hashesAfterA)}` };
  },

  // P207 rename (retract old + create new, guarded) racing delete.
  "guarded-old-name-retracted": ({ after, addresses }) => {
    const old = after.get(addresses[0]);
    return { holds: old.found === false, observed: `old name found=${old.found}` };
  },
  "new-name-created-atomically": ({ a, after, addresses }) => {
    const fresh = after.get(addresses[1]);
    const old = after.get(addresses[0]);
    // The rename is ONE batch (retract old + create new), so old-gone and new-present must
    // agree: both happened or neither did. That is what atomic means here, and it holds whether
    // the batch we observed succeeded or was refused as a replay of one that already landed.
    // "Landed" means ANY attempt of the rename batch succeeded. Under retry-replay the runner
    // reports the replay as `a` and carries the first attempt beside it; a refused replay of a
    // batch that already landed is not a half-applied rename, it is idempotence.
    const renameLanded = !threw(a) || (a.first_attempt != null && !threw(a.first_attempt));
    // If no attempt landed the new name must not exist, full stop; the old name's state then
    // belongs to whoever else touched it (the delete), not to the rename.
    const holds = renameLanded ? (old.found === false && fresh.found === true) : fresh.found === false;
    return { holds, observed: `rename landed=${renameLanded} old found=${old.found} new found=${fresh.found}` };
  },
  "pinned-locator-readable": ({ after, addresses }) => {
    const locator = after.get(addresses[2]);
    return { holds: locator.found === true, observed: `locator found=${locator.found}` };
  },

  // P252 fork racing merge: addresses are [original, fork, merge].
  "fork-remains-scoped": ({ a, after, addresses }) => {
    const fork = after.get(addresses[1]);
    const landed = !threw(a) || (a.first_attempt != null && !threw(a.first_attempt));
    const holds = landed ? fork.found === true : fork.found === false;
    return { holds, observed: `fork landed=${landed} fork found=${fork.found}` };
  },
  "no-semantic-merge-record": ({ after, addresses }) => {
    const merge = after.get(addresses[2]);
    return { holds: merge.found === false, observed: `merge record found=${merge.found}` };
  },
  "immutable-identity-stable": ({ b, before, after, addresses }) => {
    const was = before.get(addresses[0]).payload_hash;
    const now = after.get(addresses[0]).payload_hash;
    const read = b.reply?.content_hash ?? null;
    const holds = !threw(b) && was != null && was === now && read === was;
    return { holds, observed: `original before=${was} read=${read} after=${now}` };
  },

  // P377 restore racing garbage-collect: addresses are [pointer].
  "current-pointer-restored": ({ a, after, addresses }) => {
    const target = a.reply?.restored_to ?? a.first_attempt?.reply?.restored_to ?? null;
    const now = after.get(addresses[0]).payload_hash;
    const holds = target != null && now === target;
    return { holds, observed: `current=${now} restore target=${target}` };
  },
  "immutable-identity-remains": ({ b }) => {
    const r = b.reply ?? {};
    const holds = !threw(b) && r.found === true && typeof r.bytes_base64 === "string" && r.bytes_base64.length > 0;
    return { holds, observed: `superseded ${r.superseded_hash} found=${r.found} byte_count=${r.byte_count}` };
  },
  "reclaim-not-admitted": ({ b }) => {
    const refused = b.reply?.reclaim_refused ?? null;
    return { holds: refused != null, observed: refused ? `reclaim refused: ${refused}` : "a reclaim label was ACCEPTED" };
  },

  // P422 revoke racing evict. The owner's structured refusal is surfaced by the runner as
  // `b.error` naming each reason; a refusal that names the WRONG reason is not a pass.
  "stale-authorization-invalid": ({ b }) => {
    const holds = threw(b) && /stale-tuple=stale-or-unauthorized-decision/.test(String(b.error));
    return { holds, observed: threw(b) ? String(b.error) : "the stale tuple was VERIFIED" };
  },
  "possession-is-not-transfer-authority": ({ b }) => {
    const holds = threw(b) && /forged-actor=stale-or-unauthorized-decision/.test(String(b.error));
    return { holds, observed: threw(b) ? String(b.error) : "a forged actor holding the proof was VERIFIED" };
  },
};

const ERROR_MATCHERS = {
  ExpectedCurrentMismatch: (text) => /expected.?current.?mismatch|ExpectedCurrentMismatch/i.test(text),
  AccessDenied: (text) => /access.?denied|AccessDenied/i.test(text),
};

/**
 * @param {object} compiledCase  one entry of `operationPairCasesFromCensus(...).cases`
 * @param {object} run           `{ addresses, before, a, b, after }`
 * @returns a verdict record
 */
export function operationPairOutcome(compiledCase, run) {
  if (compiledCase == null || typeof compiledCase !== "object") {
    throw new OperationPairOutcomeError("compiledCase must be an object");
  }
  for (const field of ["addresses", "before", "a", "b", "after"]) {
    if (run?.[field] == null) throw new OperationPairOutcomeError(`run.${field} is required`, { field });
  }

  const judged = [];
  for (const name of compiledCase.expected.statePredicates) {
    const predicate = STATE_PREDICATES[name];
    if (predicate == null) {
      throw new OperationPairOutcomeError("a declared state predicate has no judge", { predicate: name, caseId: compiledCase.caseId });
    }
    const { holds, observed } = predicate(run);
    judged.push({ predicate: name, holds, observed });
  }

  const errors = [run.a, run.b].filter(threw).map((o) => String(o.error));
  for (const { code, count } of compiledCase.expected.errorPredicates) {
    const matcher = ERROR_MATCHERS[code];
    if (matcher == null) {
      throw new OperationPairOutcomeError("a declared error predicate has no matcher", { code, caseId: compiledCase.caseId });
    }
    const seen = errors.filter(matcher).length;
    judged.push({ predicate: `error:${code}`, holds: seen === count, observed: `expected ${count}, saw ${seen}${errors.length ? `: ${errors.join(" | ")}` : ""}` });
  }

  // An outcome of "pass" forbids UNEXPECTED errors; "conflict" and "denied" require the
  // declared ones and no others.
  const expectedErrorCount = compiledCase.expected.errorPredicates.reduce((sum, e) => sum + e.count, 0);
  judged.push({
    predicate: `outcome:${compiledCase.expected.outcome}`,
    holds: errors.length === expectedErrorCount,
    observed: `${errors.length} error(s) thrown, ${expectedErrorCount} declared`,
  });

  const failed = judged.filter((entry) => !entry.holds);
  return {
    kind: VERDICT_KIND,
    caseId: compiledCase.caseId,
    censusId: compiledCase.censusId,
    schedule: compiledCase.schedule,
    holds: failed.length === 0,
    judged,
    failed: failed.map((entry) => entry.predicate),
  };
}
