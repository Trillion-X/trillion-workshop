// tools/serve-a-sites-pages-from-its-rows/do-work/render.ts
//
// PURPOSE
//   Draws one page: its layout tree (pages.ts), each tool node filled with the answer of the tool that owns the job, run through
//   the engine's door as the page's caller, then drawn on the server with renderToStaticMarkup of the tool's own screen (its
//   card's `screen`: {"kind": "module", "entry": "show/<Name>.tsx", "export": "View"}) inside the shared parts the layout places,
//   inside the page's document (show/PageDocument.tsx): title, canonical address, the parts' stylesheet, the site's look rows
//   as CSS variables, the drawn tree as JSON, and one generic mount script that draws the same tree in the browser.
//
//   A page's modules are bundled once (esbuild, in memory): one bundle for the server, one for the browser, both from the same
//   generated entry over render-layout.ts. The browser's script and stylesheet are kept by BLAKE3 identity (screen-files.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A page and an AI app get the same answer and the same screen: the props of a tool's screen are exactly its answer.
//   2. A tool named by a page that has no module screen, or an answer that is not an object, refuses the page; a page is never
//      drawn with a screen left out.
//   3. The browser draws fresh over the server's markup (createRoot), so a part whose look the browser alone computes is drawn
//      with it (a hydrated page kept the server's browserless look on Nov 24 2026).
//   4. The tree's JSON is written so it cannot close its script element; a look row is written only when its value cannot end
//      its declaration. Every other value is escaped by React.
//   5. No markup is written here: the document and every part are shared components.
//   6. Nothing about any one site is in this file.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { filledInput } from './pages.ts';
import type { LayoutNode, PageRow } from './pages.ts';
import { moduleKey } from './render-layout.ts';
import type { DrawnNode } from './render-layout.ts';
import type { PageStyles } from './page-styles.ts';
import { kindOf } from './screen-files.ts';
import type { ScreenFiles } from './screen-files.ts';
import type { ToolRun } from './door.ts';

export interface Screen {
  /** The screen's file under the tools folder. */
  file: string;
  export: string;
}

export interface Timed {
  tool: string;
  ms: number;
}

export interface Shell {
  lang: string;
  title: string;
  canonical: string;
  look: string;
  /** The address a moved page sends the browser on to (pages.ts go_to). */
  goTo?: string;
}

export interface PageBundle {
  /** The whole document for the shell and the tree. */
  html(shell: Shell, tree: DrawnNode): string;
  script: string;
  sheet: string;
}

const HERE = import.meta.dirname;
const LAYOUT = join(HERE, 'render-layout.ts');
const DOCUMENT = join(HERE, '..', 'show', 'PageDocument.tsx');
// The mount's id: `root`, the id the shared page shell gives its mount (ui/show/server-rendered-page), so a site's checks that
// read `#root` read the same element on every page.
export const MOUNT = 'root';

/** Words drawn with the shared Text part, for a page of plain words (not found, refused, not reachable). */
export const TEXT_PART = 'ui/show/text/Text.tsx#Text';

/** Every tool's module screen, read once from the cards of the Workshop folder this program runs from. */
export function screensOfTools(tools: string): Map<string, Screen> {
  const screens = new Map<string, Screen>();
  for (const folder of readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const card = join(tools, folder, 'tool-rows.json');
    if (!existsSync(card)) continue;
    let records: { payload?: { id?: unknown; screen?: { kind?: unknown; entry?: unknown; export?: unknown } } }[];
    try { records = JSON.parse(readFileSync(card, 'utf8')).records ?? []; } catch { continue; }
    for (const { payload } of records) {
      const screen = payload?.screen;
      if (typeof payload?.id !== 'string' || screen?.kind !== 'module' || typeof screen.entry !== 'string') continue;
      if (screen.entry.split('/').includes('..')) continue;
      screens.set(payload.id, { file: `${folder}/${screen.entry}`, export: typeof screen.export === 'string' ? screen.export : 'View' });
    }
  }
  return screens;
}

