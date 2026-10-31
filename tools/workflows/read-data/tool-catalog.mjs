// tools/workflows/read-data/tool-catalog.mjs
//
// The Workshop's tool catalog as one file a site counts and lists from, so nobody walks the repository to find the tools.
// The source stays where it is: each tool folder's tool-rows.json is the contract of the code beside it and changes in the
// same commit. This reads those rows and makes the file in the shape tool:publish-a-list-view-as-a-file writes for a list
// view, `{ schema, source: { view, list, blake3 }, fields, rows: [{ id, values }] }`, with flat values only (the schemas, the
// way a tool is run and where it came from stay in the repository).
//
//   toolCatalog(toolsFolder) -> { fields, rows }
//   catalogDocument(toolsFolder) -> the whole file; its `blake3` is the content identity (tools/content-identity, `1f:` and
//   the BLAKE3 digits) of the canonical fields and rows, so the same rows are the same key.

import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { workshopRows } from './workshop-tool-ids.mjs';

export const CATALOG_FIELDS = [
  { id: 'title', kind: 'text', label: 'Tool' },
  { id: 'job', kind: 'text', label: 'What it gets done' },
  { id: 'description', kind: 'long-text', label: 'How it works' },
  { id: 'status', kind: 'text', label: 'Status' },
  { id: 'maker', kind: 'text', label: 'Maker' },
  { id: 'licence_class', kind: 'text', label: 'Licence class' },
  { id: 'placements', kind: 'tags', label: 'Where it runs' },
  { id: 'listed_on', kind: 'text', label: 'Listed on' },
  { id: 'folder', kind: 'text', label: 'Folder' },
  { id: 'flags', kind: 'tags', label: 'Flags' },
];

// What a tool row says about itself that a person browsing tools can use, as flags.
const FLAGS = [['read_only', 'read-only'], ['keeps_records', 'keeps-records'], ['screen', 'has-a-screen'], ['billing', 'priced']];

function values({ folder, payload }) {
  const made = { title: payload.label, job: payload.job, description: payload.description, status: payload.status, maker: payload.maker, licence_class: payload.licence_class, placements: payload.placements, listed_on: payload.listed_on, folder, flags: FLAGS.filter(([field]) => payload[field]).map(([, flag]) => flag) };
  return Object.fromEntries(Object.entries(made).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)));
}

// One row per tool, by tool id, in id order.
export function toolCatalog(tools) {
  const rows = workshopRows(tools)
    .filter(({ payload }) => payload.kind === 'ai-tool-descriptor')
    .map(row => ({ id: row.payload.id, values: values(row) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { fields: CATALOG_FIELDS, rows };
}

// Keys sorted at every level, no spaces, text as it is: the bytes the list-view publisher hashes.
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value));

export function catalogDocument(tools) {
  const body = toolCatalog(tools);
  const key = makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(body)));
  return { schema: 'list-view-file/v1', source: { view: 'tool-catalog', list: 'tools', blake3: key }, ...body };
}

// The text of published/tools.json.
export const catalogText = tools => `${JSON.stringify(catalogDocument(tools), null, 1)}\n`;
