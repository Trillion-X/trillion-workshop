// A list's public_page descriptor binds semantic roles to its own fields. This
// module returns shared page sections; it owns no markup, product names or facts.
const words = value => typeof value === 'string' ? value.trim() : '';
const firstSentence = value => words(value).replace(/^[-•]\s*/gm, '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)[0] ?? '';
const tableCell = value => words(value).replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const lines = value => words(value).split(/\n+/).map(line => line.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean);
const fieldValue = (page, row, role) => words(row?.values?.[page.fields[role]]);

// A comparison may keep its source material as rows in the same native list.
// The descriptor names fields and row kinds; neither products nor claim types
// are baked into the shared page renderer. Older lists still render as before.
export function comparisonRows(page, rows) {
  const source = page?.evidence_rows;
  return source ? rows.filter(row => words(row.values?.[source.kind_field]) === source.comparison_kind) : rows;
}

function evidenceValue(page, row, rows, role) {
  const source = page?.evidence_rows;
  if (!source) return fieldValue(page, row, role);
  const claims = rows.filter(item => words(item.values?.[source.kind_field]) === source.claim_kind
    && words(item.values?.[source.owner_field]) === row.id);
  if (role === 'sources' && source.source_ref_field && source.source_url_field) {
    const sources = new Map(rows.filter(item => words(item.values?.[source.kind_field]) === source.source_kind).map(item => [item.id, item]));
    const urls = [...new Set(claims.map(claim => sources.get(words(claim.values?.[source.source_ref_field])))
      .map(item => words(item?.values?.[source.source_url_field])).filter(Boolean))];
    if (urls.length) return urls.join('\n');
  }
  const matches = claims.filter(item => words(item.values?.[source.role_field]) === role);
  if (!matches.length) return fieldValue(page, row, role);
  return matches.map(item => words(item.values?.[source.text_field])).filter(Boolean).join(role === 'sources' ? '\n' : '\n- ');
}

function sourceActions(value) {
  return [...new Set(words(value).split(/\s+/).filter(Boolean))].flatMap((href, index) => {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:') return [];
      const host = url.hostname.replace(/^(www|ecom)\./, '').split('.')[0];
      const topic = url.pathname.split('/').filter(Boolean).slice(-2, -1)[0] ?? url.pathname.split('/').filter(Boolean).at(-1) ?? 'source';
      const label = `${host.charAt(0).toUpperCase()}${host.slice(1)} · ${topic.replace(/[-_]+/g, ' ')}`;
      return [{ label: label.length > 56 ? `Source ${index + 1}` : label, href: url.href, tone: 'quiet', new_tab: true }];
    } catch { return []; }
  });
}

function categoryGroups(page, rows) {
  const categories = new Map();
  for (const row of rows) {
    const category = fieldValue(page, row, 'category') || 'More comparisons';
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(row);
  }
  return [...categories].sort(([a], [b]) => a.localeCompare(b));
}

function categorySections({ page, rows, rowPath }) {
  return categoryGroups(page, rows).map(([category, group]) => ({
      emphasis: 'comparison-directory', heading: category,
      items: group.map(row => ({ heading: row.title ?? row.address, body: firstSentence(fieldValue(page, row, 'summary')),
        actions: [{ label: 'Read comparison', href: rowPath(row), tone: 'quiet' }] })),
    }));
}

export function comparisonIndexSections({ page, copy, rows, rowPath }) {
  rows = comparisonRows(page, rows);
  return [
    { emphasis: 'comparison-hero', heading: copy.title, heading_level: 1, body: copy.body?.about || 'Explore each choice with its sources and tradeoffs.' },
    ...categorySections({ page, rows, rowPath }),
  ];
}

export function comparisonRowSections({ page, copy, row, rows, listPath, rowPath }) {
  const allRows = rows;
  const value = role => evidenceValue(page, row, allRows, role);
  rows = comparisonRows(page, rows);
  const own = page.own_label;
  const product = value('product');
  const summary = value('summary');
  const ours = value('ours');
  const theirs = value('theirs');
  const better = lines(value('better'));
  const related = rows.filter(other => other.id !== row.id && value('category') && fieldValue(page, other, 'category') === value('category')).slice(0, 6);
  const setId = value('replacement_set');
  const install = /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-f0-9]{24}$/.test(setId)
    ? [{ label: `Install the ${value('category') || 'replacement'} set`, href: `/marketplace/${encodeURIComponent(setId)}`, post: { context: 'private' }, tone: 'primary', pending: 'Installing', done: 'Installed' }]
    : [];
  const matrix = [
    `|  | ${tableCell(own)} | ${tableCell(product)} |`,
    '| :-- | :-- | :-- |',
    `| What it does | ${tableCell(firstSentence(ours))} | ${tableCell(firstSentence(theirs))} |`,
    ...(value('price') ? [`| Published plan price | ${value('our_price') ? tableCell(value('our_price')) : '[See current plans](https://gettrillion.ai/pricing)'} | ${tableCell(value('price'))} |`] : []),
  ].join('\n');
  const sources = sourceActions(value('sources'));
  const reviewed = value('checked');
  const faq = value('faq');
  return [
    { emphasis: 'comparison-hero', heading: row.title ?? product, heading_level: 1, body: summary,
      ...(page.hero_image?.src ? { image: page.hero_image } : {}), actions: install },
    { emphasis: 'comparison-matrix', heading: 'See the difference', body: 'Scroll the table sideways to see both products.', markdown: matrix },
    { emphasis: 'comparison-products', heading: 'What each does', items: [{ heading: own, body: ours }, { heading: product, body: theirs }] },
    ...(better.length ? [{ emphasis: 'comparison-credit', heading: `Where ${product} is stronger`, items: better.map(line => ({ body: line })) }] : []),
    ...(value('pick_ours') || value('pick_theirs') ? [{ emphasis: 'comparison-pick', heading: 'Which fits your work?', items: [
      ...(value('pick_ours') ? [{ heading: `Pick ${own} if`, body: value('pick_ours') }] : []),
      ...(value('pick_theirs') ? [{ heading: `Pick ${product} if`, body: value('pick_theirs') }] : []),
    ] }] : []),
    ...(value('switching') ? [{ emphasis: 'comparison-switch', heading: 'If you switch', body: value('switching'), actions: install }] : []),
    ...(faq ? [{ emphasis: 'comparison-faq', heading: 'Questions people ask', markdown: faq }] : []),
    ...(related.length ? [{ emphasis: 'comparison-related', heading: 'Keep comparing', items: related.map(other => ({ heading: other.title, body: firstSentence(fieldValue(page, other, 'summary')),
      actions: [{ label: 'Read comparison', href: rowPath(other), tone: 'quiet' }] })) }] : []),
    { emphasis: 'comparison-sources', heading: 'How this was checked', body: reviewed ? `Reviewed ${reviewed}. Prices and capabilities can change; check the source before choosing.` : 'Prices and capabilities can change; check the source before choosing.',
      actions: [...sources, ...(value('product_url') ? sourceActions(value('product_url')) : []), { label: 'All comparisons', href: listPath, tone: 'quiet' }] },
    { emphasis: 'comparison-directory-compact', heading: 'Compare more by category',
      items: categoryGroups(page, rows).map(([category, group]) => ({ heading: category,
        actions: group.map(other => ({ label: other.title ?? other.address, href: rowPath(other), tone: 'quiet' })) })) },
  ];
}
