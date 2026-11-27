// The tool catalogue in README.md, generated from every folder's what-this-tool-does-and-how-to-run-it.json (the rows Trillion reads, test-helpers/tool-rows.mjs).
// One table row per folder that offers tools, listing each tool id it offers. A tool's job, inputs, outputs and sample run
// stay in its row. write-tool-catalogue.mjs splices this table between the two markers in README.md, and
// test/tool-catalogue-is-current.test.mjs fails when the README no longer matches what the rows say.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, rows } from './tool-rows.mjs';

export const readmePath = join(root, 'README.md');
export const START = '<!-- tool-catalogue:start -->';
export const END = '<!-- tool-catalogue:end -->';

// The row kinds that offer a tool a person's AI can run (a folder's other rows are sources, instructions or libraries).
const TOOL_KINDS = new Set(['ai-tool-descriptor', 'workflow-recipe', 'toolkit']);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The catalogue as data: each folder that offers tools, with the sorted ids of the tools it offers. */
export function catalogueEntries() {
  const offered = new Map();
  for (const { folder, payload } of rows()) {
    if (!TOOL_KINDS.has(payload.kind)) continue;
    offered.set(folder, [...(offered.get(folder) ?? []), payload.id]);
  }
  return [...offered].sort(([a], [b]) => byText(a, b)).map(([folder, ids]) => ({ folder, ids: ids.sort(byText) }));
}

/** The markdown block between the markers, generated and never edited by hand. */
export function catalogueBlock() {
  const entries = catalogueEntries();
  const count = entries.reduce((total, { ids }) => total + ids.length, 0);
  const table = entries.map(({ folder, ids }) => `| \`${folder}\` | ${ids.map(id => `\`${id.replaceAll('|', '\\|')}\``).join(', ')} |`);
  return [
    START,
    `Generated from each folder's \`what-this-tool-does-and-how-to-run-it.json\` by \`node test-helpers/write-tool-catalogue.mjs\`; do not edit it by hand. ${count} tools in ${entries.length} folders. A tool's job, inputs, outputs and sample run are in its row. \`test/tool-catalogue-is-current.test.mjs\` fails when this table is stale.`,
    '',
    '| Folder | Tools |',
    '|---|---|',
    ...table,
    END,
  ].join('\n');
}

/** The README text with its block between the markers replaced by `block`; throws when a marker is missing. */
export function spliceCatalogue(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0 || end < start) {
    throw new Error(`README.md must hold exactly one ${START} ... ${END} pair`);
  }
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

export const readReadme = () => readFileSync(readmePath, 'utf8');
export const writeReadme = text => writeFileSync(readmePath, text);
