// tools/brand-kit/read-data/brand-assets.mjs
//
// A brand is rows of a list: one row per logo variant (family, role, format, background, url) and one selection row
// (role "selection") naming the family in use. This picks, for a light or a dark page, the variant each surface draws.
// It knows no brand, account or colour: the rows decide. The rows stay in the person's list; changing a brand is
// writing rows there, never here.
//
// Invariants
// - Only the selected family is drawn. A family with no variant for a role, format and background answers null for
//   that variant, never another family's file.
// - A variant on a dark page is the white one, on a light page the black one; a mark sits on its own square of the
//   page colour, a wordmark on a transparent background.
// - A url is used only when it is HTTPS without credentials.

/** The fields of a brand row, as the list that keeps them declares them. */
export const BRAND_FIELDS = Object.freeze([
  { id: 'name', label: 'Asset', kind: 'text' },
  { id: 'brand', label: 'Brand', kind: 'text' },
  { id: 'family', label: 'Family', kind: 'text' },
  { id: 'role', label: 'Role', kind: 'text' },
  { id: 'format', label: 'Format', kind: 'text' },
  { id: 'background', label: 'Background', kind: 'text' },
  { id: 'url', label: 'Asset URL', kind: 'link-address' },
  { id: 'source', label: 'Source', kind: 'text' },
]);

export const ROLES = Object.freeze(['wordmark', 'mark']);
export const FORMATS = Object.freeze(['svg', 'png']);

/** A row's fields, whether the list answered it as { id, values } or the record store as { id, value }. */
export function fieldsOf(row) {
  const fields = row?.values ?? row?.value;
  return fields && typeof fields === 'object' ? fields : {};
}

/** A usable asset address: HTTPS with no credentials. */
export function safeAssetUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s/?#]+\/[^\s]*$/i.test(url)) return null;
  const parsed = new URL(url);
  return parsed.username || parsed.password ? null : url;
}

/** The family the selection row names, else null. */
export function selectedFamily(rows) {
  return rows.map(fieldsOf).find(fields => fields.role === 'selection')?.family ?? null;
}

/** The variant of the selected family a `tone` page draws for `role` and `format`, or null. */
export function assetForBrand(rows, { role, format, tone = 'light' }) {
  const family = selectedFamily(rows);
  if (!family) return null;
  const colour = tone === 'dark' ? 'white' : 'black';
  const background = role === 'mark' ? (tone === 'dark' ? 'black' : 'white') : 'transparent';
  const variant = rows.find(row => {
    const fields = fieldsOf(row);
    return fields.family === family && fields.role === role && fields.format === format
      && fields.background === `${colour} on ${background}`;
  });
  const url = safeAssetUrl(fieldsOf(variant).url);
  return url ? { url, row_id: variant.id, family } : null;
}

/** Every variant for both tones, and the ones a `tone` page draws. */
export function presentationFromBrand(rows, tone = 'light') {
  const forTone = which => Object.fromEntries(ROLES.flatMap(role => FORMATS.map(format =>
    [`${role}_${format}`, assetForBrand(rows, { role, format, tone: which })])));
  return { family: selectedFamily(rows), tone, variants: { light: forTone('light'), dark: forTone('dark') }, chosen: forTone(tone) };
}
