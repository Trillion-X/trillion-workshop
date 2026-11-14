// src/workspace/note-share-plan.mjs
//
// PURPOSE
//   The decisions behind a meeting note's Share row and Share via panel, as pure functions over note-share.json:
//   which destinations are ready, what a form starts with, what is missing, the body that goes to the share
//   delivery road, and how its answer is told. The screen (sharing-sheet.tsx) only draws and sends.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No destination is named here; every one is a row of note-share.json.
//   2. A send is told as sent only when the delivery road lists the place in `delivered` and stopped nowhere.
//   3. Nothing here reads or writes; it returns the request and the words.

import { publicAddressOrNull } from 'trillion-workshop/tools/refuse-requests-to-private-addresses/public-address.mjs';

const fill = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Whether a destination can be used now: link always; mail with a connected Google account that may send; service with a tool place whose name holds `match`. */
export function readyPlace(row, { places = [], accounts = [] } = {}) {
  if (row.kind === 'link') return { ready: true };
  if (row.kind === 'mail') {
    const account = accounts.find(item => item.status === 'connected' && item.can_send !== false && item.connected_at);
    return account ? { ready: true, account } : { ready: false };
  }
  const needle = String(row.match ?? '').toLowerCase();
  const place = needle ? places.find(item => String(item.label ?? '').toLowerCase().includes(needle) && String(item.id ?? '').startsWith('tool-place:')) : null;
  return place ? { ready: true, place } : { ready: false };
}

/** The destinations whose name holds what was typed, in their order. */
export const filterDestinations = (rows, query) => {
  const needle = String(query ?? '').trim().toLowerCase();
  return needle ? rows.filter(row => row.label.toLowerCase().includes(needle)) : rows;
};

/** What a form starts with: each field's `from` (title) filled from the note. */
export const startingValues = (row, { title = '' } = {}) => Object.fromEntries((row.fields ?? []).map(field => [field.id, field.from === 'title' ? title : '']));

/** The first problem with the values, in the person's words, or null. */
export function formProblem(row, values, words) {
  for (const field of row.fields ?? []) {
    const value = String(values[field.id] ?? '').trim();
    if (field.required && !value) return fill(words.missing, { field: field.label });
    if (field.kind === 'email' && value && !EMAIL.test(value)) return words.bad_email;
    if (field.kind === 'url' && value && !publicAddressOrNull(value)) return words.bad_address;
  }
  return null;
}

/** The body of POST /share-destinations/deliver for a service place: the note's link plus the form, each field offered as the tool's input. */
export function deliveryBody(row, place, values, { link, title, requestKey, limit }) {
  const clean = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value ?? '').trim().slice(0, limit)]).filter(([, value]) => value));
  const own = clean.note ?? clean.body ?? '';
  return { to: [place.id], items: [{ kind: 'link', url: link, title: clean.title || title }], ...(own ? { own_words: own } : {}), input: clean, request_key: requestKey, from: 'Meeting note' };
}

/** The mail a draft is made from: where, subject, and the message with the note's link under it. */
export const mailParts = (values, { link, limit }) => ({
  to: String(values.to ?? '').trim(),
  subject: String(values.subject ?? '').trim().slice(0, 300),
  body: `${String(values.body ?? '').trim().slice(0, limit)}${values.body?.trim() ? '\n\n' : ''}${link}`,
});

/** How the delivery road's answer reads: { kind: 'sent' | 'queued' | 'refused', words }. */
export function deliveryOutcome(answer, row, place, words) {
  if (answer?.queued) return { kind: 'queued', words: words.queued };
  const reached = Array.isArray(answer?.delivered) && answer.delivered.some(item => item.id === place.id);
  if (reached && !answer.stopped_at) return { kind: 'sent', words: fill(words.sent, { destination: row.label }) };
  return { kind: 'refused', words: fill(words.refused, { destination: row.label, reason: String(answer?.stopped_at?.error ?? words.failed).replace(/\.$/, '') }) };
}
export const sentWords = (row, words) => fill(words.sent, { destination: row.label });
