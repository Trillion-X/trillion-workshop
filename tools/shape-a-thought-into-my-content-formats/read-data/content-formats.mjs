// tools/shape-a-thought-into-my-content-formats/read-data/content-formats.mjs
//
// Ported from old trillion src/content-formats.mjs (tag old-trillion-before-worker-retire): makeContentFormats and
// handleContentFormatsRequest unchanged but for their imports, which name this repository's copies of the same DATA
// (data/content-format-starters.json and data/content-format-sources.json, byte for byte from the tag's records/) and
// modules. Left behind: makeMarketplaceContentFormats, which read Marketplace-published sections of those two DATA
// files over the bundled ones (src/marketplace-content-document.mjs); here the bundled DATA is what is read.
//
// The content formats a person writes and speaks in: every format they saved, then the ones every account starts with
// (DATA: records/content-format-starters.json, the same file the Expansion media workspace reads). One list every
// client reads the same way: the iPhone's Formats screen drops a thought into each one and reads it as a script while
// recording, and any AI reads it to write in a format the person already uses.
//
//   GET  /content-formats   { formats: [{ id, label, description, category, category_id, category_icon, icon, logo, content_type, input, process, output, spec, slots, body_template, tags, from }],
//                             example_kinds: [{ id, label, hint }] }
//   POST /content-formats   { formats: [{ id?, label, spec?, description?, content_type?, input?, process?, output?, slots?, body_template?, tags? }
//                                      | { id, removed: true }] }
//                           replaces the person's own list and returns the same as GET; { id, removed: true } takes a
//                           starter out of their list (GET lists it under removed_starters) and it stays out until
//                           { id, removed: false } or a format with its id puts it back
//   GET  /content-formats/sources { sources: [{ kind, label, id, title, at }] }
//                           the person's own recordings, notes and pursuits a format can be filled from, newest first
//                           (kinds are DATA: records/content-format-sources.json)
//   POST /content-formats/shape   { thought?, source?: { kind, id }, format_ids? }
//                           { scripts: [{ format_id, format_label, about, lines: [{ id, label, words, theirs }], text, input, process, output }], before_writing: { workflows: [{ workflow_id, next_call }] } | { job, next_call } }
//                           one thought dropped into each format (or the ones named), as the Formats screen shows it
//                           with { source, material }: which of theirs filled it (their newest when neither thought nor
//                           source is given) and the words drawn from it
//   POST /content-formats/follow  { format_id, about?, material?, heard, said? }
//                           { said, total, progress, done, next_words }: how far through that script the words heard
//                           reach, the way the Record screen's teleprompter follows a voice
//
// A format says what it is made from (input), the steps that make it (process, in order) and what comes out and where
// it goes (output). Its slots are its parts in order, each { id, label, hint }: what is said or written first, next and
// last. example_kinds are where every piece takes its real examples from (the person's own work, a customer, someone
// well known).
// A starter keeps its spec (how to write it from a recording) and its slots; a writing framework or template from the
// library has slots and a description. from says whose it is: "saved" (the person's) or "starter".
//
// Invariants
// - The starters are always listed after the person's own, so a saved format never hides the ones everyone has; only
//   the person's own { id, removed: true } row takes a starter out of their list.
// - A save is checked whole before anything is written, so a refused format leaves the saved list as it was.
// - A saved format with a starter's id is the person's version of it and replaces that starter in the list.
//
// store: { saved() -> list | null, putSaved(list) }; readers: see makeContentFormats.
import starters from '../data/content-format-starters.json' with { type: 'json' };
import sourceKinds from '../data/content-format-sources.json' with { type: 'json' };
import captionStyles from '../../media-composition/read-data/caption-styles.json' with { type: 'json' };
import { follow, heardWords, scriptFor, scriptFromWords, sentencesOf, scriptSegments, scriptText, scriptWords, teleprompterAt } from '../../turn-any-recording-already-in-the-persons-files/src/workspace/recording.mjs';
import { failureOf } from '../../tweak-live-controls/failure.mjs';

