// src/list-refusals.mjs
//
// Purpose: how the lists (src/lists.mjs) and everything built over them (src/list-row-operations.mjs,
// src/placed-lists.mjs) refuse. Every refusal's words are DATA (src/lists.json `words`); one is made by `listSay(key, values)`.
//
// Non-Negotiable Invariants:
//   1. A refusal made by `listSay` carries what it was about (`detail`: the words' key and the row, field and value named),
//      so a caller can mend the request (a form of the missing values) instead of parsing the sentence.
//   2. A canonical refusal is an actual returned outcome, even when prior admitted work happened. It is never evidence that
//      the command was not dispatched.
//
import data from './lists.json' with { type: 'json' };

export class ListsError extends Error {}

export const listRefusal = error => error instanceof ListsError ? { status: 400, body: { error: error.message, ...(error.detail ? { refused: error.detail } : {}) } } : null;

export const listSay = (key, values = {}) => Object.assign(new ListsError(data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))), { detail: { code: key, ...values } });
