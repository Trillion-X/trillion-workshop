// tools/workflows/use-case-catalog/do-work/render-public-catalog.mjs
//
// Renders the public marketplace catalog as static files: catalog.json (one page of every public listing), one
// listing/<id>.json per listing, and sitemap.xml (one address per listing). Pure: it reads and writes nothing. The caller
// reads the rows from the person's own stores with a public flag per row and hands them in.
//
//   renderPublicCatalog({ origin, workflows, tools, uses }) → { catalog: { items, total }, listings: { [id]: text }, sitemap }
//   catalog.json holds the listings only; use-case rows reach the sitemap by their marketplace address.
//
// INVARIANTS
//   1. Only rows with public === true leave. A row without that flag is dropped before any field is read.
//   2. Each kind has an allow list of fields. Nothing else is copied, so no private column can reach a file.
//   3. Inputs leave as names and descriptions only: no defaults, values or types beyond what the words say.
//   4. Every output is checked for email addresses, phone numbers (an international +, a bracketed area code or
//      three-three-four groups; a date is not one) and vault connection names (a store name such as
//      sales_store-connection, which always has an underscore); a match refuses the render.
const ALLOW = {
  workflow: ['recipe', 'title', 'job', 'produces', 'kind', 'about', 'inputs', 'steps'],
  tool: ['id', 'title', 'job', 'shelf', 'marketplace', 'kind', 'about', 'inputs', 'steps'],
  use: ['id', 'title', 'job', 'shelf', 'marketplace', 'uses'],
};
const VAULT_NAME = /\b[a-z0-9]+_[a-z0-9_]*-connection\b/;
const SECRET_SHAPES = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|(?<![\w-])\d{3}[-.\s]\d{3}[-.\s]\d{4}(?![\w-])/,
  /\b[a-z0-9]+_[a-z0-9_]*-connection\b/,
];

const pick = (row, fields) => Object.fromEntries(fields.filter(field => row[field] !== undefined && row[field] !== null).map(field => [field, row[field]]));
const publicOnly = rows => (Array.isArray(rows) ? rows : []).filter(row => row?.public === true);
const slugOf = id => String(id).replace(/^(workflow|tool):/, '');
// The words a listing page shows: each input's name and what it says, never its default, enum or value.
// A description that names a vault connection is left out (its input keeps its name): the connection never reaches a page.
const inputsOf = schema => Object.entries(schema?.properties && typeof schema.properties === 'object' ? schema.properties : {})
  .map(([name, property]) => {
    const says = typeof property?.description === 'string' ? property.description : '';
    return { name, says: VAULT_NAME.test(says) ? '' : says };
  });
// Step titles only, from a recipe row's own steps; a step with no title is left out.
const stepsOf = steps => (Array.isArray(steps) ? steps.map(step => step?.title).filter(title => typeof title === 'string' && title) : []);

function shaped(row, kind) {
  const out = pick(row, ALLOW[kind]);
  if (kind !== 'use') {
    out.inputs = inputsOf(row.input_schema);
    out.steps = stepsOf(row.steps);
  }
  return out;
}

export function renderPublicCatalog({ origin, workflows = [], tools = [], uses = [] } = {}) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) throw new Error('origin must be an https address');
  const items = [
    ...publicOnly(workflows).map(row => ({ ...shaped({ ...row, kind: 'workflow' }, 'workflow'), id: row.recipe })),
    ...publicOnly(tools).map(row => shaped({ ...row, kind: 'tool' }, 'tool')),
  ];
  const catalog = { schema: 'public-marketplace-catalog/v1', origin, total: items.length, items };
  const listings = Object.fromEntries(items.map(row => {
    return [row.id, JSON.stringify(row, null, 2) + '\n'];
  }));
  const text = JSON.stringify(catalog, null, 2) + '\n';
  for (const body of [text, ...Object.values(listings)]) {
    for (const shape of SECRET_SHAPES) {
      if (shape.test(body)) throw new Error(`public catalog refused: a value matches ${shape}`);
    }
  }
  const addresses = [
    ...items.map(row => row.kind === 'workflow' ? `${origin}/marketplace/workflow/${slugOf(row.recipe)}` : `${origin}/marketplace/tool/${slugOf(row.id)}`),
    ...publicOnly(uses).map(row => row.marketplace).filter(Boolean),
  ];
  const unique = [...new Set(addresses)].filter(address => address.startsWith(origin + '/'));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${unique.map(address => `  <url><loc>${address.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</loc></url>`).join('\n')}\n</urlset>\n`;
  return { catalog: text, listings, sitemap };
}
