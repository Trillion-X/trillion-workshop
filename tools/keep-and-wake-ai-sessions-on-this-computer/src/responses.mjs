// src/responses.mjs
//
// What anyone says back to a thing: a reaction or words, on the whole thing or on one part of it.
//
// Purpose
//   Anything a person can see in Trillion can be answered where it is: a post, a shared file, a decision, a list row,
//   a sentence on a screen. An answer points at its target with one anchor shape, { record, part? }: `record` is the
//   thing's own reference (a space item's id, file:<identity>, a decision's case id...), and `part`, when the answer
//   is about a piece of it, says which piece in the words of its own kind (a text range, an element, a moment, a point).
//   The answer is kept where the thing's audience already is: in a space, as one of its items (words, with reply_to and
//   the part) or one of its reactions (src/spaces.mjs space_item_reactions); in the person's own Trillion, as a message
//   about the anchor (src/messages.mjs), which every one of their AIs reads. This module is the one place that says
//   what a reaction and a part may hold, so both stores and every screen read the same rules.
//
// Non-negotiable invariants
//   1. Nothing here names a kind of part, a kind of record or a reaction: the palette and the vote symbol are DATA
//      (src/reactions.json), a part's kind is the caller's word, and any emoji or https picture is a reaction.
//   2. One reaction is one row per (thing, person, symbol): reacting again with the same symbol changes nothing, and
//      taking it back removes that row. A custom reaction's symbol is its glyph, so two people's same GIF count together.
//   3. A part is a plain object with a `kind`, at most limits.anchor_bytes when written as JSON; nothing else of its shape
//      is checked here, because each kind's owner draws and finds it.
//   4. The vote is one reaction symbol (reactions.json `vote`), so a community's votes and everyone's reactions are one
//      table with one tally; the vote is counted with its budget, never drawn in the reaction row.
//
import reactions from './reactions.json' with { type: 'json' };

export const VOTE = reactions.vote;
export const PALETTE = reactions.palette;
const BY_SYMBOL = new Map(PALETTE.map(row => [row.symbol, row]));
const LIMITS = reactions.limits;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

/** The generic thing and optional part a Space response is about. */
export function anchorFrom(anchor) {
  if (!plain(anchor) || typeof anchor.record !== 'string' || !anchor.record.trim() || anchor.record.length > 500) {
    throw new Error('An anchor names the thing a response is about: { record, part? }.');
  }
  const part = partFrom(anchor.part);
  return { record: anchor.record.trim(), ...(part ? { part } : {}) };
}

/** The stable row key shared by reactions to the same generic anchor. */
export const responseAnchorKey = anchor => `anchor:${canonical(anchorFrom(anchor))}`;

/** The reaction a request names, as it is kept: a palette symbol or the vote (no glyph kept), or the person's own
 *  emoji or https picture (its glyph is its symbol). Throws with words a person can act on. */
export function reactionFrom({ symbol, glyph } = {}) {
  if (typeof symbol === 'string' && (BY_SYMBOL.has(symbol) || symbol === VOTE)) return { symbol, glyph: null };
  const own = typeof glyph === 'string' ? glyph.trim() : typeof symbol === 'string' ? symbol.trim() : '';
  if (!own) throw new Error('Choose a reaction: one of the offered ones, an emoji, or an https picture or GIF.');
  if (/^https:\/\//i.test(own)) {
    if (own.length > LIMITS.picture_address) throw new Error(`A picture's address is at most ${LIMITS.picture_address} characters.`);
    try { new URL(own); } catch { throw new Error('That picture address is not a web address.'); }
    return { symbol: own, glyph: own };
  }
  if (/\s/.test(own) || [...own].length > LIMITS.emoji_characters) throw new Error(`A reaction is one emoji or a short mark of at most ${LIMITS.emoji_characters} characters, with no spaces.`);
  return { symbol: own, glyph: own };
}

/** What a kept reaction draws: its palette glyph, else the glyph kept with it. */
export const glyphOf = (symbol, kept = null) => BY_SYMBOL.get(symbol)?.glyph ?? kept ?? symbol;
/** What a kept reaction says on hover: its palette label, else the picture label for a picture, else its own glyph. */
export const labelOf = (symbol, kept = null) => BY_SYMBOL.get(symbol)?.label ?? (/^https:\/\//i.test(kept ?? symbol) ? reactions.picture_label : kept ?? symbol);

/** The part an answer points at, as kept, or null for the whole thing. */
export function partFrom(part) {
  if (part == null) return null;
  if (!plain(part) || typeof part.kind !== 'string' || !part.kind.trim() || part.kind.length > 60) throw new Error('A part names its kind: { kind, ... }.');
  const written = JSON.stringify(part);
  if (written.length > LIMITS.anchor_bytes) throw new Error(`A part is at most ${LIMITS.anchor_bytes} characters.`);
  return JSON.parse(written);
}

/** Stable JSON text for matching the same part when object keys arrive in a different order. */
export const partKey = part => part == null ? null : canonical(partFrom(part));

/** Kept reaction rows ({ item_id?, symbol, relay, count, glyph }) folded for one reader: the vote as { count, yours },
 *  the rest as one entry per symbol in the order each was first given, with who gave it when `nameOf` is passed. */
export function foldReactions(rows, reader, nameOf = null) {
  const vote = { count: 0, yours: 0 };
  const bySymbol = new Map();
  for (const row of rows) {
    if (row.symbol === VOTE) {
      vote.count += row.count;
      if (row.relay === reader) vote.yours = row.count;
      continue;
    }
    const entry = bySymbol.get(row.symbol) ?? { symbol: row.symbol, glyph: glyphOf(row.symbol, row.glyph), label: labelOf(row.symbol, row.glyph), count: 0, yours: false, ...(nameOf ? { by: [] } : {}) };
    entry.count += 1;
    if (row.relay === reader) entry.yours = true;
    if (nameOf) entry.by.push(row.relay === reader ? 'You' : nameOf(row.relay));
    bySymbol.set(row.symbol, entry);
  }
  return { ...(vote.count || vote.yours ? { votes: vote } : {}), ...(bySymbol.size ? { reactions: [...bySymbol.values()] } : {}) };
}
