// parts/http-client/do-work/request-scopes.mjs
//
// PURPOSE
//   Turns a request template (a JSON object whose strings may hold {{name}} placeholders) into the request that is sent, and
//   says what was resolved, what stayed open and which secrets were placed. Used by any executor that sends a person's
//   own requests (computer/loopback-executor.mjs) so every one resolves the same way.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Ordered scopes: a name is read from the first scope that holds it, left to right. Secrets are appended last, so a
//      scope can never shadow or reach a secret.
//   2. A name no scope holds stays in the text as written ({{name}}) and is listed in `unresolved`. It is never guessed or blanked.
//   3. The stored template is never changed: the answer is a new snapshot; the caller keeps the template with its placeholders.
//   4. A secret is bound to the hosts it may be sent to (DATA on the secret: `hosts`, whole-label domain matches). It is placed only
//      when the request's host, read from the address after every ordinary variable is resolved and again from the written
//      address before, is inside one of them, and the address read after placing it names the same host. Otherwise it stays
//      as {{name}} and the answer says why.
//   5. Nothing here names a variable, a secret, a host or a service.
//
import settings from './request-scopes.json' with { type: 'json' };
import { hostWithin } from './same-origin.mjs';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDER = new RegExp(`${escape(settings.open)}\\s*([^{}\\s][^{}]*?)\\s*${escape(settings.close)}`, 'g');
const NAME = new RegExp(settings.name_pattern);

const hostOfUrl = text => { try { return new URL(text).hostname.toLowerCase(); } catch { return null; } };

/** `node` with every string's placeholders replaced by `replace(name)` (undefined leaves the placeholder as written). */
function walk(node, replace) {
  if (typeof node === 'string') return node.replace(PLACEHOLDER, (whole, name) => { const value = replace(name.trim()); return value === undefined ? whole : value; });
  if (Array.isArray(node)) return node.map(item => walk(item, replace));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, replace)]));
  return node;
}

const names = node => {
  const found = new Set();
  walk(node, name => { found.add(name); return undefined; });
  return [...found];
};

/**
 * @param template  the stored request, e.g. { url, method, headers, body }
 * @param scopes    [{ name, values: { key: string } }] in order, first holding a key wins
 * @param secrets   [{ name, value, hosts: [domain] }]
 * @returns { request, unresolved: [name], placed: [secret name], refused: [{ name, why }], values: [placed secret values] }
 */
export function resolveRequest(template, { scopes = [], secrets = [] } = {}) {
  const lookup = name => {
    for (const scope of scopes) if (scope?.values && Object.hasOwn(scope.values, name)) return String(scope.values[name]);
    return undefined;
  };
  // Phase 1: ordinary scopes only. A secret name that no scope holds stays open here.
  const ordinary = walk(template, lookup);
  const urlField = settings.request_url_field;
  const writtenHost = typeof template?.[urlField] === 'string' ? hostOfUrl(template[urlField]) : null;
  const readHost = typeof ordinary?.[urlField] === 'string' ? hostOfUrl(ordinary[urlField]) : null;

  const refused = [];
  const allowed = new Map();
  for (const secret of secrets) {
    if (!NAME.test(secret.name ?? '') || typeof secret.value !== 'string') continue;
    const hosts = secret.hosts ?? [];
    if (!readHost) { refused.push({ name: secret.name, why: settings.words.secret_url_unreadable.replace('{name}', secret.name) }); continue; }
    const within = host => hosts.some(domain => hostWithin(host, domain));
    // The written address is judged too when it names a host itself; a template whose host is a placeholder is judged once it is read.
    if (!within(readHost) || (writtenHost && !within(writtenHost))) {
      refused.push({ name: secret.name, why: fill(settings.words.secret_host_unbound, { name: secret.name, hosts: hosts.join(', ') || 'no host', host: readHost }) });
      continue;
    }
    allowed.set(secret.name, secret.value);
  }
  const placed = new Set();
  const request = walk(ordinary, name => { if (allowed.has(name)) { placed.add(name); return allowed.get(name); } return undefined; });
  // Placing a secret must not move the request to another host.
  if (placed.size && typeof request?.[urlField] === 'string' && hostOfUrl(request[urlField]) !== readHost) {
    const why = [...placed].map(name => ({ name, why: settings.words.secret_moved_host.replace('{name}', name) }));
    return { request: ordinary, unresolved: names(ordinary), placed: [], refused: [...refused, ...why], values: [] };
  }
  return { request, unresolved: names(request), placed: [...placed], refused, values: [...placed].map(name => allowed.get(name)) };
}

/** `node` with every secret value replaced by the mask. `keep` names keys whose subtree is left as it is (the response). */
export function scrubValues(node, values, { keep = settings.response_event_keys } = {}) {
  const secret = values.filter(value => typeof value === 'string' && value.length);
  const clean = (item, key) => {
    if (keep.includes(key)) return item;
    if (typeof item === 'string') return secret.reduce((text, value) => text.split(value).join(settings.mask), item);
    if (Array.isArray(item)) return item.map(entry => clean(entry));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, clean(v, k)]));
    return item;
  };
  return clean(node);
}
