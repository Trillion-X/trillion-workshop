// tools/write-a-post-for-each-place/read-data/post-tools.mjs
//
// The row over surface-compose.mjs (moved unchanged): one body of neutral blocks written for one place, from that place's
// capability record. The record is named (a surface row in surface-compose.json), handed in whole, or made from a post
// place's own limits. Nothing is read or written anywhere else.
import rules from './surface-compose.json' with { type: 'json' };
import { capabilityOf, capabilityOfPlace, composeFor } from './surface-compose.mjs';

/** The capability record the input asks for: exactly one of surface, capability or place. */
export function capabilityAsked({ surface, capability, place } = {}) {
  const given = [surface, capability, place].filter(value => value !== undefined).length;
  if (given !== 1) throw new Error('Give exactly one of surface (a surface name), capability (a capability record) or place (a post place).');
  if (surface !== undefined) {
    const named = capabilityOf(surface);
    if (!named) throw new Error(`No surface is named ${surface}. Known surfaces: ${Object.keys(rules.surfaces).join(', ')}.`);
    return named;
  }
  return capability ?? capabilityOfPlace(place);
}

/** tool:write-a-post-for-a-place: { body, degraded, unproven_used, truncated, capability }. */
export function writeBodyForPlace(input) {
  const capability = capabilityAsked(input ?? {});
  return { ...composeFor(input?.blocks ?? [], capability, { marker: input?.marker ?? '' }), capability };
}
