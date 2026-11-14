#!/usr/bin/env node
// packages/access-scoped-content/do-work/project-a-catalog-as-access-scoped-content.mjs
//
// PURPOSE
// Turn a catalog of items, and the media those items name, into the rows this
// package's surface reads. The catalog already says what each item is, what it
// sits inside, what access it needs and which media it plays. Nothing here is
// typed by hand, so an item added to the catalog appears in the library by
// being in the catalog.
//
// NON-NEGOTIABLE INVARIANTS
// - No product, course, customer or app vocabulary. It reads `kind` values and
//   reference fields and knows nothing else about the domain.
// - Containment comes from the catalog's own parent reference and is preserved
//   as `parent_ref` addressing the row id, so any depth survives.
// - An item whose media cannot be played still becomes a row. A learner has to
//   be able to SEE what a program contains before anything can open.
// - An item keeps the media it names even when none of it plays; a written
//   lesson opens as its text rather than as an empty player.
// - The descriptor label the reader admits arrives as an argument. This producer
//   mints no schema name of its own.

import { readFileSync, writeFileSync } from 'node:fs';

const CATALOG_ITEM = 'content-catalog-item';
const MEDIA_SOURCE = 'media-source';
const EMBED_CONTROL = 'media-embed-control';
const PLAYER = {
  package_name: 'media-playback',
  entry_name: 'media-playback-surface',
  material_target: 'component:media-playback-surface',
};

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} requires one value`);
  }
  return value.trim();
}

function recordsIn(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(rows)) throw new Error(`${file} holds no records array`);
  return rows.map((row) => (row && typeof row === 'object' && row.payload ? row.payload : row));
}

function byKind(rows, kind) {
  return rows.filter((row) => row && typeof row === 'object' && row.kind === kind);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const catalogFile = argumentValue('--catalog');
const mediaFile = argumentValue('--media');
const outputFile = argumentValue('--output');
const decisionRef = argumentValue('--access-decision');
const renderSurfaceSchema = argumentValue('--render-surface-schema');
const perItemAccess = !process.argv.includes('--one-grant-opens-the-whole-library');

const catalogRows = recordsIn(catalogFile);
const mediaRows = recordsIn(mediaFile);
const items = byKind(catalogRows, CATALOG_ITEM);
if (items.length === 0) throw new Error('the catalog names no items');

// Containment is stated from EITHER end. A row may name what contains it, and a
// row may name what it contains. Reading only one of the two is why a bundle
// that listed its own contents still looked empty: the contents said nothing
// about the bundle, and nobody asked the bundle.
const parentOfChild = new Map();
for (const item of items) {
  for (const childRef of Array.isArray(item.child_content_refs) ? item.child_content_refs : []) {
    if (text(childRef) && childRef !== item.id) parentOfChild.set(childRef, item.id);
  }
}
function containerOf(item) {
  return text(item.parent_content_ref) ?? parentOfChild.get(item.id) ?? null;
}
// A catalog holds everything a business offers: courses, but also services,
// sessions and proof clips. A library is what a learner studies, so when the
// caller names the programs it holds, only those programs and what sits inside
// them become rows. Naming none keeps every item.
const rootRefs = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--root' && text(process.argv[index + 1])) rootRefs.push(process.argv[index + 1].trim());
}
if (rootRefs.length) {
  const known = new Set(items.map((item) => item.id));
  const unknown = rootRefs.filter((ref) => !known.has(ref));
  if (unknown.length) throw new Error(`--root names items the catalog does not hold: ${unknown.join(', ')}`);
  const held = new Set(rootRefs);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of items) {
      if (!held.has(item.id) && held.has(containerOf(item))) { held.add(item.id); grew = true; }
    }
  }
  items.splice(0, items.length, ...items.filter((item) => held.has(item.id)));
}

const labelById = new Map(items.map((item) => [item.id, text(item.title) ?? item.id]));
const orderById = new Map(items.map((item) => [item.id, Number.isFinite(item.sort_order) ? Number(item.sort_order) : 0]));

const mediaById = new Map(byKind(mediaRows, MEDIA_SOURCE).map((media) => [media.id, media]));
const embedControls = new Map(byKind(mediaRows, EMBED_CONTROL).map((control) => [control.id, control]));

const rows = items
  .map((item) => {
    // Something that plays comes first. When nothing does, the item still keeps
    // the media it names, because a written lesson IS its content: dropping it
    // left the row a bare title and the surface had nothing to open.
    const named = (Array.isArray(item.media_refs) ? item.media_refs : [])
      .map((ref) => mediaById.get(ref))
      .filter(Boolean);
    const media = named.find((candidate) => text(candidate.embed_url)) ?? named[0] ?? null;
    const control = media && text(media.embed_control_ref)
      ? embedControls.get(media.embed_control_ref) ?? null
      : null;
    // Some libraries gate each item by what was bought; others gate the whole
    // library once, at the door. Carrying per-item requirements into the second
    // kind locks every row against a viewer who already holds the only grant
    // that surface issues, so which one this is comes from the caller.
    const accessRef = text(item.access_ref);
    const requiredAccessRefs = perItemAccess && accessRef && !/:public$/.test(accessRef) ? [accessRef] : [];
    const summary = text(item.summary);
    return {
      // A surface opened on a container shows its contents, so the id a row is
      // addressed by and the id its children point at must be the SAME id.
      id: item.id,
      content_ref: item.id,
      label: text(item.title) ?? item.id,
      ...(summary ? { summary: summary.slice(0, 280) } : {}),
      ...(containerOf(item) ? { parent_ref: containerOf(item) } : {}),
      // What a row is grouped under is what CONTAINS it, and only the rows that
      // sit inside nothing fall back to the catalog's own collection. A surface
      // that groups by collection alone puts a whole library in one heading,
      // which is a list of ninety-eight things and not a course.
      collection_ref: containerOf(item) ?? text(item.collection_id) ?? 'library',
      ...(containerOf(item) && labelById.has(containerOf(item))
        ? { collection_label: labelById.get(containerOf(item)) }
        : {}),
      ...(Number.isFinite(orderById.get(containerOf(item))) ? { collection_order: orderById.get(containerOf(item)) } : {}),
      ...(Number.isFinite(item.sort_order) ? { item_order: Number(item.sort_order) } : {}),
      available: true,
      ...(requiredAccessRefs.length ? { required_access_refs: requiredAccessRefs } : {}),
      access_decision_ref: decisionRef,
      access_decision_revision: 1,
      access_decision_current_revision: 1,
      render_surface: {
        schema: renderSurfaceSchema,
        package_entry: { package_name: PLAYER.package_name, entry_name: PLAYER.entry_name },
        material_target: PLAYER.material_target,
        surface_input: {
          show_frame_chrome: false,
          media: media
            ? { ...media, ...(control ? { embed_control: control } : {}) }
            : { content_ref: item.id, label: text(item.title) ?? '' },
        },
      },
    };
  })
  .sort((left, right) => (left.item_order ?? 0) - (right.item_order ?? 0));

const PROJECTION_ADDRESS = 'package-set-records::access-scoped-content-projection';

// An address has exactly one writer. If the set already declares this one, these
// rows belong IN that record, not in a second file beside it: a second file is a
// second writer, and which of the two the app reads is then a question nobody
// can answer by looking. Writing into the existing record keeps the answer to
// "where does the library come from" a single place.
const existing = JSON.parse(readFileSync(outputFile, 'utf8'));
const existingRecords = Array.isArray(existing) ? existing : existing.records;
if (!Array.isArray(existingRecords)) throw new Error(`${outputFile} holds no records array`);
const held = existingRecords.findIndex((record) => record?.address === PROJECTION_ADDRESS);
if (held === -1) {
  throw new Error(`${outputFile} does not declare ${PROJECTION_ADDRESS}, so these rows have no writer there`);
}
existingRecords[held] = { ...existingRecords[held], payload: rows };
writeFileSync(outputFile, `${JSON.stringify(existing, null, 2)}\n`);

const containers = new Set(rows.map((row) => row.parent_ref).filter(Boolean));
process.stdout.write(`${rows.length} rows, ${containers.size} of them hold others, written to ${outputFile}\n`);
