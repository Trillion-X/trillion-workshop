// computer/offered-endpoints.mjs
//
// Purpose
//   A person's other computers can offer a model server to this one by publishing a short text file of addresses. This
//   module reads those files, accepts only the addresses whose host the person allowed, and gives them to
//   computer/local-models.mjs as more rows to try after this computer's own servers, so a Mac mini in the next room can
//   answer when the laptop's model is busy, and the answer says which road served it.
//
// Non-negotiable invariants
//   1. An offered address is accepted only when its scheme and its host are allowed by DATA (computer/offered-endpoints.json
//      and the person's own set); a file can never widen what is allowed, and the default allows only this computer.
//   2. Reading an offered file is bounded (bytes, seconds, lines) and a file that cannot be read offers nothing; it never
//      stops this computer's own servers from answering.
//   3. What each set offered, accepted and refused (with the reason) is told in the read's report, never dropped silently.
//   4. The person's sets are their own file (`file`); this module only reads it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import settings from './offered-endpoints.json' with { type: 'json' };
import { hostWithin } from '../http-client/do-work/same-origin.mjs';

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
const home = path => path.replace(/^~(?=\/|$)/, homedir());
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sameHost = (host, pattern) => host === pattern || (hostWithin(host, pattern) && hostWithin(pattern, host));
const hostMatches = (host, pattern) => pattern.startsWith('*.')
  ? hostWithin(host, pattern.slice(2)) && !sameHost(host, pattern.slice(2))
  : sameHost(host, pattern);

/** The person's sets (an empty list when they keep none). */
export function setsIn(file = settings.file, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(home(file), 'utf8'));
    return Array.isArray(parsed?.sets) ? parsed.sets.filter(isObject) : [];
  } catch { return []; }
}

/** The addresses a set's offered text may use: { accepted: [url], refused: [{ line, why }] }. Pure. */
export function acceptOffered(text, set, rules = settings) {
  const allowed = Array.isArray(set.allowed_hosts) && set.allowed_hosts.length ? set.allowed_hosts : rules.default_allowed_hosts;
  const accepted = [];
  const refused = [];
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const line of lines) {
    if (accepted.length >= rules.most_endpoints) { refused.push({ line: '', why: fill(rules.words.too_many_lines, { most: rules.most_endpoints }) }); break; }
    let url;
    try { url = new URL(line); } catch { refused.push({ line, why: rules.words.not_an_address }); continue; }
    if (!rules.schemes.includes(url.protocol)) { refused.push({ line, why: fill(rules.words.bad_scheme, { scheme: url.protocol }) }); continue; }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowed.some(pattern => hostMatches(host, pattern))) { refused.push({ line, why: fill(rules.words.not_allowed, { host }) }); continue; }
    accepted.push(url.href);
  }
  return { accepted, refused };
}

/** The text a set is offered from (an https address or a path), bounded; throws the reason it cannot be read. */
export async function offeredText(set, { fetchImpl = fetch, read = readFileSync, rules = settings } = {}) {
  if (/^https?:\/\//.test(set.offered_from)) {
    const answer = await fetchImpl(set.offered_from, { signal: AbortSignal.timeout(rules.fetch_seconds * 1000) });
    if (!answer.ok) throw new Error(`answered ${answer.status}`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    return bytes.subarray(0, rules.most_bytes).toString('utf8');
  }
  return read(home(set.offered_from)).subarray(0, rules.most_bytes).toString('utf8');
}

/** Every set read now: [{ id, label, accepted, refused, note? }] and the rows to try (chat-row shaped, in set order). */
export async function readOffered({ sets = setsIn(), fetchImpl = fetch, read = readFileSync, rules = settings } = {}) {
  const report = [];
  const rows = [];
  for (const set of sets) {
    let seen;
    try { seen = acceptOffered(await offeredText(set, { fetchImpl, read, rules }), set, rules); }
    catch (error) { report.push({ id: set.id, label: set.label ?? set.id, accepted: [], refused: [], note: fill(rules.words.unreadable, { why: String(error.message ?? error) }) }); continue; }
    report.push({ id: set.id, label: set.label ?? set.id, ...seen });
    seen.accepted.forEach((url, index) => rows.push({ id: `offered:${set.id}:${index + 1}`, url, model: set.model, timeout_seconds: set.timeout_seconds ?? rules.default_timeout_seconds }));
  }
  return { report, rows };
}

