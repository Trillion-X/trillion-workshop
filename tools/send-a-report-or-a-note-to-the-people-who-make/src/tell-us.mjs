// src/tell-us.mjs
//
// PURPOSE
//   The words of a report to the people who make Trillion, shared by its two roads: the sidebar's Tell us screen (the tool
//   row `tool:tell-trillions-makers`, run through the workshop) and an AI's `tell_trillions_makers` MCP tool (src/tools.mjs).
//   Both end in the one hand-to-an-account action (src/hand-to-an-account.mjs), reached for an AI by `tellTheMakers` here,
//   which the account's own resource answers as its tell-us family (src/native-owner-routes.json), so
//   a report is the same row with the same kind whichever road it came by; only `sent_by` (`ai` or `screen`) and
//   `harness` (the AI app) say which. This module only turns what an AI sent into the input that road takes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The kinds are records/hq-reports.json `kinds`: the tool takes an id (bug, friction, idea, feedback), the Notes
//      from members list keeps its label, and the sidebar's choice shows its words. Nothing else names a kind.
//   2. A person's own words travel only when the AI says they are the person's to send (`include_their_words`) AND the
//      account's `content` choice is on (records/hq-sharing.json); otherwise the report holds only the AI's own note.
//   3. Everything is cut to records/hq-reports.json `limits`; nothing here reads a person's store: the account's sharing
//      choice, the shipped tool rows and the hand-off are supplied by the owner that mounts `tellTheMakers`.
//
import reports from '../records/hq-reports.json' with { type: 'json' };

export const REPORT_KINDS = reports.kinds;
export const REPORT_WORDS = reports.words;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** The list's label for a kind id the tool takes (`bug` → "a bug report"), or null. */
export const labelOfKind = id => REPORT_KINDS.find(kind => kind.id === id)?.label ?? null;
/** The kind id for what the list keeps or the sidebar sent ("a bug report" → `bug`); an id stays itself. */
export const reportKindOf = value => REPORT_KINDS.find(kind => kind.label === value || kind.id === value)?.id ?? 'feedback';

/**
 * What an AI's tell_trillions_makers call asks, checked and cut. → { input, theirWords, harness } where `input` is what the
 * hand-to-an-account action reads (kind as the list's label, the AI's own note, where). Throws an Error with plain words
 * when the call lacks a kind or a note.
 */
export function readAiReport(asked) {
  const kind = labelOfKind(asked?.kind);
  if (!kind) throw new Error(REPORT_WORDS.bad_kind);
  const note = text(asked?.note, reports.limits.note);
  if (!note) throw new Error(REPORT_WORDS.no_note);
  return {
    input: { kind, note, ...(text(asked?.where, reports.limits.where) ? { where: text(asked.where, reports.limits.where) } : {}) },
    theirWords: asked?.include_their_words === true ? text(asked?.their_words, reports.limits.their_words) : '',
    harness: text(asked?.harness, reports.limits.harness),
  };
}

/**
 * An AI's report to the people who make Trillion: the same shipped tool row and the same hand-to-an-account action as the
 * sidebar's Tell us screen, sent as `ai`. An account that does not share its activity with Trillion HQ sends nothing from
 * its AI (the person's own Tell us screen still works); the person's words go only with `include_their_words` and the
 * account's `content` choice. → the hand-off's answer, or { kept: false, said } when the account does not share.
 */
export async function tellTheMakers(asked, { harness = '', sharing, tools, send }) {
  const report = readAiReport(asked);
  const chosen = await sharing();
  if (!chosen.activity) return { kept: false, said: REPORT_WORDS.not_sharing };
  const row = (await tools()).find(tool => tool.id === reports.tool_id);
  if (!row) throw new Error('There is nowhere to send this yet.');
  return send(report.input, row.invoke, { sentBy: 'ai', harness: report.harness || harness, theirWords: chosen.content ? report.theirWords : '' });
}

/** POST /tell-us on the account's own resource; every plan reaches it. A report the account cannot send is a 400. */
export async function handleTellUsRequest(owner, request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/tell-us') return Response.json({ error: 'Not found' }, { status: 404 });
  try { return Response.json(await tellTheMakers(await request.json(), owner)); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}
