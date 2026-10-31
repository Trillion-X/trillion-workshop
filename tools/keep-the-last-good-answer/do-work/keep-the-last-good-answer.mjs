// packages/keep-the-last-good-answer/do-work/keep-the-last-good-answer.mjs
//
// PURPOSE: ask a live source for an answer. If it answers, keep that answer. If it
// does not, hand back the one that was kept. So the fallback is always the last thing
// that was really true, instead of whatever was true when something was built.
//
// WHY THIS EXISTS: on 2026-09-03 a live host returned `502 public entry unavailable`
// for over an hour because the engine it reads was down, and its only alternative was
// a file baked into a container image months earlier. A baked fallback is a guess
// recorded at BUILD time. A kept fallback is an observation recorded at RUN time.
// The host had received the true answer every time the engine was up, and had nowhere
// to put it. A sibling host had tolerated the identical failure since 2026-08-07, so
// the fix had been applied to one host rather than to the category.
//
// NON-NEGOTIABLE INVARIANTS
// 1. This file knows nothing about what an answer IS, where it is kept, or who the
//    source is. All three arrive as functions. There is no fs, no http, no path, no
//    scene and no product word below, which is why a second caller costs nothing.
// 2. Failing to KEEP never fails the answer. Keeping is for the NEXT cold start; the
//    caller asking right now already has its value and must not lose it because a
//    disk was full.
// 3. A source that answers with NOTHING has not answered, and must never overwrite a
//    good kept answer with emptiness. This is the quiet way the whole idea turns into
//    a page that goes blank and never recovers, and it is invisible in testing because
//    a healthy source never produces it.
// 4. The caller is TOLD where its answer came from and is never made to guess. A
//    holder that returns only a value forces every caller to re-derive whether it holds
//    fresh truth or a survivor, and they will each derive it differently.
// 5. Nothing here logs. A failure is RETURNED. The caller owns its own voice, and a
//    library that prints is a library that cannot be used twice.
//
// DELIBERATELY ABSENT, and the reasons are load-bearing rather than laziness:
//   timeouts and retries belong to askTheSource, the only party that knows what a slow
//   answer means; storage is injected or this becomes a file cache and is useless for a
//   value kept in memory, a KV or a database row; serialization belongs to the store;
//   and freshness policy is unresolved on purpose, recorded in the gauntlet rather than
//   designed ahead of a real case that needs it.

// The three places an answer can come from. This is a closed set by physics, in the
// same way Option and Result are closed: an answer is either the live one, or the one
// that survived, or there is not one. There is no fourth, and no caller or package can
// invent one, so naming them here is not the finite enumeration that the enum
// dissolution rule forbids. Anything that feels like a fourth is a property OF an
// answer and belongs in a field beside it, never as a new origin.
export const FROM_THE_SOURCE = 'from-the-source';
export const FROM_WHAT_WAS_KEPT = 'from-what-was-kept';
export const NOTHING_TO_GIVE = 'nothing-to-give';

// `undefined` and `null` both mean the source had nothing to say. Everything else is a
// real answer, including 0, an empty string and false, because this holder does not get
// to decide that a caller's 0 is meaningless. A truthiness check here would be a bug
// that only shows up on the one day a legitimate 0 arrives.
function isAnAnswer(value) {
  return value !== undefined && value !== null;
}

/**
 * @param {object} how
 * @param {() => Promise<any>|any} how.askTheSource
 *        The live read. May throw, may answer with nothing. Both are ordinary here.
 * @param {() => Promise<any>|any} [how.readWhatWasKept]
 *        Produces the surviving answer. May throw; a store that cannot be read is
 *        treated exactly like a store that is empty, because to the caller they are the
 *        same situation, and splitting them would only push the branch outward.
 * @param {(value: any) => Promise<void>|void} [how.keepThisAnswer]
 *        Persists a live answer. Its failure is reported, never raised.
 * @returns {() => Promise<{origin: string, value: any, sourceFailure?: any, keepFailure?: any, keptFailure?: any}>}
 */
export function keepTheLastGoodAnswer({ askTheSource, readWhatWasKept, keepThisAnswer } = {}) {
  if (typeof askTheSource !== 'function') {
    throw new TypeError(
      'keepTheLastGoodAnswer needs askTheSource, because there is nothing to keep without a source',
    );
  }

  // ONE object per call, on every path, which is the floor: something has to be
  // returned. The obvious spelling of this builds a result and then respreads it
  // (`{ ...answer, origin, value }`) on the fallback path, so a dead source cost two
  // allocations and a live one cost two more on a keep failure. Filling a freshly made
  // local object instead is not a purity problem, because nothing else has seen it yet,
  // and it deletes the spreads rather than optimizing them.
  //
  // Every field is ALWAYS present, null when it does not apply. Two reasons, and the
  // second is the one that lasts. It keeps a single hidden class, so property access
  // stays monomorphic instead of transitioning shape per outcome. And presence-as-signal
  // is an encoding: a consumer would have to ask whether a key exists rather than what
  // its value is, which is the shorthand the machine-readable rule forbids.
  function anEmptyAnswer() {
    return {
      origin: NOTHING_TO_GIVE,
      value: null,
      sourceFailure: null,
      keepFailure: null,
      keptFailure: null,
    };
  }

  async function fillFromWhatWasKept(answer) {
    if (typeof readWhatWasKept !== 'function') return answer;
    try {
      const kept = await readWhatWasKept();
      if (isAnAnswer(kept)) {
        answer.origin = FROM_WHAT_WAS_KEPT;
        answer.value = kept;
      }
    } catch (keptFailure) {
      answer.keptFailure = keptFailure;
    }
    return answer;
  }

  return async function answerNow() {
    const answer = anEmptyAnswer();
    let live;
    try {
      live = await askTheSource();
    } catch (sourceFailure) {
      answer.sourceFailure = sourceFailure;
      return fillFromWhatWasKept(answer);
    }

    // Invariant 3.
    if (!isAnAnswer(live)) return fillFromWhatWasKept(answer);

    answer.origin = FROM_THE_SOURCE;
    answer.value = live;
    if (typeof keepThisAnswer !== 'function') return answer;
    try {
      await keepThisAnswer(live);
    } catch (keepFailure) {
      // Invariant 2. The caller keeps its value; only the NEXT cold start pays.
      answer.keepFailure = keepFailure;
    }
    return answer;
  };
}