/** The page's tree: its layout (or its tool's screen alone), with the main node as the page's own tool. */
export function treeOf(page: PageRow, params: Record<string, string>): LayoutNode {
  const main: LayoutNode | null = page.tool ? { tool: page.tool, input: filledInput(page.input, params) } : null;
  if (!page.layout) return main!;
  const swap = (node: LayoutNode): LayoutNode => {
    if ('main' in node) return node.props ? { ...main!, props: node.props } as LayoutNode : main!;
    if ('go_to' in node) return node;
    if ('nodes' in node) return { nodes: node.nodes.map(swap) };
    if ('part' in node && node.children) return { ...node, children: node.children.map(swap) };
    return node;
  };
  return swap(page.layout);
}

const runKey = (tool: string, input: unknown): string => JSON.stringify([tool, input ?? {}]);

/** Every tool run a tree needs, each once, in tree order. */
export function runsOf(tree: LayoutNode): ToolRun[] {
  const runs = new Map<string, ToolRun>();
  const walk = (node: LayoutNode) => {
    if ('tool' in node) runs.set(runKey(node.tool, node.input), { tool: node.tool, input: node.input ?? {} });
    if ('part' in node) for (const child of node.children ?? []) walk(child);
    if ('nodes' in node) node.nodes.forEach(walk);
  };
  walk(tree);
  return [...runs.values()];
}

/** The tree with every tool node drawn by its screen with its answer, ready for render-layout.ts. */
export async function drawnTreeOf(tree: LayoutNode, screens: Map<string, Screen>, run: (call: ToolRun) => Promise<unknown>): Promise<{ drawn: DrawnNode; timed: Timed[]; answerOf: (call: ToolRun) => Record<string, unknown> | undefined }> {
  const runs = runsOf(tree);
  for (const call of runs) if (!screens.has(call.tool)) throw new Error(`${call.tool} has no module screen in its card, so no page can draw it.`);
  const timed: Timed[] = [];
  const answers = new Map(await Promise.all(runs.map(async call => {
    const started = performance.now();
    const answer = await run(call);
    timed.push({ tool: call.tool, ms: Math.round(performance.now() - started) });
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`${call.tool} answered something that is not an object, so its screen has no props.`);
    return [runKey(call.tool, call.input), answer as Record<string, unknown>] as const;
  })));
  const drawn = (node: LayoutNode): DrawnNode => {
    if ('text' in node) return { text: node.text };
    if ('go_to' in node) return { text: node.go_to };
    if ('nodes' in node) return { nodes: node.nodes.map(drawn) };
    if ('tool' in node) {
      const screen = screens.get(node.tool)!;
      return { module: moduleKey(screen.file, screen.export), props: { ...(node.props ?? {}), ...answers.get(runKey(node.tool, node.input)) } };
    }
    if ('main' in node) throw new Error('A main node was left in the tree.');
    return { module: moduleKey(node.part, node.export ?? 'View'), ...(node.props ? { props: node.props } : {}), ...(node.children ? { children: node.children.map(drawn) } : {}) };
  };
  return { drawn: drawn(tree), timed, answerOf: call => answers.get(runKey(call.tool, call.input)) };
}

/** A page of plain words: a heading and a line, each the shared Text part. */
export function wordsTree(heading: string, words: string): DrawnNode {
  return {
    module: TEXT_PART, props: { as: 'section', variant: 'body' }, children: [
      { module: TEXT_PART, props: { variant: 'heading-xl' }, children: [{ text: heading }] },
      { module: TEXT_PART, props: { variant: 'body' }, children: [{ text: words }] },
    ],
  };
}