// How a finished piece is reached from the scripts: each format's own workflow when the person's saved format names one,
// else the job to find one for with find_workflow (DATA: records/content-format-sources.json before_writing). No
// particular workflow is named here: the account's DATA or the Marketplace answers which one runs.
function beforeWriting(formats, sourceKinds) {
  const chosen = [...new Set(formats.map(format => format.workflow_id).filter(Boolean))];
  if (chosen.length) return { workflows: chosen.map(workflow_id => ({ workflow_id, next_call: { tool: 'start_workflow', arguments: { workflow_id } } })) };
  const job = sourceKinds.before_writing?.find_workflow?.job;
  if(!job)throw new ContentFormatsError('The writing instruction is no longer published. Choose a saved format with its own workflow.');
  return { job, next_call: { tool: 'find_workflow', arguments: { job } } };
}

export class ContentFormatsError extends Error {}

const MAX_FORMATS = 100;
const MAX_SLOTS = 12;
const MAX_STEPS = 12;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// Where a format takes the person's own words from: one DATA row per kind (records/content-format-sources.json).
// The most of their own sentences any format can carry (MAX_SLOTS parts, two sentences each, recording.mjs).
const MOST_SENTENCES = MAX_SLOTS * 2;
const SOURCES_PER_KIND = 5;

function shaped(row, from, categories) {
  return {
    id: row.id,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    // Its tab on the Formats screen and its look: the format's own icon or logo, else its category's icon.
    ...(categories.has(row.category_id) ? { category: categories.get(row.category_id).label, category_id: row.category_id, ...(categories.get(row.category_id).icon ? { category_icon: categories.get(row.category_id).icon } : {}) } : row.category ? { category: row.category } : {}),
    ...(row.icon ?? categories.get(row.category_id)?.icon ? { icon: row.icon ?? categories.get(row.category_id).icon } : {}),
    ...(row.logo ? { logo: row.logo } : {}),
    ...(row.content_type ? { content_type: row.content_type } : {}),
    ...(row.input ? { input: row.input } : {}),
    ...(row.process?.length ? { process: [...row.process] } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.spec ? { spec: row.spec } : {}),
    slots: (row.slots ?? []).map(({ id, label, hint }) => ({ id, label, ...(hint ? { hint } : {}) })),
    ...(row.body_template ? { body_template: row.body_template } : {}),
    ...(row.caption_style ? { caption_style: row.caption_style } : {}),
    ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
    tags: [...(row.tags ?? [])],
    from,
  };
}

// Every starter as one row: the formats first, then the library's frameworks and templates.

function slotsFrom(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SLOTS) throw new ContentFormatsError(`${label}: slots is a list of up to ${MAX_SLOTS} parts, each { label, hint }.`);
  const seen = new Set();
  return value.map(slot => {
    const slotLabel = object(slot) ? optionalText(slot.label, 80) : null;
    if (!slotLabel) throw new ContentFormatsError(`${label}: each part needs a label.`);
    let id = optionalText(slot.id, 60) ?? (slug(slotLabel) || `part_${seen.size + 1}`);
    if (!/^[a-z][a-z0-9_-]*$/i.test(id)) throw new ContentFormatsError(`${label}: part id "${id}" uses letters, numbers, - and _ only, starting with a letter.`);
    while (seen.has(id)) id = `${id}_${seen.size}`;
    seen.add(id);
    const hint = optionalText(slot.hint, 400);
    return { id, label: slotLabel, ...(hint ? { hint } : {}) };
  });
}

function stepsFrom(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STEPS) throw new ContentFormatsError(`${label}: process is a list of up to ${MAX_STEPS} steps, each in words.`);
  const steps = value.map(step => optionalText(step, 1000));
  if (steps.some(step => !step)) throw new ContentFormatsError(`${label}: each process step says what to do, in words.`);
  return steps;
}

