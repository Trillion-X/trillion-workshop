// tools/ui/show/button/button-face-css.mjs
//
// The one Button's face as a stylesheet, for a page that draws the shared Button (./Button.tsx) without the Workshop's
// whole part sheet: a sales page, a course page, an article. Three parts, in order:
//   1. the look: only the declarations of the site's look (its look CSS, the same text its sign-in page wears) that the
//      face reads, set on the Button itself, so the site's colours, corner and sheen paint the button and the look never
//      repaints the page around it;
//   2. the blank every Button starts from ([data-button-face], the Button names its face on itself), in the base layer, so
//      a page with no reset still draws no browser border, fill or font on it;
//   3. the face: Tailwind compiles exactly the class words of the Button's own files (bundled from ./index.ts, so every
//      part it draws with is read) against Screen Look's theme and variants, the same theme the Workshop's web build uses.
// Another site gives its own look and gets its own colours: nothing here is one site's.
// usage: const css = await buttonFaceCss({ lookCss })   (lookCss: the site's look CSS, `:root{--button-primary-bg:...}`)
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The class words a script can hold are the words of its string literals (the method of the Workshop's web build).
const classWords = text => new Set((text.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? []).flatMap(literal => literal.slice(1, -1).split(/\s+/)).filter(Boolean));

// The top-level @theme blocks and @custom-variant lines of a sheet: the theme and variants the parts' classes are written
// against, without the sheet's own rules.
function themeOf(sheet) {
  const kept = [];
  for (let at = 0; at < sheet.length;) {
    const next = sheet.slice(at).search(/@theme\b|@custom-variant\b/);
    if (next < 0) break;
    const start = at + next;
    let end = start;
    for (let depth = 0; end < sheet.length; end += 1) {
      const c = sheet[end];
      if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) { end += 1; break; }
      else if (c === ';' && depth === 0) { end += 1; break; }
    }
    kept.push(sheet.slice(start, end));
    at = end;
  }
  return kept.join('\n');
}

// Every `--name: value` of a look, the last one winning, as the browser reads it.
function declarationsOf(lookCss) {
  const found = new Map();
  for (const [, name, value] of lookCss.matchAll(/(--[\w-]+)\s*:\s*([^;}]*)/g)) found.set(name, value.trim());
  return found;
}

const namesRead = text => new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]));

export async function buttonFaceCss({ lookCss }) {
  if (typeof lookCss !== 'string' || !lookCss.trim()) throw new TypeError("Give the site's look CSS: the face takes its colours from it.");
  const bundled = await esbuild.build({ bundle: true, entryPoints: [path.join(here, 'index.ts')], format: 'esm', jsx: 'automatic', logLevel: 'silent', packages: 'external', platform: 'neutral', write: false });
  const words = classWords(bundled.outputFiles[0].text);
  const theme = themeOf(readFileSync(path.join(here, '..', '..', '..', 'screen-look', 'show', 'coss-workspace.css'), 'utf8'));
  const compiled = await compile(`@layer theme, base, components, utilities;\n@import "tailwindcss/theme" layer(theme);\n@tailwind utilities;\n${theme}`, {
    base: path.dirname(require.resolve('tailwindcss/package.json')),
    onDependency: () => {},
  });
  const face = compiled.build([...words]);
  const blank = '@layer base{:where([data-button-face]){box-sizing:border-box;margin:0;padding:0;border:0 solid;background-color:transparent;background-image:none;color:inherit;font:inherit;text-decoration:none;appearance:none}}';
  // The look's declarations the face reads, and the ones those read in turn.
  const look = declarationsOf(lookCss);
  const carried = new Map();
  const pending = [...namesRead(face)];
  while (pending.length) {
    const name = pending.pop();
    if (carried.has(name) || !look.has(name)) continue;
    carried.set(name, look.get(name));
    pending.push(...namesRead(look.get(name)));
  }
  // Set on the Button itself (its words and marks inherit them), never on the page: a page reading a look name of its
  // own (a heading's --font-display) keeps its own value.
  const worn = `:where([data-button-face]){${[...carried].map(([name, value]) => `${name}:${value}`).join(';')}}`;
  return ['@layer theme, base, components, utilities;', worn, blank, face].join('\n');
}
