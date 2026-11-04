// The value at a path of keys in a row, and the first filled one of several paths.
const at = (row, path) => path.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), row);
const firstOf = (row, paths = []) => {
  for (const path of paths) {
    const value = at(row, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};
const inputFrom = (shape, row) => Object.fromEntries(Object.entries(shape ?? {}).flatMap(([key, value]) => {
  if (Array.isArray(value)) {
    const found = firstOf(row, value);
    return found === null ? [] : [[key, found]];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return [[key, inputFrom(value, row)]];
  return [];
}));
const counted = ([one, many], n) => (n === 1 ? one : many).replace('{n}', String(n));
// What something costs as the card's key value and its unit (`$0.01` and `/call`), or nothing when it is free.
const priceParts = price => (price && typeof price === 'object' ? (price.amount ? { value: String(price.amount), ...(price.per ? { unit: `/${price.per}` } : {}) } : null)
  : price === null || price === undefined || price === '' ? null : { value: String(price) });
const priceWords = price => (price && typeof price === 'object' ? (price.amount ? `${price.amount}${price.per ? ` a ${price.per}` : ''}` : null)
  : price === null || price === undefined || price === '' ? null : String(price));

/** One source row of `kind` as a shelf item. `published` holds the ids this account published of that kind. */
export function shelfItem(kind, row, published = new Set()) {
  const id = String(firstOf(row, kind.fields.id) ?? '');
  const maker = firstOf(row, kind.fields.made_by);
  const mine = Boolean(kind.mine) && kind.mine.is_one_of.includes(firstOf(row, kind.mine.field));
  // A kind published separately is published when the shared shelf holds it; a kind whose rows are all on the shelf
  // already can only be withdrawn.
  const isPublished = mine && Boolean(kind.published) && published.has(id);
  const price = priceWords(firstOf(row, kind.fields.price));
  const cost = priceParts(firstOf(row, kind.fields.price));
  const runs = firstOf(row, kind.fields.runs);
  const picture = firstOf(row, kind.fields.picture);
  const preview = kind.preview ? {
    type: kind.preview.type,
    ...Object.fromEntries(Object.entries(kind.preview.fields ?? {}).flatMap(([name, paths]) => {
      const value = firstOf(row, paths);
      return value === null ? [] : [[name, value]];
    })),
  } : null;
  const address = kind.link ? firstOf(row, kind.link.from) : null;
  const { title, service } = titleOf({ title: firstOf(row, kind.fields.title), tool_id: id });
  const can = [
    ...(kind.use ? [kind.use.id] : []),
    ...(!mine ? [] : kind.published ? [isPublished ? 'withdraw' : 'publish'] : ['withdraw']).filter(verb => kind[verb]),
  ];
  return {
    id,
    key: `${kind.id}/${id}`,
    kind: kind.id,
    kind_label: kind.one,
    icon: kind.icon,
    title,
    ...(service ? { service } : {}),
    job: String(firstOf(row, kind.fields.job) ?? ''),
    made_by: maker === null ? null : kind.made_by_words[maker] ?? String(maker),
    price,
    ...(cost ? { value: cost.value, ...(cost.unit ? { unit: cost.unit } : {}), value_label: price } : {}),
    runs: typeof runs === 'number' ? runs : null,
    mine,
    published: isPublished,
    ...(isPublished ? { badge: kinds.badges.published } : mine ? { badge: kinds.badges.mine } : {}),
    facts: [
      ...(typeof runs === 'number' && runs > 0 ? [{ label: kinds.facts.runs.label, icon: kinds.facts.runs.icon, value: counted(kinds.facts.runs.words, runs) }] : []),
      ...kind.facts.flatMap(({ from, ...fact }) => {
        const value = firstOf(row, from);
        const text = Array.isArray(value) ? value.join(', ') : value === null || typeof value === 'object' ? '' : String(value);
        return text ? [{ ...fact, value: text }] : [];
      }),
    ],
    ...(typeof picture === 'string' ? { picture } : {}),
    ...(preview ? { preview } : {}),
    ...(kind.use?.input_from ? { action_input: inputFrom(kind.use.input_from, row) } : {}),
    ...(kind.use?.id ? { use_verb: kind.use.id } : {}),
    ...(webAddress(address) ? { link: { label: kind.link.label, icon: kind.link.icon, url: address } } : {}),
    open_target: kind.open ? { surface: kind.open.surface, title, input: { [kind.open.input]: id } } : null,
    ...(kind.publish?.inputs?.includes('usage_price') ? { publish_terms: { price_label: kind.publish.price_label, site_label: kind.publish.site_label } } : {}),
    can,
  };
}

/** Built-in arrangement templates are real DATA from the same list used by LayoutPicker. */
const starterScreenLabels = Object.fromEntries(workspaceScreens.surfaces.map(surface => [surface.id, { label: surface.label, icon: surface.icon }]));
function marketplaceLayouts(url) {
  const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
  const offset = pageOf(url, 'offset', 0);
  const limit = Math.min(Math.max(pageOf(url, 'limit', kinds.page.default_limit), 1), kinds.page.max_limit);
  const rows = starterLayouts
    .filter(layout => !q || layout.name.toLocaleLowerCase().includes(q))
    .map(layout => ({ ...layout, description: 'A screen arrangement you can add to your Layouts menu.', made_by: 'Trillion', screen_labels: starterScreenLabels }));
  return json({ rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit });
}

// Only a web page is linked; any other kind of address (javascript:, data:, a file) is left off the card.
const webAddress = value => {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

// What a self-paging kind can be narrowed by, from its reply: each field that lists choices, once, with every choice
