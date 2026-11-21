// src/workspace/tool-catalogue-rows.mjs
//
// PURPOSE
//   The screen rows of the account's tool catalogue (tools:list), as the signed-in page offers them. A list row says a
//   tool's id, label and job; the screen a tool declares (its label, icon, folder, parts) is in the tool's own one-tool
//   answer. The page keeps that answer on this computer when the tool is opened, so the next load draws the tool's own
//   screen from the first paint: `keptScreens` is what those kept answers declared, by tool id.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a tool or a screen: every label, icon, folder and part is what the tool's own answer says.
//   2. A list row's own `screen` wins; a kept description fills in only the rows whose list row carries none.

import { toolSurfaces } from '../work-workshop.mjs';

/** The screen a catalogue row declares: its list answer's own, else the one its kept description declared. */
const screenOf = (tool, keptScreens) => {
  if (tool.screen && typeof tool.screen === 'object') return tool.screen;
  const kept = keptScreens.get(tool.id);
  return kept && typeof kept === 'object' ? kept : null;
};

/** One catalogue page (or every page read so far) as the screen rows the sidebar holds. */
export function catalogueRows(tools, keptScreens = new Map()) {
  return toolSurfaces(tools.map(tool => {
    const screen = screenOf(tool, keptScreens);
    return { tool_id: tool.id, label: tool.label, job: tool.job, next_call: true, ...(screen ? { screen } : {}) };
  }));
}
