// The operator's Brand assets list is the source of selections and URLs. The
// same resolver works for a builder's own list rows; it knows no account name.
import { resolveScreenLookPalette } from '../../screen-look/read-data/resolve-screen-look-palette.js';
import { lookFor, lookScheme } from '../../draw-the-apps-icon-in-every-size-from/src/page-look.mjs';
import { BRAND_FIELDS, assetForBrand } from '../../brand-kit/read-data/brand-assets.mjs';
export { BRAND_FIELDS, assetForBrand };

export const backgroundTone = lookScheme;
export const paletteForBrand = look => resolveScreenLookPalette(look);
export const fallbackBrandPalette = lookFor('trillion-black').palette;

// When the editable brand owner is briefly unavailable, the public asset route
// uses the approved bundled family rather than drawing a broken image. The
// normal route still resolves the current selection from the owner's rows.
export function fallbackBrandAssetPath(role, format, tone) {
  if (!['wordmark', 'mark'].includes(role) || !['svg', 'png'].includes(format)) return null;
  // A failed owner read still gives the share page and its mark one bundled look.
  const selectedTone = tone === 'light' || tone === 'dark' ? tone : backgroundTone(fallbackBrandPalette);
  const light = selectedTone === 'light';
  const colour = light ? 'black' : 'white';
  const background = role === 'mark' ? (light ? 'white' : 'black') : 'transparent';
  return `/brand/${role}-${colour}-${background}.${format}`;
}

export function presentationFromBrand(rows, look) {
  const palette = paletteForBrand(look);
  const tone = backgroundTone(palette);
  return {
    palette,
    tone,
    variants: Object.fromEntries(['light', 'dark'].map(forTone => [forTone, Object.fromEntries(
      ['wordmark', 'mark'].flatMap(role => ['svg', 'png'].map(format =>
        [`${role}_${format}`, assetForBrand(rows, { role, format, tone: forTone })])))])),
    wordmark_svg: assetForBrand(rows, { role: 'wordmark', format: 'svg', tone }),
    wordmark_png: assetForBrand(rows, { role: 'wordmark', format: 'png', tone }),
    mark_svg: assetForBrand(rows, { role: 'mark', format: 'svg', tone }),
    mark_png: assetForBrand(rows, { role: 'mark', format: 'png', tone }),
  };
}

// The fields each action needs in input.stored. A field the caller leaves out (undefined) is a need: the action keeps
// nothing and names what to read. A list handed as null is absent, not unknown.
const NEEDS = Object.freeze({
  create: ['list', 'rows'],
  delete: ['list', 'mayDelete'],
  save: ['list', 'rows'],
  edit: ['list', 'rows'],
  import: ['list', 'rows'],
  remove: ['list', 'rows'],
  select: ['list', 'rows'],
  read: ['list', 'rows', 'worn', 'look'],
  export: ['list', 'rows', 'worn', 'look'],
  resolve: ['list', 'rows', 'worn', 'look'],
});

const newList = (label, listId) => ({
  label: label ?? 'Brand assets', about: 'Brand families and variants used by screens and messages.', row_type: listId, title_field: 'name', fields: BRAND_FIELDS,
});

/** All brands use the Lists and Screen look the caller hands in (input.stored: { list, rows, worn, look, mayDelete }).
 * list is the list's value or null; rows are the list's rows as { id, values }. Every write comes back as keep: each
 * record with the value it expected (null when absent), so the caller's store refuses it when that record has moved.
 * A builder may add roles and families as rows; the app's share and email consumers ask for the roles they draw. No
 * account or brand is named by this tool. */
export function runBrandKit(input = {}) {
  const { action = 'read', list_id: listId = 'brand-assets', stored = {}, row_id: rowId, values, rows, family, role, format = 'svg', tone } = input;
  if (!Object.hasOwn(NEEDS, action)) throw new Error(`Brand assets can create, read, edit, import, export, save, remove, select, resolve and delete; not ${action}.`);
  const needs = NEEDS[action].filter(name => stored[name] === undefined);
  if (needs.length) return { needs, keep: [], complete: false };
  if (action !== 'create' && action !== 'delete' && !stored.list) throw new Error(`${listId} is not there; create it first.`);

  const keep = [];
  const done = result => ({ ...result, keep, complete: true });
  const rowType = `record:${stored.list?.row_type ?? listId}`;
  const existing = rowId => stored.rows?.find(row => row.id === rowId);
  const writeRows = writes => {
    for (const row of writes) {
      const before = existing(row.id);
      keep.push({ id: `${rowType}:${row.id}`, type: rowType, value: { ...structuredClone(before?.values ?? {}), ...row.values },
        expected: before ? { type: rowType, value: structuredClone(before.values) } : null });
    }
  };

  if (action === 'create') {
    const list = stored.list ?? newList(input.label, listId);
    if (!stored.list) keep.push({ id: `list:${listId}`, type: 'list', value: list, expected: null });
    return done({ list, rows: stored.rows, said: `${listId} is ready.` });
  }
  if (action === 'delete') {
    if (!stored.mayDelete) throw new Error('This service brand is in use; its list cannot be removed.');
    if (stored.list) keep.push({ id: `list:${listId}`, type: 'list', value: null, expected: { type: 'list', value: stored.list } });
    return done({ removed: listId, said: `${listId} was removed; its asset records remain recoverable.` });
  }
  if (action === 'save' || action === 'edit' || action === 'import') {
    const writes = rows ?? (rowId && values ? [{ id: rowId, values }] : []);
    if (!Array.isArray(writes) || !writes.length) throw new Error('Give rows, or row_id and values.');
    for (const row of writes) if (row.values?.url) {
      const url = new URL(row.values.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A brand asset URL must be HTTPS without credentials.');
    }
    writeRows(writes);
    return done({ said: `${writes.length} brand row(s) saved.` });
  }
  if (action === 'remove') {
    if (!rowId) throw new Error('Give row_id to remove.');
    const selected = stored.rows.find(row => row.values?.role === 'selection')?.values?.family;
    const row = existing(rowId);
    if (row?.values?.role === 'selection' || row?.values?.family === selected) throw new Error('Select another complete family before removing an active brand row.');
    if (row) keep.push({ id: `${rowType}:${rowId}`, type: rowType, value: null, expected: { type: rowType, value: structuredClone(row.values) } });
    return done({ said: `${rowId} was removed.` });
  }
  if (action === 'select') {
    if (!family || !stored.rows.some(row => row.values?.family === family && row.values?.role !== 'selection')) throw new Error('Choose a family that has asset rows.');
    const selection = stored.rows.find(row => row.values?.role === 'selection');
    writeRows([{ id: selection?.id ?? 'brand', values: { name: input.label ?? selection?.values?.name ?? 'Brand', role: 'selection', family } }]);
    return done({ said: `Now using ${family}.` });
  }
  // read, export and resolve
  if (!stored.worn || !stored.look) throw new Error('No Screen look is worn.');
  const presentation = presentationFromBrand(stored.rows, stored.look);
  return done(action === 'resolve'
    ? { asset: assetForBrand(stored.rows, { role, format, tone: tone ?? presentation.tone }), palette: presentation.palette,
      said: `Resolved ${role ?? 'asset'} in the worn ${stored.worn} look.` }
    : { list: stored.list, rows: stored.rows, worn: stored.worn, presentation, said: `${stored.rows.length} brand rows; wearing ${stored.worn}.` });
}
