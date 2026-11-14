// src/screen-capabilities.mjs
//
// Purpose
//   What a connected AI can change on the person's Trillion screen, read from DATA (./screen-capabilities.json): one
//   paragraph of the MCP instructions (screenParagraph) and, for every tool a row names, the row's `when` added to that
//   tool's description (withScreenHints), so the instructions and the tool list teach the same thing from one row.
//
// Non-Negotiable Invariants
//   - A new way to shape the screen is a new DATA row; nothing here names a capability or a tool.
//   - A tool named by several rows gets every row's `when`, in row order.
//
import screen from './screen-capabilities.json' with { type: 'json' };

/** The paragraph every AI reads when it connects: the opening, one sentence per row, then the closing. */
export function screenParagraph(data = screen) {
  const rows = data.capabilities.map(row => `${row.name} (${row.tools.join(', ')}): ${row.what}. Use it ${row.when}. Do it well: ${row.well}.`);
  return [data.opening, ...rows, data.closing].join(' ');
}

/** Each tool with the `when` of every row that names it added to its description. */
export function withScreenHints(tools, data = screen) {
  const hints = new Map();
  for (const row of data.capabilities) for (const name of row.tools) hints.set(name, [...(hints.get(name) ?? []), `On the person's screen (${row.name}), use it ${row.when}.`]);
  return tools.map(tool => (hints.has(tool.name) ? { ...tool, description: `${tool.description} ${hints.get(tool.name).join(' ')}` } : tool));
}

export { screen };
