// A placed capability is a versioned reference, never executable page source.
// This owner admits the public-app visitor action already supported by the
// installation. Other capability kinds remain closed until their owner supplies
// a render and action adapter with current viewer authorization.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedPublicPublishedReference, publicPublishedCapabilityAdapter } from './public-app-published-contract.mjs';

// A placement's id is also its tool name in AI apps (src/public-app-mcp.mjs), which take at most 64 characters.
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^1f:[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Only words and a shared appearance choice may be authored on a public card.
// The source link and available operations always come from the published owner.
export function checkedPublicCardPresentation(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(key => !['title', 'description', 'style'].includes(key)) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 ||
      typeof value.description !== 'string' || !value.description.trim() || value.description.length > 600 ||
      !['card', 'plain'].includes(value.style)) throw new Error('Give this public card a title, description and appearance.');
  return { title: value.title.trim(), description: value.description.trim(), style: value.style };
}

// The words a visitor-action form shows are DATA on its placement: a heading, a line under it, the button's words,
// what the visitor reads once it is sent, and per field a label and whether the page's own address fills it
// (from_page_address names the query parameter, like from for ?from=front-door, so each printed code counts apart).
const WORDS = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
export function checkedVisitorFormPresentation(value, action) {
  if (value === undefined) return undefined;
  const keys = ['title', 'description', 'submit_label', 'done_message', 'fields'];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) ||
      (value.title !== undefined && !WORDS(value.title, 120)) || (value.description !== undefined && !WORDS(value.description, 600)) ||
      (value.submit_label !== undefined && !WORDS(value.submit_label, 40)) || (value.done_message !== undefined && !WORDS(value.done_message, 300)) ||
      (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > 40))) {
    throw new Error('Give this form short words: a title, description, button words, a thank-you line and field labels.');
  }
  const seen = new Set();
  const fields = value.fields?.map(field => {
    if (!object(field) || Object.keys(field).some(key => !['id', 'label', 'from_page_address', 'multiline', 'repeatable', 'add_label', 'remove_label'].includes(key)) ||
        !action.fields.some(row => row.id === field.id) || seen.has(field.id) ||
        (field.label !== undefined && !WORDS(field.label, 80)) ||
        (field.from_page_address !== undefined && !/^[a-z][a-z0-9_-]{0,39}$/.test(field.from_page_address)) ||
        (field.multiline !== undefined && typeof field.multiline !== 'boolean') ||
        (field.repeatable !== undefined && typeof field.repeatable !== 'boolean') ||
        (field.add_label !== undefined && (!WORDS(field.add_label, 80) || field.repeatable !== true)) ||
        (field.remove_label !== undefined && (!WORDS(field.remove_label, 80) || field.repeatable !== true)) ||
        ((field.multiline !== undefined || field.repeatable !== undefined) && action.fields.find(row => row.id === field.id)?.type !== 'text') ||
        (field.multiline === true && field.repeatable === true) ||
        (field.from_page_address !== undefined && (field.multiline === true || field.repeatable === true))) {
      throw new Error(`Each form field must be one of the ${action.id} action's fields, named once, with a short label.`);
    }
    seen.add(field.id);
    return { id: field.id, ...(field.label ? { label: field.label.trim() } : {}), ...(field.from_page_address ? { from_page_address: field.from_page_address } : {}),
      ...(field.multiline === true ? { multiline: true } : {}), ...(field.repeatable === true ? { repeatable: true } : {}),
      ...(field.add_label ? { add_label: field.add_label.trim() } : {}), ...(field.remove_label ? { remove_label: field.remove_label.trim() } : {}) };
  });
  return Object.fromEntries(Object.entries({ title: value.title?.trim(), description: value.description?.trim(),
    submit_label: value.submit_label?.trim(), done_message: value.done_message?.trim(), fields }).filter(([, item]) => item !== undefined));
}

export function publicAppActionVersion(action) {
  return `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(action))))}`;
}

// Version of the read-only installation response view contract. Its contents
// remain current records behind the installation's authenticated owner check.
export const publicAppRecordsCapabilityVersion = `1f:${bytesToHex(blake3(new TextEncoder().encode('public-app-installation-records:responses')) )}`;