function entryOf(tools: string, keys: string[], ending: string): string {
  const imports = keys.map((key, i) => {
    const [file, name] = key.split('#');
    return `import { ${name} as m${i} } from ${JSON.stringify(join(tools, file))};`;
  });
  const modules = `const modules = {${keys.map((key, i) => `${JSON.stringify(key)}: m${i}`).join(', ')}};`;
  return [`import { layoutElement } from ${JSON.stringify(LAYOUT)};`, ...imports, modules, ending].join('\n');
}

// The tree's JSON can never close its script element, nor break a line inside it.
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const SERVER_END = `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageDocument } from ${JSON.stringify(DOCUMENT)};
export const html = (shell, tree, files, json) => '<!doctype html>' + renderToStaticMarkup(createElement(PageDocument, { ...shell, ...files, tree: json, mount: ${JSON.stringify(MOUNT)} }, layoutElement(tree, modules)));`;
const BROWSER_END = `import { createRoot } from 'react-dom/client';
const tree = JSON.parse(document.getElementById(${JSON.stringify(`${MOUNT}-tree`)}).textContent);
createRoot(document.getElementById(${JSON.stringify(MOUNT)})).render(layoutElement(tree, modules));`;

// A part's own stylesheet comes with it: plain .css as it is, .module.css with its class names made local to the file. Fonts
// and pictures a stylesheet or a part names are emitted as files, then kept by identity (screen-files.ts).
const LOADERS = {
  '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'css', '.module.css': 'local-css',
  '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.otf': 'file', '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file', '.webp': 'file', '.svg': 'file',
} as const;
// Where the emitted files are named in the bundles' text before each is given its identity address.
const ASSETS = '/screen-files-assets-to-keep/';

type ServerHtml = (shell: Shell, tree: DrawnNode, files: { script: string; sheet: string }, json: string) => string;

/** Bundles are made once per set of modules and kept for the program's life. */
export class PageBundles {
  #tools: string;
  #styles: PageStyles;
  #files: ScreenFiles;
  #made = new Map<string, Promise<PageBundle>>();

  constructor(tools: string, styles: PageStyles, files: ScreenFiles) {
    this.#tools = tools;
    this.#styles = styles;
    this.#files = files;
  }