function formatsFrom(list, STARTERS) {
  if (!Array.isArray(list)) throw new ContentFormatsError('formats is a list: each { label, spec or slots }, optionally id, description, content_type, body_template and tags.');
  if (list.length > MAX_FORMATS) throw new ContentFormatsError(`At most ${MAX_FORMATS} saved formats.`);
  const seen = new Set();
  return list.map(item => {
    // A starter the person took out of their list: kept as theirs so it stays out until they put it back.
    if (object(item) && item.removed === true) {
      const id = optionalText(item.id, 60);
      if (!id || !STARTERS.some(row => row.id === id)) throw new ContentFormatsError('removed takes the id of a starter format: { id, removed: true }.');
      if (seen.has(id)) throw new ContentFormatsError(`${id} is in the list twice.`);
      seen.add(id);
      return { id, removed: true };
    }
    const label = object(item) ? optionalText(item.label, 120) : null;
    if (!label) throw new ContentFormatsError('Each format needs a label.');
    const spec = optionalText(item.spec, 12000);
    const slots = slotsFrom(item.slots, label);
    if (!spec && !slots.length) throw new ContentFormatsError(`${label}: say how it goes, as spec (words) or slots (its parts).`);
    const contentType = optionalText(item.content_type, 100);
    if (contentType && !/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType)) throw new ContentFormatsError(`${label}: content_type is a media type such as text/markdown.`);
    const description = optionalText(item.description, 1000);
    const bodyTemplate = optionalText(item.body_template, 12000);
    const input = optionalText(item.input, 2000);
    const process = stepsFrom(item.process, label);
    const output = optionalText(item.output, 2000);
    let id = optionalText(item.id, 100) ?? (slug(label) || `format_${seen.size + 1}`);
    while (seen.has(id)) id = `${id}_${seen.size}`;
    seen.add(id);
    const category = optionalText(item.category, 40);
    const categoryId = optionalText(item.category_id, 40);
    const icon = optionalText(item.icon, 40);
    const logo = optionalText(item.logo, 60);
    const tags = Array.isArray(item.tags) ? item.tags.map(tag => optionalText(tag, 60)).filter(Boolean).slice(0, 20) : [];
    // The caption style its videos are captioned in: a row of the caption styles (parts/media-composition), so a video
    // drafted in this format with captions in any other style is refused (src/social-posts.mjs).
    const captionStyle = optionalText(item.caption_style, 60);
    // The workflow this person runs to finish a piece in this format: any workflow_id find_workflow answers.
    const workflowId = optionalText(item.workflow_id, 200);
    if (workflowId && !/^workflow:[a-z0-9][a-z0-9-]*$/.test(workflowId)) throw new ContentFormatsError(`${label}: workflow_id is a workflow_id from find_workflow.`);
    if (captionStyle && !captionStyles.styles.some(style => style.id === captionStyle)) throw new ContentFormatsError(`${label}: caption_style is one of the caption styles: ${captionStyles.styles.map(style => style.id).join(', ')}.`);
    return { id, label, ...(workflowId ? { workflow_id: workflowId } : {}), ...(categoryId ? { category_id: categoryId } : {}), ...(category ? { category } : {}), ...(icon ? { icon } : {}), ...(logo ? { logo } : {}), ...(description ? { description } : {}), ...(contentType ? { content_type: contentType } : {}), ...(input ? { input } : {}), ...(process.length ? { process } : {}), ...(output ? { output } : {}), ...(spec ? { spec } : {}), slots, ...(bodyTemplate ? { body_template: bodyTemplate } : {}), ...(captionStyle ? { caption_style: captionStyle } : {}), tags };
  });
}

