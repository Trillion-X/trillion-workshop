// src/surface-compose.mjs
//
// ONE BODY, WRITTEN FOR WHAT THE PLACE CAN SHOW: THE COMPOSER READS A CAPABILITY RECORD, NEVER THE PLACE'S NAME.
//
// Purpose: a body (a change summary, a status, a picture with words) is posted to several kinds of place: a pull request thread
// on one forge, a merge request note on another, a chat, a post. Each shows different things. The body is written once as
// neutral blocks and this writes it for one place from that place's capability record (src/surface-compose.json), degrading
// what the place cannot show and saying what it degraded and which capabilities it relied on that nobody has confirmed.
//
// Non-negotiable invariants:
//   1. Every branch is on a capability field (html, collapsibles, checkboxes, dialect, max_chars, theme.strategy), never on a
//      surface id.
//   2. The marker (if given) is first and survives any cut: a message that cannot be found again is not one we posted.
//   3. Markup is written through the one tree writer (parts/ui/show/server-rendered-page/markup-tree.mjs), never by hand.
//   4. A body over max_chars is cut at a block boundary, never mid-block, and says so.
//   5. Pure: same blocks and capability, same body.
//
// Block types: { type: 'heading', text, level? } { type: 'paragraph', text } { type: 'code', text }
//   { type: 'image', alt, url, dark_url? } { type: 'checklist', items: [{ text, done }] }
//   { type: 'collapsible', summary, blocks } { type: 'list', items: [text] }
// Key concepts: `capabilityOf(surfaceId, settings?)`, `capabilityOfPlace(place, settings?)`,
//   `composeFor(blocks, capability, { marker }, settings?)` -> { body, degraded: [capability], unproven_used: [capability], truncated }
import rules from './surface-compose.json' with { type: 'json' };
import { element, serialise, textOf } from '../parts/ui/show/server-rendered-page/markup-tree.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

/** The capability record of a named surface, or null when the DATA has none. */
export const capabilityOf = (surfaceId, settings = rules) => (Object.hasOwn(settings.surfaces, surfaceId) ? { id: surfaceId, ...settings.surfaces[surfaceId] } : null);

/** The capability record of a post place (src/post-places.mjs row payload), from the limits its `format` states. */
export function capabilityOfPlace(place, settings = rules) {
  const limit = place?.format?.caption_max_characters;
  const base = settings.place_surface;
  const sourced = Boolean(place?.format?.source);
  return { id: place?.id ?? 'post-place', html: base.html, collapsibles: base.collapsibles, checkboxes: base.checkboxes, dialect: base.dialect,
    max_chars: typeof limit === 'number' ? limit : null, theme: base.theme, unproven: sourced ? [] : [...base.unproven_when_unsourced] };
}

const plainOf = text => text.replace(/[*_`#>]+/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1');

function renderBlock(block, capability, state, settings, depth = 0) {
  const words = settings.words;
  const markdown = capability.dialect === 'markdown';
  const text = value => (markdown ? String(value ?? '') : plainOf(String(value ?? '')));
  switch (block?.type) {
    case 'heading': return markdown ? `${'#'.repeat(Math.min(Math.max(block.level ?? 2, 1), 6))} ${text(block.text)}` : text(block.text);
    case 'paragraph': return text(block.text);
    case 'code': return markdown ? `\`\`\`\n${block.text}\n\`\`\`` : String(block.text);
    case 'list': return block.items.map(item => `${markdown ? '-' : '•'} ${text(item)}`).join('\n');
    case 'checklist': {
      if (!capability.checkboxes) state.degrade('checkboxes'); else state.use('checkboxes');
      return block.items.map(item => (capability.checkboxes && markdown
        ? `- ${item.done ? words.box_done : words.box_open} ${text(item.text)}`
        : `• ${item.done ? words.plain_box_done : words.plain_box_open} ${text(item.text)}`)).join('\n');
    }
    case 'image': {
      const strategy = capability.theme?.strategy ?? 'single';
      if (block.dark_url && strategy === 'single') state.degrade('theme');
      else if (block.dark_url) state.use('theme');
      if (!markdown) return `${block.alt}: ${block.url}`;
      if (block.dark_url && strategy === 'picture' && capability.html) {
        return serialise(element('picture', {}, [element('source', { media: '(prefers-color-scheme: dark)', srcset: block.dark_url }), element('img', { src: block.url, alt: block.alt })]));
      }
      if (block.dark_url && strategy === 'suffix') {
        return `![${block.alt}](${block.url}${capability.theme.light ?? ''})\n![${block.alt}](${block.dark_url}${capability.theme.dark ?? ''})`;
      }
      return `![${block.alt}](${block.url})`;
    }
    case 'collapsible': {
      const inner = block.blocks.map(item => renderBlock(item, capability, state, settings, depth + 1)).join('\n\n');
      if (capability.collapsibles && capability.html && markdown) {
        state.use('collapsibles');
        state.use('html');
        return serialise(element('details', {}, [element('summary', {}, [textOf(block.summary)]), textOf(`\n\n${inner}\n\n`)]));
      }
      state.degrade('collapsibles');
      return `${markdown ? `${'#'.repeat(Math.min(depth + 3, 6))} ` : ''}${fill(words.folded_heading, { summary: text(block.summary) })}\n\n${inner}`;
    }
    default: throw new Error(`unknown block type ${String(block?.type)}`);
  }
}

/** The body for one place. `blocks` are the neutral blocks; `marker` (optional) is the text that must be first and survive a cut. */
export function composeFor(blocks, capability, { marker = '' } = {}, settings = rules) {
  const degraded = new Set();
  const used = new Set();
  const state = { degrade: name => degraded.add(name), use: name => used.add(name) };
  if (capability.dialect !== 'markdown') used.add('dialect');
  const pieces = blocks.map(block => renderBlock(block, capability, state, settings)).filter(piece => piece !== '');
  const head = marker ? [marker] : [];
  let truncated = false;
  let kept = [...head, ...pieces];
  const limit = capability.max_chars;
  if (typeof limit === 'number') {
    used.add('max_chars');
    const note = fill(settings.words.truncated, { max: limit });
    const fits = list => list.join('\n\n').length <= limit;
    if (!fits(kept)) {
      truncated = true;
      degraded.add('max_chars');
      kept = [...head];
      for (const piece of pieces) {
        if (!fits([...kept, piece, note])) break;
        kept.push(piece);
      }
      kept.push(note);
    }
  }
  const unproven = new Set(capability.unproven ?? []);
  return { body: kept.join('\n\n'), degraded: [...degraded], unproven_used: [...used].filter(name => unproven.has(name)), truncated };
}
