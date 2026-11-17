// scripts/light-theme.mjs
//
// Purpose: the light theme's tokens as a stylesheet serves them, read once from their one source
// (tools/ui/show/twenty/theme-light.css). The tokens hold for the whole page and for anything marked light, so the
// theme's first rule is given both selectors and the file goes into a stylesheet once (it went in twice, once as
// `.light` and once as `:root`, 65 KB each, which put the workspace stylesheet over its budget).
//
// The theme is Twenty's whole generated set, about a thousand tokens; a page reads a few dozen. Given the text that
// can read them (the sources and the other looks of the stylesheet), it keeps the tokens that text names, and the
// tokens those name in turn, so the page pays only for what it can use.
//
// Non-negotiable invariants:
// - Only the first `.light {` rule (the tokens) is widened to `:root, .light`; the rules after it (squircle corners
//   under @supports, component rules) keep their own selectors, exactly as the doubled copy served them.
// - Every stylesheet that carries the light theme reads it here, so the page, the file view and the extension agree on
//   every token they carry.
// - A token is left out only when no text given names it, nor any kept token's value, nor the theme's own later rules.
//   No source builds a token's name from parts (`--t-${...}`); one that did would have to be named whole somewhere.
//   Given no readers, every token is kept.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /--t-[A-Za-z0-9_-]+/g;

/** The tokens of the theme's first rule, each `--t-name: value` as written; a value's parentheses may hold a `;` (the
 *  noise picture's data address), so a declaration ends only at a `;` outside them. */
function tokensOf(body) {
  const tokens = [];
  let depth = 0, start = 0;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ';' && depth === 0) {
      const text = body.slice(start, at + 1);
      const name = text.trim().match(/^--t-[A-Za-z0-9_-]+/)?.[0];
      if (!name) throw new Error(`theme-light.css: a declaration of its tokens is not a --t- token: ${text.trim().slice(0, 80)}`);
      tokens.push({ name, text });
      start = at + 1;
    }
  }
  if (body.slice(start).trim()) throw new Error('theme-light.css: its tokens rule ends inside a declaration');
  return tokens;
}

/** The light theme for a stylesheet, given the parts root and, optionally, every text that can read its tokens. */
export function lightThemeCss(parts, readers = null) {
  const theme = readFileSync(join(parts, 'ui/show/twenty/theme-light.css'), 'utf8');
  const open = theme.indexOf('.light {');
  const bodyStart = open + '.light {'.length;
  const close = theme.indexOf('\n}', bodyStart);
  if (open < 0 || close < 0) throw new Error('theme-light.css: its first rule is no longer `.light { ... }`');
  const tokens = tokensOf(theme.slice(bodyStart, close));
  const rest = theme.slice(0, open) + theme.slice(close + 2);
  const wanted = new Set();
  const name = text => { for (const [token] of text.matchAll(NAME)) wanted.add(token); };
  if (readers) { name(rest); for (const text of readers) name(text); }
  else for (const token of tokens) wanted.add(token.name);
  // A kept token's value may name others (a radius from a spacing): follow until nothing new is named.
  for (let before = -1; before !== wanted.size;) {
    before = wanted.size;
    for (const token of tokens) if (wanted.has(token.name)) name(token.text);
  }
  const kept = tokens.filter(token => wanted.has(token.name)).map(token => token.text).join('');
  return `${theme.slice(0, open)}:root, .light {${kept}\n}${theme.slice(close + 2)}`;
}