// store: { saved() -> list | null, putSaved(list) }
// readers: keyed by a source kind's `read`, each { list(kind, limit) -> [{ id, title, at }] newest first,
//          words(kind, id) -> { title, words } | null }: the person store's own files, pursuits and the rest.
export function makeContentFormats({ store, readers = {}, starterRows=starters, sourceRows=sourceKinds }) {
  const categories=new Map((starterRows.writing_library.categories??[]).map(row=>[row.id,row]));
  const shapeRow=(row,from)=>shaped(row,from,categories);
  const STARTERS=[...starterRows.formats,...starterRows.writing_library.frameworks,...starterRows.writing_library.templates].map(row=>shapeRow(row,'starter'));
  const KINDS=new Map(sourceRows.kinds.map(row=>[row.id,row]));
  function read() {
    const kept = store.saved() ?? [];
    const removed = new Set(kept.filter(row => row?.removed === true).map(row => row.id));
    const saved = kept.filter(row => row?.removed !== true).map(row => shapeRow(row, 'saved'));
    const ids = new Set([...saved.map(row => row.id), ...removed]);
    return {
      formats: [...saved, ...STARTERS.filter(row => !ids.has(row.id)).map(row => structuredClone(row))],
      removed_starters: STARTERS.filter(row => removed.has(row.id)).map(row => ({ id: row.id, label: row.label })),
      example_kinds: structuredClone(starterRows.example_kinds),
    };
  }
  function save(input = {}) {
    if (!object(input) || input.formats === undefined) throw new ContentFormatsError('Nothing to save: give formats, the whole list of this person\'s own formats.');
    // A starter they took out stays out when a later save leaves its row off (a client that sends back what it read
    // never sees it); { id, removed: false } or a format with its id puts it back.
    const restored = new Set(Array.isArray(input.formats) ? input.formats.filter(item => object(item) && item.removed === false).map(item => item.id) : []);
    const next = formatsFrom(Array.isArray(input.formats) ? input.formats.filter(item => !(object(item) && item.removed === false)) : input.formats,STARTERS);
    const named = new Set(next.map(row => row.id));
    const stillRemoved = (store.saved() ?? []).filter(row => row?.removed === true && !named.has(row.id) && !restored.has(row.id));
    store.putSaved([...next, ...stillRemoved]);
    return read();
  }
  // The person's own material a format can be filled from, newest first: up to SOURCES_PER_KIND of each kind.
  async function sources() {
    const lists = await Promise.all([...KINDS.values()].map(async kind => {
      const reader = readers[kind.read];
      const rows = reader ? await reader.list(kind, SOURCES_PER_KIND).catch(() => []) : [];
      return rows.map(row => ({ kind: kind.id, label: kind.label, id: String(row.id), title: row.title ?? '', at: row.at ?? '' }));
    }));
    return { sources: lists.flat().sort((a, b) => String(b.at).localeCompare(String(a.at))) };
  }
  // One source's words, as many sentences as any format can carry: { kind, label, id, title, words } or a refusal.
  async function materialOf(source) {
    const kind = object(source) ? KINDS.get(source.kind) : null;
    if (!kind || typeof source.id !== 'string' || !source.id) throw new ContentFormatsError(`Name the source as { kind, id }: kind is one of ${[...KINDS.keys()].join(', ')}, id from content_format_sources.`);
    const read = readers[kind.read] ? await readers[kind.read].words(kind, source.id) : null;
    if (!read) throw new ContentFormatsError(`That ${kind.label} is not in this account any more.`);
    return { kind: kind.id, label: kind.label, id: source.id, title: read.title ?? '', words: sentencesOf(read.words).slice(0, MOST_SENTENCES).join('\n') };
  }
  // A durable, tenant-checked source link for a post; retain its identity and display name, never the source words.
  async function reference(source) {
    const material = await materialOf(source);
    return { kind: material.kind, label: material.label, id: material.id, title: material.title };
  }
  // Each format (or the ones named, in the order named) filled with the person's own words: their thought, and the
  // material it is drawn from (a source named, else their newest recording, note or pursuit when no thought is given).
  // The script shown and read aloud (recording.mjs); `source` says which of theirs filled it, `material` its words.
  async function shape(input = {}) {
    const body = object(input) ? input : {};
    const hasThought = Object.hasOwn(body, 'thought');
    const thought = optionalText(body.thought, 2000);
    if (hasThought && !thought && body.source === undefined) throw new ContentFormatsError('Say the thought to shape, as thought.');
    let named = body.source !== undefined ? body.source : null;
    if (!thought && !named) {
      named = (await sources()).sources[0] ?? null;
      if (!named) throw new ContentFormatsError('Say the thought to shape, as thought: this account has no recording, note or pursuit to draw from yet.');
    }
    const material = named ? await materialOf(named) : null;
    const formats = read().formats;
    const wanted = body.format_ids === undefined ? formats : (Array.isArray(body.format_ids) ? body.format_ids : [body.format_ids]).map(id => {
      const found = formats.find(format => format.id === id);
      if (!found) throw new ContentFormatsError(`There is no format "${id}": read content_formats for their ids.`);
      return found;
    });
    return {
      source: material ? { kind: material.kind, label: material.label, id: material.id, title: material.title } : null,
      material: material?.words ?? '',
      scripts: wanted.map(format => { const script = scriptFor(format, thought ?? '', material?.words ?? ''); return { ...script, text: scriptText(script) }; }),
      // The scripts are outlines, not finished pieces. Writing the piece straight from them skips the person's own
      // philosophy and copywriting laws, so the way to the finished piece is named here, in every answer.
      before_writing: beforeWriting(wanted,sourceRows),
    };
  }
  // How far the words heard reach through one format's script, continuing from `said` words already read.
  // A script that is not ready (a part with no words yet, or no words at all) is never followed: it is reported as not
  // ready, with the parts still to write, and never as already read.
  function followThrough(input = {}) {
    if (typeof input?.heard !== 'string') throw new ContentFormatsError('Give the words heard, as heard.');
    let script;
    if (typeof input.script === 'string') script = scriptFromWords(input.script);
    else {
      const format = object(input) ? read().formats.find(row => row.id === input.format_id) : null;
      if (!format) throw new ContentFormatsError('Name the script\'s format as format_id (read content_formats for their ids), or give its finished words as script.');
      script = scriptFor(format, typeof input.about === 'string' ? input.about : '', typeof input.material === 'string' ? input.material : '');
    }
    if (!script.ready) {
      return {
        ready: false, done: false, said: 0, total: 0, progress: 0, next_words: '', missing: script.missing,
        message: `This script is not ready to read: ${script.missing.join(', ')} ${script.missing.length === 1 ? 'has' : 'have'} no words yet. Write the finished words first (shape_into_formats names the writing workflow as before_writing), then follow them with script.`,
      };
    }
    const segments = scriptSegments(script);
    const words = scriptWords(segments);
    const from = { said: Number.isInteger(input.said) ? Math.min(Math.max(input.said, 0), words.length) : 0 };
    const place = follow(words, heardWords(input.heard), from);
    const shown = segments.flatMap(segment => segment.split(/\s+/)).filter(Boolean);
    return { ready: true, said: place.said, total: words.length, progress: teleprompterAt(place, words.length).progress, done: words.length > 0 && place.said >= words.length, next_words: shown.slice(place.said, place.said + 12).join(' ') };
  }
  return { read, save, shape, sources, reference, follow: followThrough };
}

