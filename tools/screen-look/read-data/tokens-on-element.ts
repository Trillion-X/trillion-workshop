// parts/screen-look/read-data/tokens-on-element.ts
//
// PURPOSE
//   The look tokens one element wears, so changing "every one like it" changes the token and with it every element that
//   wears it. Pure: the caller answers, for each token, which of the element's properties change when that token changes
//   (in a browser: set the token to another value on the page, read the element, put it back).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which properties count, their order and the word said for each is DATA (tokens-on-element.json); nothing here
//      names a token, a screen or an element kind.
//   2. A token is worn on a property only when changing it changes that property of the element, so every row offered
//      changes the element picked. Among several, the one the element's own classes name wins.
//   3. One row per property, each token at most once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import rules from './tokens-on-element.json';
import type { EditableScreenLookTheme, EditableScreenLookToken } from './read-editable-screen-look-themes';

export type WornToken = { property: string; word: string; token: EditableScreenLookToken };

/** The element's computed properties that count. */
export const propertiesToRead = (): string[] => Object.keys(rules.properties);

/** The CSS variables an element's own classes name (a class with a state prefix such as `hover:` is not its own look). */
export const variablesInClasses = (className: string): Set<string> => new Set(className.split(/\s+/)
  .filter(name => !name.includes(':'))
  .flatMap(name => [...name.matchAll(/var\((--[\w-]+)/g)].map(match => match[1])));

/**
 * The tokens of `theme` the element wears, one row per property. `changes` answers the properties of the element that
 * change when a token changes; `named` the CSS variables the element's own classes name.
 */
export function tokensOnElement(theme: EditableScreenLookTheme, changes: (token: EditableScreenLookToken) => string[], named: Set<string>): WornToken[] {
  const changed = theme.tokens.map(token => ({ token, properties: new Set(changes(token)) }));
  const worn: WornToken[] = [];
  const taken = new Set<string>();
  for (const [property, word] of Object.entries(rules.properties as Record<string, string>)) {
    const wearing = changed.filter(one => one.properties.has(property) && !taken.has(one.token.key)).map(one => one.token);
    const token = wearing.find(one => one.css_variable && named.has(one.css_variable)) ?? wearing[0];
    if (!token) continue;
    taken.add(token.key);
    worn.push({ property, word, token });
  }
  return worn;
}
