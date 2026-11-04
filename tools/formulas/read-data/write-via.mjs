// src/write-via.mjs
//
// Purpose: every record write says the road it came by. A write's actor is `by` (the reader or app that asked) plus
// `via` { app, road, basis }: the app's registered name, the kind of sign-in it came through (a person's page, an AI
// over MCP, a file connection, Trillion itself) and how the app name is known. It is kept once per change in the log's
// actor context (and on a removed row's trash record, and on a list's per-field stamps when the list keeps them), and a
// history line says it in plain words: "You via Claude Code over MCP".
//
// Non-Negotiable Invariants:
//   1. Compact: at most three short strings per change, each cut at write-via.json `chars`; nothing about the call's
//      input is kept.
//   2. The road comes only from the admitted command (its claims and recorder), never from what a request says about
//      itself; a road this file has no words for is kept as its kind and said without words.
//   3. Words are DATA (src/write-via.json); this file names no app and no road.
//
import data from './write-via.json' with { type: 'json' };

const short = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, data.chars) : null);

/** The compact `via` of an admitted command ({ claims, recorder }), or null when it says nothing. */
export function viaOf({ claims, recorder } = {}) {
  const signIn = typeof claims?.sign_in === 'string' ? claims.sign_in : '';
  const road = short(signIn.includes(':') ? signIn.slice(0, signIn.indexOf(':')) : recorder?.app_basis === 'service' ? 'service' : null);
  const via = { app: short(recorder?.app), road, basis: short(recorder?.app_basis) };
  const kept = Object.fromEntries(Object.entries(via).filter(([, value]) => value !== null));
  return Object.keys(kept).length ? kept : null;
}

/** The plain-words line for one write's actor ({ by, person?, via? }): who, through which app, by which road. */
export function viaWords(actor) {
  const via = actor?.via ?? {};
  const fill = template => template.replace(/\{(\w+)\}/g, (_, key) => ({
    who: short(actor?.person) ?? data.said.who_default,
    app: via.app ?? '',
    road: data.roads[via.road] ?? '',
    basis: data.bases[via.basis] ?? '',
  })[key] ?? '').replace(/\s+/g, ' ').trim();
  return fill(via.app ? data.said.with_app : data.said.without_app);
}
