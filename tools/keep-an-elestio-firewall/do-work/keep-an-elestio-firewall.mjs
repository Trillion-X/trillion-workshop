#!/usr/bin/env node
// tools/keep-an-elestio-firewall/do-work/keep-an-elestio-firewall.mjs
//
// PURPOSE: tool:keep-an-elestio-firewall, run in the tool container. Reads the request on stdin ({ email, project_id, vm_id,
// rules, apply?, wait_seconds?, poll_seconds? }) and makes one Elestio service's firewall equal the rules it is given:
// 1. trades the vault's Elestio API token (descriptor 4, elestio-api-key) for a session (auth/checkAPIToken);
// 2. reads whether the firewall is on (servers/getServerDetails, isFirewallActivated) and, when it is, its rules
//    (servers/DoActionOnServer, action getFirewallRules);
// 3. when apply is not false and the firewall is off or its rules differ, sends the whole rule set: enableFirewall when it
//    is off, updateFirewall when it is on (both replace every rule; a dashboard tool port not in the rules is closed);
// 4. reads both back every poll_seconds until the firewall is on with exactly the rules, or wait_seconds pass.
// The rules are the caller's DATA (each computer's row); this file holds none of them. It refuses, before any call, a rule
// set that leaves out a port Elestio's own control needs open to everyone (22/tcp: its automation's SSH; 4242/udp: its
// Nebula private network), so the tool cannot cut Elestio off from the computer. The way back from a bad set is the same
// tool with a corrected set, or Elestio's disableFirewall (dashboard or its API). No answer or error carries the token or
// the session.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elest.io/api';
const HELD_DESCRIPTOR = 4;
const EVERYONE = ['0.0.0.0/0', '::/0'];
// The ports Elestio's control reaches the computer on; Elestio refuses other targets for them (its network firewall page
// and its Terraform provider, read Nov 25 2026).
export const ELESTIO_NEEDS = [
  { type: 'INPUT', port: '22', protocol: 'tcp', targets: EVERYONE },
  { type: 'INPUT', port: '4242', protocol: 'udp', targets: EVERYONE },
];

// One rule in one spelling: type upper case, port a string, protocol lower case, targets sorted and unique.
export const normal = rule => ({
  type: String(rule?.type ?? 'INPUT').toUpperCase(),
  port: String(rule?.port ?? '').trim(),
  protocol: String(rule?.protocol ?? '').toLowerCase(),
  targets: [...new Set((Array.isArray(rule?.targets) ? rule.targets : String(rule?.targets ?? '').split(','))
    .map(target => String(target).trim()).filter(Boolean))].sort(),
});
const keyOf = rule => `${rule.type}|${rule.port}|${rule.protocol}|${rule.targets.join(',')}`;
const byKey = (a, b) => keyOf(a).localeCompare(keyOf(b));

/** The rule set as given, in one spelling, or a refusal naming the first rule that is wrong. */
export function checkedRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('rules must be a list of at least the ports Elestio needs');
  const checked = rules.map(normal);
  for (const rule of checked) {
    if (!['INPUT', 'OUTPUT'].includes(rule.type)) throw new Error(`rule ${keyOf(rule)}: type must be INPUT or OUTPUT`);
    if (!/^\d{1,5}(-\d{1,5})?$/.test(rule.port) || rule.port.split('-').some(n => +n < 1 || +n > 65535)) throw new Error(`rule ${keyOf(rule)}: port must be a port or a range of ports`);
    if (!['tcp', 'udp'].includes(rule.protocol)) throw new Error(`rule ${keyOf(rule)}: protocol must be tcp or udp`);
    if (rule.targets.length === 0) throw new Error(`rule ${keyOf(rule)}: targets must name at least one address or range`);
    if (rule.targets.some(target => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(target))) throw new Error(`rule ${keyOf(rule)}: each target must be an IP address or a CIDR range`);
  }
  for (const need of ELESTIO_NEEDS.map(normal)) {
    const given = checked.find(rule => rule.type === need.type && rule.port === need.port && rule.protocol === need.protocol);
    if (!given || keyOf(given) !== keyOf(need)) throw new Error(`rules must keep ${need.port}/${need.protocol} open to ${EVERYONE.join(' and ')}: Elestio reaches the computer on it`);
  }
  const keys = checked.map(keyOf);
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice) throw new Error(`rule ${twice} is given twice`);
  return checked.sort(byKey);
}

