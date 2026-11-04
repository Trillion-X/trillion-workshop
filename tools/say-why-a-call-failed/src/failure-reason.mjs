// src/failure-reason.mjs
//
// Why a call failed, in words: the error's message and then the message of what caused it. The resource meter wraps a call that
// failed as measurement_or_receipt_uncertain and keeps the real failure as its cause, so a log or a lane that named only the wrapper
// told no one what to fix (speech-meaning on one account and a RecordBook alarm, 2026-10-20).
export function reasonOf(error) {
  const parts = [];
  for (let held = error, depth = 0; held !== undefined && held !== null && depth < 4; held = held.cause, depth += 1) {
    const words = held instanceof Error ? held.message : String(held);
    if (words && !parts.includes(words)) parts.push(words);
  }
  return parts.join(': ').slice(0, 600);
}
