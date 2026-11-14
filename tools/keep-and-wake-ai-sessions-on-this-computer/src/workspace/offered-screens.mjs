// src/workspace/offered-screens.mjs
//
// PURPOSE
//   The workspace's screens as a program reads them (a Mac release's data/tool_screens/surfaces.json): the screens the Workshop's own
//   rows hold (./screens.mjs) plus every screen a tool offers in its own part.json `offers`. An app that shows screens names none of
//   them: a tool added to the Workshop appears by adding its folder, with no change to the app.
//
//   part.json `offers` is a list of tool rows in the shape records/workshop-screen-tool-records.json already holds
//   ({ id, label, description?, listed_on?, screen: { kind, module | entry, icon, surface } }); the sidebar group, order and label
//   are fields of that row (`screen.surface.sidebar_collection`, `order`, `label`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A tool offers only a screen that is its own code (`screen.kind` module) or one the page already has (`app-entry`). A row
//      that names any other kind is refused: no screen is drawn from a tool's description, input_schema or field kinds.
//   2. An id is offered once: a row repeating a screen's id, or two tools offering the same id, is refused, never shadowed.
//   3. Node reads the Workshop folder this file sits in (tools/*/part.json); the page bundle never imports this file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import screens, { SCREEN_TOOL_ROWS, surfaceOfScreenTool } from './screens.mjs';

const OWN_CODE = new Set(['module', 'app-entry']);
const WORKSHOP = fileURLToPath(new URL('../../../../', import.meta.url));

/** The tool rows every tool folder of the Workshop at `root` offers in its part.json, each with the tool that offers it. */
export function offeredRows(root = WORKSHOP) {
  const tools = join(root, 'tools');
  const rows = [];
  for (const entry of readdirSync(tools, { withFileTypes: true }).filter(one => one.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(tools, entry.name, 'part.json');
    if (!existsSync(file)) continue;
    const offers = JSON.parse(readFileSync(file, 'utf8')).offers;
    if (offers === undefined) continue;
    if (!Array.isArray(offers)) throw new Error(`tools/${entry.name}/part.json offers must be a list of screen rows.`);
    for (const row of offers) {
      if (!row || typeof row.id !== 'string' || !row.screen?.surface || typeof row.screen.surface !== 'object') throw new Error(`tools/${entry.name}/part.json offers a row with no id or screen.surface.`);
      if (!OWN_CODE.has(row.screen.kind)) throw new Error(`${row.id} (tools/${entry.name}/part.json) offers a ${row.screen.kind} screen; a tool offers its own code (module) or an existing screen (app-entry), never one drawn from its description or inputs.`);
      rows.push({ ...row, offeredBy: entry.name });
    }
  }
  return rows;
}

/** The workspace's screens and settings with every offered screen added. */
export function offeredScreens(root = WORKSHOP) {
  const held = new Set(SCREEN_TOOL_ROWS.map(row => row.id));
  const offered = offeredRows(root).map(({ offeredBy, ...row }) => {
    if (held.has(row.id)) throw new Error(`${row.id} is offered by tools/${offeredBy}/part.json and is already a screen row.`);
    held.add(row.id);
    return row;
  });
  return { ...screens, surfaces: [...screens.surfaces, ...offered.map(surfaceOfScreenTool)] };
}

export default offeredScreens();
