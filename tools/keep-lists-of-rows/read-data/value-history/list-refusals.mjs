// read-data/value-history/list-refusals.mjs
//
// Purpose: how the value-history functions (list-value-history.mjs, history-requests.mjs) refuse. Every refusal's words
// are DATA (./lists.json `words`); one is made by `listSay(key, values)`.
//
// Non-Negotiable Invariants:
//   1. A refusal made by `listSay` carries what it was about (`detail`: the words' key and the field and values named),
//      so a caller can mend the request instead of parsing the sentence.
//   2. A refusal is an actual returned outcome, even when prior admitted work happened. It is never evidence that the
//      command was not dispatched.
//
import data from './lists.json' with { type: 'json' };

export class ListsError extends Error {}

export const listRefusal = error => error instanceof ListsError ? { status: 400, body: { error: error.message, ...(error.detail ? { refused: error.detail } : {}) } } : null;

export const listSay = (key, values = {}) => Object.assign(new ListsError(data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))), { detail: { code: key, ...values } });
