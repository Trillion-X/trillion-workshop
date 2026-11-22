// src/workspace/offered-screens.mjs
//
// PURPOSE
//   The workspace's screens as a program reads them (a Mac release's data/tool_screens/surfaces.json): every screen a tool offers in
//   its own part.json `offers`, with the workspace's settings (./screens.mjs, which holds no screen rows of its own). An app that shows
//   screens names none of them: a tool added to the Workshop appears by adding its folder, with no change to the app.
//
//   part.json `offers` is a list of tool rows
//   ({ id, label, description?, listed_on?, screen: { kind, module | entry, icon, surface } }); the sidebar group, order and label
//   are fields of that row (`screen.surface.sidebar_collection`, `order`, `label`). A row with no `screen.surface` is a tool whose
//   screen opens an existing one with its own input (tool:errors opens the activity screen on what failed): a tool, never a
//   sidebar screen, as the workspace read its screen rows before they moved here (rows with no surface were left out).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A tool offers only a screen it wrote itself: its own code (`screen.kind` module), one the page already has (`app-entry`),
//      or a screen it declares as shared parts (`parts`, with its own `spec` of root and elements, drawn by parts-screen.tsx from
//      shared parts only, no code). A row that names any other kind, or a parts row with no spec of its own, is refused: no
//      screen is drawn from a tool's description, input_schema or field kinds.
//   2. An id is offered once: a row repeating a screen's id, or two tools offering the same id, is refused, never shadowed.
//   3. Node reads the Workshop folder this file sits in (tools/*/part.json); the page bundle never imports this file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import screens, { SCREEN_TOOL_ROWS, surfaceOfScreenTool } from './screens.mjs';

const OWN_CODE = new Set(['module', 'app-entry', 'parts']);
/** Whether a parts row carries its own declared spec (a root and its elements), not one to be drawn from its inputs. */
const declaresParts = screen => screen.kind !== 'parts' || (screen.spec && typeof screen.spec === 'object' && typeof screen.spec.root === 'string' && screen.spec.elements && typeof screen.spec.elements === 'object');
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
      if (!row || typeof row.id !== 'string') throw new Error(`tools/${entry.name}/part.json offers a row with no id.`);
      if (!OWN_CODE.has(row.screen.kind) || !declaresParts(row.screen)) throw new Error(`${row.id} (tools/${entry.name}/part.json) offers a ${row.screen.kind} screen${row.screen.kind === 'parts' ? ' with no spec of its own' : ''}; a tool offers its own code (module), an existing screen (app-entry) or a screen it declares in shared parts (parts, with its spec), never one drawn from its description or inputs.`);
      rows.push({ ...row, offeredBy: entry.name });
    }
  }
  return rows;
}

/** The workspace's screens and settings with every offered screen added. */
export function offeredScreens(root = WORKSHOP) {
  const held = new Set(SCREEN_TOOL_ROWS.map(row => row.id));
  const offered = offeredRows(root).filter(row => row.screen?.surface && typeof row.screen.surface === 'object').map(({ offeredBy, ...row }) => {
    if (held.has(row.id)) throw new Error(`${row.id} is offered by tools/${offeredBy}/part.json and is already a screen row.`);
    held.add(row.id);
    return row;
  });
  return { ...screens, surfaces: [...screens.surfaces, ...offered.map(surfaceOfScreenTool)] };
}

export default offeredScreens();
