// src/record-find.mjs
// What one request to find the person's records by their words asks of a record store's find(): the same reading for
// the hosted store (POST /records/find in src/person-store.mjs) and the copy kept on a device (src/workspace/device-copy.ts).
// { words, fields, leave_out, limit, resume } -> { words, fields, leaveOut, limit, budget, resume }, words split into at most
// 8 lowercase terms. One request looks at no more than FIND_BUDGET records, so what it reads does not grow with the
// records held; when that ends the walk before `limit` records are found, the answer's `next` is sent back as `resume`.
export const FIND_BUDGET = 4000;
export const findArguments = body => ({
  words: (String(body?.words ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8),
  fields: body?.fields,
  leaveOut: Array.isArray(body?.leave_out) ? body.leave_out : [],
  limit: body?.limit,
  budget: FIND_BUDGET,
  resume: typeof body?.resume === 'string' ? body.resume : null,
});
/** A store's find() answer as the request is answered: { records: [{ id, kind, title }] }, and `next` (send it as
 *  `resume`) only when the walk stopped before the end. */
export const foundRecords = found => ({ records: found.map(({ id, type, title }) => ({ id, kind: type, title: title.slice(0, 140) })), ...(found.next ? { next: found.next } : {}) });