const ACTIONS = { '/content-formats/shape': 'shape', '/content-formats/follow': 'follow' };
const READS = { '/content-formats/sources': 'sources' };

export async function handleContentFormatsRequest(contentFormats, request) {
  try {
    const path = new URL(request.url).pathname;
    const action = ACTIONS[path];
    if (request.method === 'GET') {
      if (READS[path]) return Response.json(await contentFormats[READS[path]]());
      if (path === '/content-formats') return Response.json(await contentFormats.read());
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    if (path !== '/content-formats' && !action) return Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await request.text();
    if (raw.length > 1_000_000) throw new ContentFormatsError('Request too large');
    const body = JSON.parse(raw || '{}');
    return Response.json(action ? await contentFormats[action](body) : await contentFormats.save(body));
  } catch (error) {
    // A failure that tries again later is the shared failure owner's to answer, never a refusal of this request.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: error instanceof ContentFormatsError || error instanceof SyntaxError ? 400 : 500 });
  }
}

const slotRow = { type: 'object', required: ['label'], properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } } };
const formatRow = { type: 'object', properties: { id: { type: 'string' }, removed: { type: 'boolean', description: 'With a starter\'s id and nothing else: true takes that starter out of their list, false puts it back' }, label: { type: 'string' }, category_id: { type: 'string', description: 'One of the starters\' categories (writing, social, video, persuasion, storytelling, education): its tab and icon on the Formats screen' }, category: { type: 'string', description: 'A category of their own, in a word or two, when none of the starters\' fits' }, icon: { type: 'string', description: 'A Lucide icon name for the format' }, logo: { type: 'string', description: 'Where it goes, as a logo slug such as x, instagram, youtube or substack' }, description: { type: 'string' }, content_type: { type: 'string' }, input: { type: 'string' }, process: { type: 'array', maxItems: MAX_STEPS, items: { type: 'string' } }, output: { type: 'string' }, spec: { type: 'string' }, slots: { type: 'array', maxItems: MAX_SLOTS, items: slotRow }, body_template: { type: 'string' }, caption_style: { type: 'string', enum: captionStyles.styles.map(style => style.id), description: 'The caption style its videos are captioned in; a video drafted in this format with captions in another style is refused' }, tags: { type: 'array', items: { type: 'string' } } } };