  bundleFor(keys: string[]): Promise<PageBundle> {
    const id = keys.join('\n');
    let made = this.#made.get(id);
    if (!made) {
      made = this.#make(keys);
      made.catch(() => this.#made.delete(id));
      this.#made.set(id, made);
    }
    return made;
  }

  async #make(keys: string[]): Promise<PageBundle> {
    // Both builds name every local class and emitted file the same way (no identifier minifying), so the server's markup and
    // the browser's draw read the same stylesheet.
    const common = {
      bundle: true, write: false, jsx: 'automatic', logLevel: 'silent', loader: LOADERS, define: { 'process.env.NODE_ENV': '"production"' },
      outdir: join(HERE, 'page-bundle'), entryNames: 'page', assetNames: '[name]-[hash]', publicPath: ASSETS,
    } as const;
    const [server, browser] = await Promise.all([
      build({ ...common, stdin: { contents: entryOf(this.#tools, keys, SERVER_END), resolveDir: HERE, loader: 'ts' }, platform: 'node', format: 'cjs' }),
      build({ ...common, stdin: { contents: entryOf(this.#tools, keys, BROWSER_END), resolveDir: HERE, loader: 'ts' }, platform: 'browser', format: 'esm', minifyWhitespace: true, minifySyntax: true }),
    ]);
    // Each emitted file is kept by its identity, and every name of it in the bundles becomes that address.
    const addresses = new Map<string, string>();
    for (const file of browser.outputFiles) {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (name.startsWith('page.')) continue;
      const kind = kindOf(name);
      if (!kind) throw new Error(`A part names ${name}, which is not a kind of file a page may load.`);
      addresses.set(`${ASSETS}${name}`, this.#files.keep(Buffer.from(file.contents), kind));
    }
    const placed = (text: string) => [...addresses].reduce((done, [from, to]) => done.replaceAll(from, to), text);
    const outputOf = (result: { outputFiles: { path: string; text: string }[] }, ending: string) => result.outputFiles.find(file => file.path.endsWith(`/page.${ending}`))?.text ?? '';
    const loaded: { exports: { html?: ServerHtml } } = { exports: {} };
    new Function('module', 'exports', 'require', placed(outputOf(server, 'js')))(loaded, loaded.exports, createRequire(import.meta.url));
    const draw = loaded.exports.html!;
    const text = placed(outputOf(browser, 'js'));
    const partsCss = placed(outputOf(browser, 'css'));
    const files = { script: this.#files.keep(text, 'js'), sheet: this.#files.keep(`${this.#styles.sheetFor(`${text}\n${partsCss}`)}\n${partsCss}`, 'css') };
    return { html: (shell, tree) => draw(shell, tree, files, safeJson(tree)), ...files };
  }
}

// A name may group with dots (colour.accent); its variable joins with dashes (--colour-accent).
const LOOK_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const LOOK_VALUE = /^[^;{}<>\\\n\r]+$/;

/** The look row that names the site's Screen Look theme; every other row is a CSS variable, except font faces. */
export const THEME_ROW = 'theme';
/** Look rows named `font-face.<anything>` are the site's own font files: "<family>|<weight>|<style>|<file path or https address>". */
export const FONT_FACE = 'font-face.';
const FACE = /^([A-Za-z0-9 _-]{1,60})\|([1-9]00)\|(normal|italic)\|(\/[A-Za-z0-9._~\/-]+|https:\/\/[A-Za-z0-9._~\/:-]+)$/;

export interface FontFace {
  family: string;
  weight: string;
  style: string;
  src: string;
}

/** The font face rows, checked; a row that is not "<family>|<weight>|<style>|<address of a font file>" refuses the set. */
export function fontFacesOf(rows: Record<string, unknown>[]): FontFace[] {
  return rows.filter(row => typeof row.name === 'string' && row.name.startsWith(FONT_FACE)).map(row => {
    const match = typeof row.value === 'string' ? FACE.exec(row.value) : null;
    if (!match || !kindOf(match[4]) || !['woff2', 'woff', 'ttf', 'otf'].includes(kindOf(match[4])!)) {
      throw new Error(`look ${String(row.name)}: a font face is "<family>|<weight 100-900>|<normal or italic>|<path or https address of a .woff2, .woff, .ttf or .otf>".`);
    }
    return { family: match[1], weight: match[2], style: match[3], src: match[4] };
  });
}

const FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

/** @font-face rules for the faces, each font's bytes already kept at `address` (same site, so no cross-origin font rule). */
export function fontFaceCss(faces: (FontFace & { address: string })[]): string {
  return faces.map(face => `@font-face{font-family:'${face.family}';src:url('${face.address}') format('${FORMATS[kindOf(face.src)!]}');font-weight:${face.weight};font-style:${face.style};font-display:swap}`).join('');
}

/** The site's look rows ({name, value}) as CSS variables on :root; a row that could end a declaration refuses the set. */
export function lookCss(rows: Record<string, unknown>[]): string {
  const pairs = rows.filter(row => row.name !== THEME_ROW && !String(row.name).startsWith(FONT_FACE)).map(row => {
    if (typeof row.name !== 'string' || !LOOK_NAME.test(row.name)) throw new Error(`look ${JSON.stringify(row.name)}: a name is lower-case words with dashes, grouped by dots.`);
    if (typeof row.value !== 'string' || !LOOK_VALUE.test(row.value)) throw new Error(`look ${row.name}: a value is one CSS value, with no ; { } < > or backslash.`);
    return `--${row.name.replaceAll('.', '-')}:${row.value};`;
  });
  return pairs.length ? `:root{${pairs.join('')}}` : '';
}
