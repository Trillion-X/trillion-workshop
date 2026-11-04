// Move the public door to another hosting-provider row: rent, set up, publish the download, cut DNS, prove the new
// address serves /healthz and the download, then release the old lease and rewrite the current-door row.
// Every step reads the rows of the person's Service connections list and keeps its receipts in their Public door
// receipts list, both through the records door. Credentials are fetched by vault name at the step that uses them.
// A failed proof rolls DNS back and keeps the old lease; the old lease is released only after the proof passes.
import { execFileSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { hostingProvider, dnsProvider, currentDoor, saveCurrentDoor } from '../read-data/public-door-rows.mjs';
import { doorReceipts } from '../read-data/door-receipts.mjs';
import { leaseClient, provisionHostLease, removeHostLease, readHostLease } from './portable-host-lease.mjs';
import { dnsClient, prepareCutover, changeCutover } from './portable-dns-cutover.mjs';

/** Proof by default: ordinary trust, the real hostname, pinned to the new address (curl --resolve). */
export function curlProof(url, hostname, address) {
  // curl gets an empty environment, so no held value the run was handed reaches it.
  execFileSync('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--head', '--max-time', '20', '--resolve', `${hostname}:443:${address}`, url], { stdio: ['ignore', 'pipe', 'pipe'], env: {} });
  return true;
}

/**
 * to: hosting-provider row id. records: the person's records door (the rows, and the receipts: leases, DNS receipt, move journal).
 * steps.setupHost(lease, door) runs the host setup and TLS owner; steps.publishDownload(lease, door) configures the
 * host's proxy (its own paths and downloads folder; every other path goes to the engine). Tests replace credential, fetchImpl, resolve4, prove, wait and those two steps.
 * Tests also hand in their own records door.
 */
export async function movePublicDoor({ to, records, name, publicKey, credential, fetchImpl = fetch, resolve4 = dns.resolve4, prove = curlProof, wait = ms => new Promise(r => setTimeout(r, ms)), steps, attempts = 20, report = () => {} }) {
  const target = await hostingProvider(to, records), from = await currentDoor(records), dnsRow = await dnsProvider(from.dns_provider, records);
  if (!target.move_ready) throw new Error(`The door cannot move to ${target.name}: ${target.not_ready_because}`);
  const receipts = doorReceipts(records);
  const journalFile = 'door-move', leaseFile = `lease-${target.id}-${name}`, dnsFile = `dns-cutover-${target.id}-${name}`;
  const receipt = { schema: 'public-door-move/1', from: { provider: from.hosting_provider, server_id: from.server_id, address: from.address, lease_file: from.lease_file }, to: target.id, hostname: from.hostname, done: [] };
  const step = async (id, detail = {}) => { receipt.done.push({ id, ...detail }); await receipts.save(journalFile, receipt); report(id, detail); };

  const request = target.base ? leaseClient(target, await credential(target.vault_key), { fetchImpl }) : null;
  const lease = await provisionHostLease({ request, receipts, file: leaseFile, name, publicKey, provider: target, lifetime: 'service', expiresAt: null });
  await step('rented', { server_id: lease.serverId, address: lease.address, lease_file: leaseFile });
  const door = { ...from, hosting_provider: target.id, server_id: lease.serverId, address: lease.address, lease_file: leaseFile };
  await steps.setupHost(lease, door); await step('set-up');
  await steps.publishDownload(lease, door); await step('download-published');

  const cut = { hostname: door.hostname, address: lease.address };
  const dnsRequest = dnsClient(await credential(dnsRow.vault_key), { fetchImpl, provider: dnsRow });
  await prepareCutover(cut, { request: dnsRequest, receipts, file: dnsFile });
  const active = await changeCutover(cut, { request: dnsRequest, receipts, file: dnsFile });
  await step('dns-cut', { record: active.targetId, address: lease.address });

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
    await changeCutover(cut, { request: dnsRequest, receipts, file: dnsFile, rollback: true });
    await step('dns-rolled-back', { because: last });
    throw new Error(`The new door at ${lease.address} was not proven (${last}); DNS was rolled back, the old door and its lease were kept, and the new lease is ${leaseFile}.`);
  }
  await step('proven', { urls });

  if (from.lease_file && await receipts.read(from.lease_file)) {
    const old = await readHostLease(receipts, from.lease_file), oldRow = await hostingProvider(old.provider ?? from.hosting_provider, records);
    const oldRequest = oldRow.base ? leaseClient(oldRow, await credential(oldRow.vault_key), { fetchImpl }) : null;
    await removeHostLease({ request: oldRequest, receipts, file: from.lease_file, provider: oldRow });
    await step('old-released', { lease_file: from.lease_file });
  } else await step('old-not-released', { because: 'the current-door row names no readable lease file; release the old host from its own receipt' });

  const saved = await saveCurrentDoor({ ...door, dns_record: active.targetId, unknown_because: undefined }, records);
  await step('door-row-saved');
  return { door: saved, receipt };
}