// The rule set an answer holds: { rules }, { data: { rules } }, { data: [...] } or a bare list.
const rulesIn = json => {
  const rules = json?.rules ?? json?.data?.rules ?? (Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null);
  if (!Array.isArray(rules)) throw new Error('getFirewallRules answered no list of rules');
  return rules.map(normal).sort(byKey);
};

// The service's own refusal words, with anything long and key-like masked.
const refusal = (step, status, json, text) => {
  const said = json?.message ?? json?.details ?? json?.error ?? text;
  return new Error(`${step} answered ${status}: ${String(said ?? '').slice(0, 300).replace(/[A-Za-z0-9_\-.]{24,}/g, '<masked>')}`);
};

/** Sends one JSON POST to the Elestio API and returns its JSON; refuses a non-2xx answer or an answer with status KO. */
export function makeElestio({ send = fetch } = {}) {
  return async (step, path, body) => {
    const answer = await send(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await answer.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!answer.ok || json === null || json.status === 'KO') throw refusal(step, answer.status, json, text);
    return json;
  };
}

/** The firewall answer for one request. `read` gives the held token, `post` sends one API call, `wait` waits ms, `now` is ms. */
export async function keepAnElestioFirewall(request, {
  read = () => readFileSync(HELD_DESCRIPTOR, 'utf8'),
  post = makeElestio(),
  wait = ms => new Promise(done => setTimeout(done, ms)),
  now = () => Date.now(),
} = {}) {
  const { email, project_id: projectID, vm_id: vmID } = request;
  const want = checkedRules(request.rules);
  const apply = request.apply !== false;
  const waitMs = (request.wait_seconds ?? 300) * 1000;
  const pollMs = (request.poll_seconds ?? 5) * 1000;

  const token = read().trim();
  if (!token) throw new Error('the held Elestio token is empty: put elestio-api-key in the vault of the computer that runs this');
  const { jwt } = await post('auth/checkAPIToken', 'auth/checkAPIToken', { email, token });
  if (typeof jwt !== 'string' || !jwt) throw new Error('auth/checkAPIToken answered no session');
  const ids = { jwt, vmID: String(vmID) };

  const state = async () => {
    const details = await post('getServerDetails', 'servers/getServerDetails', { ...ids, projectID: String(projectID) });
    const service = (details.serviceInfos ?? [details.data ?? details]).flat()[0];
    if (!service || String(service.vmID ?? vmID) !== String(vmID)) throw new Error(`getServerDetails answered no service ${vmID}`);
    const on = Number(service.isFirewallActivated) === 1;
    const rules = on ? rulesIn(await post('getFirewallRules', 'servers/DoActionOnServer', { ...ids, action: 'getFirewallRules' })) : [];
    return { on, rules };
  };
  const difference = rules => ({
    open: want.filter(rule => !rules.some(have => keyOf(have) === keyOf(rule))),
    close: rules.filter(have => !want.some(rule => keyOf(rule) === keyOf(have))),
  });

  const before = await state();
  const owed = difference(before.rules);
  const same = before.on && owed.open.length === 0 && owed.close.length === 0;
  const action = same || !apply ? null : before.on ? 'updateFirewall' : 'enableFirewall';
  const askedAt = now();
  if (action) await post(action, 'servers/DoActionOnServer', { ...ids, action, rules: want });

  let after = before, reads = 0;
  if (action) {
    for (;;) {
      after = await state();
      reads += 1;
      const left = difference(after.rules);
      if ((after.on && left.open.length === 0 && left.close.length === 0) || now() - askedAt >= waitMs) break;
      await wait(pollMs);
    }
  }
  const left = difference(after.rules);
  const ok = after.on && left.open.length === 0 && left.close.length === 0;
  const reason = ok ? null
    : !apply ? 'apply was false: nothing was sent'
    : !after.on ? `the firewall is still off after ${Math.round(waitMs / 1000)} s`
    : `the rules still differ after ${Math.round(waitMs / 1000)} s`;
  return {
    ok,
    vm_id: String(vmID),
    action,
    before: { on: before.on, rules: before.rules },
    after: { on: after.on, rules: after.rules },
    opened: action ? owed.open : [],
    closed: action && before.on ? owed.close : [],
    still_differs: ok ? null : left,
    asked_at: action ? new Date(askedAt).toISOString() : null,
    seconds: action ? Math.round((now() - askedAt) / 1000) : 0,
    reads,
    ...(reason ? { reason } : {}),
  };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  keepAnElestioFirewall(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
