// A visitor view is data supplied by the capability's source owner, never HTML
// or executable code. The public-app host rechecks its source before returning
// this projection, and the browser renders it with textContent/createElement.
const SCHEMA = 'trillion.public-visitor-view/1';
const APP_ORIGIN = 'https://app.gettrillion.ai';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} needs text.`);
  return value.trim();
};
function publicAppPath(value, label) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label} needs a Trillion link.`);
  const url = new URL(value, APP_ORIGIN);
  const marketplaceRoute = /^\/marketplace\/[^/]+\/?$/.test(decodeURIComponent(url.pathname));
  if (url.origin !== APP_ORIGIN || url.username || url.password || url.search || url.hash ||
      !(marketplaceRoute || ['/marketplace', '/marketplace/', '/runs', '/runs/', '/workshop', '/workshop/'].includes(url.pathname))) {
    throw new Error(`${label} needs a public Marketplace or Runs link.`);
  }
  return url.href;
}

/** Validate the one render contract shared by all visitor-safe source owners. */
export function checkedPublicAppVisitorView(input) {
  if (!object(input) || Object.keys(input).some(key => !['schema', 'source_label', 'title', 'description', 'href', 'sections', 'actions'].includes(key)) || input.schema !== SCHEMA) {
    throw new Error('This visitor view is not supported.');
  }
  if (!Array.isArray(input.sections ?? []) || (input.sections ?? []).length > 12) throw new Error('A visitor view can have up to 12 sections.');
  const sections = (input.sections ?? []).map(section => {
    if (!object(section) || Object.keys(section).some(key => !['heading', 'text', 'items'].includes(key))) throw new Error('A visitor view section is invalid.');
    if (!Array.isArray(section.items ?? []) || (section.items ?? []).length > 20) throw new Error('A visitor view section can have up to 20 items.');
    const items = (section.items ?? []).map(item => {
      if (!object(item) || Object.keys(item).some(key => !['label', 'text', 'href'].includes(key)) || (!item.label && !item.text)) throw new Error('A visitor view item needs a label or text.');
      return { ...(item.label ? { label: text(item.label, 'An item label', 120) } : {}),
        ...(item.text ? { text: text(item.text, 'Item text', 1000) } : {}), ...(item.href ? { href: publicAppPath(item.href, 'An item') } : {}) };
    });
    return { ...(section.heading ? { heading: text(section.heading, 'A section heading', 120) } : {}),
      ...(section.text ? { text: text(section.text, 'Section text', 2000) } : {}), ...(items.length ? { items } : {}) };
  });
  if (!Array.isArray(input.actions ?? []) || (input.actions ?? []).length > 4) throw new Error('A visitor view can have up to four actions.');
  const actions = (input.actions ?? []).map(action => {
    if (!object(action) || Object.keys(action).some(key => !['label', 'href'].includes(key))) throw new Error('A visitor view action is invalid.');
    return { label: text(action.label, 'An action label', 80), href: publicAppPath(action.href, 'An action') };
  });
  const view = { schema: SCHEMA, source_label: text(input.source_label, 'A source label', 80),
    title: text(input.title, 'A title', 120), description: text(input.description, 'A description', 1000),
    href: publicAppPath(input.href, 'A Trillion link'), ...(sections.length ? { sections } : {}), ...(actions.length ? { actions } : {}) };
  if (new TextEncoder().encode(JSON.stringify(view)).byteLength > 32_768) throw new Error('This visitor view is too large.');
  return view;
}

export function publicAppVisitorView({ source_label, title, description, url, sections, actions }) {
  return checkedPublicAppVisitorView({ schema: SCHEMA, source_label, title, description, href: url, sections, actions });
}
