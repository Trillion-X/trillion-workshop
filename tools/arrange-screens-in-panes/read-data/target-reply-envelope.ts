// packages/screen-arrangement/read-data/target-reply-envelope.ts
//
// PURPOSE: one place that knows an engine reply arrives WRAPPED.
//
// `sendRequestToBitfieldTarget` is typed `Promise<BitfieldTargetReply>`, and `BitfieldTargetReply`
// is `{ payload: Uint8Array }`. So every caller must unwrap before it decodes, and a caller that
// forgets sees a plain object, hands it straight back, and then reads every field of the reply as
// `undefined`.
//
// ⛔ WHY THIS IS ITS OWN FILE RATHER THAN A THIRD COPY. The rule was already implemented once, in
// `ask-screen-arrangement.ts`, and two other callers in this same package did not have it:
// `apply-application-composition-selection.ts` failed with `current readback is invalid for
// <address>` while the SAME operation at the SAME address over HTTP returned
// `{found, payload, content_hash}` every time, and
// `dispatch-application-composition-transition.ts` would fail the same way with
// `returned no write_set`. The engine was answering correctly and the consumers were discarding the
// answer, which reads as a broken engine and is a broken consumer.
//
// That failure mode is especially expensive because the symptom points AWAY from the cause: a
// missing field looks like the producer sent the wrong thing. One owner for the envelope means the
// next caller cannot forget, and the next reader has one place to check.

/** True for a byte view regardless of which realm created it.
 *
 *  ⛔ `instanceof Uint8Array` IS NOT ENOUGH AND THE FIRST VERSION OF THIS FILE USED IT. Every realm
 *  has its own `Uint8Array` constructor, so bytes that crossed a module, worker, vm or host
 *  boundary fail the check while being, in every way that matters, a Uint8Array. This is not
 *  theoretical: the test below caught it immediately on bytes made by `TextEncoder` under the test
 *  runner, which is exactly the shape the real engine boundary produces.
 *
 *  The idiom was copied from a sibling that has always used `instanceof`, so the sibling has the
 *  same latent fragility. Copying a working line does not import the conditions under which it
 *  works, and this one works only while producer and consumer share a realm. */
function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && (value as ArrayBufferView & { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1;
}

/** Unwrap `{ payload: <bytes> }` to the bytes inside. Anything else passes through untouched, so
 *  this is safe to apply to a value that has already been decoded, or that never was an envelope. */
export function insideTargetReplyEnvelope(value: unknown): unknown {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && isBytes((value as { payload?: unknown }).payload)
    ? (value as { payload: Uint8Array }).payload
    : value;
}
