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

// Read from the operator account's own records resource, where its Brand assets list and worn Screen look live, through
// the same list and look routes its AIs use. The Worker reads them as the service, a sign-in of its own; the list and
// look remain the only editable sources. `consume(path, body, method)` answers one route; tests supply their own.
// That sign-in is a service actor the operator account's own policy owner mints (src/service-actor-origins.json
// brand-presentation), opening only the list and looks routes.
// The caller supplies an already admitted owner; this tool never mints an actor.
async function operatorConsumer(owner) {
  if (typeof owner?.consume !== 'function') throw new Error('The operator brand store is unavailable.');
  return owner.consume;
}
export async function readOperatorBrandPresentation(env, { consume = null } = {}) {
  const read = consume ?? await operatorConsumer(env);
  const answer = async (path, body, method) => {
    const result = await read(path, body, method);
    if (result == null) throw new Error(`The brand owner has no route for ${path}.`);
    return result;
  };
  const { rows } = await answer('/lists/brand-assets', undefined, 'GET');
  const { worn } = await answer('/looks', undefined, 'GET');
  if (!worn) throw new Error('No Screen look is worn.');
  const { look } = await answer('/looks/read', { look_id: worn }, 'POST');
  return presentationFromBrand(rows, look);
}

// The service's brand as every page and email draws it: the service record brand-presentation (src/service-records.json),
// which the operator's own records resource publishes into the service's edge store whenever a write touches its
// Brand assets list or its looks (src/service-record-publication.mjs), and the operator's store publishes once it
// starts. Every reader reads its region's copy, however old, so no page or email waits on the operator's resource
// (its three reads took 10 to 39 s on a busy day, 2026-10-07) and none is drawn in another account's colours. Null
// when it was never published: a page then draws the bundled brand (fallbackBrandAssetPath, fallbackBrandPalette) and an
// email is not sent (src/mail-sender.mjs).
export const BRAND_RECORD = 'brand-presentation';
// The admitted publication owner supplies this read. Its storage schema and cache
// stay with that owner; this tool never substitutes the operator's live store.
export const readBrandPresentationWithin = owner => owner.serviceRecord(BRAND_RECORD);

/** All brands use the existing Lists and Screen looks owners. A builder may add
 * roles and families as rows; the app's share and email consumers ask for the
 * roles they draw. No account or brand is named by this tool. */
export async function runBrandKit({ lists, looks, mayDelete = true }, input = {}) {
  const { action = 'read', list_id: listId = 'brand-assets', row_id: rowId, values, rows, family, role, format = 'svg', tone } = input;
  if (action === 'create') {
    try { await lists.read(listId); }
    catch (error) {
      if (lists.find && await lists.find(listId)) throw error;
      await lists.save({ id: listId, label: input.label ?? 'Brand assets', about: 'Brand families and variants used by screens and messages.', row_type: listId, title_field: 'name', fields: BRAND_FIELDS }); }
    return { ...await lists.read(listId), said: `${listId} is ready.` };
  }
  if (action === 'delete') {
    if (!mayDelete) throw new Error('This service brand is in use; its list cannot be removed.');
    return { ...await lists.save({ id: listId, remove: true }), said: `${listId} was removed; its asset records remain recoverable.` };
  }
  const current = await lists.read(listId);
  if (action === 'save' || action === 'edit' || action === 'import') {
    const writes = rows ?? (rowId && values ? [{ id: rowId, values }] : []);
    if (!Array.isArray(writes) || !writes.length) throw new Error('Give rows, or row_id and values.');
    for (const row of writes) if (row.values?.url) {
      const url = new URL(row.values.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A brand asset URL must be HTTPS without credentials.');
    }
    const saved = await lists.putRows(listId, { rows: writes });
    return { ...saved, said: `${writes.length} brand row(s) saved.` };
  }
  if (action === 'remove') {
    if (!rowId) throw new Error('Give row_id to remove.');
    const selected = current.rows.find(row => row.values?.role === 'selection')?.values?.family;
    const row = current.rows.find(one => one.id === rowId);
    if (row?.values?.role === 'selection' || row?.values?.family === selected) throw new Error('Select another complete family before removing an active brand row.');
    return { ...await lists.putRows(listId, { remove: [rowId] }), said: `${rowId} was removed.` };
  }
  if (action === 'select') {
    if (!family || !current.rows.some(row => row.values?.family === family && row.values?.role !== 'selection')) throw new Error('Choose a family that has asset rows.');
    const selection = current.rows.find(row => row.values?.role === 'selection');
    const saved = await lists.putRows(listId, { rows: [{ id: selection?.id ?? 'brand', values: { name: input.label ?? selection?.values?.name ?? 'Brand', role: 'selection', family } }] });
    return { ...saved, said: `Now using ${family}.` };
  }
  if (action !== 'read' && action !== 'export' && action !== 'resolve') throw new Error(`Brand assets can create, read, edit, import, export, save, remove, select, resolve and delete; not ${action}.`);
  const worn = (await looks.list()).worn;
  const look = (await looks.read({ look_id: worn })).look;
  const presentation = presentationFromBrand(current.rows, look);
  return action === 'resolve'
    ? { asset: assetForBrand(current.rows, { role, format, tone: tone ?? presentation.tone }), palette: presentation.palette,
      said: `Resolved ${role ?? 'asset'} in the worn ${worn} look.` }
    : { list: current.list, rows: current.rows, worn, presentation, said: `${current.rows.length} brand rows; wearing ${worn}.` };
}
