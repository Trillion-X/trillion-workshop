// Move the public door to another hosting-provider row: rent, set up, publish the download, cut DNS, prove the new
// address serves /healthz and the download, then release the old lease and rewrite the current-door row.
// Every step reads the rows in parts/service-connections/records.json. Credentials are fetched by vault name at the step that uses them.
// A failed proof rolls DNS back and keeps the old lease; the old lease is released only after the proof passes.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostingProvider, dnsProvider, currentDoor, saveCurrentDoor, serviceConnectionRecordsFile } from '../parts/service-connections/read-data/public-door-rows.mjs';
import { leaseClient, provisionHostLease, removeHostLease, readHostLease } from './portable-host-lease.mjs';
import { dnsClient, prepareCutover, changeCutover } from './portable-dns-cutover.mjs';

/** Proof by default: ordinary trust, the real hostname, pinned to the new address (curl --resolve). */
export function curlProof(url, hostname, address) {
  execFileSync('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--head', '--max-time', '20', '--resolve', `${hostname}:443:${address}`, url], { stdio: ['ignore', 'pipe', 'pipe'] });
  return true;
}

function journal(file, receipt) { writeFileSync(`${file}.next`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); renameSync(`${file}.next`, file); }

/**
 * to: hosting-provider row id. home: private deployment folder (leases, DNS receipt, move journal).
 * steps.setupHost(lease, door) runs the host setup and TLS owner; steps.publishDownload(lease, door) configures the
 * host's proxy (its own paths and downloads folder; every other path goes to the engine). Tests replace credential, fetchImpl, resolve4, prove, wait and those two steps.
 */
export async function movePublicDoor({ to, home, name, publicKey, rowsFile = serviceConnectionRecordsFile, credential, fetchImpl = fetch, resolve4 = dns.resolve4, prove = curlProof, wait = ms => new Promise(r => setTimeout(r, ms)), steps, attempts = 20, report = () => {} }) {
  const target = hostingProvider(to, rowsFile), from = currentDoor(rowsFile), dnsRow = dnsProvider(from.dns_provider, rowsFile);
  if (!target.move_ready) throw new Error(`The door cannot move to ${target.name}: ${target.not_ready_because}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const journalFile = join(home, 'door-move.json'), leaseFile = join(home, `lease-${target.id}-${name}.json`), dnsFile = join(home, `dns-cutover-${target.id}-${name}.json`);
  const receipt = { schema: 'trillion.public-door-move/1', from: { provider: from.hosting_provider, server_id: from.server_id, address: from.address, lease_file: from.lease_file }, to: target.id, hostname: from.hostname, done: [] };
  const step = (id, detail = {}) => { receipt.done.push({ id, ...detail }); journal(journalFile, receipt); report(id, detail); };

  const request = target.base ? leaseClient(target, await credential(target.vault_key), { fetchImpl }) : null;
  const lease = await provisionHostLease({ request, file: leaseFile, name, publicKey, provider: target, lifetime: 'service', expiresAt: null });
  step('rented', { server_id: lease.serverId, address: lease.address, lease_file: leaseFile });
  const door = { ...from, hosting_provider: target.id, server_id: lease.serverId, address: lease.address, lease_file: leaseFile };
  await steps.setupHost(lease, door); step('set-up');
  await steps.publishDownload(lease, door); step('download-published');

  const cut = { hostname: door.hostname, address: lease.address };
  const dnsRequest = dnsClient(await credential(dnsRow.vault_key), { fetchImpl, provider: dnsRow });
  await prepareCutover(cut, { request: dnsRequest, file: dnsFile });
  const active = await changeCutover(cut, { request: dnsRequest, file: dnsFile });
  step('dns-cut', { record: active.targetId, address: lease.address });

  const urls = [`https://${door.hostname}${door.proof.health}`, `https://${door.hostname}${door.proof.download}`];
  let proven = false, last = 'no attempt';
  for (let n = 0; n < attempts && !proven; n++) {
    try {
      const seen = await resolve4(door.hostname);
      if (!seen.includes(lease.address)) throw new Error(`public DNS still answers ${seen.join(', ')}`);
      for (const url of urls) await prove(url, door.hostname, lease.address);
      proven = true;
    } catch (error) { last = error.message; if (n + 1 < attempts) await wait(15000); }
  }
  if (!proven) {
    await changeCutover(cut, { request: dnsRequest, file: dnsFile, rollback: true });
    step('dns-rolled-back', { because: last });
    throw new Error(`The new door at ${lease.address} was not proven (${last}); DNS was rolled back, the old door and its lease were kept, and the new lease is ${leaseFile}.`);
  }
  step('proven', { urls });

  if (from.lease_file && existsSync(from.lease_file)) {
    const old = readHostLease(from.lease_file), oldRow = hostingProvider(old.provider ?? from.hosting_provider, rowsFile);
    const oldRequest = oldRow.base ? leaseClient(oldRow, await credential(oldRow.vault_key), { fetchImpl }) : null;
    await removeHostLease({ request: oldRequest, file: from.lease_file, provider: oldRow });
    step('old-released', { lease_file: from.lease_file });
  } else step('old-not-released', { because: 'the current-door row names no readable lease file; release the old host from its own receipt' });

  const saved = saveCurrentDoor({ ...door, dns_record: active.targetId, unknown_because: undefined }, rowsFile);
  step('door-row-saved');
  return { door: saved, receipt };
}

// node scripts/move-public-door.mjs PROVIDER_ROW CONFIG   (CONFIG: { home, name, publicKeyFile, tls: <portable-tls config> })
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [to, configFile] = process.argv.slice(2);
    if (!to || !configFile || process.argv.length !== 4) throw new Error('usage: move-public-door.mjs PROVIDER_ROW CONFIG');
    const c = JSON.parse(readFileSync(configFile, 'utf8'));
    const { heldByTheVault } = await import('../../bitfield-packages/packages/credentials-vault/read-data/ask-the-vault-for-one-secret.mjs');
    const credential = async key => { const held = await heldByTheVault(key); return typeof held === 'string' ? held : held?.token; };
    const { prepareConnectionHost, pinHost } = await import('./portable-service-connection.mjs');
    const tls = (lease, action) => execFileSync(process.execPath, [fileURLToPath(new URL('./portable-tls.mjs', import.meta.url)), action, writeTls(lease)], { stdio: 'inherit' });
    const writeTls = lease => { const file = join(c.home, 'tls-next.json'); writeFileSync(file, JSON.stringify({ ...c.tls, address: lease.address, knownHostsFile: join(c.home, `known-hosts-${lease.address}`) }), { mode: 0o600 }); return file; };
    const steps = {
      setupHost: async lease => { const cfg = JSON.parse(readFileSync(writeTls(lease))); pinHost(cfg); prepareConnectionHost(cfg, readFileSync(c.tls.publicKeyFile, 'utf8').trim()); for (const action of ['setup', 'issue']) tls(lease, action); },
      publishDownload: async lease => { for (const action of ['configure', 'activate']) tls(lease, action); },
    };
    const { door, receipt } = await movePublicDoor({ to, home: c.home, name: c.name, publicKey: c.publicKeyFile && readFileSync(c.publicKeyFile, 'utf8'), credential, steps, report: (id, d) => process.stderr.write(`${id} ${JSON.stringify(d)}\n`) });
    process.stdout.write(`${JSON.stringify({ door, done: receipt.done.map(s => s.id) })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
