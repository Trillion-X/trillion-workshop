// parts/screen-look/read-data/look-document-css.js
//
// A LOOK AS THE CSS A DOCUMENT CARRIES ITSELF.
//
// The embedded screen document (src/screen-view.mjs) is loaded by another AI app and must wear the person's look even
// when every later fetch to the service fails. This turns a resolved look (the variable map from
// resolve-screen-look-palette) and the fonts it names into one stylesheet: a :root block of its variables, then a
// @font-face with the face's bytes as a data: address for each family the look's font variables name that
// embedded-faces.json carries. Nothing here names a colour or a font; the look decides.
//
// Invariants
// - A variable is written only when its name is a custom property and its value can end neither the rule nor the
//   <style> element (no braces, semicolons, angle brackets, backslashes, url() or @import); any other is left out.
// - A face is written only for a family the look names, and only the faces embedded-faces.json carries.

import embedded from '../embedded-faces.json' with { type: 'json' };

const SAFE_NAME = /^--[a-z0-9-]+$/;
const UNSAFE_VALUE = /[{};<>\\]|url\(|@import|\/\*/i;

/** The families a look's font variables name first in their stacks ("Recoleta, system-ui, ..." names Recoleta). */
export function familiesNamedBy(palette) {
  const names = new Set();
  for (const [name, value] of Object.entries(palette ?? {})) {
    if (!/^--(font-|default-font)/.test(name) || typeof value !== 'string') continue;
    for (const part of value.split(',')) names.add(part.trim().replace(/^["']|["']$/g, ''));
  }
  return names;
}

/** The look's variables as one :root rule. */
export function lookVariablesCss(palette) {
  const lines = Object.entries(palette ?? {})
    .filter(([name, value]) => SAFE_NAME.test(name) && typeof value === 'string' && value && !UNSAFE_VALUE.test(value))
    .map(([name, value]) => `${name}:${value}`);
  return `:root{${lines.join(';')}}`;
}

/** The @font-face rules for the embedded faces the look names. */
export function lookFontFacesCss(palette, faces = embedded.faces) {
  const named = familiesNamedBy(palette);
  return faces.filter(face => named.has(face.family)).map(face =>
    `@font-face{font-family:'${face.family}';src:url(data:font/woff2;base64,${face.data}) format('woff2');font-weight:${face.weight};font-style:${face.style};font-display:swap}`).join('');
}

/** The stylesheet a document carries for `palette`: the faces, then the variables. */
export function lookDocumentCss(palette, faces) {
  return lookFontFacesCss(palette, faces) + lookVariablesCss(palette);
}
