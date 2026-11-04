// Published configurations keep references to their source items. An installation keeps only this identity.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import trust from './marketplace-trust.json' with { type: 'json' };

const required = (value, label, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} needs text.`);
  return value.trim();
};
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const configurationIdentity = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(stable(value)))))}`;

export function configurationOf(input, installableKinds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Describe what people can install.');
  const slug = required(input.slug, 'The link name', 80).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('The link name uses letters, numbers and hyphens.');
  const title = required(input.title, 'The name', 120);
  const description = required(input.description, 'What it does', 1000);
  if (!Array.isArray(input.components) || !input.components.length || input.components.length > 100) throw new Error('Choose between 1 and 100 things to include.');
  const allowed = new Set(installableKinds);
  const seen = new Set();
  const components = input.components.map(component => {
    const kind = required(component?.kind, 'The kind', 80);
    const id = required(component?.id, 'The item', 200);
    const version = required(component?.version, 'The item version', 100);
    if (!allowed.has(kind)) throw new Error(`${kind} cannot be installed from the Marketplace.`);
    const key = `${kind}/${id}`;
    if (seen.has(key)) throw new Error(`${id} is included twice.`);
    seen.add(key);
    return { kind, id, version };
  });
  if (input.project_data?.lists?.length) throw new Error('This configuration cannot install project lists. Include a public app that declares the records it accepts.');
  const content = { slug, title, description, components };
  const version = configurationIdentity(content);
  return { ...content, version, id: `${slug}@${version.slice(3, 27)}` };
}

const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() ?? null;
const humanKind = kind => firstText(kind?.one, kind?.label) ?? String(kind?.id ?? 'item').replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export function publicComponentSummary(component, source, kind) {
  const type = humanKind(kind ?? { id: component?.kind });
  const title = firstText(source?.title, source?.label, source?.name) ?? type;
  const description = firstText(source?.description, source?.job, source?.summary)
    ?? `A ${type.toLowerCase()} you can install in Trillion.`;
  return { kind: type, title, description };
}

export function publicConfiguration(row, origin, componentSources = []) {
  if (!row?.id || !row?.version) return null;
  const sourceByComponent = new Map(componentSources.map(source => [`${source.component?.kind}:${source.component?.id}`, source]));
  return { id: row.id, version: row.version, title: row.title, description: row.description, ...(trust.dispositions.includes(row.disposition) ? { disposition: row.disposition } : {}),
    components: row.components.map(component => {
      const source = sourceByComponent.get(`${component.kind}:${component.id}`);
      return publicComponentSummary(component, source?.row, source?.kind);
    }),
    made_by: row.made_by ?? null, url: `${origin}/marketplace/${encodeURIComponent(row.id)}` };
}

// `follows` (a slug) makes the installation stand for whichever version of that configuration Trillion ships (a row of
// Trillion's own starting set, src/starting-catalog.mjs); `without` lists component ids the person removed from it.
export function installedConfiguration(row, context, actor, at = new Date().toISOString(), pursuitId = null, { follows = null, without = null, policy = trust.install_policy } = {}) {
  if (!row?.id || !row?.version) throw new Error('This Marketplace listing is unavailable.');
  // The version's own trust disposition decides against the install policy, and is recorded on the installation.
  const disposition = trust.dispositions.includes(row.disposition) ? row.disposition : trust.unrated;
  if (policy.refuse.includes(disposition)) throw new Error(trust.words[disposition === 'blocked' ? 'refused' : 'refused_by_policy'].replace('{title}', row.title ?? row.id).replace('{version}', row.version).replace('{disposition}', disposition));
  if (context !== 'private' && (typeof context !== 'string' || !context.startsWith('space:'))) throw new Error('Choose your account or a Space.');
  if (pursuitId !== null && (context !== 'private' || typeof pursuitId !== 'string' || !pursuitId.startsWith('pursuit:')))
    throw new Error('Choose one of your pursuits.');
  return { id: pursuitId ? `marketplace-install:pursuit:${pursuitId}:${row.id}` : `marketplace-install:${context}:${row.id}`,
    configuration_id: row.id, title: row.title, version: row.version, disposition, context, ...(pursuitId ? { pursuit_id: pursuitId } : {}),
    components: row.components.map(({ kind, id, version }) => ({ kind, id, version })),
    ...(follows ? { follows, without: without ?? [] } : without?.length ? { without } : {}),
    installed_by: actor, installed_at: at };
}