export function checkedPlacedCapabilities(value, { files, actions } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error('Give up to 100 placed capabilities.');
  const seen = new Set();
  return value.map(row => {
    if (!object(row) || Object.keys(row).some(key => !['id', 'page_path', 'access', 'capability', 'presentation'].includes(key)) || !ID.test(row.id ?? '') || seen.has(row.id)) {
      throw new Error('Each placed capability needs a distinct valid id.');
    }
    seen.add(row.id);
    if (typeof row.page_path !== 'string' || !own(files ?? {}, row.page_path) || !row.page_path.endsWith('.html')) {
      throw new Error(`The ${row.id} capability needs an app page.`);
    }
    if (!['public', 'signed-in'].includes(row.access)) throw new Error(`The ${row.id} capability needs an access setting.`);
    const ref = row.capability;
    // A visitor action belongs to this same app, so its version is worked out here when the caller leaves it out;
    // a version that is given must still be the current one.
    const ownAction = object(ref) && ref.kind === 'visitor-action' ? actions?.find(item => item.id === ref.id) : undefined;
    const version = ownAction && ref.version === undefined ? publicAppActionVersion(ownAction) : ref?.version;
    if (!object(ref) || Object.keys(ref).some(key => !['kind', 'id', 'version', 'operation'].includes(key)) || !ID.test(ref.kind ?? '') || typeof ref.id !== 'string' || ref.id.length > 200 || !VERSION.test(version ?? '') ||
        (ref.operation !== undefined && !['open', 'run'].includes(ref.operation))) {
      throw new Error(`The ${row.id} capability reference is invalid.`);
    }
    if (ref.operation === 'run' && row.access !== 'public') throw new Error(`The ${row.id} run operation needs public access.`);
    if (row.presentation !== undefined && ref.kind !== 'visitor-action' && (row.access !== 'public' || !publicPublishedCapabilityAdapter(ref.kind))) {
      throw new Error(`The ${row.id} public card needs a published source and public access.`);
    }
    let presentation = ref.kind === 'visitor-action' ? undefined : checkedPublicCardPresentation(row.presentation);
    if (ref.kind === 'visitor-action') {
      if (row.access !== 'public') throw new Error(`The ${row.id} visitor action is already public; choose a private capability for signed-in access.`);
      if (!ownAction || publicAppActionVersion(ownAction) !== version) throw new Error(`The ${row.id} action changed or is unavailable.`);
      presentation = checkedVisitorFormPresentation(row.presentation, ownAction);
    } else if (ref.kind === 'installation-records') {
      if (row.access !== 'signed-in' || ref.id !== 'responses' || ref.version !== publicAppRecordsCapabilityVersion) {
        throw new Error(`The ${row.id} responses require signed-in access and the current capability version.`);
      }
    } else if (checkedPublicPublishedReference(ref, row.access)) {
      // The source owner is rechecked when a visitor reads the placement.
    } else if (row.access === 'public') {
      throw new Error(`The ${row.id} capability cannot be used by public visitors.`);
    }
    return { id: row.id, page_path: row.page_path, access: row.access,
      capability: { kind: ref.kind, id: ref.id, version, ...(ref.operation ? { operation: ref.operation } : {}) },
      ...(presentation ? { presentation } : {}) };
  });
}

export function currentPlacedCapability(route, installed, placementId, { signedIn = false } = {}) {
  if (installed?.status !== 'active') return null;
  const row = route.placed_capabilities?.find(item => item.id === placementId);
  if (!row || (row.access !== 'public' && !signedIn)) return null;
  if (row.capability.kind === 'installation-records') return signedIn && row.access === 'signed-in'
    && row.capability.id === 'responses' && row.capability.version === publicAppRecordsCapabilityVersion
    ? { placement: row, kind: 'installation-records' } : null;
  if (publicPublishedCapabilityAdapter(row.capability.kind)) return row.access === 'public'
    ? { placement: row, kind: 'published-reference' } : null;
  if (row.capability.kind !== 'visitor-action' || row.access !== 'public') return null;
  const action = installed.definition?.actions?.find(item => item.id === row.capability.id);
  if (!action || publicAppActionVersion(action) !== row.capability.version) return null;
  return { placement: row, kind: 'visitor-action', action };
}
