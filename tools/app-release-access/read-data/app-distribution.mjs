// tools/app-release-access/read-data/app-distribution.mjs (moved from old trillion computer/app-distribution.mjs)
//
// The container tool `tool:read-app-distribution`: one provider read of a configured release source with the release
// owner's held App Store Connect key. Only the named app is read. The answer is the short-lived public observation
// (read-data/distribution.mjs); it never contains a tester email, a key or Apple's raw reply.
//
// Which app a source is (its bundle identifier and TestFlight groups) is the input, not repository DATA: those are the
// release owner's own facts. publish:true would save the observation to the owner's `device-distribution:<source>`
// workspace record; a tool run cannot be granted workspace:write yet (README "Not yet"), so it is refused plainly.
import { appStoreConnect, readHeldKey } from './app-store-connect.mjs';
import { readTestFlightAvailability } from './testflight-readiness.mjs';
import { distributionObservation, distributionSource } from './distribution.mjs';

const INPUTS = ['source_id', 'publish', 'bundle_identifier', 'testflight_groups'];

export function makeAppDistributionTools({ connect = appStoreConnect, readKey = readHeldKey, readAvailability = readTestFlightAvailability, now = Date.now } = {}) {
  return { async read(input = {}) {
    const source = distributionSource(input.source_id);
    if (!source) throw new Error('Name a configured installation source.');
    if (Object.keys(input).some(name => !INPUTS.includes(name))) throw new Error('This tool reads global release availability; private tester input is not accepted.');
    if (input.publish !== undefined && typeof input.publish !== 'boolean') throw new Error('Publish must be true or false.');
    const groups = input.testflight_groups ?? [];
    if (typeof input.bundle_identifier !== 'string' || !input.bundle_identifier.trim()) throw new Error('Name the app by its bundle identifier.');
    if (!Array.isArray(groups) || groups.length > 20 || groups.some(name => typeof name !== 'string' || !name)) throw new Error('TestFlight groups must be a list of up to 20 group names.');
    if (input.publish === true) throw new Error('Publishing availability needs the release owner\'s workspace:write at the records door, which a tool run cannot be granted yet. Read it with publish false.');
    const listing = { app: { bundle_identifier: input.bundle_identifier }, testflight: { groups } };
    const asc = connect({ apiKey: readKey() });
    let apps;
    try { apps = await asc.get('/v1/apps', { query: { 'filter[bundleId]': listing.app.bundle_identifier, limit: 2 } }); }
    catch (error) { throw new Error(`The configured app could not be checked with Apple${Number.isInteger(error.status) ? ` (${error.status})` : ''}. No new availability was published.`); }
    const matches = Array.isArray(apps?.data) ? apps.data.filter(app => app?.attributes?.bundleId === listing.app.bundle_identifier) : [];
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id.trim() || apps?.links?.next) throw new Error('The configured app did not resolve to one complete Apple app record.');
    const checked = now();
    const report = await readAvailability({ asc, appId: matches[0].id, testflight: listing.testflight, now: checked });
    const observation = distributionObservation(source, report, checked);
    let published = null;
    return { source_id: source.id, observation, published };
  } };
}

const tools = makeAppDistributionTools();
export const read = input => tools.read(input);
