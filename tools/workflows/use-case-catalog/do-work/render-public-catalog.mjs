// tools/workflows/use-case-catalog/do-work/render-public-catalog.mjs
//
// Renders the public marketplace catalog as two static files: catalog.json (one list of every public listing, with
// the allow-listed fields only) and sitemap.xml (one address per listing). Pure: it reads and writes nothing. The caller
// reads the rows from the person's own stores with a public flag per row and hands them in.
//
//   renderPublicCatalog({ origin, workflows, tools, uses }) → { catalog, sitemap }
//
// INVARIANTS
//   1. Only rows with public === true leave. A row without that flag is dropped before any field is read.
//   2. Each kind has an allow list of fields. Nothing else is copied, so no private column can reach the file.
//   3. The output is checked for email addresses, phone numbers and vault connection names (a store name such as
//      sales_store-connection, which always has an underscore); a match refuses the render.
const ALLOW = {
  workflow: ['recipe', 'title', 'job', 'produces', 'kind'],
  tool: ['id', 'title', 'job', 'shelf', 'marketplace'],
  use: ['id', 'title', 'job', 'shelf', 'marketplace', 'uses'],
};
const SECRET_SHAPES = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?<![\w-])\+?\d[\d\s().-]{8,}\d(?![\w-])/,
  /\b[a-z0-9]+_[a-z0-9_]*-connection\b/,
];

const pick = (row, fields) => Object.fromEntries(fields.filter(field => row[field] !== undefined && row[field] !== null).map(field => [field, row[field]]));
const publicOnly = rows => (Array.isArray(rows) ? rows : []).filter(row => row?.public === true);
const slugOf = recipe => String(recipe).replace(/^workflow:/, '');

export function renderPublicCatalog({ origin, workflows = [], tools = [], uses = [] } = {}) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) throw new Error('origin must be an https address');
  const catalog = {
    schema: 'public-marketplace-catalog/v1',
    origin,
    workflows: publicOnly(workflows).map(row => pick(row, ALLOW.workflow)),
    tools: publicOnly(tools).map(row => pick(row, ALLOW.tool)),
    use_cases: publicOnly(uses).map(row => pick(row, ALLOW.use)),
  };
  const text = JSON.stringify(catalog, null, 2) + '\n';
  for (const shape of SECRET_SHAPES) {
    if (shape.test(text)) throw new Error(`public catalog refused: a value matches ${shape}`);
  }
  const addresses = [
    ...catalog.workflows.map(row => `${origin}/marketplace/workflow/${slugOf(row.recipe)}`),
    ...catalog.tools.map(row => row.marketplace ?? `${origin}/marketplace/tool/${row.id}`),
    ...catalog.use_cases.map(row => row.marketplace).filter(Boolean),
  ];
  const unique = [...new Set(addresses)].filter(address => address.startsWith(origin + '/'));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${unique.map(address => `  <url><loc>${address.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</loc></url>`).join('\n')}\n</urlset>\n`;
  return { catalog: text, sitemap };
}
