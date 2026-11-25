// tools/serve-a-sites-pages-from-its-rows/do-work/page-styles.ts
//
// PURPOSE
//   The stylesheet a page's shared parts draw with: the recipe the Workshop's own web build uses
//   (tools/workspace-screens/web/scripts/build-workspace.mjs), here for one page's bundle: Screen Look's Tailwind source compiled
//   for exactly the class names the bundle holds, then the parts' own looks in the web build's order
//   (workspace-screens/web/scripts/workspace-looks.json), then the light theme's tokens those read, after the starting palette.
//   The site's own look (its colours, fonts and logo) is not here: render.ts writes it from the site's look rows as CSS variables
//   after this sheet, so a site's rows win over the palette.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every file is read from the Workshop folder this program runs from; nothing is copied.
//   2. A file a look names by a relative address (its fonts) is kept by identity (screen-files.ts) and the look names that
//      address instead, so the stylesheet's own address never decides where its fonts are; a file outside the tools folder,
//      or of a kind not kept, stops the start.
//   3. A class name is a word of a string literal of the bundle: a regular expression's source is not a class (a utility made
//      from one breaks the parse of every rule after it).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { lightThemeCss } from '../../check-bundle-package-boundaries/scripts/light-theme.mjs';
import { workspaceUtilitySource } from '../../screen-look/do-work/workspace-utility-source.mjs';
import { kindOf } from './screen-files.ts';
import type { ScreenFiles } from './screen-files.ts';

interface Compiled { build(candidates: string[]): string }

export interface PageStyles {
  /** The stylesheet for a bundle whose text is `script`. */
  sheetFor(script: string): string;
}

const RELATIVE_URL = /url\(\s*(['"]?)(?!data:|https?:|\/|#)([^'")]+)\1\s*\)/g;

/** Reads the shared looks once and answers a maker of each bundle's stylesheet. `tools` is the Workshop's tools folder. */
export async function pageStyles(tools: string, files: ScreenFiles): Promise<PageStyles> {
  const workshop = join(tools, '..');
  const look = (file: string) => {
    const path = join(tools, 'screen-look', 'show', file);
    return readFileSync(path, 'utf8').replace(RELATIVE_URL, (_all, _quote, address: string) => {
      const named = join(dirname(path), address.replace(/[?#].*$/, ''));
      const kind = kindOf(named);
      if (relative(tools, named).startsWith('..') || !kind) throw new Error(`${file} names ${address}, which is not a font or picture file in the tools folder.`);
      return `url('${files.keep(readFileSync(named), kind)}')`;
    });
  };
  const looks = (JSON.parse(readFileSync(join(tools, 'workspace-screens', 'web', 'scripts', 'workspace-looks.json'), 'utf8')) as string[]).map(look);
  const tailwind = await import(pathToFileURL(join(workshop, 'node_modules', '@tailwindcss', 'node', 'dist', 'index.mjs')).href) as { compile(source: string, options: object): Promise<Compiled> };
  // The colours and sizes the parts read (--glass-bg-primary, --text-primary, ...): the palette the Workshop's pages start with.
  // page-look.mjs names Workshop files by package path and reads TypeScript, so it is bundled first, in memory.
  const bundled = await build({
    alias: { 'trillion-workshop': workshop }, bundle: true, entryPoints: [join(tools, 'workspace-screens', 'web', 'src', 'page-look.mjs')],
    format: 'cjs', logLevel: 'silent', platform: 'node', write: false,
  });
  const loaded: { exports: { wornLook?: (worn: null) => { palette: Record<string, string> } } } = { exports: {} };
  new Function('module', 'exports', bundled.outputFiles[0].text)(loaded, loaded.exports);
  const palette = `:root{${Object.entries(loaded.exports.wornLook!(null).palette).map(([name, value]) => `${name}:${value};`).join('')}}`;
  const source: string = workspaceUtilitySource(look('coss-workspace.css'));
  const compiled = await tailwind.compile(source, { base: join(workshop, 'node_modules', 'tailwindcss'), onDependency: () => {} });
  return {
    sheetFor(script: string): string {
      const literals = script.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
      const candidates = new Set(literals.flatMap(literal => literal.slice(1, -1).split(/\s+/)).filter(Boolean));
      const utilities = compiled.build([...candidates]);
      return [palette, utilities, ...looks, lightThemeCss(tools, [source, utilities, ...looks, script])].join('\n');
    },
  };
}
