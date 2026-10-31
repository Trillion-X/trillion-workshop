// tools/screen-looks/read-data/look-document-css.js
//
// A LOOK AS THE CSS A DOCUMENT CARRIES ITSELF.
//
// A page, an email or a slide made from a look must wear it even when nothing else can be fetched. This turns a
// resolved look (the variable map from resolve-screen-look-palette) and the font faces the person supplies into one
// stylesheet: a :root block of its variables, then a @font-face with the face's bytes as a data: address for each
// family the look's font variables name. Nothing here names a colour or a font; the look and the faces decide.
//
// Invariants
// - A variable is written only when its name is a custom property and its value can end neither the rule nor the
//   <style> element (no braces, semicolons, angle brackets, backslashes, url() or @import); any other is left out.
// - A face is written only for a family the look names, and only the faces the caller passes in: font files are the
//   person's own, with their own licences, so none ships here.

const SAFE_NAME = /^--[a-z0-9-]+$/;
const UNSAFE_VALUE = /[{};<>\\]|url\(|@import|\/\*/i;
const SAFE_FAMILY = /^[A-Za-z0-9 _-]+$/;
const SAFE_DATA = /^[A-Za-z0-9+/=]+$/;

/** The families a look's font variables name first in their stacks ("Serif Display, system-ui, ..." names Serif Display). */
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

/** The @font-face rules for the faces (`{ family, weight, style, format, data }`, data as base64) the look names. */
export function lookFontFacesCss(palette, faces = []) {
  const named = familiesNamedBy(palette);
  return faces
    .filter(face => named.has(face.family) && SAFE_FAMILY.test(face.family) && SAFE_DATA.test(face.data ?? ''))
    .map(face => {
      const format = face.format === 'truetype' || face.format === 'opentype' || face.format === 'woff' ? face.format : 'woff2';
      const mime = { woff2: 'font/woff2', woff: 'font/woff', truetype: 'font/ttf', opentype: 'font/otf' }[format];
      const weight = Number.isFinite(Number(face.weight)) ? Number(face.weight) : 400;
      const style = face.style === 'italic' ? 'italic' : 'normal';
      return `@font-face{font-family:'${face.family}';src:url(data:${mime};base64,${face.data}) format('${format}');font-weight:${weight};font-style:${style};font-display:block}`;
    })
    .join('');
}

/** The stylesheet a document carries for `palette`: the faces, then the variables. */
export function lookDocumentCss(palette, faces = []) {
  return lookFontFacesCss(palette, faces) + lookVariablesCss(palette);
}
