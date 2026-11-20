// src/workspace/screens.mjs
//
// The workspace's screens with its settings, the one thing every module reads them from: the settings (lists, addresses,
// what opens at start) are src/workspace/surfaces.json. The workspace keeps no screen rows of its own: each screen is a row
// its own tool declares in that tool's part.json `offers` (./offered-screens.mjs), whose screen.surface says where it sits
// and how it opens. A screen is added by its tool, and any tool whose screen names `replaces` takes a shipped screen's place
// for the account that has it (src/work-workshop.mjs toolSurfaces). The page carries only the row fields it reads
// (scripts/browser-json-fields.json): a field read here or in tool-screen.tsx that is not listed there is undefined in the page.
import settings from './surfaces.json' with { type: 'json' };
import looks from '../workshop-looks.json' with { type: 'json' };

/** The placeable screen a screen-carrying tool row is: its surface (the page's own placement where the row names none), with its words, icon and the screen it mounts: the
 *  Trillion screen it names (`screen.entry`), or else the one tool screen host (entry `tool-screen`), opened on the
 *  tool itself, which shows the tool's own screen (a screen module's code, src/workspace/tool-screen.tsx). */
export const surfaceOfScreenTool = tool => ({
  // A row that leaves out where its screen is placed takes the page's own placement (workshop-looks.json
  // tool_surface_defaults, as a catalogue tool's screen does), and its surface is named by its tool id.
  id: tool.id,
  surface_id: tool.id,
  kind: 'placeable-surface',
  placement_labels: [...looks.tool_surface_defaults.placement_labels],
  placement_order_key: `tool:${tool.id}`,
  material_target: looks.tool_surface_defaults.material_target,
  wrap_material: false,
  ...tool.screen.surface,
  label: tool.label,
  icon: tool.screen.icon,
  ...(tool.description ? { description: tool.description } : {}),
  // When the screen was first offered: a sidebar list may hold what is new by it (surfaces.json `list_rule_facts`).
  ...(tool.listed_on ? { listed_on: tool.listed_on } : {}),
  ...(typeof tool.screen.new_until === 'string' ? { sidebar_new_until: tool.screen.new_until } : {}),
  package_entry: { package_name: 'trillion', entry_name: tool.screen.entry ?? 'tool-screen' },
  ...(tool.screen.entry ? {} : { surface_input: { ...tool.screen.surface.surface_input, tool_id: tool.id } }),
});

/** What a screen says when it opens, the one event every screen's tour trigger matches: its entry, its screen (the
 *  screen it names, else its entry), the tool it opens on when it is a tool's own screen, so each tool's screen can
 *  have its own tour, and the one thing it opens on (`id`: a pursuit, a list, a job), so a tour written for one thing
 *  starts the first time that thing is opened (a trigger matching `id`, its `once_key` kept once). A screen row whose
 *  guide lives in another tour (a Home card, a preview) names it as `tour`. */
export const screenOpenedEvent = (entry, input = {}) => ({
  event_kind: 'screen-opened',
  entry,
  screen: typeof input?.screen === 'string' ? input.screen : entry,
  ...(typeof input?.tool_id === 'string' ? { tool_id: input.tool_id } : {}),
  ...(typeof input?.id === 'string' && input.id ? { id: input.id } : {}),
});

/** The workspace's own screen rows: none; every screen is offered by the tool it belongs to (./offered-screens.mjs). */
export const SCREEN_TOOL_ROWS = [];

export default { ...settings, surfaces: SCREEN_TOOL_ROWS.map(surfaceOfScreenTool) };
