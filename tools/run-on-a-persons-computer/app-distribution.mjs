// One provider read on the existing Mac host, using its existing App Store Connect credential owner.
// Only configured apps are read. The shared observation is public and expires; it never contains a tester email.
import { readFile } from 'node:fs/promises';
import settings from './app-distribution.json' with { type: 'json' };
import { appStoreConnect } from '../scripts/app-store-connect.mjs';
import { readTestFlightAvailability } from '../scripts/testflight-readiness.mjs';
import { distributionObservation, distributionSource } from '../src/device-distribution.mjs';

export function makeAppDistributionTools({ connect = appStoreConnect, readAvailability = readTestFlightAvailability,
  readListing = path => readFile(new URL(path, import.meta.url), 'utf8').then(JSON.parse), fetchImpl = fetch, now = Date.now } = {}) {
  return { async read(input = {}, { origin, key } = {}) {
    const configured = settings.sources.find(row => row.id === input.source_id);
    const source = distributionSource(input.source_id);
    if (!configured || !source) throw new Error('Name a configured installation source.');
    if (Object.keys(input).some(name => !['source_id', 'publish'].includes(name))) throw new Error('This tool reads global release availability; private tester input is not accepted.');
    if (input.publish !== undefined && typeof input.publish !== 'boolean') throw new Error('Publish must be true or false.');
    const listing = await readListing(configured.listing);
    const asc = connect({ keychainService: listing.app_store_connect.key_keychain_service, issuerId: listing.app_store_connect.issuer_id });
    let apps;
    try { apps = await asc.get('/v1/apps', { query: { 'filter[bundleId]': listing.app.bundle_identifier, limit: 2 } }); }
    catch (error) { throw new Error(`The configured app could not be checked with Apple${Number.isInteger(error.status) ? ` (${error.status})` : ''}. No new availability was published.`); }
    const matches = Array.isArray(apps?.data) ? apps.data.filter(app => app?.attributes?.bundleId === listing.app.bundle_identifier) : [];
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id.trim() || apps?.links?.next) throw new Error('The configured app did not resolve to one complete Apple app record.');
    const checked = now();
    const report = await readAvailability({ asc, appId: matches[0].id, testflight: listing.testflight, now: checked });
    const observation = distributionObservation(source, report, checked);
    let published = null;
    if (input.publish === true) {
      if (!origin || !key) throw new Error('The release owner must be signed in before publishing availability.');
      const url = new URL('/mcp/api/device-distribution', origin);
      if (url.protocol !== 'https:') throw new Error('Use the signed-in service over HTTPS.');
      url.searchParams.set('source_id', source.id);
      const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      const current = await fetchImpl(url, { headers });
      if (!current.ok) throw new Error(`The release owner's observation could not be read (${current.status}).`);
      const before = await current.json();
      const saved = await fetchImpl(url, { method: 'PUT', headers, body: JSON.stringify({ source_id: source.id, observation, expected_identity: before.identity }) });
      if (!saved.ok) throw new Error(`The release observation could not be published (${saved.status}); read it again before retrying.`);
      const result = await saved.json();
      published = { saved: result.saved === true, unchanged: result.unchanged === true, identity: result.identity ?? null };
    }
    return { source_id: source.id, observation, published };
  } };
}

export const appDistributionTools = makeAppDistributionTools();
