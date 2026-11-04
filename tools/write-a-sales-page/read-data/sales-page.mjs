// parts/public-sales-page/read-data/sales-page.mjs
//
// PURPOSE
//   One sales or landing page as ONE row of DATA, turned into a whole HTML document by the shared page writer
//   (parts/ui/show/server-rendered-page/page-sections-html.mjs) in the sales look (parts/screen-look/show/
//   sales-page.css). This is the port of bitfield-packages public-sales-page and adaptive-program-landing: their
//   sections (a hero, the story, the steps of the method, the offers and prices with a buy button, proof from real
//   people, a closing call to act, the fine print) are all the writer's one section shape with an emphasis word, so a
//   new kind of page is different DATA, never new code.
//
//   Row: { title, description?, language?, brand?, palette?: { ground, text, accent }, share?, sections: [
//          { emphasis?, heading?, body?, image?: { src, alt }, items?: [{ heading?, body?, meta?, details? }],
//            cards?: [{ heading, body?, details?, href?, tone?, image? }], actions?: [{ label, href?, tone? }] } ] }
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file writes no tags: the page writer is the one owner of the HTML, and escapes every word.
//   2. Nothing about what a page sells is written here; a page is only as true as the row it is given.
//   3. Every problem with a row is reported at once, in words the caller can fix, before anything is written.
//   4. A colour from DATA is used only when it is a plain colour value, so a row can never inject a rule.
import { pageShellHtml } from '../../ui/show/server-rendered-page/page-sections-html.mjs';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/]+\)|[a-z]+)$/i;
const WORD = /^[a-z][a-z0-9-]*$/;

/** Every problem with a page row, as sentences; an empty list means it can be written. */
export function pageProblems(row) {
  const problems = [];
  if (!object(row)) return ['The page must be an object with a title and sections.'];
  if (!text(row.title)) problems.push('title is required: what the browser tab and a shared link show.');
  if (!Array.isArray(row.sections) || !row.sections.length) problems.push('sections must list the page\'s sections, top to bottom.');
  for (const [at, section] of (Array.isArray(row.sections) ? row.sections : []).entries()) {
    if (!object(section)) { problems.push(`sections[${at}] must be an object.`); continue; }
    if (section.emphasis !== undefined && !(typeof section.emphasis === 'string' && WORD.test(section.emphasis))) problems.push(`sections[${at}].emphasis must be one plain word, like hero, story, steps, offer, proof, cta or fine.`);
    if (!['heading', 'body', 'image', 'items', 'cards', 'actions'].some(key => section[key] !== undefined)) problems.push(`sections[${at}] says nothing: give it a heading, body, items, cards, actions or an image.`);
    for (const [index, card] of (Array.isArray(section.cards) ? section.cards : []).entries()) if (!text(card?.heading)) problems.push(`sections[${at}].cards[${index}].heading is required (for an offer, its plan name).`);
    for (const [index, action] of (Array.isArray(section.actions) ? section.actions : []).entries()) if (!text(action?.label)) problems.push(`sections[${at}].actions[${index}].label is required.`);
  }
  for (const [name, value] of Object.entries(object(row.palette) ? row.palette : {})) if (!(typeof value === 'string' && COLOUR.test(value.trim()))) problems.push(`palette.${name} must be a colour, like #111111.`);
  return problems;
}

/** The whole HTML document for one page row, with the sales look (`look`, the stylesheet's text) and its palette. */
export function salesPageHtml(row, look) {
  const problems = pageProblems(row);
  if (problems.length) throw new Error(`The page was not written: ${problems.join(' ')}`);
  const palette = object(row.palette) ? row.palette : {};
  // A sales page is the business's own page, drawn in the business's own three colours and wearing no Trillion look, so
  // the other roles the page writer reads are made from those three (a role is the text colour thinned over the ground).
  const own = [['--page-bg', palette.ground], ['--page-ink', palette.text], ['--page-accent', palette.accent], ['--page-accent-deep', palette.accent]]
    .filter(([, value]) => typeof value === 'string').map(([name, value]) => [name, value.trim()]);
  const thin = percent => `color-mix(in srgb,var(--page-ink) ${percent}%,var(--page-bg))`;
  const derived = [['--page-card', 'var(--page-bg)'], ['--page-soft', thin(72)], ['--page-faint', thin(50)], ['--page-line', thin(14)],
    ['--page-line-strong', thin(24)], ['--page-tint', thin(5)], ['--page-accent-text', 'var(--page-bg)'], ['--page-focus', 'var(--page-ink)'],
    ['--page-good', 'var(--page-accent)'], ['--page-bad', 'var(--page-accent)'], ['--page-warn', 'var(--page-accent)']];
  const vars = [...own, ...(own.length ? derived : [])].map(([name, value]) => `${name}:${value}`).join(';');
  // The first section is the page's own title (its one first-level heading).
  const sections = row.sections.map((section, index) => (index === 0 ? { ...section, heading_level: 1 } : section));
  return pageShellHtml({
    title: text(row.brand) && !row.title.includes(row.brand) ? `${row.title} · ${row.brand}` : row.title,
    meta_description: text(row.description) ?? '',
    language: text(row.language) ?? 'en',
    theme: 'page',
    ...(object(row.share) ? { share: row.share } : {}),
    sections,
    // The writer's own section and card rules come after this one, so the palette is set on html:root to win.
    island: { mount_element_id: 'page', inline_css: `html,body{margin:0;padding:0}${vars ? `html:root{${vars}}` : ''}\n${look}` },
  });
}
