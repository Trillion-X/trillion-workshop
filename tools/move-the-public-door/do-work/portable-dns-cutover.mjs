// tools/move-the-public-door/do-work/portable-dns-cutover.mjs
//
// Exact-host DNS placement owner. Credentials remain in the vault; unrelated records and Worker routes are preserved.
// The API base, auth header and vault name come from the DNS provider row (points_a_name in the person's Service connections list); the request
// shapes below are Cloudflare's zones/dns_records/workers API, the only DNS row so far.
// The receipt is one Public door receipts row (read-data/door-receipts.mjs), saved before every mutation.
import { isIP } from 'node:net';

/** provider: the DNS provider row (read-data/public-door-rows.mjs dnsProvider) whose base and auth header this uses. */
export function dnsClient(token, { fetchImpl = fetch, provider }) {
  if (!provider?.base || !provider.auth) throw Error('The DNS client needs its DNS provider row.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('The held DNS credential was refused.');
  return async (method, path, body) => {
    if (!['GET', 'PATCH', 'POST', 'PUT', 'DELETE'].includes(method) || !/^(?:zones(?:\?[^\r\n]*|\/[a-f0-9]{32}\/(?:dns_records(?:\/[a-f0-9]{32})?|workers\/routes)(?:\?[^\r\n]*)?)|accounts\/[a-f0-9]{32}\/workers\/domains(?:\/[a-f0-9]{32,64})?)$/.test(path)) throw Error('The DNS operation was refused.');
    const permitted = method === 'GET' || (method === 'PATCH' && /^zones\/[a-f0-9]{32}\/dns_records\/[a-f0-9]{32}$/.test(path)) || (method === 'POST' && /^zones\/[a-f0-9]{32}\/dns_records$/.test(path)) || (method === 'PUT' && /^accounts\/[a-f0-9]{32}\/workers\/domains$/.test(path)) || (method === 'DELETE' && /^(?:zones\/[a-f0-9]{32}\/dns_records\/[a-f0-9]{32}|accounts\/[a-f0-9]{32}\/workers\/domains\/[a-f0-9]{32,64})$/.test(path));
    if (!permitted) throw Error('The DNS mutation shape was refused.');
    const response = await fetchImpl(`${provider.base}/${path}`, { method, headers: { [provider.auth.header.toLowerCase()]: `${provider.auth.prefix}${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    let answer;
    try { answer = JSON.parse(text); } catch {
      // Workers custom-domain DELETE legitimately answers empty HTTP 200.
      // The caller still requires fresh absence and DNS readback before proceeding.
      if (method === 'DELETE' && response.status === 200 && text.trim() === '' && /^accounts\/[a-f0-9]{32}\/workers\/domains\/[a-f0-9]{32,64}$/.test(path)) return { success: true, result: null };
      throw Error(`DNS response was not JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || !answer.success) throw Error(`DNS ${method} was refused (HTTP ${response.status}; provider codes ${(answer.errors ?? []).map(x => Number(x.code)).join(',')}).`);
    return answer;
  };
}
function checked(c) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname) || isIP(c.address) !== 4) throw Error('The exact DNS placement was refused.');
}
function shape(row) { const { id, type, name, content, ttl, proxied, priority, data, settings, comment, tags } = row; return { id, type, name, content, ttl, proxied, priority, data, settings, comment, tags }; }
function equal(a, b) { return JSON.stringify(shape(a)) === JSON.stringify(shape(b)); }
async function rows(request, zone) {
  const result = []; let page = 1;
  for (;;) { const answer = await request('GET', `zones/${zone}/dns_records?per_page=100&page=${page}`); result.push(...answer.result); if (page >= (answer.result_info?.total_pages ?? 1)) break; page++; }
  return result;
}
async function snapshot(c, request, zone, account) {
  if (!zone) for (let n = 0, parts = c.hostname.split('.'); n < parts.length - 1; n++) { const answer = await request('GET', `zones?name=${encodeURIComponent(parts.slice(n).join('.'))}`); if (answer.result.length === 1) { zone = answer.result[0].id; account = answer.result[0].account.id; break; } }
  if (!/^[a-f0-9]{32}$/.test(zone)) throw Error('The exact DNS zone was not found.');
  return { zone, account, records: await rows(request, zone), routes: (await request('GET', `zones/${zone}/workers/routes`)).result, domains: (await request('GET', `accounts/${account}/workers/domains`)).result };
}
/** The cutover receipt `file` names, or an error saying none is kept under that name. */
export async function readCutover(receipts, file) {
  const receipt = await receipts.read(file);
  if (!receipt) throw Error(`No DNS cutover is kept as ${JSON.stringify(file)}.`);
  return receipt;
}
export async function prepareCutover(c, { request, receipts, file }) {
  checked(c);
  const old = await receipts.read(file);
  if (old) { if (old.hostname !== c.hostname || old.address !== c.address) throw Error('Saved cutover belongs to another placement.'); return old; }
  const before = await snapshot(c, request);
  const targets = before.records.filter(row => row.name === c.hostname && ['A', 'AAAA', 'CNAME'].includes(row.type));
  const domain = before.domains.find(x => x.hostname === c.hostname);
  const managed = targets.length === 1 && targets[0].meta?.read_only && domain?.id === targets[0].meta?.origin_worker_id && domain?.environment === 'production';
  if (targets.length !== 1 || (!managed && !['A', 'CNAME'].includes(targets[0].type))) throw Error('Cutover requires one editable address record or its exact production Worker domain; no records were changed.');
  const receipt = { schema: 'portable-dns-cutover/1', hostname: c.hostname, address: c.address, state: 'prepared', mode: managed ? 'worker-domain' : 'record', originalDomain: managed ? domain : undefined, before, targetId: targets[0].id, desired: { type: 'A', name: c.hostname, content: c.address, ttl: 60, proxied: false } };
  return receipts.save(file, receipt);
}
export async function changeCutover(c, { request, receipts, file, rollback = false }) {
  checked(c); const receipt = await readCutover(receipts, file);
  const save = () => receipts.save(file, receipt);
  if (receipt.hostname !== c.hostname || receipt.address !== c.address) throw Error('Saved cutover belongs to another placement.');
  if (receipt.mode === 'worker-domain') return changeManagedDomain(c, { request, save, receipt, rollback });
  const current = await snapshot(c, request, receipt.before.zone, receipt.before.account), original = receipt.before.records.find(x => x.id === receipt.targetId), row = current.records.find(x => x.id === receipt.targetId);
  const expected = rollback ? receipt.afterTarget : original;
  const desired = rollback ? shape(original) : { ...shape(original), ...receipt.desired };
  if (!row) throw Error('The owned DNS record disappeared; no mutation was made.');
  const foreign = current.records.filter(x => x.id !== receipt.targetId), previous = receipt.before.records.filter(x => x.id !== receipt.targetId);
  if (JSON.stringify(foreign.map(shape)) !== JSON.stringify(previous.map(shape)) || JSON.stringify(current.routes) !== JSON.stringify(receipt.before.routes)) throw Error('Unrelated DNS or Worker routes changed; preserve the current state and investigate.');
  const alreadyDesired = ['type', 'name', 'content', 'ttl', 'proxied'].every(key => row[key] === desired[key]);
  if (!alreadyDesired && (!expected || !equal(row, expected))) throw Error('The owned record changed since preparation; no mutation was made.');
  if (!alreadyDesired) {
    receipt.state = rollback ? 'rollback-changing' : 'changing'; await save();
    const { id, ...body } = desired;
    await request('PATCH', `zones/${current.zone}/dns_records/${receipt.targetId}`, body);
  }
  const after = await snapshot(c, request, current.zone, current.account), actual = after.records.find(x => x.id === receipt.targetId);
  if (!actual || !['type', 'name', 'content', 'ttl', 'proxied'].every(key => actual[key] === desired[key])) throw Error('DNS mutation needs readback reconciliation; rollback source retained.');
  if (JSON.stringify(after.records.filter(x => x.id !== receipt.targetId).map(shape)) !== JSON.stringify(previous.map(shape)) || JSON.stringify(after.routes) !== JSON.stringify(receipt.before.routes)) throw Error('DNS mutation readback found unrelated changes; rollback source retained.');
  receipt.state = rollback ? 'rolled-back' : 'active'; if (!rollback) receipt.afterTarget = actual;
  return save();
}
function desiredAddress(row, desired) { return row && ['type', 'name', 'content', 'ttl', 'proxied'].every(key => row[key] === desired[key]); }
function domainShape(row) { return row && Object.fromEntries(['hostname', 'service', 'environment', 'zone_id', 'enabled', 'previews_enabled'].map(k => [k, row[k]])); }
function stable(rows, project = x => x) { return JSON.stringify(rows.map(project).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))); }
async function changeManagedDomain(c, { request, save, receipt, rollback }) {
  const before = receipt.before;
  const addresses = state => state.records.filter(x => x.name === c.hostname && ['A', 'AAAA', 'CNAME'].includes(x.type));
  function preserved(state) {
    const other = state.records.filter(x => !addresses(state).includes(x));
    const old = before.records.filter(x => x.id !== receipt.targetId);
    if (stable(other, shape) !== stable(old, shape) || stable(state.routes) !== stable(before.routes) || stable(state.domains.filter(x => x.hostname !== c.hostname)) !== stable(before.domains.filter(x => x.hostname !== c.hostname))) throw Error('Unrelated DNS, domains or Worker routes changed; no further mutation was made.');
  }
  let current = await snapshot(c, request, before.zone, before.account); preserved(current);
  let domain = current.domains.find(x => x.hostname === c.hostname), target = addresses(current);
  const original = before.records.find(x => x.id === receipt.targetId);
  if (domain && JSON.stringify(domainShape(domain)) !== JSON.stringify(domainShape(receipt.originalDomain))) throw Error('The selected custom domain changed; no mutation was made.');
  if (rollback) {
    if (target.length && !domain) {
      if (target.length !== 1 || !desiredAddress(target[0], receipt.desired) || (receipt.afterTarget && !equal(target[0], receipt.afterTarget))) throw Error('The direct DNS record changed; rollback refused.');
      receipt.state = 'rollback-removing-address'; await save();
      await request('DELETE', `zones/${before.zone}/dns_records/${target[0].id}`);
    }
    if (!domain) {
      receipt.state = 'rollback-attaching-domain'; await save();
      const { hostname, service, zone_id, enabled, previews_enabled } = receipt.originalDomain;
      await request('PUT', `accounts/${before.account}/workers/domains`, { hostname, service, zone_id, enabled, previews_enabled });
    }
  } else {
    if (domain) {
      if (target.length !== 1 || !equal(target[0], original)) throw Error('The managed DNS record changed; no mutation was made.');
      receipt.state = 'removing-domain'; await save();
      await request('DELETE', `accounts/${before.account}/workers/domains/${domain.id}`);
      current = await snapshot(c, request, before.zone, before.account); preserved(current); target = addresses(current);
      if (current.domains.some(x => x.hostname === c.hostname)) throw Error('Custom domain removal awaits readback; original state retained.');
    }
    if (target.length && (target.length !== 1 || !desiredAddress(target[0], receipt.desired))) throw Error('A selected-host address remains after domain removal; original state retained.');
    if (!target.length) {
      receipt.state = 'creating-address'; await save();
      const answer = await request('POST', `zones/${before.zone}/dns_records`, receipt.desired);
      receipt.afterTarget = answer.result; await save();
    }
  }
  const after = await snapshot(c, request, before.zone, before.account); preserved(after);
  domain = after.domains.find(x => x.hostname === c.hostname); target = addresses(after);
  if (rollback ? (!domain || JSON.stringify(domainShape(domain)) !== JSON.stringify(domainShape(receipt.originalDomain)) || target.length !== 1 || target[0].content !== original.content || target[0].type !== original.type || target[0].proxied !== original.proxied) : (domain || target.length !== 1 || !desiredAddress(target[0], receipt.desired))) throw Error('Selected-host mutation needs readback reconciliation; original state retained.');
  if (!rollback) receipt.afterTarget = target[0];
  receipt.state = rollback ? 'rolled-back' : 'active'; return save();
}
