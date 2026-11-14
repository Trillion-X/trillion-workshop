// src/workspace/colour-names.mjs
//
// PURPOSE
//   The names a person gives to the colours their calendars offer (F-0993, Amie's "Color names"): one account record of
//   { <colour>: <name> }, applied wherever an event's colour is picked. Pure; the limits and words are DATA
//   (colour-names.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A colour is named by its own colour value (lower-cased), so the same colour has the same name in every calendar that
//      offers it; a choice with no colour value cannot be named and keeps its label.
//   2. A name is trimmed and cut to `most_name_chars`; an empty name removes the entry (the usual name returns). At most
//      `most_names` names are kept; the oldest entry goes first.
//   3. A record that is not an object of names is no names at all, never an error.
//   4. The colours a person can name are the ones their calendars offer, once each (`coloursOf`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import settings from './colour-names.json' with { type: 'json' };

export const COLOUR_NAMES = settings;

const keyOf = colour => (typeof colour === 'string' && colour.trim() ? colour.trim().toLowerCase() : null);

/** The record as kept: only entries with a colour key and a non-empty name, within the bounds. */
export function readColourNames(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const names = {};
  for (const [colour, name] of Object.entries(value)) {
    const key = keyOf(colour);
    const text = typeof name === 'string' ? name.trim().slice(0, settings.most_name_chars) : '';
    if (key && text) names[key] = text;
  }
  return Object.fromEntries(Object.entries(names).slice(-settings.most_names));
}

/** The record after `colour` is named `name` (an empty name takes the entry away). */
export function renameColour(names, colour, name) {
  const key = keyOf(colour);
  if (!key) return names;
  const { [key]: _gone, ...rest } = names;
  const text = typeof name === 'string' ? name.trim().slice(0, settings.most_name_chars) : '';
  return readColourNames(text ? { ...rest, [key]: text } : rest);
}

/** The choices with the person's names in place of the provider's labels, where they named one. */
export const withColourNames = (choices, names) => choices.map(choice => {
  const named = names[keyOf(choice.color)];
  return named ? { ...choice, label: named } : choice;
});

/** Each distinct colour a calendar read offers (`sources[].event_colors`), in the order offered, with the provider's label. */
export function coloursOf(answer) {
  const seen = new Set();
  const colours = [];
  for (const source of answer?.sources ?? []) {
    for (const choice of source?.event_colors ?? []) {
      const key = keyOf(choice?.color);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      colours.push({ color: key, label: typeof choice.label === 'string' ? choice.label : '' });
    }
  }
  return colours;
}
