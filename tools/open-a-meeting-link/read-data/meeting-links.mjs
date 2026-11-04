// tools/open-a-meeting-link/read-data/meeting-links.mjs
//
// Purpose
//   Reads a meeting link (a deep link or a web address) through the declared routes in read-data/meeting-links.json:
//   which meeting app it is for, what it asks (join, start, schedule, launch ...) and its parameters, with the host
//   checked first. tool:read-meeting-link gives an agent the same road a button has, and `applyRoster` keeps a roster
//   current from full and incremental attendee updates. The rows run it on the person's computer:
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/open-a-meeting-link/read-data/meeting-links.mjs read|open
//
// Non-negotiable invariants
//   1. Routes, hosts, actions, parameters and words are DATA; this file names no meeting app.
//   2. The host is checked against the route's allow-list before any parameter is read. An allowed scheme on a host
//      that is not listed is refused, whatever its parameters say.
//   3. Only parameters the action names are kept, each only if it has the route's form; a parameter that fails its form
//      refuses the link rather than being cleaned up.
//   4. Secret parameters (passcodes, payloads) are returned for use and their names listed in `secret_params`; `redacted`
//      is the link for logs, with their values hidden.
//
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const linkSettings = () => JSON.parse(readFileSync(path.join(HERE, 'meeting-links.json'), 'utf8'));
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

/** { route, action, params, secret_params, redacted } for a link, or throws with a reason. */
export function readLink(text, settings = linkSettings()) {
  let url;
  try { url = new URL(String(text).trim()); } catch { throw refuse(settings.words.not_a_link); }
  const scheme = url.protocol.replace(/:$/, '');
  const routes = settings.routes.filter(row => row.schemes.includes(scheme));
  if (!routes.length) throw refuse(fill(settings.words.no_route, { scheme }));
  const route = routes.find(row => row.hosts.some(pattern => new RegExp(pattern, 'i').test(url.hostname)));
  if (!route) throw refuse(fill(settings.words.host_refused, { host: url.hostname }));
  const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
  const action = route.action_from === 'query' ? url.searchParams.get('action') ?? '' : first;
  const rule = route.actions[action];
  if (!rule) throw refuse(fill(settings.words.no_action, { action }));
  const params = {};
  for (const name of rule.params) {
    const value = url.searchParams.get(name);
    if (value === null || value === '') continue;
    if (!new RegExp(route.params[name].match).test(value)) throw refuse(fill(settings.words.bad_param, { name }));
    params[name] = value;
  }
  for (const name of rule.needs) if (!(name in params)) throw refuse(fill(settings.words.needs, { action, name }));
  const secret = Object.keys(params).filter(name => route.params[name].secret);
  const redacted = `${scheme}://${url.hostname}/${action}?${Object.entries(params).map(([name, value]) => `${name}=${secret.includes(name) ? '***' : value}`).join('&')}`;
  return { route: route.id, action, params, secret_params: secret, redacted };
}

/** The roster after an update: { mode: 'full', attendees } replaces it; { mode: 'incremental', attendees, removed } adds or changes by id and removes by id. */
export function applyRoster(roster, update) {
  if (update.mode === 'full') return Object.fromEntries((update.attendees ?? []).map(person => [person.id, person]));
  const next = { ...roster };
  for (const person of update.attendees ?? []) next[person.id] = { ...next[person.id], ...person };
  for (const id of update.removed ?? []) delete next[id];
  return next;
}

const openLink = link => new Promise((resolve, reject) => execFile('/usr/bin/open', [link], error => (error ? reject(error) : resolve())));

export const linkTools = {
  /** { link } -> the link is read first (refused links are never opened), then handed to the app that owns it: { opened, redacted } */
  async open(input, { open = openLink } = {}) {
    const read = readLink(input.link);
    await open(String(input.link).trim());
    return { opened: true, route: read.route, action: read.action, redacted: read.redacted };
  },
  /** { link } -> { route, action, params (secrets hidden), secret_params, redacted } */
  async read(input) {
    const read = readLink(input.link);
    return { ...read, params: Object.fromEntries(Object.entries(read.params).filter(([name]) => !read.secret_params.includes(name))) };
  },
};

/** tool:read-meeting-link and tool:open-meeting-link as the named exports run-an-export calls. */
export const read = input => linkTools.read(input);
export const open = input => linkTools.open(input);
