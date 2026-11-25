// tools/serve-a-sites-pages-from-its-rows/do-work/rows-need-parts.ts
//
// PURPOSE
//   Before a site's program moves to another Workshop commit (a pin or PAGES_COMMIT move), or before its rows name a new part,
//   lists every part and export the site's page rows name that that commit's tools folder lacks. A page draws such a node as
//   nothing (render.ts invariant 2), so a page can lose a section without failing; this check is how a move finds that out
//   before anyone sees it.
//
//   The rows name modules three ways: a layout node's { part, export } (export "View" when absent), a tool node's own
//   { part, export } or else its tool's module screen (its card's `screen`), and a page row's own tool's screen. The site also
//   draws its own parts (words pages and a failed form's outcome), which are checked too.
//
//   Run as `node do-work/rows-need-parts.ts PAGES_FILE [TOOLS_FOLDER]`: PAGES_FILE is the page rows as run-sql answers them (the
//   statement of pages.ts PAGES_SQL); TOOLS_FOLDER is the tools folder of the commit to check (a `git archive` export of it),
//   this program's own when absent. It prints { tools, named, missing: [{ key, why, pages }], rows_set_aside } and exits 1 when
//   anything is missing, 0 when nothing is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A module is checked the way a page bundle reads it (render.ts partExportsOf, esbuild), never by searching the text.
//   2. Read only: no file is written outside esbuild's in-memory output.
//   3. Nothing about any one site is in this file.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagesOf } from './pages.ts';
import type { LayoutNode, PageRow } from './pages.ts';
import { BUTTON_PART, CARD_PART, CONTAINER_PART, FORM_OUTCOME_PART, missingPartsOf, partExportsOf, screensOfTools, TEXT_PART } from './render.ts';
import type { Screen } from './render.ts';
import { moduleKey } from './render-layout.ts';

/** The parts the site itself draws, whatever its rows say. */
export const SITE_PARTS = [TEXT_PART, BUTTON_PART, CARD_PART, CONTAINER_PART, FORM_OUTCOME_PART];

export interface NeededParts {
  tools: string;
  named: number;
  missing: { key: string; why: string; pages: string[] }[];
  rows_set_aside: { path: string; why: string }[];
}

/** Each module key a page names, with the pages naming it; a tool with no module screen is given as `tool:<id>` with no file. */
export function namedModulesOf(pages: PageRow[], screens: Map<string, Screen>): { keys: Map<string, Set<string>>; unscreened: Map<string, Set<string>> } {
  const keys = new Map<string, Set<string>>();
  const unscreened = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, key: string, page: string) => (into.get(key) ?? into.set(key, new Set()).get(key)!).add(page);
  const tool = (id: string, page: string) => {
    const screen = screens.get(id);
    if (screen) add(keys, moduleKey(screen.file, screen.export), page);
    else add(unscreened, id, page);
  };
  for (const page of pages) {
    const where = page.host ? `${page.host}${page.path}` : page.path;
    if (page.tool) tool(page.tool, where);
    const walk = (node: LayoutNode): void => {
      if ('nodes' in node) return node.nodes.forEach(walk);
      if ('tool' in node) {
        if (node.part !== undefined) add(keys, moduleKey(node.part, node.export ?? 'View'), where);
        else tool(node.tool, where);
        return;
      }
      if ('part' in node) {
        add(keys, moduleKey(node.part, node.export ?? 'View'), where);
        (node.children ?? []).forEach(walk);
      }
    };
    if (page.layout) walk(page.layout);
  }
  for (const key of SITE_PARTS) add(keys, key, '(the site tool\'s own words pages)');
  return { keys, unscreened };
}

/** What the page rows need from a tools folder that it lacks. */
export async function rowsNeedParts(rows: Record<string, unknown>[], tools: string): Promise<NeededParts> {
  const { pages, refused } = pagesOf(rows);
  const { keys, unscreened } = namedModulesOf(pages, screensOfTools(tools));
  const read = new Map<string, ReturnType<typeof partExportsOf>>();
  const missing = await missingPartsOf([...keys.keys()].sort(), file => {
    let made = read.get(file);
    if (!made) read.set(file, made = partExportsOf(tools, file));
    return made;
  });
  return {
    tools,
    named: keys.size + unscreened.size,
    missing: [
      ...[...unscreened].sort().map(([id, at]) => ({ key: id, why: `${id} has no module screen in these tools`, pages: [...at].sort() })),
      ...missing.map(({ key, why }) => ({ key, why, pages: [...keys.get(key)!].sort() })),
    ],
    rows_set_aside: refused,
  };
}

const started = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (started) {
  const [pagesFile, toolsFolder] = process.argv.slice(2);
  if (!pagesFile) {
    console.error('usage: node do-work/rows-need-parts.ts PAGES_FILE [TOOLS_FOLDER]');
    process.exit(2);
  }
  const answer = JSON.parse(readFileSync(pagesFile, 'utf8'));
  const rows = Array.isArray(answer) ? answer : (answer.rows ?? answer.result?.rows);
  const needed = await rowsNeedParts(rows, toolsFolder ?? join(import.meta.dirname, '..', '..'));
  console.log(JSON.stringify(needed, null, 2));
  process.exit(needed.missing.length ? 1 : 0);
}
