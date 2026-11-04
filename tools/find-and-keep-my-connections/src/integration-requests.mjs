// src/integration-requests.mjs
//
// Purpose
//   The services a person asked Trillion to connect to next, kept as one list on their account and drawn by the
//   Connections screen (src/account-screens.mjs integrationRequestSection). Adding one also tells the people who make
//   Trillion through the same report the Tell us screen sends (src/account-routes.mjs connections/request). The words,
//   limits and the report's kind are DATA (src/integration-requests.json).
//
// Non-negotiable invariants
//   1. The same service asked for twice is one request (names compare without case or spacing); the older one stays.
//   2. A request holds only what the person typed, cut to the DATA's lengths; its id is the BLAKE3 identity of its name.
//   3. The list holds at most `max` requests; a full list refuses a new one in words, it never drops an old one.
//
import settings from './integration-requests.json' with { type: 'json' };
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const INTEGRATION_REQUESTS = settings;
/** The words of a service card's Learn more panel (src/integration-requests.json learn_more). */
export const LEARN_MORE = settings.learn_more;
/** The words of a service card the person's plan does not let them connect (src/integration-requests.json plan_gate). */
export const PLAN_GATE = settings.plan_gate;

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const normal = name => name.toLowerCase();
const idOf = name => `ask_${bytesToHex(blake3(new TextEncoder().encode(normal(name)))).slice(0, 24)}`;

export class IntegrationRequestError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** The kept list as rows, oldest first; anything that is not a request row is left out. */
export const requestsOf = kept => (Array.isArray(kept) ? kept : []).filter(row => row && typeof row.id === 'string' && typeof row.name === 'string');

/** The list with one request added: → { rows, request } or throws IntegrationRequestError in plain words. */
export function addRequest(kept, { name, note } = {}, now = new Date()) {
  const rows = requestsOf(kept);
  const asked = text(name, settings.name_max);
  if (!asked) throw new IntegrationRequestError(settings.words.need_name);
  const id = idOf(asked);
  const earlier = rows.find(row => row.id === id);
  if (earlier) throw new IntegrationRequestError(settings.words.already.replace('{name}', earlier.name));
  if (rows.length >= settings.max) throw new IntegrationRequestError(settings.words.full.replace('{max}', String(settings.max)));
  const why = text(note, settings.note_max);
  const request = { id, name: asked, ...(why ? { note: why } : {}), asked_at: now.toISOString() };
  return { rows: [...rows, request], request };
}

/** The list with request `id`'s note changed (an empty note takes it off): → { rows, request } (request null when it was not there). */
export function changeRequest(kept, id, { note } = {}) {
  const rows = requestsOf(kept);
  const earlier = rows.find(row => row.id === id);
  if (!earlier) return { rows, request: null };
  const why = text(note, settings.note_max);
  const { note: dropped, ...rest } = earlier;
  const request = why ? { ...rest, note: why } : rest;
  return { rows: rows.map(row => (row.id === id ? request : row)), request };
}

/** The list without request `id`: → { rows, removed } (removed null when it was not there). */
export function removeRequest(kept, id) {
  const rows = requestsOf(kept);
  const removed = rows.find(row => row.id === id) ?? null;
  return { rows: rows.filter(row => row.id !== id), removed };
}

/** What the report to the makers says (src/integration-requests.json report_note). */
export const reportNoteOf = request => settings.report_note.replace('{name}', request.name).replace('{note}', request.note ? `. ${request.note}` : '');
