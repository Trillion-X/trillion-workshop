// Names supplied while making an account are profile facts, not proof of legal identity.
// Keep the complete display name and optional parts independently. A legacy email-shaped
// account label supplies no human name; never split a display name or email into parts.
export const PROFILE_NAME_FIELDS = Object.freeze(['name', 'given_name', 'family_name']);
const text = value => typeof value === 'string' ? value.trim() : '';
const email = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

export function suppliedProfileNames(input = {}) {
  const names = Object.fromEntries(PROFILE_NAME_FIELDS.flatMap(field => {
    const value = text(input?.[field]);
    const most = field === 'name' ? 1024 : 256;
    if ([...value].length > most) throw new Error(`${field} must be ${most} characters or fewer.`);
    return value && !(field === 'name' && email(value)) ? [[field, value]] : [];
  }));
  if (!names.name && (names.given_name || names.family_name)) names.name = [names.given_name, names.family_name].filter(Boolean).join(' ');
  return names;
}

// A connected account's label that reads as a person's name: two or more words of letters, no '@', no digits. Labels that
// read as an address or a handle are not evidence of a name, so they neither supply one nor conflict with one. Every
// person-like label must be the same; two different names give no name at all.
const PERSON_LABEL = /^[\p{L}'’-]+(?:\s+[\p{L}'’-]+)+$/u;
export function connectedPersonName(rows) {
  const names = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = text(row?.account_label).replace(/\s+/g, ' ');
    if (PERSON_LABEL.test(label)) names.set(label.toLowerCase(), label);
  }
  return names.size === 1 ? [...names.values()][0] : null;
}

// The name the setup read uses, from the first owner that holds one in `order` (the identity requirement's `name_from` in
// src/setup-policy.json). The person's own saved name always comes first when it is there. `sources` maps each other owner
// to what it holds: { name, given_name?, family_name? }. `keep` says the name came from elsewhere and the person has not
// written a name of their own, so Trillion may keep it as its filled name; a name the person wrote is never replaced.
// A profile that could not be read (null) gives no name at all: what the person wrote is unknown.
export function profileNameFrom({ order = ['profile'], profile, sources = {}, written = [] }) {
  if (profile === null) return { name: null, name_from: null, given_name: null, family_name: null, keep: false };
  const own = object(profile) ? profile : {};
  for (const source of order) {
    const found = source === 'profile' ? { name: own.name, given_name: own.given_name, family_name: own.family_name } : sources[source];
    // An account label that is an address names no person; it is skipped so no later owner splits it into name parts.
    const name = email(text(found?.name)) ? '' : text(found?.name);
    if (!name) continue;
    const other = source !== 'profile';
    return { name, name_from: source,
      given_name: text(own.given_name) || (other ? text(found.given_name) : ''),
      family_name: text(own.family_name) || (other ? text(found.family_name) : ''),
      keep: other && !written.includes('name') };
  }
  return { name: '', name_from: null, given_name: text(own.given_name), family_name: text(own.family_name), keep: false };
}
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Making an account needs a first and a last name (signing in to one never does). Whitespace alone is blank.
export const SIGNUP_NAMES_NEEDED = 'Enter your first name and last name.';
export const signupNamesComplete = names => Boolean(text(names?.given_name) && text(names?.family_name));

export const signupNamesKey = accountId => `account-profile-names:${accountId}`;

// Read only the bounded envelope written by the authentication owner. Its method
// and original time describe self-supplied facts, never legal identity verification.
export function checkedSignupNames(value, accountId) {
  if (typeof accountId !== 'string' || !accountId.trim() || !value || value.schema !== 'trillion.signup-names/v1' || value.account_id !== accountId
    || !['password', 'passkey'].includes(value.method) || typeof value.at !== 'string' || value.at.length > 40 || !Number.isFinite(Date.parse(value.at))) return null;
  try { return { schema: value.schema, account_id: accountId, names: suppliedProfileNames(value.names), method: value.method, at: value.at }; }
  catch { return null; }
}

// Called only after signup succeeds, using the password request or the held CREATE
// challenge. Existing account edits, including an explicit blank, stay authoritative.
// This also records same-value confirmation of a previously automatic display name.
export function keepSignupNames(current, input, method, at) {
  if (!['password', 'passkey'].includes(method)) return current;
  const names = suppliedProfileNames(input);
  const written = new Set(current.written ?? []);
  const sources = { ...(current.name_sources ?? {}) }, changes = {};
  for (const [field, value] of Object.entries(names)) {
    if (written.has(field)) continue;
    // An older account may predate written/filled metadata. Preserve its actual edit.
    if (text(current[field]) && current[field] !== value && current[field] !== current.filled?.[field]) continue;
    changes[field] = value;
    sources[field] = { kind: 'signup', method, at };
    written.add(field);
  }
  return Object.keys(changes).length ? { ...current, ...changes, written: [...written], name_sources: sources } : current;
}

// A name that is only the account's handle: one token equal to the part of the email before the "@" (or the placeholder
// Trillion wrote before it knew a name). It tells nobody who the person is, so a real name may replace it.
export function handleOnlyName(name, accountEmail) {
  const value = text(name).toLowerCase();
  if (!value) return false;
  if (value === 'member') return true;
  if (/\s/.test(value)) return false;
  const local = text(accountEmail).toLowerCase().split('@')[0];
  return Boolean(local) && (value === local || value.replace(/[^a-z0-9]/g, '') === local.replace(/[^a-z0-9]/g, ''));
}

// What a purchase says about its buyer, from a checkout: the full name, and first/last only where Stripe gives them as
// separate fields (customer_details.individual_name). A full name is never split into parts here.
export function purchaseNames(attributes = {}) {
  const pick = value => text(value) && !email(text(value)) ? text(value) : '';
  const given_name = pick(attributes.customer_given_name), family_name = pick(attributes.customer_family_name);
  const name = pick(attributes.customer_name) || [given_name, family_name].filter(Boolean).join(' ');
  return Object.fromEntries(Object.entries({ name, given_name, family_name }).filter(([, value]) => value));
}

// Keeps the buyer's name from their purchase where the profile has none worth keeping. A field the person wrote (a profile
// edit or sign-up) is never replaced; a field that is empty, only a handle, or still what Trillion filled is. When the
// purchase gave only a full name, the parts stay empty and the full name is marked as such so the person's AI can confirm
// the parts (network_profile given_name/family_name) instead of Trillion guessing a split.
export function keepPurchaseNames(current, input, accountEmail, at) {
  const names = purchaseNames(input);
  if (!Object.keys(names).length) return current;
  const written = new Set(current.written ?? []);
  const sources = { ...(current.name_sources ?? {}) }, changes = {};
  const theirs = field => ['profile-edit', 'signup'].includes(sources[field]?.kind);
  const replaceable = field => {
    if (theirs(field)) return false;
    const held = text(current[field]);
    if (!held || held === current.filled?.[field]) return true;
    return field === 'name' && handleOnlyName(held, accountEmail) && sources.name?.kind !== 'purchase';
  };
  for (const [field, value] of Object.entries(names)) {
    if (!replaceable(field) || current[field] === value) continue;
    changes[field] = value;
    sources[field] = { kind: 'purchase', at, ...(field === 'name' && !names.given_name && !names.family_name && !text(current.given_name) && !text(current.family_name) ? { parts_unknown: true } : {}) };
    written.add(field);
  }
  return Object.keys(changes).length ? { ...current, ...changes, written: [...written], name_sources: sources } : current;
}