export const contentFormatTools = call => [
  { name: 'content_format_sources', description: 'The recordings, notes and pursuits in this account that can fill a content format, newest first. Each source has kind, id, title and date. Use one as source with shape_into_formats; it changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/content-formats/sources') },
  { name: 'content_formats', description: 'The content formats this person writes and speaks in: their own saved formats first, then the ones every account starts with (blog post, article, Substack post, newsletter, X thread, Instagram caption, short video, YouTube video, carousel, content series, and writing frameworks such as AIDA), plus example_kinds, where every piece takes its real examples from. Each has id, label, description, input (what it is made from), process (the steps, in order), output (what comes out and where it goes), spec (how to write it from a recording or a thought), slots (its parts in order, each { id, label, hint }), body_template (the parts in [brackets], when it has one), caption_style (the caption style its videos use, when it names one), tags and from ("saved" or "starter"). Read it before writing something for them, and write in their format. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/content-formats') },
  { name: 'save_content_formats', description: 'Replaces this person\'s own content formats (read content_formats first, then send the whole list with your change). Each format: label, and spec (how it goes, in words) or slots (its parts in order, each { label, hint }), optionally id, category_id or category, icon or logo (how it looks on the Formats screen), description, content_type (such as text/markdown), input, process (its steps in order) and output (what comes out and where it goes), body_template (the parts in [brackets]), caption_style (the caption style its videos are captioned in), workflow_id (the workflow from find_workflow they finish a piece in this format with) and tags. Use it to keep a format they studied from a post they shared or one they describe. A format with a starter\'s id replaces that starter for them, and { id, removed: true } with a starter\'s id takes that starter out of their list (content_formats lists it under removed_starters; it stays out until { id, removed: false } puts it back). Returns what content_formats returns.', inputSchema: { type: 'object', required: ['formats'], properties: { formats: { type: 'array', maxItems: MAX_FORMATS, items: formatRow } } }, run: input => call('/content-formats', input ?? {}) },
  { name: 'shape_into_formats', description: 'Shapes a thought or one of this person\'s own sources into their content formats. Give source { kind, id } from content_format_sources to use a recording, note or pursuit; thought may name the specific idea to draw from it. Without either, their newest source is used. Returns the checked source reference, its words and each format\'s script, with ready (every part has words to read) and missing (the parts still to write; their hint says what goes there). The scripts are outlines: make the finished piece with before_writing.next_call, the workflow a format of theirs names or the one find_workflow finds for that job, then keep the source and format ids with draft_post. Choose a format that fits the relevant pursuit and a connected posting destination. Link the draft to its pursuit with set_record_scope. This changes nothing.', inputSchema: { type: 'object', properties: { thought: { type: 'string', description: 'The specific idea to shape, in their words; optional when source is given' }, source: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { type: 'string', description: 'A kind from content_format_sources' }, id: { type: 'string', description: 'That source\'s id' } } }, format_ids: { type: 'array', items: { type: 'string' }, description: 'Only these formats (ids from content_formats); every format when left out' } } }, run: input => call('/content-formats/shape', input ?? {}) },
  { name: 'follow_script', description: 'Finds how far someone has read through a format\'s script from the words heard (a live transcript or a finished one), the way the Record screen\'s teleprompter follows a voice: each word heard is looked for a few words ahead of the place reached, so an aside or a misheard word never loses the place and it never moves back. Give the finished words as script, or format_id and about (the thought the script was made with) as shape_into_formats took them; then heard, and said (the place from an earlier call) to continue. Returns ready, said (script words read), total, progress (0 to 1), done, and next_words, what comes next. A script with parts still to write answers ready false with missing (those parts) and is never done. It changes nothing.', inputSchema: { type: 'object', required: ['heard'], properties: { script: { type: 'string', description: 'The finished words to read' }, format_id: { type: 'string' }, about: { type: 'string' }, heard: { type: 'string', description: 'The words heard since said' }, said: { type: 'integer', minimum: 0, description: 'The place already reached (said from an earlier call); 0 when left out' } } }, run: input => call('/content-formats/follow', input ?? {}) },
];

export const contentFormatAnnotations = {
  content_format_sources: { title: 'Read sources for my formats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  content_formats: { title: 'Read my content formats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_content_formats: { title: 'Save my content formats', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  shape_into_formats: { title: 'Shape a thought into my formats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  follow_script: { title: 'Follow my script', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
