// Who each record is shared with, chosen item by item (src/record-sharing.mjs), against the real Network (spaces, the
// one space check, offers to people) and a real EEAF store: the sheet's preview is exactly the copy a share makes; a
// record chosen as not shared is refused to everyone else; shared only with one person lets only that person read it;
// a chain covers the records linked to it and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withSourceImports } from './source-imports-for-tests.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import { decisionStore } from '../src/decision-store.mjs';
import { handleSpacesRequest, shareableCopy } from '../src/person-spaces.mjs';
import { shareKeptFiles } from '../src/workspace/share-kept-files.mjs';
import { spaceTools } from '../src/space-tools.mjs';
import { makeShareDestinations } from '../src/share-destinations.mjs';
import { recordScopeMethods } from '../src/record-scope.mjs';
import { handleSharingRequest, linksFrom, previewOf, recordSharingActions, recordSharingMethods, resolveSharing, shareCodeOf, sharingTools, SharingError } from '../src/record-sharing.mjs';
import rules from '../src/network-settings.json' with { type: 'json' };
import sharing from '../src/record-sharing.json' with { type: 'json' };
import { importSource } from './import-source-for-tests.mjs';
import { accountControlBinding } from './account-control-binding-for-tests.mjs';

const source = withSourceImports(readFileSync(new URL('../src/network.mjs', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace("import rules from './network-settings.json' with { type: 'json' };", `const rules = ${JSON.stringify(rules)};`));
const { Network } = await importSource(source);

const stores = new Map();
function network() {
  const { sql, transaction } = sqliteHost(':memory:');
  const net = new Network({ storage: { sql, transactionSync: transaction } }, { ACCOUNT_CONTROL: accountControlBinding(), PERSON: { idFromString: ref => ref, get: ref => stores.get(ref) ?? { includesPlanFeature: async () => true, spaceChanged: async () => {} } } });
  // This domain fixture supplies the original-source projection transport.
  // Native custody/admission has its actual-host cases; a direct mock Network
  // call cannot manufacture an admitted native Space command or borrow bytes.
  net.releasePrivateSourceToSpace = async ({ relay, private_ref, space_id }) => {
    const before = sql.exec('SELECT person_ref FROM relays WHERE relay = ?', relay).toArray()[0];
    if (!before) return null;
    const original = stores.get(before.person_ref);
    if (!original) return null;
    const copy = await original.releaseRecordToSpace({ private_ref, space_id });
    const after = sql.exec('SELECT person_ref FROM relays WHERE relay = ?', relay).toArray()[0];
    if (after?.person_ref !== before.person_ref) throw new Error('Private source custody changed during release.');
    return copy;
  };
  return net;
}

// One person's own store as record-sharing sees it: their EEAF records, their relay, the network, and the pool.
function person(net, ref, relay) {
  const { sql, transaction } = sqliteHost(':memory:');
  const facts = new Map();
  const kept = new Map();
  const pool = { removed: [], unpublished: [], remove: async id => { pool.removed.push(id); }, unpublishStory: async id => { pool.unpublished.push(id); } };
  const self = Object.assign({
    sql, transaction, pool: () => pool, poolCalls: pool, ctx: { id: { toString: () => ref }, waitUntil: () => {} },
    // The account's native looks owner: this harness's account wears no look (page answers null).
    looks: () => ({ page: async () => null }),
    env: { ACCOUNT_CONTROL: accountControlBinding(), PERSON: { idFromString: id => id, get: id => stores.get(id) } },
    relay: () => relay, network: () => net,
    fact: name => facts.get(name) ?? null, setFact: (name, value) => { facts.set(name, value); return value; },
    sharingOn: () => true, share: async () => null, publishStory: async () => null, includesPlanFeature: async () => true, spaceChanged: async () => {},
    // As src/person-store.mjs shareableRecord reads one record for a share: a file in the person's files by its
    // identity, or one of their records.
    async shareableRecord({ record_id: id, file }) {
      if (file) return { kind: 'file', private_ref: `file:${file}`, title: null, body: { identity: file, name: null, byte_length: 12, media_type: 'text/markdown' } };
      const type = store.eeaf.typeOf(id);
      return shareableCopy(type, id, store.eeaf.read(id), this.copyShape(id));
    },
    shareDestinationsOwner() {
      return makeShareDestinations({ store: { choices: () => facts.get('share-destinations') ?? null, putChoices: value => facts.set('share-destinations', value) }, instructions: { instructions: () => ({ instructions: [] }), shapeInstructions: list => list }, pursuits: async () => (await net.spaces({ relay })).spaces.map(space => ({ id: `pursuit:${space.space_id}`, title: space.title, parents: [], children: [], depth: 0, space_id: space.space_id, others: [], people_count: 1 })) });
    },
    write(id, type, value) { store.eeaf.write([{ id, type, value }], { actor: { by: 'test' } }); },
    // As src/person-store.mjs keeps a Workshop tool's records (a sales contract): the newest value by its id.
    workshopValue: id => kept.get(id) ?? null,
    keep(id, value) { kept.set(id, value); },
  }, recordSharingMethods, recordScopeMethods);
  const store = decisionStore(sql, { transaction, written: records => self.scopeWritten(records) });
  self.store = store;
  store.setSetting = (name, value) => facts.set(name.startsWith('shared:') || name.startsWith('story:') ? name : name, value);
  stores.set(ref, self);
  return self;
}

// ana shares a space with bo and dee; cy is on the network but in no space with ana.
async function world() {
  const net = network();
  const relays = { ana: 'relay_' + 'a'.repeat(32), bo: 'relay_' + 'b'.repeat(32), cy: 'relay_' + 'c'.repeat(32), dee: 'relay_' + 'd'.repeat(32) };
  for (const [name, relay] of Object.entries(relays)) net.remember(relay, `store-${name}`);
  const people = Object.fromEntries(Object.entries(relays).map(([name, relay]) => [name, person(net, `store-${name}`, relay)]));
  const { membership_id: space } = await net.createMembership({ relay: relays.ana, person_ref: 'store-ana', label: 'project', title: 'Bakery' });
  for (const other of ['bo', 'dee']) {
    const invite = await net.request({ from: relays.ana, person_ref: 'store-ana', to: relays[other], why: 'Bakery with me', membership_id: space });
    await net.answer({ relay: relays[other], request_id: invite.request_id, accept: true });
  }
  const ana = people.ana;
  ana.write('pursuit:launch', 'pursuit', { id: 'pursuit:launch', title: 'Launch in 40 stores', now: '0 stores', after: '40 stores', why_it_matters: 'Rent is due', status: 'active' });
  ana.write('pursuit:health', 'pursuit', { id: 'pursuit:health', title: 'Something private', now: 'a', after: 'b', status: 'active' });
  ana.write('case_copacker', 'decision', { input: { goal: 'Which co-packer' }, status: 'decided', decision: { option: 'North' }, created_at: '2026-09-28T00:00:00Z', cited_pursuits: { 'pursuit:launch': 'Launch in 40 stores' } });
  ana.write('case_doctor', 'decision', { input: { goal: 'Which doctor' }, status: 'decided', decision: { option: 'Dr B' }, created_at: '2026-09-28T00:00:00Z', cited_pursuits: { 'pursuit:health': 'Something private' } });
  return { net, relays, people, space, ana };
}

// A person reads what someone shared with them, as their own store's route does.
async function readAs(reader, offerId) {
  const answer = await handleSharingRequest(reader, new Request('https://person/shared-with-me/read', { method: 'POST', body: JSON.stringify({ offer_id: offerId }) }));
  return { ok: answer.ok, body: await answer.json() };
}
const offersTo = async reader => (await handleSharingRequest(reader, new Request('https://person/shared-with-me'))).json();

test('the preview is exactly the copy a share makes, field for field, with the fields left out gone from both', async () => {
  const { net, relays, space, ana } = await world();
  const sheet = await ana.sharingSheet('pursuit:launch');
  const copy = shareableCopy('pursuit', 'pursuit:launch', ana.store.eeaf.read('pursuit:launch'));
  assert.deepEqual(sheet.preview.fields.map(field => field.id), Object.keys(copy.body));
  assert.equal(sheet.preview.fields.find(field => field.id === 'why_it_matters').label, 'Why it matters');
  assert.deepEqual(sheet.fields.map(field => [field.id, field.included]), Object.keys(copy.body).map(id => [id, true]));
  const trimmed = await ana.previewSharing('pursuit:launch', ['why_it_matters']);
  assert.deepEqual(trimmed.preview.fields.map(field => field.id), ['title', 'now', 'after', 'status']);
  await ana.setRecordSharing('pursuit:launch', { spaces: [space], leave_out: ['why_it_matters'] });
  const [item] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.deepEqual(Object.keys(item.body), trimmed.preview.fields.map(field => field.id), 'what bo reads is what the preview showed');
  assert.ok(!JSON.stringify(item).includes('Rent is due'));
  const decision = await ana.sharingSheet('case_copacker');
  assert.deepEqual(decision.preview.fields.map(field => [field.id, field.value]), [['input', 'Which co-packer'], ['status', 'Decided'], ['decision', 'North'], ['created_at', 'September 28, 2026']]);
  await assert.rejects(ana.setRecordSharing('pursuit:launch', { leave_out: ['cited_pursuits'] }), /not a field/);
});

test('the sheet offers Only my devices can open this on a sealable kind shared nowhere, says why while it is shared, and shows only the switch once sealed', async () => {
  const { space, ana } = await world();
  const open = await ana.sharingSheet('pursuit:launch');
  assert.deepEqual(open.sealed, { on: false, label: 'Only my devices can open this', detail: open.sealed.detail, blocked: null });
  assert.equal((await ana.sharingSheet('case_copacker')).sealed, null, 'a kind a device cannot seal has no switch');
  await ana.setRecordSharing('pursuit:launch', { spaces: [space] });
  assert.match((await ana.sharingSheet('pursuit:launch')).sealed.blocked, /Stop sharing it first/);
  await ana.setRecordSharing('pursuit:launch', { spaces: [] });
  const { keyFromPassphrase, sealRecord, SEALED_TYPE } = await import('../parts/sealed-records/do-work/sealed-records.mjs');
  const key = keyFromPassphrase('river stone lantern', 'salt-of-ana');
  ana.store.eeaf.write([{ id: 'pursuit:launch', type: SEALED_TYPE, value: await sealRecord(key, 'pursuit:launch', { type: 'pursuit', value: ana.store.eeaf.read('pursuit:launch') }) }], { actor: { by: 'test device' } });
  const sealed = await ana.sharingSheet('pursuit:launch');
  assert.equal(sealed.sealed.on, true);
  assert.deepEqual([sealed.places, sealed.fields, sealed.preview.fields], [[], [], []], 'nothing of a sealed record is offered to anyone');
  assert.ok(!JSON.stringify(sealed).includes('Launch'));
  // The page reads the sheet and its links over the routes, by the sealed record's own id.
  const routed = await (await handleSharingRequest(ana, new Request('https://person/sharing/pursuit%3Alaunch'))).json();
  assert.equal(routed.sealed.on, true);
  const links = await handleSharingRequest(ana, new Request('https://person/sharing/pursuit%3Alaunch/links'));
  assert.equal(links.status, 200);
  assert.deepEqual((await links.json()).links, []);
  const making = await handleSharingRequest(ana, new Request('https://person/sharing/pursuit%3Alaunch/links', { method: 'POST', body: JSON.stringify({ scope: { kind: 'public' } }) }));
  assert.equal(making.status, 400, 'no link can be made for a sealed record');
});

test('a Space resolves its item from the owner on every read, including edits, field choices and withdrawal', async () => {
  const { net, relays, space, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { spaces: [space] });
  const [first] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(first.body.now, '0 stores');
  ana.write('pursuit:launch', 'pursuit', { ...ana.store.eeaf.read('pursuit:launch'), now: '12 stores' });
  const [edited] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(edited.item_id, first.item_id, 'the Space item keeps its identity');
  assert.equal(edited.body.now, '12 stores', 'the current owner value is shown without sharing again');
  await ana.setRecordSharing('pursuit:launch', { spaces: [space], leave_out: ['why_it_matters'] });
  const [trimmed] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(trimmed.body.why_it_matters, undefined);
  await ana.setRecordSharing('pursuit:launch', { spaces: [] });
  const [withdrawn] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(withdrawn.body, null);
  await assert.rejects(ana.releaseRecordToSpace({ private_ref: 'pursuit:launch', space_id: space }), /not to share this here/);
});

test('a Space owner rechecks its sharing choice after an awaited record projection', async () => {
  const { space, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { spaces: [space] });
  const originalCopy = ana.sharedCopy.bind(ana);
  let entered;
  const projectionStarted = new Promise(resolve => { entered = resolve; });
  let resume;
  const projectionGate = new Promise(resolve => { resume = resolve; });
  let held = false;
  ana.sharedCopy = async ref => {
    const copy = await originalCopy(ref);
    if (ref === 'pursuit:launch' && !held) {
      held = true;
      entered();
      await projectionGate;
    }
    return copy;
  };
  const reading = ana.releaseRecordToSpace({ private_ref: 'pursuit:launch', space_id: space });
  await projectionStarted;
  await ana.setRecordSharing('pursuit:launch', { spaces: [] });
  resume();
  await assert.rejects(reading, /not to share this here/);
});

test('a selected record reference shares into a Space through the same owner choice', async () => {
  const { net, relays, space, ana } = await world();
  const shared = await ana.shareInto(space, { record: 'pursuit:launch' });
  const [item] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(item.item_id, shared.item_id);
  assert.equal(item.body.title, 'Launch in 40 stores');
  assert.equal(ana.effectiveSharing('pursuit:launch').spaces.includes(space), true);
});

test('a record marked not shared is refused to every other reader: a person, a space, and the network', async () => {
  const { net, relays, people, space, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { people: [relays.bo], spaces: [space] });
  const [offer] = (await offersTo(people.bo)).shared_with_you;
  assert.equal((await readAs(people.bo, offer.offer_id)).ok, true);
  await ana.setRecordSharing('pursuit:launch', { network: false, people: [], spaces: [] });
  assert.deepEqual((await offersTo(people.bo)).shared_with_you, [], 'the offer is gone');
  const refused = await readAs(people.bo, offer.offer_id);
  assert.equal(refused.ok, false);
  assert.match(refused.body.error, /not shared with you/);
  // Even a stale road straight to ana's store is decided again at the moment of reading.
  await assert.rejects(ana.releaseRecord({ private_ref: 'pursuit:launch', asking_relay: relays.bo }), /not shared with you/);
  const [withdrawn] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(withdrawn.body, null, 'the copy in the space is withdrawn');
  await assert.rejects(ana.shareInto(space, { record_id: 'pursuit:launch' }), /chose not to share this here/, 'the pursuit\'s one check refuses a share of it');
  assert.equal(ana.networkMay('pursuit:launch', {}), false);
  assert.equal(ana.networkMay('case_doctor', {}), true, 'a decision with no choice follows the account, shared by default');
  assert.equal(ana.networkMay('pursuit:health', {}), false, 'a kind the account choice does not cover stays private with no choice');
});

test('shared only with one person lets only that person read it', async () => {
  const { relays, people, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { network: false, people: [relays.bo] });
  const [offer] = (await offersTo(people.bo)).shared_with_you;
  const read = await readAs(people.bo, offer.offer_id);
  assert.equal(read.ok, true);
  assert.equal(read.body.title, 'Launch in 40 stores');
  assert.equal(read.body.provenance.from, 'Member 1');
  assert.equal(read.body.private_ref, undefined, 'the private id stays with its owner');
  assert.deepEqual((await offersTo(people.dee)).shared_with_you, [], 'dee is in the space but was not picked');
  assert.equal((await readAs(people.dee, offer.offer_id)).ok, false);
  assert.equal((await readAs(people.cy, offer.offer_id)).ok, false);
  await assert.rejects(ana.releaseRecord({ private_ref: 'pursuit:launch', asking_relay: relays.dee }), /not shared with you/);
  await assert.rejects(ana.setRecordSharing('pursuit:launch', { people: [relays.cy] }), /not one of your pursuits/, 'only people ana shares a space with can be picked');
  assert.equal(ana.networkMay('pursuit:launch', {}), false);
});

test('external record links use the same sanitized sharing owner, bind recipients, expire, and revoke', async () => {
  const { ana, relays } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  await ana.setRecordSharing('pursuit:launch', { network: false, people: [], spaces: [] });
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const link = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'email', value: ' Client@Example.com ' }, expires_at: expiresAt });
  assert.equal(link.scope.value, 'client@example.com');
  assert.equal(ana.shareLinksOf('pursuit:launch')[0].code, undefined, 'list view never returns the bearer code');
  const personBound = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'private', value: relays.bo } });
  const codeBound = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'code', value: 'sent-separately' } });
  await assert.rejects(ana.resolveRecordShare(link.code), /for someone else/);
  const unprovedPage = await ana.sharedPageForLink(link.code);
  assert.equal(unprovedPage.access.admitted, false);
  assert.equal(unprovedPage.copy, null, 'a recipient without the named email gets no shared copy');
  assert.ok(Number.isFinite(unprovedPage._timing.grant_ms));
  assert.ok(Number.isFinite(unprovedPage._timing.sender_ms));
  assert.equal(unprovedPage._timing.copy_ms, undefined, 'refused pages do not read a shared copy');
  assert.deepEqual(ana.shareLinksOf('pursuit:launch').find(row => row.share_id === codeBound.share_id).scope, { kind: 'code' }, 'saved access codes are not returned again');
  const read = await ana.resolveRecordShare(link.code, { verified_email: 'CLIENT@example.com', now: Date.parse(expiresAt) - 1000 });
  assert.equal(read.title, 'Launch in 40 stores');
  assert.equal(read.private_ref, undefined);
  const page = await ana.sharedPageForLink(link.code, { verified_email: 'CLIENT@example.com' });
  assert.equal(page.access.admitted, true);
  assert.equal(page.copy.title, 'Launch in 40 stores');
  assert.equal(page.copy.private_ref, undefined);
  assert.ok(Number.isFinite(page._timing.grant_ms));
  assert.ok(Number.isFinite(page._timing.sender_ms));
  assert.ok(Number.isFinite(page._timing.copy_ms));
  const events = ana.store.eeaf.ids('commercial-event').map(id => ana.store.eeaf.read(id));
  assert.ok(events.some(event => event.event === 'share_created' && event.subject_id === 'pursuit:launch'));
  assert.ok(events.some(event => event.event === 'share_viewed' && event.subject_id === 'pursuit:launch'));
  await ana.resolveRecordShare(link.code, { verified_email: 'client@example.com' });
  assert.equal(ana.store.eeaf.ids('commercial-event').length, events.length, 'revisiting a page does not append another view event');
  await ana.resolveRecordShare(link.code, { verified_email: 'client@example.com', record_view: false });
  assert.equal(ana.store.eeaf.ids('commercial-event').length, events.length, 'a byte read rechecks access without growing the page-view log');
  await assert.rejects(ana.resolveRecordShare(link.code, { verified_email: 'client@example.com', now: Date.parse(expiresAt) + 1000 }), /ended/);
  assert.equal((await ana.resolveRecordShare(personBound.code, { relay: relays.bo })).title, 'Launch in 40 stores');
  await assert.rejects(ana.resolveRecordShare(personBound.code, { relay: relays.dee }), /for someone else/);
  assert.equal((await ana.resolveRecordShare(codeBound.code, { access_code: 'sent-separately' })).title, 'Launch in 40 stores');
  assert.deepEqual(await ana.resolveRecordShareGrant(link.code, { verified_email: 'client@example.com', buyer_ref: 'store-bo' }), { record_ref: 'pursuit:launch', share_id: link.share_id, buyer_ref: 'store-bo', unsigned: false });
  assert.equal((await ana.resolveRecordShareGrant(link.code, { verified_email: 'client@example.com' })).buyer_ref, null, 'a proved recipient with no account has no buyer yet; checkout refuses one (negotiated-offers accept)');
  await ana.revokeRecordShare('pursuit:launch', personBound.share_id);
  await assert.rejects(ana.resolveRecordShare(personBound.code, { relay: relays.bo }), /ended/);
  assert.equal((await ana.sharedPageForLink(personBound.code, { relay: relays.bo })).denied, true, 'owner RPC returns a typed denial after revocation');
});

test('a tool link lets only the person it names run the tool, only while it is open, and only when it says run', async () => {
  const { ana, relays } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  // As src/person-store.mjs keeps a saved tool: its copy for a sheet, and its row for a link holder's Workshop.
  const row = { id: 'tool:count-words', job: 'Count the words in a text', invoke: { kind: 'container', files: '1f:' + '0'.repeat(64) } };
  const describe = ana.shareableRecord.bind(ana);
  ana.shareableRecord = async args => (args.tool ? { kind: 'tool', private_ref: args.tool, title: 'Count words', body: { descriptor: row, files: {} } } : describe(args));
  ana.sharedToolRow = async id => (id === row.id ? row : null);
  const sheet = await ana.sharingSheet('tool:count-words');
  assert.deepEqual(sheet.abilities.map(item => item.id), ['view', 'run'], 'a tool offers seeing it, then running it, as roles');
  assert.deepEqual(sheet.abilities_given, ['view', 'run'], 'a new tool link lets its person run it unless the sharer says otherwise');
  const hour = new Date(Date.now() + 3_600_000).toISOString();
  const forBo = await ana.createRecordShare('tool:count-words', { scope: { kind: 'private', value: relays.bo }, expires_at: hour });
  assert.deepEqual(forBo.can, ['view', 'run']);
  assert.deepEqual(await ana.releaseSharedTool(forBo.code, { relay: relays.bo }), row, 'the named person gets the tool to run in their own account');
  assert.deepEqual(await ana.releaseSharedTool(forBo.code, { relay: relays.bo }, 'tool:count-words'), row);
  await assert.rejects(ana.releaseSharedTool(forBo.code, { relay: relays.bo }, 'tool:something-else'), /does not share tool:something-else/);
  await assert.rejects(ana.releaseSharedTool(forBo.code, { relay: relays.dee }), /for someone else/, 'anyone else is refused');
  await assert.rejects(ana.releaseSharedTool(forBo.code, {}), /for someone else/, 'no one at all is refused');
  await assert.rejects(ana.releaseSharedTool(forBo.code, { relay: relays.bo }, null, Date.parse(hour) + 1000), /ended/, 'after its time nothing runs');
  const byEmail = await ana.createRecordShare('tool:count-words', { scope: { kind: 'email', value: 'Bo@Example.com' }, expires_at: hour });
  assert.deepEqual(await ana.releaseSharedTool(byEmail.code, { verified_email: 'bo@example.com' }), row, 'an email link runs for the account signed in with that email');
  await assert.rejects(ana.releaseSharedTool(byEmail.code, { verified_email: 'someone@example.com' }), /for someone else/);
  const seeOnly = await ana.createRecordShare('tool:count-words', { scope: { kind: 'private', value: relays.bo }, can: ['view'] });
  await assert.rejects(ana.releaseSharedTool(seeOnly.code, { relay: relays.bo }), /see this tool, not run it/);
  await ana.revokeRecordShare('tool:count-words', forBo.share_id);
  await assert.rejects(ana.releaseSharedTool(forBo.code, { relay: relays.bo }), /ended/, 'stopping the link stops the next run');
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, can: ['view', 'run'] }), /cannot let someone run/, 'only a kind that offers run can carry it');
  assert.equal(shareCodeOf(`https://app.gettrillion.ai/share/${byEmail.code}`), byEmail.code);
  assert.equal(shareCodeOf(`https://app.gettrillion.ai/share/${byEmail.code}?access_code=x`), byEmail.code);
  assert.equal(shareCodeOf(byEmail.code), byEmail.code);
  assert.equal(shareCodeOf('https://app.gettrillion.ai/share/'), null);
  assert.equal(shareCodeOf('not a link'), null);
  const send = sharingTools(async (path, body) => ({ path, body })).find(item => item.name === 'send_share_link');
  assert.deepEqual(await send.run({ record: 'tool:count-words', share_id: 'share_1', note: 'For you' }), { path: '/sharing/tool%3Acount-words/links/share_1/send', body: { note: 'For you' } });
});

test('a public view-only page paints without a sender read, then reads the current name behind a live grant', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  const link = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, can: ['view'] });
  let currentName = 'Ana';
  let reads = 0;
  ana.accountName = async () => { reads++; return currentName; };
  const page = await ana.sharedPageForLink(link.code);
  assert.equal(page.copy.title, 'Launch in 40 stores');
  assert.equal(page.access.sender, null);
  assert.equal(page.access.deferred_sender, true);
  assert.equal(reads, 0, 'the page does not wait for the account-name store');
  assert.equal(await ana.shareSenderForLink(link.code), 'Ana');
  currentName = 'Anastasia';
  assert.equal(await ana.shareSenderForLink(link.code), 'Anastasia', 'the name is current, not saved on the share');
  currentName = null;
  assert.equal(await ana.shareSenderForLink(link.code), null, 'an unnamed account leaves the neutral attribution alone');

  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  ana.accountName = async () => { entered(); await paused; return currentName; };
  const pending = ana.shareSenderForLink(link.code);
  await started;
  await ana.revokeRecordShare('pursuit:launch', link.share_id);
  release();
  await assert.rejects(pending, /ended/, 'a revocation during name lookup cannot release the sender');
});

test('an account log full error cannot turn an authorized share page into an ended link', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
  };
  const link = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' } });
  const originalWrite = ana.store.eeaf.write;
  ana.store.eeaf.write = (rows, options) => {
    if (rows.some(row => row.type === 'commercial-event' && row.value?.event === 'share_viewed')) throw new Error('Exceeded the maximum database size.');
    return originalWrite.call(ana.store.eeaf, rows, options);
  };
  const copy = await ana.resolveRecordShare(link.code);
  assert.equal(copy.title, 'Launch in 40 stores');
  assert.equal(copy.provenance.origin, 'shared by link');
});

test('a routed share reuses its index but still checks this owner and the current grant', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
  };
  const link = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' } });
  const index = JSON.parse([...values.values()][0]);
  ana.env.APP_KV.get = async () => { throw new Error('duplicate link index read'); };
  assert.equal((await ana.resolveRecordShare(link.code, { link_index: index, record_view: false })).title, 'Launch in 40 stores');
  await assert.rejects(ana.resolveRecordShare(link.code, { link_index: { ...index, person_ref: 'another-owner' }, record_view: false }), /unavailable/);
  await ana.revokeRecordShare('pursuit:launch', link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code, { link_index: index, record_view: false }), /ended/);
});

test('one link to several records keeps one grant and rechecks every source on read', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
  };
  const first = 'file:first-video';
  const second = 'file:second-video';
  const link = await ana.createRecordShare(first, { scope: { kind: 'public' }, records: [second, first] });
  const copy = await ana.resolveRecordShare(link.code);
  assert.equal(copy.kind, 'collection');
  assert.deepEqual(copy.items.map(item => item.body.identity), ['first-video', 'second-video']);
  assert.ok(copy.items.every(item => !('private_ref' in item)));
  const originalRead = ana.shareableRecord.bind(ana);
  const readNames = [];
  ana.shareableRecord = async input => { readNames.push(input.file); return originalRead(input); };
  const selected = await ana.resolveRecordShare(link.code, { item_index: 1, record_view: false });
  assert.equal(selected.body.identity, 'second-video');
  assert.deepEqual(readNames, ['second-video'], 'one video range does not read every other item in the collection');
  assert.equal(ana.shareLinksOf(first).length, 1);
  await assert.rejects(ana.createRecordShare(first, { scope: { kind: 'public' }, records: Array.from({ length: 100 }, (_, index) => `file:extra-${index}`) }), /at most 99/);
  await ana.revokeRecordShare(first, link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code), /ended/);
});

test('one unpublished mixed link accepts ordered batches beyond 100 and reads a far-end video directly', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const first = Array.from({ length: 80 }, (_, n) => ({ kind: 'record', record: `file:early-${n}` }));
  const middle = Array.from({ length: 80 }, (_, n) => n % 2
    ? { kind: 'link', url: `https://example.com/${n}`, title: `Link ${n}` }
    : { kind: 'text', text: `Words ${n}` });
  const last = Array.from({ length: 80 }, (_, n) => ({ kind: 'record', record: `file:late-${n}`, ...(n === 79 ? { title: 'Final clip' } : {}) }));
  const share = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: first, publish: false, expected_total: 240 });
  await assert.rejects(ana.resolveRecordShare(share.code), /ended/, 'draft links cannot reveal a partial selection');
  await assert.rejects(ana.publishRecordShare(share.record, share.share_id), /80 of 240/, 'a draft cannot publish a partial selection');
  assert.equal(share.entry_count, 80);
  const added = await ana.appendRecordShare(share.record, share.share_id, { expected_count: 80, items: middle });
  assert.equal(added.entry_count, 160);
  assert.equal((await ana.appendRecordShare(share.record, share.share_id, { expected_count: 80, items: middle })).entry_count, 160, 'same batch is an idempotent retry');
  await assert.rejects(ana.appendRecordShare(share.record, share.share_id, { expected_count: 80, items: [{ kind: 'text', text: 'Different' }] }), /now has 160/);
  assert.equal((await ana.appendRecordShare(share.record, share.share_id, { expected_count: 160, items: last })).entry_count, 240);
  const grant = ana.sharingRowOf(share.record).link_grants.find(item => item.share_id === share.share_id);
  assert.equal(grant.entries, undefined, 'large memberships do not accumulate inside the grant row');
  assert.equal(grant.collection.leaf_count, 240);
  assert.equal((await ana.publishRecordShare(share.record, share.share_id)).published, true);
  const originalRead = ana.shareableRecord.bind(ana);
  const readNames = [];
  ana.shareableRecord = async input => { if (input.file) readNames.push(input.file); return originalRead(input); };
  const originalSql = ana.sql.exec.bind(ana.sql);
  const pageReads = [];
  ana.sql.exec = (query, ...binds) => {
    if (/^SELECT .* FROM share_collection_pages/.test(query)) pageReads.push({ query, binds });
    return originalSql(query, ...binds);
  };
  const selected = await ana.resolveRecordShare(share.code, { item_index: 239, record_view: false });
  assert.equal(selected.body.identity, 'late-79');
  assert.equal(selected.title, 'Final clip');
  assert.deepEqual(readNames, ['late-79'], 'last-item byte admission must not read the preceding files');
  assert.equal(pageReads.length, 1, 'last-item lookup reads one indexed collection page');
  pageReads.length = 0;
  readNames.length = 0;
  const fullPage = await ana.resolveRecordShare(share.code, { item_offset: 70, item_limit: 32, record_view: false });
  assert.equal(fullPage.items.length, 32);
  assert.equal(fullPage.items[0].body.identity, 'early-70');
  assert.equal(fullPage.items[31].body.url, 'https://example.com/21');
  assert.deepEqual(readNames, Array.from({ length: 10 }, (_, n) => `early-${70 + n}`), 'the page reads only its ten visible source files');
  assert.equal(pageReads.length, 2, 'a 32-item window uses one starting-page lookup and one bounded page read');
  assert.equal(pageReads[1].binds[1], 2, 'the SQL page range starts at the indexed page, not at the collection beginning');
  const page = await ana.resolveRecordShare(share.code, { item_offset: 224, item_limit: 32, record_view: false });
  assert.equal(page.item_count, 240);
  assert.equal(page.item_offset, 224);
  assert.equal(page.items.length, 16);
  assert.equal(page.has_more, false);
  assert.equal(page.items[0].body.identity, 'late-64');
  await ana.revokeRecordShare(share.record, share.share_id);
  await assert.rejects(ana.resolveRecordShare(share.code, { item_index: 239, record_view: false }), /ended/);
});

test('repeated one-item appends fill bounded pages instead of creating a page for each batch', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const share = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 40,
    items: [{ kind: 'text', text: 'Clip 0' }] });
  for (let count = 1; count < 40; count += 1) {
    const result = await ana.appendRecordShare(share.record, share.share_id, {
      expected_count: count, items: [{ kind: 'text', text: `Clip ${count}` }],
    });
    assert.equal(result.entry_count, count + 1);
  }
  const grant = ana.sharingRowOf(share.record).link_grants.find(item => item.share_id === share.share_id);
  assert.equal(grant.collection.page_count, 2);
  const pages = ana.sql.exec('SELECT ordinal_start, leaf_start, entries_json FROM share_collection_pages WHERE share_id = ? ORDER BY page_no', share.share_id).toArray();
  assert.deepEqual(pages.map(page => [page.ordinal_start, page.leaf_start, JSON.parse(page.entries_json).length]), [[0, 0, 32], [32, 32, 8]]);
  await ana.publishRecordShare(share.record, share.share_id);
  const final = await ana.resolveRecordShare(share.code, { item_offset: 24, item_limit: 32, record_view: false });
  assert.deepEqual(final.items.map(item => item.body.text), Array.from({ length: 16 }, (_, n) => `Clip ${n + 24}`));
  await ana.revokeRecordShare(share.record, share.share_id);
  assert.equal(ana.sql.exec('SELECT COUNT(*) AS count FROM share_collection_pages WHERE share_id = ?', share.share_id).toArray()[0].count, 0,
    'a revoked collection releases its reference pages');
});

test('indexed pages preserve nested order and recheck a child grant without reading preceding files', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'First nested' }, { kind: 'text', text: 'Second nested' }] });
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 3, items: [
    { kind: 'record', record: 'file:before' }, { kind: 'share', code: child.code }, { kind: 'record', record: 'file:after' },
  ] });
  await ana.publishRecordShare(outer.record, outer.share_id);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 2, record_view: false })).body.text, 'Second nested');
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 3, record_view: false })).body.identity, 'after');
  await ana.revokeRecordShare(child.record, child.share_id);
  await assert.rejects(ana.resolveRecordShare(outer.code, { item_index: 2, record_view: false }), /ended/);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 3, record_view: false })).body.identity, 'after', 'an unrelated item after a revoked nested link remains reachable');
});

test('inline collections keep withdrawn nested positions and refuse uncounted legacy subtrees', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [
    { kind: 'text', text: 'Former first' }, { kind: 'text', text: 'Former second' },
  ] });
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [
    { kind: 'text', text: 'Before' }, { kind: 'share', code: child.code }, { kind: 'text', text: 'After' },
  ] });
  assert.equal(ana.sharingRowOf(outer.record).link_grants[0].entries[1].leaf_count, 2);
  await ana.revokeRecordShare(child.record, child.share_id);
  const page = await ana.resolveRecordShare(outer.code, { item_offset: 1, item_limit: 3, record_view: false });
  assert.equal(page.item_count, 4);
  assert.deepEqual(page.items.map(item => item.kind), ['withdrawn', 'withdrawn', 'text']);
  assert.equal(page.items[2].body.text, 'After');
  await assert.rejects(ana.resolveRecordShare(outer.code, { item_index: 1, record_view: false }), /ended/);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 3, record_view: false })).body.text, 'After');

  const row = ana.sharingRowOf(outer.record);
  ana.store.eeaf.write([{ id: `sharing:${outer.record}`, type: 'sharing', value: {
    ...row, link_grants: row.link_grants.map(grant => grant.share_id !== outer.share_id ? grant : {
      ...grant, entries: grant.entries.map(({ leaf_count: _count, ...entry }) => entry),
    }),
  } }], { actor: { by: 'test' } });
  await assert.rejects(ana.resolveRecordShare(outer.code, { item_offset: 0, record_view: false }), /unavailable/,
    'a legacy grant with no saved child size cannot shift a later public index');
});

test('a source withdrawn at a page boundary keeps both adjacent pages and later indexes stable', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const entries = Array.from({ length: 66 }, (_, at) => [31, 32].includes(at)
    ? { kind: 'record', record: 'file:one-withdrawn-source', title: 'No longer public' }
    : { kind: 'text', text: `Survivor ${at}` });
  const link = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false,
    expected_total: entries.length, items: entries });
  await ana.publishRecordShare(link.record, link.share_id);
  const realShareable = ana.shareableRecord.bind(ana);
  ana.shareableRecord = async input => {
    if (input.file === 'one-withdrawn-source') throw new SharingError('one-withdrawn-source is not in your files.');
    return realShareable(input);
  };
  const first = await ana.resolveRecordShare(link.code, { item_offset: 0, item_limit: 32, record_view: false });
  const middle = await ana.resolveRecordShare(link.code, { item_offset: 32, item_limit: 32, record_view: false });
  const last = await ana.resolveRecordShare(link.code, { item_offset: 64, item_limit: 32, record_view: false });
  assert.deepEqual([first.items.length, middle.items.length, last.items.length], [32, 32, 2]);
  assert.deepEqual([first.items[31], middle.items[0]], [
    { kind: 'withdrawn', title: 'No longer shared' }, { kind: 'withdrawn', title: 'No longer shared' },
  ]);
  assert.equal(middle.items[1].body.text, 'Survivor 33');
  assert.equal(last.items[1].body.text, 'Survivor 65');
  await assert.rejects(ana.resolveRecordShare(link.code, { item_index: 31, record_view: false }), /not in your files/);
  await assert.rejects(ana.resolveRecordShare(link.code, { item_index: 32, record_view: false }), /not in your files/);
  assert.equal((await ana.resolveRecordShare(link.code, { item_index: 33, record_view: false })).body.text, 'Survivor 33');
  await ana.revokeRecordShare(link.record, link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code, { item_offset: 32, record_view: false }), /ended/);
});

test('a withdrawn nested child leaves a mixed outer collection and independent sibling links readable', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [
    { kind: 'text', title: 'Secret child title', text: 'Secret child words' },
    { kind: 'record', record: 'file:secret-child-file', title: 'Secret child file' },
  ] });
  const sibling = await ana.createRecordShare('file:sibling', { scope: { kind: 'public' } });
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 11, items: [
    { kind: 'text', text: 'Opening words' },
    { kind: 'link', url: 'https://example.com/one' },
    { kind: 'record', record: 'file:sibling' },
    { kind: 'text', text: 'Before child' },
    { kind: 'share', code: child.code, title: 'Secret nested label' },
    { kind: 'record', record: 'file:after' },
    { kind: 'link', url: 'https://example.com/two' },
    { kind: 'text', text: 'Middle words' },
    { kind: 'record', record: 'file:last' },
    { kind: 'text', text: 'Closing words' },
    { kind: 'link', url: 'https://example.com/three' },
  ] });
  await ana.publishRecordShare(outer.record, outer.share_id);
  const before = await ana.resolveRecordShare(outer.code, { record_view: false });
  assert.equal(before.item_count, 12);
  assert.equal(before.items[4].body.text, 'Secret child words');
  assert.equal(before.items[5].body.identity, 'secret-child-file');

  await ana.revokeRecordShare(child.record, child.share_id);
  await assert.rejects(ana.resolveRecordShare(child.code, { record_view: false }), /ended/);
  const after = await ana.resolveRecordShare(outer.code, { record_view: false });
  assert.equal(after.kind, 'collection');
  assert.equal(after.item_count, 12);
  assert.deepEqual(after.items.slice(4, 6), [
    { kind: 'withdrawn', title: 'No longer shared' },
    { kind: 'withdrawn', title: 'No longer shared' },
  ]);
  assert.equal(after.items[2].body.identity, 'sibling');
  assert.equal(after.items[6].body.identity, 'after');
  assert.equal(after.items[11].body.url, 'https://example.com/three');
  assert.doesNotMatch(JSON.stringify(after), /Secret child|secret-child|Secret nested/);
  await assert.rejects(ana.resolveRecordShare(outer.code, { item_index: 4, record_view: false }), /ended/);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 6, record_view: false })).body.identity, 'after');
  assert.equal((await ana.resolveRecordShare(sibling.code, { record_view: false })).body.identity, 'sibling');
  const normalGet = ana.env.APP_KV.get;
  ana.env.APP_KV.get = async (key, type) => {
    if (key.endsWith(child.code)) throw new Error('KV temporarily unavailable');
    return normalGet(key, type);
  };
  await assert.rejects(ana.resolveRecordShare(outer.code, { record_view: false }), /KV temporarily unavailable/,
    'a storage failure is not mistaken for an ended child');
});

test('a visible run inside a nested paged share reads one bounded page from each collection', async () => {
  const { ana } = await world();
  const values = new Map();
  const kvReads = [];
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { kvReads.push(key); return type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null; },
    delete: async key => values.delete(key),
  };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 64,
    items: Array.from({ length: 64 }, (_, n) => ({ kind: 'text', text: `Nested ${n}` })) });
  await ana.publishRecordShare(child.record, child.share_id);
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'share', code: child.code }] });
  await ana.publishRecordShare(outer.record, outer.share_id);
  kvReads.length = 0;
  const originalSql = ana.sql.exec.bind(ana.sql);
  const pageReads = [];
  ana.sql.exec = (query, ...binds) => {
    if (/^SELECT .* FROM share_collection_pages/.test(query)) pageReads.push({ query, binds });
    return originalSql(query, ...binds);
  };
  const page = await ana.resolveRecordShare(outer.code, { item_offset: 16, item_limit: 32, record_view: false });
  assert.deepEqual(page.items.map(item => item.body.text), Array.from({ length: 32 }, (_, n) => `Nested ${n + 16}`));
  assert.equal(pageReads.length, 4, 'the outer and child each use one starting-page lookup and one bounded page read');
  assert.equal(kvReads.filter(key => key.endsWith(child.code)).length, 1, 'the child grant is checked once for this visible run');
});

test('a source read pending through revocation cannot return a direct or nested shared file', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const originalRead = ana.shareableRecord.bind(ana);
  const duringRead = async (share, revoked) => {
    let release;
    let markReading;
    const reading = new Promise(resolve => { markReading = resolve; });
    ana.shareableRecord = async input => {
      if (input.file === 'waiting-video') {
        markReading();
        await new Promise(resolve => { release = resolve; });
      }
      return originalRead(input);
    };
    const pending = ana.resolveRecordShare(share.code, { item_index: 0, record_view: false });
    await reading;
    await ana.revokeRecordShare(revoked.record, revoked.share_id);
    release();
    await assert.rejects(pending, /ended/);
    ana.shareableRecord = originalRead;
  };
  const direct = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'record', record: 'file:waiting-video' }] });
  await ana.publishRecordShare(direct.record, direct.share_id);
  await duringRead(direct, direct);
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'record', record: 'file:waiting-video' }] });
  await ana.publishRecordShare(child.record, child.share_id);
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'share', code: child.code }] });
  await ana.publishRecordShare(outer.record, outer.share_id);
  await duringRead(outer, child);
});

test('an unfinished replacement keeps its existing named link live until the complete share publishes', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const old = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'selected-clips', items: [{ kind: 'text', text: 'Old selection' }] });
  const draft = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'selected-clips', publish: false, expected_total: 2, items: [{ kind: 'text', text: 'New selection' }] });
  assert.equal((await ana.resolveRecordShare('selected-clips', { record_view: false })).body.text, 'Old selection');
  await assert.rejects(ana.publishRecordShare(draft.record, draft.share_id), /1 of 2/);
  assert.equal((await ana.resolveRecordShare(old.code, { record_view: false })).body.text, 'Old selection');
  await ana.appendRecordShare(draft.record, draft.share_id, { expected_count: 1, items: [{ kind: 'text', text: 'Another new item' }] });
  const write = ana.store.eeaf.write.bind(ana.store.eeaf);
  ana.store.eeaf.write = () => { throw new Error('Failed publication'); };
  await assert.rejects(ana.publishRecordShare(draft.record, draft.share_id), /Failed publication/);
  assert.equal((await ana.resolveRecordShare('selected-clips', { record_view: false })).body.text, 'Old selection', 'a failed publication must not take the old named link away');
  ana.store.eeaf.write = write;
  const published = await ana.publishRecordShare(draft.record, draft.share_id);
  assert.equal(published.name, 'selected-clips');
  assert.deepEqual((await ana.resolveRecordShare('selected-clips', { record_view: false })).items.map(item => item.body.text), ['New selection', 'Another new item']);
  await assert.rejects(ana.resolveRecordShare(old.code, { record_view: false }), /ended/);
});

test('an immediate named replacement keeps the old link live when its grant write fails', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const old = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'instant-clips', items: [{ kind: 'text', text: 'Old clip' }] });
  const write = ana.store.eeaf.write.bind(ana.store.eeaf);
  ana.store.eeaf.write = () => { throw new Error('Failed new grant'); };
  await assert.rejects(ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'instant-clips', items: [{ kind: 'text', text: 'New clip' }] }), /Failed new grant/);
  ana.store.eeaf.write = write;
  assert.equal((await ana.resolveRecordShare('instant-clips', { record_view: false })).body.text, 'Old clip');
  assert.equal((await ana.resolveRecordShare(old.code, { record_view: false })).body.text, 'Old clip');
  const replacement = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'instant-clips', items: [{ kind: 'text', text: 'New clip' }] });
  assert.equal((await ana.resolveRecordShare('instant-clips', { record_view: false })).body.text, 'New clip');
  assert.equal((await ana.resolveRecordShare(replacement.code, { record_view: false })).body.text, 'New clip');
  await assert.rejects(ana.resolveRecordShare(old.code, { record_view: false }), /ended/);
});

test('an immediate named replacement restores the old name when ending the old grant fails', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const old = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'restore-clips', items: [{ kind: 'text', text: 'Old clip' }] });
  const revoke = ana.revokeRecordShare.bind(ana);
  ana.revokeRecordShare = (record, shareId) => shareId === old.share_id ? Promise.reject(new Error('Old revoke failed')) : revoke(record, shareId);
  await assert.rejects(ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'restore-clips', items: [{ kind: 'text', text: 'New clip' }] }), /Old revoke failed/);
  ana.revokeRecordShare = revoke;
  assert.equal((await ana.resolveRecordShare('restore-clips', { record_view: false })).body.text, 'Old clip');
  assert.equal((await ana.resolveRecordShare(old.code, { record_view: false })).body.text, 'Old clip');
});

test('a commercial-event write failure does not report a live share as failed', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const write = ana.store.eeaf.write.bind(ana.store.eeaf);
  ana.store.eeaf.write = (entries, options) => {
    if (entries.some(entry => entry.type === 'commercial-event')) throw new Error('Analytics unavailable');
    return write(entries, options);
  };
  const share = await ana.createRecordShare(null, { scope: { kind: 'public' }, address: 'analytics-case', items: [{ kind: 'text', text: 'Still live' }] });
  assert.equal((await ana.resolveRecordShare(share.code, { record_view: false })).body.text, 'Still live');
  assert.equal((await ana.resolveRecordShare('analytics-case', { record_view: false })).body.text, 'Still live');
  await ana.revokeRecordShare(share.record, share.share_id);
  await assert.rejects(ana.resolveRecordShare(share.code, { record_view: false }), /ended/);
});

test('concurrent publication of one draft retains one named address', async () => {
  const { ana } = await world();
  const values = new Map();
  let release;
  let markBlocked;
  const blocked = new Promise(resolve => { markBlocked = resolve; });
  let gate = true;
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => {
      if (key === 'record-share-link:chosen-name' && gate) {
        gate = false;
        markBlocked();
        await new Promise(resolve => { release = resolve; });
      }
      return type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null;
    },
    delete: async key => values.delete(key),
  };
  const draft = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'text', title: 'Chosen Name', text: 'One item' }] });
  const pending = ana.publishRecordShare(draft.record, draft.share_id);
  await blocked;
  const first = await ana.publishRecordShare(draft.record, draft.share_id);
  release();
  const second = await pending;
  assert.equal(first.name, 'chosen-name');
  assert.equal(second.name, first.name);
  assert.equal(ana.sharingRowOf(draft.record).link_grants.find(item => item.share_id === draft.share_id).address, first.name);
  assert.equal([...values.values()].filter(value => JSON.parse(value).share_id === draft.share_id).length, 2,
    'the draft has one opaque code and one readable address');
});

test('the public collection tools create, append and publish one 101-item link through the authenticated route', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const tools = Object.fromEntries(sharingTools((path, body) => handleSharingRequest(ana, new Request(`https://person${path}`, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))).map(tool => [tool.name, tool]));
  const createdResponse = await tools.share_collection_by_link.run({ scope: { kind: 'public' }, publish: false, expected_total: 101,
    items: Array.from({ length: 100 }, (_, n) => ({ kind: 'text', text: `Item ${n}` })) });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.published, false);
  const appendedResponse = await tools.add_to_share_collection_link.run({ share_id: created.share_id, expected_count: 100, items: [{ kind: 'record', record: 'file:final-video' }] });
  assert.equal(appendedResponse.status, 200);
  assert.equal((await appendedResponse.json()).entry_count, 101);
  const publishedResponse = await tools.publish_share_collection_link.run({ share_id: created.share_id });
  assert.equal(publishedResponse.status, 200);
  assert.equal((await ana.resolveRecordShare(created.code, { item_index: 100, record_view: false })).body.identity, 'final-video');
});

test('owner can page, copy and stop earlier mixed links after the creation panel closes', async () => {
  const { ana, people } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const first = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [
    { kind: 'record', record: 'file:clip-one', title: 'Kitchen clip' },
    { kind: 'record', record: 'case_copacker', title: 'Co-packer choice' },
  ] });
  const second = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 2,
    items: [{ kind: 'text', text: 'Watch together', title: 'Viewing note' }] });
  await ana.appendRecordShare(second.record, second.share_id, { expected_count: 1,
    items: [{ kind: 'record', record: 'file:clip-two', title: 'Second clip' }] });
  await ana.publishRecordShare(second.record, second.share_id);
  const pending = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 2,
    items: [{ kind: 'text', text: 'Not open yet' }] });
  const found = [];
  let before = null;
  do {
    const query = new URLSearchParams({ limit: '1', ...(before ? { before } : {}) });
    const response = await handleSharingRequest(ana, new Request(`https://person/sharing/collection/links?${query}`, {
      headers: { 'x-trillion-origin': 'https://app.gettrillion.ai' },
    }));
    assert.equal(response.status, 200);
    const page = await response.json();
    found.push(...page.links);
    before = page.next_before;
  } while (before);
  assert.deepEqual(new Set(found.map(link => link.share_id)), new Set([first.share_id, second.share_id, pending.share_id]));
  assert.equal(found.find(link => link.share_id === first.share_id).first_title, 'Kitchen clip');
  assert.equal(found.find(link => link.share_id === second.share_id).first_title, 'Viewing note');
  assert.ok(found.every(link => link.address.startsWith('https://app.gettrillion.ai/share/')));
  assert.equal(found.find(link => link.share_id === pending.share_id).published, false, 'an unfinished link remains findable but cannot be offered as open');
  assert.deepEqual(people.bo.collectionLinks().links, [], 'another owner cannot enumerate these grants');
  const stopped = await handleSharingRequest(ana, new Request(`https://person/sharing/collection/links/${first.share_id}/revoke`, { method: 'POST', body: '{}' }));
  assert.equal(stopped.status, 200);
  assert.ok(ana.collectionLinks({ limit: 32 }).links.find(link => link.share_id === first.share_id).revoked_at);
  await assert.rejects(ana.resolveRecordShare(first.code, { item_index: 0, record_view: false }), /ended/);
});

test('existing mixed links can be read, renewed and stopped through the generic owner route', async () => {
  const { ana, people } = await world();
  ana.env.APP_KV = kvOf(new Map());
  const created = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [
    { kind: 'text', title: 'A note', text: 'Keep the same shared selection.' },
    { kind: 'record', record: 'file:clip-one', title: 'A clip' },
  ] });
  const row = ana.sharingRowOf(created.record);
  ana.store.eeaf.write([{ id: `sharing:${created.record}`, type: 'sharing', value: {
    ...row, link_grants: row.link_grants.map(grant => ({ ...grant, expires_at: '2001-01-01T00:00:00.000Z' })),
  } }], { actor: { by: 'test' } });
  const path = `/sharing/${encodeURIComponent(created.record)}/links`;
  const request = (owner, suffix = '', body) => handleSharingRequest(owner, new Request(`https://person${path}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const found = await request(ana);
  assert.equal(found.status, 200);
  const links = (await found.json()).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].share_id, created.share_id);
  assert.equal(links[0].code, undefined);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const changed = await request(ana, `/${created.share_id}/change`, { expires_at: until, can: ['view'] });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).expires_at, until);
  assert.equal(ana.sharingRowOf(created.record).link_grants.length, 1);
  assert.equal((await ana.resolveRecordShare(created.code, { record_view: false })).item_count, 2);
  assert.equal((await request(people.bo)).status, 400, 'another person cannot read the owner grants');
  assert.equal((await request(people.bo, `/${created.share_id}/change`, { expires_at: until })).status, 400);
  assert.equal((await request(ana, '/wrong-share/change', { expires_at: until })).status, 400);
  const badAbility = await request(ana, `/${created.share_id}/change`, { can: ['view', 'pay'] });
  assert.equal(badAbility.status, 400, 'management keeps the collection ability check');
  const stopped = await request(ana, `/${created.share_id}/revoke`, {});
  assert.equal(stopped.status, 200);
  assert.equal((await request(ana, `/${created.share_id}/change`, { expires_at: until })).status, 400);
  assert.ok((await (await request(ana)).json()).links[0].revoked_at, 'ended links remain manageable');
  const draft = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 2,
    items: [{ kind: 'text', text: 'First draft note' }] });
  const draftPath = `/sharing/${encodeURIComponent(draft.record)}/links`;
  const manageDraft = (suffix, body) => handleSharingRequest(ana, new Request(`https://person${draftPath}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  assert.equal((await manageDraft('')).status, 200, 'paged drafts have the same management owner');
  assert.equal((await manageDraft(`/${draft.share_id}/change`, { expires_at: until })).status, 200);
  assert.equal((await manageDraft(`/${draft.share_id}/items`, { expected_count: 1, items: [{ kind: 'text', text: 'Last draft note' }] })).status, 200);
  assert.equal((await manageDraft(`/${draft.share_id}/publish`, {})).status, 200);
  assert.equal((await ana.resolveRecordShare(draft.code, { record_view: false })).item_count, 2);
  assert.equal((await manageDraft('', { scope: { kind: 'public' } })).status, 400, 'a collection owner cannot create a replacement record link');
});

test('a failed first draft write rolls back pages and a later draft can use the same store', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  const write = ana.store.eeaf.write.bind(ana.store.eeaf);
  ana.store.eeaf.write = () => { throw new Error('Failed grant write'); };
  await assert.rejects(ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'text', text: 'Keep after retry' }] }), /Failed grant write/);
  assert.equal(ana.sql.exec('SELECT COUNT(*) AS count FROM share_collection_pages').toArray()[0].count, 0);
  ana.store.eeaf.write = write;
  const retry = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'text', text: 'Keep after retry' }] });
  await ana.publishRecordShare(retry.record, retry.share_id);
  assert.equal((await ana.resolveRecordShare(retry.code, { record_view: false })).body.text, 'Keep after retry');
});

test('paged nesting counts both records and inline items from an older mixed grant without entries', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const child = await ana.createRecordShare('file:older', { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Older words' }] });
  const row = ana.sharingRowOf('file:older');
  ana.store.eeaf.write([{ id: 'sharing:file:older', type: 'sharing', value: { ...row, link_grants: row.link_grants.map(grant => {
    const { entries: _entries, ...older } = grant;
    return older;
  }) } }], { actor: { by: 'test' } });
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 2,
    items: [{ kind: 'share', code: child.code }, { kind: 'record', record: 'file:after' }] });
  assert.equal(ana.sharingRowOf(outer.record).link_grants[0].collection.leaf_count, 3);
  await ana.publishRecordShare(outer.record, outer.share_id);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 1, record_view: false })).body.text, 'Older words');
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 2, record_view: false })).body.identity, 'after');
});

test('duplicate nested link DAGs count once per grant and support a far-end indexed read', async () => {
  const { ana } = await world();
  const values = new Map();
  let lookups = 0;
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => {
    if (key.startsWith('record-share-link:')) lookups += 1;
    return type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null;
  } };
  let child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Deep leaf' }] });
  for (let depth = 0; depth < 25; depth += 1) child = await ana.createRecordShare(null, { scope: { kind: 'public' },
    items: [{ kind: 'share', code: child.code }, { kind: 'share', code: child.code }] });
  lookups = 0;
  const outer = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 1,
    items: [{ kind: 'share', code: child.code }] });
  assert.equal(ana.sharingRowOf(outer.record).link_grants[0].collection.leaf_count, 2 ** 25);
  assert.ok(lookups < 100, 'counting a shared DAG should inspect each distinct child, not each of its millions of leaves');
  await ana.publishRecordShare(outer.record, outer.share_id);
  assert.equal((await ana.resolveRecordShare(outer.code, { item_index: 2 ** 25 - 1, record_view: false })).body.text, 'Deep leaf');
});

test('a draft revoked during item validation cannot append its later batch', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const draft = await ana.createRecordShare(null, { scope: { kind: 'public' }, publish: false, expected_total: 2,
    items: [{ kind: 'text', text: 'First' }] });
  const originalRead = ana.shareableRecord.bind(ana);
  ana.shareableRecord = async input => {
    if (input.file === 'late') await ana.revokeRecordShare(draft.record, draft.share_id);
    return originalRead(input);
  };
  await assert.rejects(ana.appendRecordShare(draft.record, draft.share_id, { expected_count: 1,
    items: [{ kind: 'record', record: 'file:late' }] }), /changed or ended/);
  assert.equal(ana.sharingRowOf(draft.record).link_grants[0].collection.entry_count, 1);
});

test('one link can combine a video, workflow, and decision without copying private workflow fields', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
  };
  const workflow = shareableCopy('workflow', 'workflow:review', {
    label: 'Review footage', job: 'Pick the useful moments', input_schema: { type: 'object' },
    steps: [{ id: 'watch', do: 'Watch each clip' }], source: { private_note: 'Keep this back' },
  });
  const original = ana.shareableRecord;
  ana.shareableRecord = async function (input) {
    return input.record_id === 'workflow:review' ? workflow : original.call(this, input);
  };
  const link = await ana.createRecordShare('file:first-video', { scope: { kind: 'public' }, records: ['workflow:review', 'case_copacker'] });
  const collection = await ana.resolveRecordShare(link.code);
  assert.equal(collection.kind, 'collection');
  assert.deepEqual(collection.items.map(item => item.kind), ['file', 'workflow', 'decision']);
  assert.deepEqual(Object.keys(collection.items[1].body), ['label', 'job', 'input_schema', 'steps']);
  assert.ok(!JSON.stringify(collection).includes('Keep this back'));
  await ana.revokeRecordShare('file:first-video', link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code), /ended/);
});

test('one generic link keeps records, links and words together without copying files', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const link = await ana.createRecordShare(null, {
    scope: { kind: 'public' },
    items: [
      { kind: 'text', title: 'For Jihan', text: 'Here are the clips from this week.' },
      { kind: 'link', title: 'The project', url: 'https://example.com/project' },
      { kind: 'record', record: 'file:first-video', title: 'Clip one' },
    ],
  });
  const copy = await ana.resolveRecordShare(link.code);
  assert.equal(copy.kind, 'collection');
  assert.deepEqual(copy.items.map(item => item.kind), ['text', 'link', 'file']);
  assert.equal(copy.items[0].body.text, 'Here are the clips from this week.');
  assert.equal(copy.items[1].body.url, 'https://example.com/project');
  assert.ok(!('private_ref' in copy.items[2]));
  await ana.revokeRecordShare(link.record, link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code), /ended/);
});

test('a mixed collection keeps the title of each repeated source in its original place', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Child words' }] });
  const items = [
    { kind: 'text', text: 'Same words', title: 'Opening note' },
    { kind: 'link', url: 'https://example.com/reference', title: 'First reference' },
    { kind: 'text', text: 'Same words', title: 'Closing note' },
    { kind: 'link', url: 'https://example.com/reference', title: 'Second reference' },
    { kind: 'share', code: child.code, title: 'First child' },
    { kind: 'share', code: child.code, title: 'Second child' },
  ];
  const link = await ana.createRecordShare(null, { scope: { kind: 'public' }, items });
  const grant = ana.sharingRowOf(link.record).link_grants.find(row => row.code === link.code);
  assert.deepEqual(grant.entries.map(({ leaf_count: _count, ...entry }) => entry), items,
    'the source order and per-occurrence titles survive normalization');
  assert.deepEqual(grant.entries.slice(4).map(entry => entry.leaf_count), [1, 1]);
  const copy = await ana.resolveRecordShare(link.code);
  assert.deepEqual(copy.items.map(item => item.title), [
    'Opening note', 'First reference', 'Closing note', 'Second reference', 'Shared words', 'Shared words',
  ]);
});

test('nested share collections expand to arbitrary depth and cycles stop safely', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const leaf = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'leaf' }, { kind: 'text', text: 'second leaf' }] });
  const middle = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'share', code: leaf.code }] });
  const top = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'share', code: middle.code }] });
  const expanded = await ana.resolveRecordShare(top.code);
  assert.deepEqual(expanded.items.map(item => item.body.text), ['leaf', 'second leaf']);
  assert.equal((await ana.resolveRecordShare(top.code, { item_index: 1, record_view: false })).body.text, 'second leaf', 'an indexed read also works through nested shares');
  const root = ana.sharingRowOf(`share-bundle:${leaf.share_id}`);
  ana.store.eeaf.write([{ id: `sharing:share-bundle:${leaf.share_id}`, type: 'sharing', value: { ...root, link_grants: root.link_grants.map(grant => grant.code === leaf.code ? { ...grant, entries: [{ kind: 'share', code: leaf.code }] } : grant) } }], { actor: { by: 'test' } });
  await assert.rejects(ana.resolveRecordShare(leaf.code), /circular/);
});

test('an explicit outer grant can reach a recipient-bound child and then show only a withdrawn marker', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const child = await ana.createRecordShare(null, {
    scope: { kind: 'email', value: 'recipient@example.com' },
    items: [{ kind: 'text', text: 'The current child content' }],
  });
  await assert.rejects(ana.resolveRecordShare(child.code), /someone else|access code/);
  const outer = await ana.createRecordShare(null, {
    scope: { kind: 'public' }, items: [{ kind: 'share', code: child.code }],
  });
  assert.equal((await ana.resolveRecordShare(outer.code)).body.text, 'The current child content',
    'the outer link is a new explicit owner grant with its own audience');
  await ana.revokeRecordShare(child.record, child.share_id);
  await assert.rejects(ana.resolveRecordShare(child.code), /ended/);
  const withdrawn = await ana.resolveRecordShare(outer.code);
  assert.equal(withdrawn.kind, 'withdrawn');
  assert.equal(withdrawn.title, 'No longer shared');
  assert.doesNotMatch(JSON.stringify(withdrawn), /The current child content/);
});

test('a mixed collection has an AI revoke action reaching its existing owner route', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null };
  const link = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Temporary words' }] });
  const revoke = sharingTools((path, body) => handleSharingRequest(ana, new Request(`https://person${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))).find(tool => tool.name === 'revoke_share_collection_link');
  assert.ok(revoke, 'the same collection grant can be stopped through MCP');
  const response = await revoke.run({ share_id: link.share_id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).share_id, link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code), /ended/);
});

test('a mixed collection enters a Space in one request while keeping each source check', async () => {
  const { net, relays, space, ana } = await world();
  const result = await ana.shareIntoMany(space, {
    records: ['pursuit:launch', 'case_copacker'],
    items: [{ kind: 'link', title: 'Reference', url: 'https://example.com/reference' }, { kind: 'text', text: 'Look at these together.' }],
  });
  assert.equal(result.count, 4);
  const items = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.deepEqual(items.map(item => item.kind).sort(), ['decision', 'link', 'pursuit', 'text']);
});

test('240 mixed Space items resume in bounded ordered batches without copying or replaying a withdrawal', async () => {
  const { net, relays, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  const sizes = [];
  let interrupt = true;
  net.addSharedSpaceItems = async input => {
    sizes.push(input.entries.length);
    if (interrupt && sizes.length === 2) { interrupt = false; throw new Error('The second batch lost its response.'); }
    return original(input);
  };
  const items = Array.from({ length: 240 }, (_, index) => index % 3 === 0
    ? { kind: 'file', file: `1f:clip-${index}` }
    : index % 3 === 1 ? { kind: 'text', text: `Words ${index}` }
      : { kind: 'link', url: `https://example.com/${index}` });
  items[101] = { kind: 'workflow', workflow_id: 'workflow:review' };
  items[202] = { kind: 'tool', tool_id: 'tool:caption-reader' };
  const originalShareable = ana.shareableRecord.bind(ana);
  ana.shareableRecord = async input => input.record_id === 'workflow:review'
    ? { kind: 'workflow', private_ref: 'workflow:review', title: 'Review footage', body: { label: 'Review footage' } }
    : input.tool === 'tool:caption-reader'
      ? { kind: 'tool', private_ref: 'tool:caption-reader', title: 'Caption reader', body: { label: 'Caption reader' } }
      : originalShareable(input);
  const send = (chosen = items) => handleSpacesRequest(ana, new Request(`https://person/spaces/${space}/share`, {
    method: 'POST', body: JSON.stringify({ items: chosen, request_key: 'selected-240' }),
  }));
  assert.equal((await send()).status, 400);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 100);
  const firstHundred = net.sql.exec('SELECT id FROM space_items WHERE space_id = ? ORDER BY added_at DESC', space).toArray().map(row => row.id);
  const resumed = await send();
  assert.equal(resumed.status, 200);
  const selected = await resumed.json();
  assert.equal(selected.count, 240);
  assert.deepEqual(sizes, [100, 100, 100, 100, 40]);
  assert.deepEqual(selected.placed.slice(0, 100).map(row => row.item_id), firstHundred);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 240);
  const lookupPlan = net.sql.exec("EXPLAIN QUERY PLAN SELECT source_ref, space_id FROM space_items WHERE contributed_by = ? AND origin = 'private' AND withdrawn_at IS NULL AND source_ref IN (SELECT value FROM json_each(?))", relays.ana, JSON.stringify(['file:1f:clip-0'])).toArray();
  assert.ok(lookupPlan.some(row => row.detail.includes('space_items_private_by_owner_ref')), 'holding lookup uses the private-copy index');
  const seen = [];
  let before = null;
  do {
    const page = await net.spaceItems({ relay: relays.bo, space_id: space, before, limit: 100 });
    seen.push(...page.items.map(row => row.item_id));
    before = page.next_before;
  } while (before);
  assert.deepEqual(seen, selected.placed.map(row => row.item_id));
  const file = net.sql.exec('SELECT origin, source_ref, body FROM space_items WHERE id = ?', selected.placed[0].item_id).toArray()[0];
  assert.equal(file.origin, 'private');
  assert.equal(file.source_ref, 'file:1f:clip-0');
  assert.deepEqual(JSON.parse(file.body), { identity: '1f:clip-0', name: null, byte_length: 12, media_type: 'text/markdown' });
  assert.equal(net.sql.exec('SELECT origin FROM space_items WHERE id = ?', selected.placed[101].item_id).toArray()[0].origin, 'private');
  assert.equal(net.sql.exec('SELECT origin FROM space_items WHERE id = ?', selected.placed[202].item_id).toArray()[0].origin, 'private');
  const replayed = await send();
  assert.equal(replayed.status, 200);
  const again = await replayed.json();
  assert.deepEqual(again.placed, selected.placed);
  assert.ok(again.shared.every(batch => batch.added === 0), 'a full retry writes no new items');
  const changed = items.slice();
  changed[239] = { kind: 'text', text: 'Different last item' };
  assert.equal((await send(changed)).status, 400, 'one request key cannot name different contents');
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 240);
  await net.withdrawSpaceItem({ relay: relays.ana, space_id: space, item_id: selected.placed[1].item_id });
  assert.equal((await send()).status, 200);
  assert.equal(net.sql.exec('SELECT body FROM space_items WHERE id = ?', selected.placed[1].item_id).toArray()[0].body, null,
    'retrying the same selection cannot revive a withdrawn literal item');
  await ana.setRecordSharing('file:1f:clip-0', { network: false, spaces: [] });
  await assert.rejects(ana.releaseRecordToSpace({ private_ref: 'file:1f:clip-0', space_id: space }), /not to share this here/);
});

test('a lost Space reply finishes an unchanged private choice on retry, without reviving a later withdrawal', async () => {
  const { net, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  let loseReply = true;
  net.addSharedSpaceItems = async input => {
    const answer = await original(input);
    if (loseReply) { loseReply = false; throw new Error('The Space kept the batch but its reply was lost.'); }
    return answer;
  };
  const ref = 'file:1f:lost-reply';
  await ana.setRecordSharing(ref, { network: null, spaces: [] });
  const send = () => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:lost-reply' }], request_key: 'lost-reply' });
  await assert.rejects(send(), /reply was lost/);
  assert.equal((await ana.releaseRecordToSpace({ private_ref: ref, space_id: space })).kind, 'file');
  const recovered = await send();
  assert.equal(recovered.count, 1);
  assert.equal((await ana.releaseRecordToSpace({ private_ref: ref, space_id: space })).kind, 'file');
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 1);

  loseReply = true;
  const withdrawnRef = 'file:1f:withdraw-before-retry';
  await ana.setRecordSharing(withdrawnRef, { network: null, spaces: [] });
  const sendWithdrawn = () => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:withdraw-before-retry' }], request_key: 'withdraw-before-retry' });
  await assert.rejects(sendWithdrawn(), /reply was lost/);
  await ana.setRecordSharing(withdrawnRef, { network: false, spaces: [] });
  await assert.rejects(sendWithdrawn(), /not to share this here/);
  await assert.rejects(ana.releaseRecordToSpace({ private_ref: withdrawnRef, space_id: space }), /not to share this here/);
});

test('a private selection paused before its first Space write cannot publish after its owner withdraws the choice', async () => {
  const { net, relays, space, ana } = await world();
  const ref = 'workflow:revoked-in-flight';
  const copy = { kind: 'workflow', private_ref: ref, title: 'Private workflow', body: { secret: 'must stay private' } };
  const copies = new Map([[ref, copy]]);
  ana.sharedCopy = async recordRef => copies.get(recordRef);
  ana.shareableRecord = async ({ record_id: recordRef }) => copies.get(recordRef);
  await ana.setRecordSharing(ref, { network: null, spaces: [] });

  const original = net.addSharedSpaceItems.bind(net);
  let pendingWrite = null;
  net.addSharedSpaceItems = async input => {
    const held = pendingWrite;
    if (held) {
      pendingWrite = null;
      held.enter();
      await held.gate;
    }
    return original(input);
  };
  const holdNextWrite = () => {
    let enter;
    let resume;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    pendingWrite = { enter, gate };
    return { entered, resume };
  };
  const firstHold = holdNextWrite();
  const sending = ana.shareIntoMany(space, { records: [ref], request_key: 'revoked-in-flight' });
  await firstHold.entered; // The private projection and its original sharing choice are already captured.
  await ana.setRecordSharing(ref, { network: false, spaces: [] });
  firstHold.resume();
  await sending;

  const saved = net.sql.exec('SELECT body, withdrawn_at FROM space_items WHERE space_id = ? AND contributed_by = ? AND source_ref = ?', space, relays.ana, ref).toArray()[0];
  assert.ok(!saved || saved.withdrawn_at || saved.body === null,
    'the delayed request cannot leave a recipient-readable private snapshot in the Space');
  const recipientView = await net.spaceItems({ relay: relays.bo, space_id: space, limit: 20 });
  assert.equal(recipientView.items.some(item => item.body?.secret === 'must stay private'), false,
    'a later owner revocation fences the pending write instead of publishing its captured private body');

  const sameRef = 'workflow:same-choice-rewrite';
  copies.set(sameRef, { kind: 'workflow', private_ref: sameRef, title: 'Unshared workflow', body: { secret: 'still private' } });
  await ana.setRecordSharing(sameRef, { network: null, spaces: [] });
  const secondHold = holdNextWrite();
  const sameChoice = ana.shareIntoMany(space, { records: [sameRef], request_key: 'same-choice-rewrite' });
  await secondHold.entered;
  await ana.setRecordSharing(sameRef, { network: null, spaces: [] }); // A newer explicit choice with identical fields.
  secondHold.resume();
  await sameChoice;
  const rewritten = net.sql.exec('SELECT body, withdrawn_at FROM space_items WHERE space_id = ? AND contributed_by = ? AND source_ref = ?', space, relays.ana, sameRef).toArray()[0];
  assert.ok(!rewritten || rewritten.withdrawn_at || rewritten.body === null,
    'an identical later choice revision still fences the earlier pending write');
});

test('an older sharing choice cannot overwrite a newer choice while its Network fence is in flight', async () => {
  const { net, relays, space, ana } = await world();
  const ref = 'pursuit:launch';
  const original = net.fencePrivateShareIntents.bind(net);
  let entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  let resume;
  const firstGate = new Promise(resolve => { resume = resolve; });
  let pauseFirst = true;
  net.fencePrivateShareIntents = async input => {
    if (pauseFirst && input.private_refs.includes(ref)) {
      pauseFirst = false;
      entered();
      await firstGate;
    }
    return original(input);
  };

  const older = ana.setRecordSharing(ref, { network: false, spaces: [space] });
  await firstEntered;
  await ana.setRecordSharing(ref, { network: false, spaces: [] });
  resume();
  await assert.rejects(older, /Sharing changed while this choice was being saved/);
  assert.deepEqual(ana.sharingRowOf(ref).spaces, []);
  const recipient = await net.spaceItems({ relay: relays.bo, space_id: space, limit: 20 });
  assert.equal(recipient.items.some(item => item.body?.title === 'Launch in 40 stores'), false);
});

test('a newer sharing choice survives an older choice that commits while the newer projection waits', async () => {
  const { space, ana } = await world();
  const ref = 'pursuit:launch';
  const originalCopy = ana.sharedCopy.bind(ana);
  const originalFence = ana.network().fencePrivateShareIntents.bind(ana.network());
  let firstFenceEntered;
  const firstFence = new Promise(resolve => { firstFenceEntered = resolve; });
  let resumeFirst;
  const firstGate = new Promise(resolve => { resumeFirst = resolve; });
  let holdFence = true;
  ana.network().fencePrivateShareIntents = async input => {
    if (holdFence && input.private_refs.includes(ref)) {
      holdFence = false;
      firstFenceEntered();
      await firstGate;
    }
    return originalFence(input);
  };
  const older = ana.setRecordSharing(ref, { network: false, spaces: [space] });
  await firstFence;

  let newerProjectionEntered;
  const newerProjection = new Promise(resolve => { newerProjectionEntered = resolve; });
  let resumeNewer;
  const newerGate = new Promise(resolve => { resumeNewer = resolve; });
  let pauseProjection = true;
  ana.sharedCopy = async recordRef => {
    if (pauseProjection && recordRef === ref) {
      pauseProjection = false;
      newerProjectionEntered();
      await newerGate;
    }
    return originalCopy(recordRef);
  };
  const newer = ana.setRecordSharing(ref, { network: false, spaces: [] });
  await newerProjection;
  resumeFirst();
  await older;
  resumeNewer();
  await newer;
  assert.deepEqual(ana.sharingRowOf(ref).spaces, [], 'the later intent wins even if the earlier save completed first');
});

test('a first arrival of an older selection cannot follow a newer selection withdrawal and revive its item', async () => {
  const { net, relays, space, ana } = await world();
  const ref = 'workflow:delayed-selection';
  const copy = { kind: 'workflow', private_ref: ref, title: 'Ordered workflow', body: { secret: 'selection body' } };
  ana.sharedCopy = async () => copy;
  ana.shareableRecord = async () => copy;
  const originalAllowed = net.allowedInSpace.bind(net);
  let entered;
  const firstAdmission = new Promise(resolve => { entered = resolve; });
  let continueAdmission;
  const admissionGate = new Promise(resolve => { continueAdmission = resolve; });
  let pauseFirst = true;
  net.allowedInSpace = async (...args) => {
    if (pauseFirst && args[2] === 'add_items') {
      pauseFirst = false;
      entered();
      await admissionGate;
    }
    return originalAllowed(...args);
  };

  const older = ana.shareIntoMany(space, { records: [ref], request_key: 'selection-A-delayed' });
  await firstAdmission; // A began first but has not received its Space generation yet.
  const newer = await ana.shareIntoMany(space, { records: [ref], request_key: 'selection-B' });
  const itemId = newer.placed[0].item_id;
  await net.withdrawSpaceItem({ relay: relays.ana, space_id: space, item_id: itemId });
  continueAdmission();
  await older;

  const row = net.sql.exec('SELECT body, withdrawn_at FROM space_items WHERE id = ?', itemId).toArray()[0];
  assert.equal(row.body, null, 'late arrival of older selection A cannot overwrite the withdrawn generation from B');
  assert.ok(row.withdrawn_at);
  const recipientItem = (await net.spaceItems({ relay: relays.bo, space_id: space, limit: 20 })).items.find(item => item.item_id === itemId);
  assert.ok(recipientItem?.withdrawn || recipientItem?.body === null,
    'the recipient sees only the withdrawn marker after selection B was taken back');
});

test('a lost Space reply repairs an inherited private choice after the selected item was kept', async () => {
  const { net, relays, people, space, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { network: false, spaces: [], chain: true });
  assert.equal(ana.effectiveSharing('case_copacker')?.inherited, true);
  assert.equal(ana.effectiveSharing('case_copacker')?.network, false);
  const seen = [];
  people.bo.spaceItemsAdded = async event => { seen.push(event); };
  await net.watchSpaceItems({ relay: relays.bo, space_id: space, watching: true });
  const original = net.addSharedSpaceItems.bind(net);
  let loseReply = true;
  net.addSharedSpaceItems = async input => {
    const answer = await original(input);
    if (loseReply) { loseReply = false; throw new Error('The Space kept the inherited item but its reply was lost.'); }
    return answer;
  };
  const send = () => ana.shareIntoMany(space, { items: [{ kind: 'record', record: 'case_copacker' }], request_key: 'inherited-private-reply' });
  await assert.rejects(send(), /reply was lost/);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 1);
  assert.equal((await ana.releaseRecordToSpace({ private_ref: 'case_copacker', space_id: space })).kind, 'decision');
  assert.equal(seen[0].items[0].kind, 'decision');
  assert.ok(seen[0].items[0].body, 'a watcher receives only a choice-authorized projection');
  const recovered = await send();
  assert.equal(recovered.placed.length, 1);
  assert.equal((await ana.releaseRecordToSpace({ private_ref: 'case_copacker', space_id: space })).kind, 'decision');
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items[0].kind, 'decision');
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 1);
});

test('a Space watcher cannot receive a private snapshot without the owner choice', async () => {
  const { net, relays, people, space } = await world();
  const seen = [];
  people.bo.spaceItemsAdded = async event => { seen.push(event); };
  await net.watchSpaceItems({ relay: relays.bo, space_id: space, watching: true });
  await net.addSharedSpaceItems({ relay: relays.ana, space_id: space, selection_key: 'watcher-owner-check', intent_order: 1, entries: [{
    record: { kind: 'file', private_ref: 'file:1f:watcher-private', title: 'Private title', body: { text: 'Private body' }, shared_here: true },
    order_at: new Date().toISOString(),
  }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].items[0].title, null);
  assert.equal(seen[0].items[0].body, null);
});

test('a direct private share reaches a watcher after its owner choice is kept', async () => {
  const { net, relays, people, space, ana } = await world();
  const seen = [];
  people.bo.spaceItemsAdded = async event => { seen.push(event); };
  await net.watchSpaceItems({ relay: relays.bo, space_id: space, watching: true });
  const shared = await ana.shareInto(space, { record_id: 'case_copacker' });
  assert.ok(shared.item_id);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].items[0].kind, 'decision');
  assert.ok(seen[0].items[0].body);
});

test('an old selection with no Person order cannot revive a different withdrawn legacy share', async () => {
  const { net, relays, space } = await world();
  const entry = { record: { kind: 'file', private_ref: 'file:1f:legacy-clip', title: 'Legacy clip', body: { identity: '1f:legacy-clip' }, shared_here: true }, order_at: new Date().toISOString() };
  const newer = await net.addSharedSpaceItems({ relay: relays.ana, space_id: space, selection_key: 'legacy-B', entries: [entry] });
  net.sql.exec('UPDATE space_items SET share_intent_order = NULL WHERE id = ?', newer.ids[0]);
  await net.withdrawSpaceItem({ relay: relays.ana, space_id: space, item_id: newer.ids[0] });
  const older = await net.addSharedSpaceItems({ relay: relays.ana, space_id: space, selection_key: 'legacy-A', entries: [entry] });
  assert.deepEqual(older.ids, newer.ids);
  assert.deepEqual(older.withdrawn, [true]);
  assert.equal(net.sql.exec('SELECT body FROM space_items WHERE id = ?', newer.ids[0]).toArray()[0].body, null);
});

test('a selection that did not reach the Space cannot revive a newer withdrawn selection on retry', async () => {
  const { net, relays, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  let loseBeforeSpace = true;
  net.addSharedSpaceItems = async input => {
    if (loseBeforeSpace) { loseBeforeSpace = false; throw new Error('The first selection never reached the Space.'); }
    return original(input);
  };
  const send = request_key => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:ordered-clip' }], request_key });
  await assert.rejects(send('selection-A-before-Space'), /never reached/);
  const second = await send('selection-B-withdrawn');
  const itemId = second.placed[0].item_id;
  await net.withdrawSpaceItem({ relay: relays.ana, space_id: space, item_id: itemId });
  const oldRetry = await send('selection-A-before-Space');
  assert.deepEqual(oldRetry.placed, [{ item_id: itemId, withdrawn: true }]);
  const row = net.sql.exec('SELECT body, withdrawn_at FROM space_items WHERE id = ?', itemId).toArray()[0];
  assert.equal(row.body, null);
  assert.ok(row.withdrawn_at);
});

test('an old selection cannot fill the gap before a newer owner choice reaches the Space', async () => {
  const { net, space, ana } = await world();
  const originalBatch = net.addSharedSpaceItems.bind(net);
  let delayFirst = true;
  net.addSharedSpaceItems = async input => {
    if (delayFirst) { delayFirst = false; throw new Error('The first selection did not reach the Space.'); }
    return originalBatch(input);
  };
  const ref = 'file:1f:changed-while-waiting';
  const send = request_key => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:changed-while-waiting' }], request_key });
  await assert.rejects(send('older-choice'), /did not reach/);
  const originalDirect = net.shareIntoSpace.bind(net);
  net.shareIntoSpace = async () => { throw new Error('The newer choice did not reach the Space.'); };
  await assert.rejects(ana.setRecordSharing(ref, { network: false, spaces: [space] }), /newer choice did not reach/);
  net.shareIntoSpace = originalDirect;
  assert.ok(ana.effectiveSharing(ref)?.spaces.includes(space));
  await assert.rejects(send('older-choice'), /choice changed since the pursuit selection/);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 0);
  const fresh = await send('fresh-choice');
  assert.equal(fresh.placed.length, 1);
});

test('a later owner-choice withdrawal fences an earlier Space call delayed in transit', async () => {
  const { net, relays, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  let delayed = null;
  net.addSharedSpaceItems = async input => {
    if (!delayed) { delayed = input; throw new Error('The first selection was delayed in transit.'); }
    return original(input);
  };
  const ref = 'file:1f:owner-withdrawn';
  const send = request_key => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:owner-withdrawn' }], request_key });
  await assert.rejects(send('old-owner-choice'), /delayed in transit/);
  const second = await send('newer-owner-choice');
  await ana.setRecordSharing(ref, { network: false, spaces: [] });
  const late = await original(delayed);
  assert.deepEqual(late.ids, [second.placed[0].item_id]);
  assert.deepEqual(late.withdrawn, [true]);
  assert.equal(net.sql.exec('SELECT body FROM space_items WHERE id = ?', second.placed[0].item_id).toArray()[0].body, null);
  await assert.rejects(ana.releaseRecordToSpace({ private_ref: ref, space_id: space }), /not to share this here/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items[0].body, null);
});

test('removing a Space choice fences an earlier selection even before its first item exists', async () => {
  const { net, relays, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  let delayed = null;
  net.addSharedSpaceItems = async input => { delayed = input; throw new Error('The first item was delayed in transit.'); };
  const ref = 'file:1f:not-yet-arrived';
  await assert.rejects(ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:not-yet-arrived' }], request_key: 'before-first-item' }), /delayed in transit/);
  await ana.setRecordSharing(ref, { network: false, spaces: [] });
  const late = await original(delayed);
  assert.deepEqual(late.ids, [null]);
  assert.deepEqual(late.withdrawn, [true]);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 0);
  assert.equal(net.sql.exec('SELECT intent_order FROM space_private_share_fences WHERE space_id = ? AND contributed_by = ? AND source_ref = ?', space, relays.ana, ref).toArray().length, 1);
});

test('an older selection cannot revive or reorder a private item after a newer share is withdrawn', async () => {
  const { net, relays, space, ana } = await world();
  const send = request_key => ana.shareIntoMany(space, { items: [{ kind: 'file', file: '1f:ordered-clip' }], request_key });
  const first = await send('selection-A');
  const second = await send('selection-B');
  assert.deepEqual(second.placed, first.placed);
  const itemId = first.placed[0].item_id;
  await net.withdrawSpaceItem({ relay: relays.ana, space_id: space, item_id: itemId });
  const oldRetry = await send('selection-A');
  assert.deepEqual(oldRetry.placed, [{ item_id: itemId, withdrawn: true }]);
  const withdrawn = net.sql.exec('SELECT body, withdrawn_at FROM space_items WHERE id = ?', itemId).toArray()[0];
  assert.equal(withdrawn.body, null);
  assert.ok(withdrawn.withdrawn_at);
  const fresh = await send('selection-C');
  assert.deepEqual(fresh.placed, first.placed);
  assert.equal(net.sql.exec('SELECT withdrawn_at FROM space_items WHERE id = ?', itemId).toArray()[0].withdrawn_at, null);
});

test('large valid words are sent in byte-bounded mixed slices', async () => {
  const { net, relays, space, ana } = await world();
  const original = net.addSharedSpaceItems.bind(net);
  const byteSizes = [];
  net.addSharedSpaceItems = async input => {
    byteSizes.push(new TextEncoder().encode(JSON.stringify(input.entries)).byteLength);
    return original(input);
  };
  const items = Array.from({ length: 12 }, (_, index) => ({ kind: 'text', text: `${index} ${'x'.repeat(100_000)}` }));
  const selected = await ana.shareIntoMany(space, { items, request_key: 'large-words' });
  assert.equal(selected.count, 12);
  assert.ok(byteSizes.length > 1, 'a large selection crosses the Network boundary in smaller slices');
  assert.ok(byteSizes.every(size => size <= 1024 * 1024));
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space, limit: 20 })).items.length, 12);
});

test('a refused Space stops a large private selection before projecting its files', async () => {
  const { net, relays, space, ana } = await world();
  const originalShareable = ana.shareableRecord.bind(ana);
  let projected = 0;
  ana.shareableRecord = async input => { projected += 1; return originalShareable(input); };
  ana.relay = () => relays.cy;
  const items = Array.from({ length: 1000 }, (_, index) => ({ kind: 'file', file: `1f:unread-${index}` }));
  await assert.rejects(ana.shareIntoMany(space, { items, request_key: 'refused-large-selection' }));
  assert.equal(projected, 0, 'the Space checks membership before any private source is projected');
  assert.equal(net.sql.exec('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?', space).toArray()[0].n, 0);
});

test('a too-large late Space item is refused before the first bounded batch writes', async () => {
  const { net, relays, space, ana } = await world();
  const items = Array.from({ length: 100 }, (_, index) => ({ kind: 'text', text: `First ${index}` }));
  await assert.rejects(ana.shareIntoMany(space, { items: [...items, { kind: 'text', text: 'Last', title: 'x'.repeat(301) }], request_key: 'oversized-title' }), /title holds at most 300/);
  items.push({ kind: 'text', text: 'x'.repeat(200001) });
  await assert.rejects(ana.shareIntoMany(space, { items, request_key: 'oversized-last' }), /at most 200000 characters/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.length, 0);
});

test('the direct Space share route stops reading a body beyond its 2 MB bound', async () => {
  const { net, relays, space, ana } = await world();
  const response = await handleSpacesRequest(ana, new Request(`https://person/spaces/${space}/share`, {
    method: 'POST', body: JSON.stringify({ items: [{ kind: 'text', text: 'x'.repeat(2_000_000) }] }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too large/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.length, 0);
});

test('one denied private source blocks the whole mixed Space slice before its literals are written', async () => {
  const { net, relays, space, ana } = await world();
  await ana.setRecordSharing('pursuit:launch', { network: false, spaces: [] });
  await assert.rejects(ana.shareIntoMany(space, { request_key: 'private-denied', items: [
    { kind: 'text', text: 'Do not post only this note' }, { kind: 'record', record: 'pursuit:launch' },
  ] }), /not to share this here/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.length, 0);
});

test('a repeated private source in one mixed selection keeps its first chosen position and one Space row', async () => {
  const { net, relays, space, ana } = await world();
  const result = await ana.shareIntoMany(space, { request_key: 'same-file-twice', items: [
    { kind: 'file', file: '1f:clip' }, { kind: 'text', text: 'Between' },
    { kind: 'file', file: '1f:clip' }, { kind: 'link', url: 'https://example.com/after' },
  ] });
  assert.equal(result.placed[0].item_id, result.placed[2].item_id);
  const page = await net.spaceItems({ relay: relays.bo, space_id: space });
  assert.deepEqual(page.items.map(item => item.item_id), [result.placed[0], result.placed[1], result.placed[3]].map(item => item.item_id));
});

test('overlong shared words are refused before a link or its text is kept', async () => {
  const { ana } = await world();
  const before = ana.store.eeaf.ids('sharing').length;
  await assert.rejects(ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'x'.repeat(20001) }] }), /20,000 characters/);
  await assert.rejects(ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'link', url: 'https://example.com', title: 'x'.repeat(301) }] }), /title holds at most 300/);
  assert.equal(ana.store.eeaf.ids('sharing').length, before);
});

test('the Space share route accepts a namespace file reference in records without copying its bytes', async () => {
  const { net, relays, space, ana } = await world();
  const response = await handleSpacesRequest(ana, new Request(`https://person/spaces/${space}/share`, {
    method: 'POST', body: JSON.stringify({ records: ['file:1f:video'] }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 1);
  const items = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'file');
  assert.equal(net.sql.exec('SELECT source_ref FROM space_items WHERE id = ?', items[0].item_id).toArray()[0].source_ref, 'file:1f:video');
  assert.equal(items[0].private_ref, undefined, 'the owner reference stays private to the Space');
  assert.equal(items[0].body.identity, '1f:video');
});

test('the Space share route keeps an interleaved mixed selection in its picked order without copying sources', async () => {
  const { net, relays, space, ana } = await world();
  const index = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => index.set(key, value),
    get: async (key, type) => type === 'json' && index.has(key) ? JSON.parse(index.get(key)) : null,
    delete: async key => index.delete(key),
  };
  const child = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Nested words' }] });
  const response = await handleSpacesRequest(ana, new Request(`https://person/spaces/${space}/share`, {
    method: 'POST', body: JSON.stringify({ items: [
      { kind: 'link', url: 'https://example.com/first', title: 'First link' },
      { kind: 'record', record: 'pursuit:launch' },
      { kind: 'text', text: 'A note', title: 'A note' },
      { kind: 'file', file: '1f:video', title: 'Footage' },
      { kind: 'share', code: child.code, title: 'Nested collection' },
      { kind: 'link', url: 'https://example.com/last', title: 'Last link' },
    ] }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.count, 6);
  assert.equal(result.placed.length, 6);
  const items = (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body);
  assert.deepEqual(items.map(item => item.kind), ['link', 'pursuit', 'text', 'file', 'link', 'link']);
  assert.deepEqual(items.map(item => item.item_id), result.placed.map(item => item.item_id));
  const file = items.find(item => item.kind === 'file');
  assert.equal(file.body.identity, '1f:video');
  const nested = items.find(item => item.title === 'Nested collection');
  assert.equal(nested.body.url, `/share/${child.code}`);
  await ana.revokeRecordShare(child.record, child.share_id);
  await assert.rejects(ana.resolveRecordShare(child.code), /ended/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.find(item => item.item_id === nested.item_id).body.url, `/share/${child.code}`);
});

test('sharing an existing Space record again keeps its id and places it at its chosen position', async () => {
  const { net, relays, space, ana } = await world();
  const first = await ana.shareInto(space, { record: 'pursuit:launch' });
  const selected = await ana.shareIntoMany(space, { items: [
    { kind: 'text', text: 'Before the record' },
    { kind: 'record', record: 'pursuit:launch' },
    { kind: 'text', text: 'After the record' },
  ] });
  const items = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  assert.equal(selected.placed[1].item_id, first.item_id);
  assert.deepEqual(items.map(item => item.item_id), selected.placed.map(item => item.item_id));
});

test('a mixed Space batch preflights private references before writing any item', async () => {
  const { net, relays, space, ana } = await world();
  await assert.rejects(ana.shareIntoMany(space, { records: ['pursuit:launch', 'missing-record'], items: [{ kind: 'text', text: 'never partly sent' }] }), /missing-record|not in your Trillion/);
  assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.length, 0);
});

test('a Space batch refuses an unknown or ended nested grant before writing its other items', async () => {
  const { net, relays, space, ana } = await world();
  const index = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => index.set(key, value),
    get: async (key, type) => type === 'json' && index.has(key) ? JSON.parse(index.get(key)) : null,
  };
  const share = await ana.createRecordShare(null, { scope: { kind: 'public' }, items: [{ kind: 'text', text: 'Short-lived' }] });
  for (const code of ['missing-grant', share.code]) {
    if (code === share.code) await ana.revokeRecordShare(share.record, share.share_id);
    await assert.rejects(ana.shareIntoMany(space, {
      records: ['pursuit:launch'],
      items: [{ kind: 'text', text: 'Do not partly send this.' }, { kind: 'share', code }],
    }), /nested share must belong to this Trillion and still be open/);
    assert.equal((await net.spaceItems({ relay: relays.bo, space_id: space })).items.length, 0);
  }
});

test('a chain covers the record and the records linked to it, and nothing else; ending it takes back what it covered', async () => {
  const { net, relays, people, space, ana } = await world();
  assert.deepEqual(ana.chainMembers('pursuit:launch'), ['case_copacker']);
  assert.deepEqual(linksFrom('decision', ana.store.eeaf.read('case_copacker')), ['pursuit:launch']);
  await ana.setRecordSharing('pursuit:launch', { chain: true, spaces: [space], people: [relays.bo], network: false });
  const titles = async () => (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body).map(item => item.title).sort();
  assert.deepEqual(await titles(), ['Launch in 40 stores', 'Which co-packer']);
  assert.deepEqual((await offersTo(people.bo)).shared_with_you.map(item => item.title).sort(), ['Launch in 40 stores', 'Which co-packer']);
  assert.equal(ana.effectiveSharing('case_copacker').from, 'pursuit:launch');
  assert.equal(ana.effectiveSharing('case_doctor'), null, 'a decision about another pursuit is not covered');
  assert.equal(ana.effectiveSharing('pursuit:health'), null);
  assert.equal(ana.networkMay('case_copacker', {}), false, 'the chain keeps it out of the network too');
  const sheet = await ana.sharingSheet('case_copacker');
  assert.equal(sheet.inherited_from.record, 'pursuit:launch');
  await ana.setRecordSharing('pursuit:launch', { chain: false });
  assert.deepEqual(await titles(), ['Launch in 40 stores']);
  assert.deepEqual((await offersTo(people.bo)).shared_with_you.map(item => item.title), ['Launch in 40 stores']);
});

test('a chain follows declared links to any depth without crossing into sibling pursuits', async () => {
  const { net, relays, space, ana } = await world();
  ana.write('case_copacker', 'decision', {
    ...ana.store.eeaf.read('case_copacker'),
    cited_pursuits: { 'pursuit:launch': 'Launch in 40 stores', 'pursuit:health': 'Something private' },
  });
  ana.write('plan:copacker', 'plan', {
    title: 'Find a co-packer', goal: 'Ship the product', status: 'active',
    decision_case_id: 'case_copacker',
  });
  assert.deepEqual(ana.chainMembers('pursuit:launch').sort(), ['case_copacker', 'plan:copacker']);
  await ana.setRecordSharing('pursuit:launch', { chain: true, spaces: [space], network: false });
  const shown = async () => (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body).map(item => item.title).sort();
  assert.deepEqual(await shown(), ['Find a co-packer', 'Launch in 40 stores', 'Which co-packer']);
  assert.equal(ana.effectiveSharing('plan:copacker').from, 'pursuit:launch');
  assert.equal(ana.effectiveSharing('pursuit:health'), null, 'a decision citing two pursuits does not bridge one chain into the other');
  await ana.setRecordSharing('pursuit:launch', { chain: false });
  assert.deepEqual(await shown(), ['Launch in 40 stores']);
});

test('an external link on an intermediate record leaves its inherited chain and descendants intact', async () => {
  const { net, relays, space, ana } = await world();
  ana.write('plan:copacker', 'plan', { title: 'Find a co-packer', goal: 'Ship the product', status: 'active', decision_case_id: 'case_copacker' });
  const index = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => index.set(key, value),
    get: async (key, type) => type === 'json' && index.has(key) ? JSON.parse(index.get(key)) : null,
    delete: async key => index.delete(key),
  };
  await ana.setRecordSharing('pursuit:launch', { chain: true, spaces: [space], network: false });
  assert.deepEqual(ana.chainMembers('pursuit:launch').sort(), ['case_copacker', 'plan:copacker']);
  await ana.createRecordShare('case_copacker', { scope: { kind: 'public' } });
  assert.equal(ana.sharingRowOf('case_copacker').choice_made, false);
  assert.deepEqual(ana.chainMembers('pursuit:launch').sort(), ['case_copacker', 'plan:copacker']);
  assert.equal(ana.effectiveSharing('case_copacker').from, 'pursuit:launch');
  assert.equal(ana.effectiveSharing('plan:copacker').from, 'pursuit:launch');
  const shown = async () => (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body).map(item => item.title).sort();
  assert.deepEqual(await shown(), ['Find a co-packer', 'Launch in 40 stores', 'Which co-packer']);
  await ana.setRecordSharing('case_copacker', { network: false, spaces: [], people: [] });
  assert.deepEqual(ana.chainMembers('pursuit:launch'), ['case_copacker']);
  assert.equal(ana.effectiveSharing('plan:copacker'), null);
});

test('sharing a link-only record into a Space carries its inherited choice into the new direct choice', async () => {
  const { relays, space, ana } = await world();
  const index = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => index.set(key, value),
    get: async (key, type) => type === 'json' && index.has(key) ? JSON.parse(index.get(key)) : null,
    delete: async key => index.delete(key),
  };
  await ana.setRecordSharing('pursuit:launch', { chain: true, spaces: [space], people: [relays.bo], network: false });
  await ana.createRecordShare('case_copacker', { scope: { kind: 'public' } });
  await ana.shareInto(space, { record_id: 'case_copacker' });
  const choice = ana.sharingRowOf('case_copacker');
  assert.equal(choice.choice_made, true);
  assert.equal(choice.network, false);
  assert.deepEqual(choice.spaces, [space]);
  assert.deepEqual(choice.people, [relays.bo]);
  assert.equal(choice.link_grants.length, 1);
});

test('an old unmarked private choice still stops recursive sharing', async () => {
  const { ana } = await world();
  ana.write('plan:copacker', 'plan', { title: 'Private plan', goal: 'Private', status: 'active', decision_case_id: 'case_copacker' });
  ana.write('sharing:case_copacker', 'sharing', {
    record: 'case_copacker', network: false, spaces: [], people: [], chain: false, leave_out: [],
    changed_at: '2026-09-28T00:00:00Z',
  });
  assert.deepEqual(ana.chainMembers('pursuit:launch'), ['case_copacker']);
  assert.equal(ana.effectiveSharing('case_copacker').inherited, false);
});

test('an explicit choice on an intermediate record stops a recursive chain at that record', async () => {
  const { net, relays, space, ana } = await world();
  ana.write('plan:copacker', 'plan', { title: 'Private plan', goal: 'Private', status: 'active', decision_case_id: 'case_copacker' });
  await ana.setRecordSharing('case_copacker', { network: false, spaces: [], people: [] });
  assert.deepEqual(ana.chainMembers('pursuit:launch'), ['case_copacker']);
  await ana.setRecordSharing('pursuit:launch', { chain: true, spaces: [space], network: false });
  const shown = (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body).map(item => item.title);
  assert.deepEqual(shown, ['Launch in 40 stores']);
  assert.equal(ana.effectiveSharing('plan:copacker'), null);
});

test('a plan can explicitly share its linked decision and pursuit', async () => {
  const { net, relays, space, ana } = await world();
  ana.write('plan:copacker', 'plan', { title: 'Find a co-packer', goal: 'Ship the product', status: 'active', decision_case_id: 'case_copacker' });
  assert.equal((await ana.sharingSheet('plan:copacker')).chain.label, 'Include linked work');
  await ana.setRecordSharing('plan:copacker', { chain: true, spaces: [space], network: false });
  const shown = (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body).map(item => item.title).sort();
  assert.deepEqual(shown, ['Find a co-packer', 'Launch in 40 stores', 'Which co-packer']);
});

test('sharing DATA labels plans and contracts while private navigation links stay out of recursive chains', async () => {
  const { ana } = await world();
  assert.equal(sharing.kinds.plan, 'Plan');
  assert.equal(sharing.kinds['sales-contract'], 'Contract');
  ana.write('message:about', 'message', {
    id: 'message:about',
    app: 'test',
    speaker: 'person',
    text: 'A private navigation note',
    at: '2026-10-04T00:00:00.000Z',
    about: [{ kind: 'decision', id: 'case_copacker' }],
  });
  assert.deepEqual(ana.chainMembers('pursuit:launch'), ['case_copacker']);
  assert.equal(ana.effectiveSharing('message:about'), null);
});

test('a record shared on its own before a chain came around it keeps that as its own choice', async () => {
  const { net, relays, space, ana } = await world();
  await ana.shareInto(space, { record_id: 'case_copacker' });
  assert.deepEqual(ana.sharingRowOf('case_copacker').spaces, [space]);
  await ana.setRecordSharing('pursuit:launch', { chain: true, network: false, spaces: [] });
  assert.equal(ana.effectiveSharing('case_copacker').inherited, false);
  const items = (await net.spaceItems({ relay: relays.bo, space_id: space })).items.filter(item => item.body);
  assert.deepEqual(items.map(item => item.title), ['Which co-packer']);
});

test('the choice in force: its own first, else the most private chain covering it', () => {
  const linked = () => true;
  const open = { record: 'a', network: true, spaces: [], people: [], chain: true, changed_at: '2026-09-28T02:00:00Z' };
  const closed = { record: 'b', network: false, spaces: [], people: [], chain: true, changed_at: '2026-09-28T01:00:00Z' };
  assert.equal(resolveSharing('x', { own: null, chains: [open, closed], linked }).from, 'b');
  assert.equal(resolveSharing('x', { own: { record: 'x', network: true, spaces: [], people: [] }, chains: [closed], linked }).from, 'x');
  assert.equal(resolveSharing('x', { own: null, chains: [open], linked: () => false }), null);
});

// The sharing sheet an AI reads with sharing_of (GET /sharing/<record>), as the person's own sign-in asks it.
const sheetOf = async (owner, record) => (await handleSharingRequest(owner, new Request(`https://person/sharing/${encodeURIComponent(record)}`))).json();

test('sharing_of on a note never shared says it is with the person alone, even with the account sharing decisions', async () => {
  const { ana } = await world();
  const sheet = await sheetOf(ana, 'file:note-identity');
  assert.equal(sheet.thing.kind, 'file');
  assert.deepEqual(sheet.places.filter(place => place.picked), [], 'no place is picked: not the network, no space, nobody');
  assert.equal(sheet.places.find(place => place.to.network).picked, false);
  const pursuit = await sheetOf(ana, 'pursuit:health');
  assert.deepEqual(pursuit.places.filter(place => place.picked), [], 'a pursuit never shared is private too');
  const decision = await sheetOf(ana, 'case_doctor');
  assert.equal(decision.places.find(place => place.to.network).picked, true, 'a decision follows the account, which shares by default');
  // Chosen into the network on purpose, the note says so.
  const chosen = await (await handleSharingRequest(ana, new Request('https://person/sharing/file%3Anote-identity', { method: 'POST', body: JSON.stringify({ network: true }) }))).json();
  assert.equal(chosen.places.find(place => place.to.network).picked, true);
});

test('the Shared with me tool lists what others shared with this person and reads one of them', async () => {
  const { relays, people, ana } = await world();
  const shared = recordSharingActions(people.bo)['shared-with-me'];
  assert.deepEqual(await shared(), { shared_with_you: [] });
  await ana.setRecordSharing('pursuit:launch', { network: false, people: [relays.bo] });
  const { shared_with_you: [offer] } = await shared();
  assert.deepEqual([offer.from, offer.kind, offer.title], ['Member 1', 'pursuit', 'Launch in 40 stores']);
  const { shared: copy } = await shared({ offer_id: offer.offer_id });
  assert.equal(copy.title, 'Launch in 40 stores');
  assert.equal(copy.provenance.from, 'Member 1');
  assert.ok(copy.preview.fields.some(field => field.label === 'Why it matters'));
  await ana.setRecordSharing('pursuit:launch', { people: [] });
  await assert.rejects(shared({ offer_id: offer.offer_id }), /not shared with you/, 'a thing no longer shared is refused, not shown from an old copy');
});

test('a link made for one email address is emailed to that address, naming the deal and never its price', async () => {
  const { ana } = await world();
  const values = new Map([['sign-in-methods:user-ana', JSON.stringify({ email: { address: 'user-4eb3b960@example.com' } })]]);
  const mail = [];
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  ana.env.EMAIL = { send: async message => { mail.push(message); return { messageId: 'message-1' }; } };
  ana.setFact('owner_user_id', 'user-ana');
  ana.accountName = async () => 'Ana Lopez';
  ana.keep('sales-contract:deal', { id: 'sales-contract:deal', kind: 'sales-contract', name: 'Founder coaching', contract: { name: 'Founder coaching', rules: [{ type: 'Commitment', amount: 123456, currency: 'usd' }] } });
  const link = await ana.createRecordShare('sales-contract:deal', { scope: { kind: 'email', value: 'Buyer@Example.com' }, origin: 'https://app.example' });
  assert.equal(link.address, `https://app.example/share/${link.code}`, 'a deal opens on the one share page, like every other link');
  const sent = await ana.sendRecordShare('sales-contract:deal', link.share_id, { note: 'Great talking today.', origin: 'https://app.example' });
  assert.equal(sent.sent_to, 'buyer@example.com');
  assert.equal(mail.length, 1);
  const [email] = mail;
  assert.equal(email.to, 'buyer@example.com');
  assert.equal(email.replyTo, 'user-4eb3b960@example.com');
  assert.equal(email.subject, 'Ana Lopez sent you a deal: Founder coaching');
  assert.match(email.html, new RegExp(`https://app\\.example/share/${link.code}`));
  assert.match(email.text, /Great talking today\./);
  assert.doesNotMatch(`${email.text}${email.html}`, /1,?234|123456/, 'the price stays behind the signed-in link');
  assert.ok(ana.shareLinksOf('sales-contract:deal')[0].sent_at, 'the link remembers when it was sent');
  assert.equal(ana.store.eeaf.ids('record:sent').length, 1, 'the email is in the sharer\'s Sent');

  const open = await ana.createRecordShare('sales-contract:deal', { scope: { kind: 'public' }, origin: 'https://app.example' });
  await assert.rejects(ana.sendRecordShare('sales-contract:deal', open.share_id), /one email address/);
  await ana.revokeRecordShare('sales-contract:deal', link.share_id);
  await assert.rejects(ana.sendRecordShare('sales-contract:deal', link.share_id), /not open/);
  ana.keep('sales-contract:gone', { id: 'sales-contract:gone', name: 'Gone', contract: { name: 'Gone', rules: [] }, removed_at: '2026-10-01T00:00:00.000Z' });
  await assert.rejects(ana.createRecordShare('sales-contract:gone', { scope: { kind: 'public' }, origin: 'https://app.example' }), /not in your Trillion/, 'a removed contract cannot be shared');
  assert.equal(mail.length, 1);
});

test('one mixed collection link can be emailed through the generic sender without copying its items', async () => {
  const { ana } = await world();
  const values = new Map();
  const mail = [];
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  ana.env.EMAIL = { send: async message => { mail.push(message); return { messageId: 'mixed-collection-email' }; } };
  ana.accountName = async () => 'Ana Lopez';
  const items = [
    { kind: 'record', record: 'file:first-video' },
    { kind: 'record', record: 'case_copacker' },
    { kind: 'link', url: 'https://example.com/reference' },
    { kind: 'text', text: 'Look at these together.' },
  ];
  const link = await ana.createRecordShare(null, { items, scope: { kind: 'email', value: 'jihan@example.com' }, origin: 'https://app.example' });
  const send = sharingTools((path, body) => handleSharingRequest(ana, new Request(`https://person${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-trillion-origin': 'https://app.example' },
  }))).find(tool => tool.name === 'send_share_collection_link');
  assert.ok(send);
  const response = await send.run({ share_id: link.share_id, note: 'Here are the files and notes.' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent_to, 'jihan@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, 'Ana Lopez shared 4 items with you');
  assert.match(mail[0].text, new RegExp(`https://app\\.example/share/${link.code}`));
  assert.equal(ana.store.eeaf.ids('record:sent').length, 1);
  assert.deepEqual(ana.sharingRowOf(link.record).link_grants[0].entries, items, 'the grant still holds the original references and words');
  const copy = await ana.resolveRecordShare(link.code, { verified_email: 'jihan@example.com' });
  assert.deepEqual(copy.items.map(item => item.kind), ['file', 'decision', 'link', 'text']);
});

test('a shared sales contract shows only the agreed terms share_from_private lets out, and an ended link shows nothing', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
    delete: async key => values.delete(key),
  };
  const id = 'sales-contract:client-a';
  ana.keep(id, {
    id, kind: 'sales-contract', status: 'draft', name: 'Client services', share_id: 'internal-share-state',
    contract: {
      name: 'Client services agreement',
      parties: [{ role: 'provider', name: 'Casey', email: 'private@example.com' }],
      scope: ['Campaign strategy'],
      price: { amount_cents: 123456, currency: 'usd' },
      payment_schedule: { interval: 'month', secret: 'discard this' },
      sharing: { internal_record_ids: ['private-ref'] },
      product: { name: 'Service', description: 'Work', terms: ['One launch'], internal_note: 'private' },
      internal_debug: 'private',
    },
  });
  const link = await ana.createRecordShare(id, { scope: { kind: 'email', value: 'client@example.com' }, origin: 'https://app.example' });
  const viewed = await ana.resolveRecordShare(link.code, { verified_email: 'CLIENT@example.com' });
  assert.equal(viewed.kind, 'sales-contract');
  assert.deepEqual(Object.keys(viewed.body).sort(), ['contract', 'name']);
  assert.deepEqual(viewed.body.contract, {
    name: 'Client services agreement',
    parties: [{ role: 'provider', name: 'Casey' }],
    scope: ['Campaign strategy'],
    product: { name: 'Service', description: 'Work', terms: ['One launch'] },
  });
  assert.equal(JSON.stringify(viewed).includes('123456'), false, 'the saved price stays private; the buyer sees the price agreed for them');
  assert.equal(JSON.stringify(viewed).includes('private-ref'), false);
  await assert.rejects(ana.resolveRecordShare(link.code, { verified_email: 'someone-else@example.com' }));
  await ana.revokeRecordShare(id, link.share_id);
  await assert.rejects(ana.resolveRecordShare(link.code, { verified_email: 'client@example.com' }), /ended/);
  const revoked = ana.store.eeaf.ids('commercial-event').map(at => ana.store.eeaf.read(at)).find(event => event.event === 'share_revoked');
  assert.equal(revoked?.subject_id, id, 'ending a link is kept with the other share events');
});

test('signing in from a share link comes back to that link, and to nothing else', async () => {
  const { shareReturn } = await import('../src/record-sharing.mjs');
  assert.equal(shareReturn('/share/AbC_12-x'), '/share/AbC_12-x');
  assert.equal(shareReturn('/share/abc?access_code=one'), '/share/abc?access_code=one');
  for (const next of ['/contract-offer/AbC_12-x', '/share/a/b', '//evil.example/share/a', '/share/a?next=/x', '/work', 'https://evil.example/share/a']) assert.equal(shareReturn(next), null, next);
});

// One link, one grant (src/record-sharing.mjs): who may open it, what they may do (record-sharing.json abilities), until
// when, under which condition (a formula-engine rule tree over when_facts), and whose brand the page carries.
const { makeRowFilter } = await import('../parts/formula-engine/rules/filter-rows-by-rules.mjs');
const ruleOperatorRows = (await import('../parts/formula-engine/rules/rule-operators.json', { with: { type: 'json' } })).default;
const rowFilter = makeRowFilter({ operators: ruleOperatorRows, wasm: () => readFileSync(new URL('../parts/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const kvOf = values => ({
  put: async (key, value) => values.set(key, value),
  get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
});

test('a deal link opens without an account; signing it needs a proved email, once, and is told to the sharer', async () => {
  const { ana } = await world();
  ana.env.APP_KV = kvOf(new Map());
  ana.keep('sales-contract:deal', { id: 'sales-contract:deal', kind: 'sales-contract', name: 'Founder coaching', contract: { name: 'Founder coaching', rules: [] } });
  const link = await ana.createRecordShare('sales-contract:deal', { scope: { kind: 'email', value: 'buyer@example.com' } });
  assert.deepEqual(link.can, ['view', 'sign', 'pay'], 'a deal link carries the abilities its kind is given (record-sharing.json given)');
  const stranger = await ana.shareAccess(link.code, {});
  assert.equal(stranger.admitted, false);
  assert.equal(stranger.needs, 'email', 'a visitor is asked to prove an email address, never to make an account');
  const buyer = { verified_email: 'Buyer@Example.com' };
  const open = await ana.shareAccess(link.code, buyer);
  assert.equal(open.admitted, true);
  assert.equal(open.acts_need_proof, true);
  assert.equal(open.proven, true);
  await assert.rejects(ana.signRecordShare(link.code, {}, { name: 'Bo Buyer' }), /someone else/);
  await assert.rejects(ana.signRecordShare(link.code, buyer, { name: 'B' }), /name/i);
  const signed = await ana.signRecordShare(link.code, buyer, { name: '  Bo   Buyer ' });
  assert.equal(signed.name, 'Bo Buyer');
  assert.deepEqual(await ana.signRecordShare(link.code, buyer, { name: 'Someone Else' }), signed, 'signing again keeps the first signature');
  const after = await ana.shareAccess(link.code, buyer);
  assert.equal(after.signed_by_you, true);
  assert.deepEqual(after.signatures, [{ name: 'Bo Buyer', signed_at: signed.signed_at }]);
  assert.equal(JSON.stringify(after).includes('buyer@example.com'), false, 'the page is never handed the signer\'s email');
  assert.equal((await ana.resolveRecordShareGrant(link.code, { ...buyer, buyer_ref: 'person:bo' })).unsigned, false);
  const events = ana.store.eeaf.ids('commercial-event').map(id => ana.store.eeaf.read(id));
  assert.ok(events.some(event => event.event === 'share_signed' && event.subject_id === 'sales-contract:deal'));
});

test('a link may only carry abilities its kind offers, and always lets its recipient see it', async () => {
  const { ana } = await world();
  ana.env.APP_KV = kvOf(new Map());
  const plain = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' } });
  assert.deepEqual(plain.can, ['view']);
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, can: ['view', 'pay'] }), /cannot let someone pay/);
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, can: ['sign'] }), /include view/);
  await assert.rejects(ana.signRecordShare(plain.code, { verified_email: 'a@example.com' }, { name: 'Ann Other' }), /does not ask for a signature/);
});

test('a link\'s own condition decides when it opens: once only, and only while its record is in a state', async () => {
  const { ana } = await world();
  ana.env.APP_KV = kvOf(new Map());
  ana.filterRowsByRules = rowFilter.filterRowsByRules;
  const rule = (field, operator, params) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator, params }] });
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, when: rule('mood', 'is_any_of', { values: ['good'] }) }), /names a fact/);
  const once = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, when: rule('opened', 'less_than', { value: 1 }) });
  assert.equal((await ana.resolveRecordShare(once.code)).title, 'Launch in 40 stores');
  await assert.rejects(ana.resolveRecordShare(once.code), /not open right now/, 'a link that opens once is closed after its first open');
  assert.equal((await ana.shareAccess(once.code, {})).closed, true);
  const counted = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' } });
  await ana.resolveRecordShare(counted.code);
  await ana.resolveRecordShare(counted.code);
  assert.equal(ana.sharingRowOf('pursuit:launch').link_grants.find(grant => grant.share_id === counted.share_id).opened, undefined, 'a link whose condition never reads opens does not write on every view');
  const dated = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, when: rule('now', 'after', { value: Date.now() + 86_400_000 }) });
  await assert.rejects(ana.resolveRecordShare(dated.code), /not open right now/);
  assert.equal((await ana.resolveRecordShare(dated.code, { now: Date.now() + 2 * 86_400_000 })).title, 'Launch in 40 stores');
});

test('the recipient page carries the sharer\'s own brand unless the link asks for Trillion\'s', async () => {
  const { ana } = await world();
  ana.env.APP_KV = kvOf(new Map());
  const before = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' } });
  assert.deepEqual((await ana.shareAccess(before.code, {})).look, { kind: 'trillion', name: 'Trillion' }, 'with no brand of their own a page wears Trillion\'s');
  assert.throws(() => ana.setShareLook({ name: 'Ana Studio', accent: 'red' }), /colour/i);
  ana.setShareLook({ name: 'Ana Studio', accent: '#336699' });
  assert.deepEqual((await ana.shareAccess(before.code, {})).look, { kind: 'own', name: 'Ana Studio', accent: '#336699' });
  const plain = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, look: 'trillion' });
  assert.equal((await ana.shareAccess(plain.code, {})).look.kind, 'trillion');
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, look: 'loud' }), /own .* or trillion/);
});

// A link's readable address and listing in search results (record-sharing.json addresses): a public link takes its
// address from the shared thing's first words, a chosen address another account holds is refused, only a public link
// can be listed, a list shares its rows with only the fields it shows, and a revoked link leaves the listed index.
test('a public list link gets a readable address, lists its rows, and leaves search results when revoked', async () => {
  const { ana, people } = await world();
  const values = new Map();
  const kv = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : null,
    delete: async key => values.delete(key),
  };
  ana.env.APP_KV = kv;
  people.bo.env.APP_KV = kv;
  const { makeLists } = await import('../src/lists.mjs');
  const lists = makeLists({ eeaf: ana.store.eeaf });
  lists.save({ id: 'bakery-flavours', label: 'Bakery flavours', about: 'Every flavour we sell.', fields: [{ id: 'name', label: 'Name' }, { id: 'taste', label: 'Taste', kind: 'long-text' }, { id: 'checked', label: 'Checked', kind: 'date' }] });
  lists.putRows('bakery-flavours', { rows: [{ values: { name: 'Sea salt', taste: 'Plain and salty', checked: '2026-10-01' } }, { values: { name: 'Caramel', taste: 'Sweet', checked: '2026-10-03' } }] });
  // A value a tool keeps on a row that the list does not show never leaves.
  const [firstRow] = lists.read('bakery-flavours').rows;
  const rowType = `record:${lists.read('bakery-flavours').list.row_type}`;
  ana.write(`${rowType}:${firstRow.id}`, rowType, { ...firstRow.values, supplier_cost: 'PRIVATE COST' });

  await assert.rejects(ana.createRecordShare('list:bakery-flavours', { scope: { kind: 'email', value: 'a@example.com' }, listed: true }), /anyone may open/);
  const link = await ana.createRecordShare('list:bakery-flavours', { scope: { kind: 'public' }, listed: true });
  assert.equal(link.name, 'bakery-flavours');
  assert.match(link.address, /\/share\/bakery-flavours$/);
  const copy = await ana.resolveRecordShare('bakery-flavours', { record_view: false });
  assert.equal(copy.title, 'Bakery flavours');
  assert.deepEqual(copy.body.rows.map(row => row.title).sort(), ['Caramel', 'Sea salt']);
  assert.doesNotMatch(JSON.stringify(copy), /PRIVATE COST/);

  // Someone else cannot take the address; a second public link to the same list gets the words with another word.
  await people.bo.write('pursuit:bo', 'pursuit', { id: 'pursuit:bo', title: 'Bakery flavours', now: 'a', after: 'b', status: 'active' });
  await assert.rejects(people.bo.createRecordShare('pursuit:bo', { scope: { kind: 'public' }, address: 'bakery-flavours' }), /already uses that address/);
  const second = await people.bo.createRecordShare('pursuit:bo', { scope: { kind: 'public' } });
  assert.match(second.name, /^bakery-flavours-[a-z]+$/);
  await assert.rejects(ana.createRecordShare('pursuit:launch', { scope: { kind: 'public' }, address: 'Not Allowed' }), /lowercase/);

  const listed = await ana.listedShare('bakery-flavours');
  assert.equal(listed.changed, '2026-10-03');
  assert.equal(listed.copy.body.rows.length, 2);
  const originalResolve = ana.resolveRecordShare;
  ana.resolveRecordShare = async (...args) => {
    const current = await originalResolve.apply(ana, args);
    return { ...current, body: { ...current.body, public_page: { layout: 'comparison', evidence_rows: { kind_field: 'record_kind' } } } };
  };
  assert.equal((await ana.listedShare('bakery-flavours')).copy.body.public_page.evidence_rows.kind_field, 'record_kind');
  ana.resolveRecordShare = originalResolve;
  assert.ok(values.has('record-share-listed:bakery-flavours'));
  await ana.revokeRecordShare('list:bakery-flavours', link.share_id);
  assert.equal(values.has('record-share-listed:bakery-flavours'), false);
  assert.equal(await ana.listedShare('bakery-flavours'), null);
});

test('a permitted comparison row reads only its referenced evidence and sources', async () => {
  const evidence = { kind_field: 'record_kind', comparison_kind: 'comparison', claim_kind: 'claim', source_kind: 'source',
    owner_field: 'comparison_id', role_field: 'claim_role', text_field: 'claim_text', source_ref_field: 'source_id',
    source_url_field: 'source_url', evidence_list: 'evidence', claim_ids_field: 'claim_ids' };
  const copy = { kind: 'list', title: 'Compared', body: { fields: [{ id: 'title', kind: 'text' }, { id: 'record_kind', kind: 'choice' }],
    rows: [{ id: 'comparison', title: 'Trillion vs Paper', values: { title: 'Trillion vs Paper', record_kind: 'comparison', claim_ids: ['claim1'] } }],
    public_page: { layout: 'comparison', evidence_rows: evidence } } };
  const records = new Map([
    ['list:evidence', { row_type: 'evidence' }],
    ['record:evidence:claim1', { title: 'Paper price', record_kind: 'claim', comparison_id: 'comparison', claim_role: 'price', claim_text: '$12', source_id: 'source1' }],
    ['record:evidence:source1', { title: 'Paper pricing', record_kind: 'source', source_url: 'https://paper.example/pricing' }],
  ]);
  const read = [];
  const person = { shareAccess: async () => ({ admitted: true }), resolveRecordShare: async () => copy,
    store: { eeaf: { read(id) { read.push(id); return records.get(id) ?? null; } } } };
  const result = await recordSharingMethods.sharedPageForLink.call(person, 'shared', {}, { row_address: 'trillion-vs-paper', count_open: false });
  assert.deepEqual(result.copy.body.evidence_rows.map(row => row.id), ['claim1', 'source1']);
  assert.deepEqual(read, ['list:evidence', 'record:evidence:claim1', 'record:evidence:source1']);
  read.length = 0;
  await recordSharingMethods.sharedPageForLink.call(person, 'shared', {}, { count_open: false });
  assert.deepEqual(read, [], 'the directory reads no evidence rows');
  person.shareAccess = async () => ({ admitted: false });
  const denied = await recordSharingMethods.sharedPageForLink.call(person, 'shared', {}, { row_address: 'trillion-vs-paper' });
  assert.equal(denied.copy, null);
  assert.deepEqual(read, [], 'denied access reads no evidence rows');
});

test('one row of a list is shared on its own: only that row leaves, by link or email, never into a space', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => (type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : values.get(key) ?? null), delete: async key => values.delete(key) };
  ana.filterRowsByRules = rowFilter.filterRowsByRules;
  const { makeLists } = await import('../src/lists.mjs');
  const lists = makeLists({ eeaf: ana.store.eeaf });
  lists.save({ id: 'flavours', label: 'Flavours', fields: [{ id: 'name', label: 'Name' }, { id: 'taste', label: 'Taste' }] });
  lists.putRows('flavours', { rows: [{ values: { name: 'Sea salt', taste: 'Salty' } }, { values: { name: 'Caramel', taste: 'Sweet' } }] });
  const caramel = lists.read('flavours').rows.find(row => row.values.name === 'Caramel');
  const ref = `list:flavours:rows:${caramel.id}`;
  const sheet = await ana.sharingSheet(ref);
  assert.equal(sheet.thing.title, 'Caramel');
  assert.deepEqual(sheet.preview.fields.filter(field => ['fields', 'rows'].includes(field.id)).map(field => field.value), ['1. Name\n2. Taste', '1. Name: Caramel · Taste: Sweet'], 'the preview says the row in words, never as raw data');
  assert.deepEqual(sheet.places, [],'a part goes by link or email; its whole goes into spaces');
  assert.deepEqual(sheet.abilities.map(ability => ability.id), ['view']);
  const link = await ana.createRecordShare(ref, { scope: { kind: 'public' } });
  assert.match(link.address, /\/share\/caramel$/, 'the row\'s own words name its link');
  const copy = await ana.resolveRecordShare(link.code);
  assert.deepEqual(copy.body.rows.map(row => row.title), ['Caramel'], 'only that row leaves');
  await assert.rejects(ana.sharedCopy('list:flavours:rows:nothing-here'), /not in your Trillion/);
});

test('one saved view of a list is shared on its own: only the rows that view keeps leave, and a view that is gone shares nothing', async () => {
  const { ana } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => (type === 'json' && values.has(key) ? JSON.parse(values.get(key)) : values.get(key) ?? null), delete: async key => values.delete(key) };
  ana.filterRowsByRules = rowFilter.filterRowsByRules;
  const { makeLists } = await import('../src/lists.mjs');
  const lists = makeLists({ eeaf: ana.store.eeaf });
  lists.save({ id: 'flavours', label: 'Flavours', fields: [{ id: 'name', label: 'Name' }, { id: 'taste', label: 'Taste' }] });
  lists.putRows('flavours', { rows: [{ values: { name: 'Sea salt', taste: 'Salty' } }, { values: { name: 'Caramel', taste: 'Sweet' } }, { values: { name: 'Honey', taste: 'Sweet' } }] });
  lists.saveView('flavours', { id: 'sweet', label: 'Sweet ones', search: 'Sweet' });
  const ref = 'list:flavours:views:sweet';
  const sheet = await ana.sharingSheet(ref);
  assert.equal(sheet.thing.title, 'Sweet ones');
  assert.deepEqual(sheet.places, [], 'a part goes by link or email; its whole goes into spaces');
  const link = await ana.createRecordShare(ref, { scope: { kind: 'public' } });
  const copy = await ana.resolveRecordShare(link.code);
  assert.deepEqual(copy.body.rows.map(row => row.title).sort(), ['Caramel', 'Honey'], 'only the rows the view keeps leave');
  await assert.rejects(ana.sharedCopy('list:flavours:views:gone'), /not in your Trillion/);
});

test('one shared list row carries only its named media and saved-view row identities', async () => {
  const original = `1f:${'a'.repeat(64)}`;
  const other = `1f:${'b'.repeat(64)}`;
  const poster = `1f:${'c'.repeat(64)}`;
  const whole = { kind: 'list', title: 'Clips', body: {
    fields: [{ id: 'name', kind: 'text' }, { id: 'picture', kind: 'file', media: true }],
    rows: [{ id: 'a', title: 'Shared', values: { picture: original } }, { id: 'b', title: 'Private', values: { picture: other } }],
    files: [{ identity: original, poster_identity: poster, poster_media_type: 'image/png' }, { identity: other }],
    shown_views: [{ id: 'pictures', display: { as: 'pictures' }, row_ids: ['a', 'b'] }],
  } };
  const copy = await recordSharingMethods.sharedCopy.call({ sharedCopy: async () => whole }, 'list:clips:rows:a');
  assert.deepEqual(copy.body.rows.map(row => row.id), ['a']);
  assert.deepEqual(copy.body.files, [whole.body.files[0]], 'only the selected row original can authorize its kept poster');
  assert.deepEqual(copy.body.shown_views[0].row_ids, ['a']);
  assert.deepEqual(whole.body.files.map(file => file.identity), [original, other], 'the whole list source is preserved');
});

test('an open link changes what it lets someone do, until when and under what condition, without a new link', async () => {
  const { ana } = await world();
  ana.env.APP_KV = kvOf(new Map());
  const link = await ana.createRecordShare('pursuit:launch', { scope: { kind: 'email', value: 'a@example.com' } });
  await assert.rejects(ana.changeRecordShare('pursuit:launch', link.share_id, { can: ['view', 'pay'] }), /cannot let someone pay/);
  await assert.rejects(ana.changeRecordShare('pursuit:launch', link.share_id, { expires_at: '2001-01-01T00:00:00Z' }), /future time/);
  await assert.rejects(ana.changeRecordShare('pursuit:launch', link.share_id, { when: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'mood', operator: 'is_any_of', params: { values: ['good'] } }] } }), /names a fact/);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const changed = await ana.changeRecordShare('pursuit:launch', link.share_id, { expires_at: until, when: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'opened', operator: 'less_than', params: { value: 3 } }] } });
  assert.equal(changed.expires_at, until);
  assert.equal(changed.code, undefined, 'the access code never comes back');
  const kept = ana.sharingRowOf('pursuit:launch').link_grants.find(grant => grant.share_id === link.share_id);
  assert.equal(kept.counts_opens, true, 'a condition reading opens makes the link count them');
  await ana.changeRecordShare('pursuit:launch', link.share_id, { when: null, expires_at: null });
  const cleared = ana.sharingRowOf('pursuit:launch').link_grants.find(grant => grant.share_id === link.share_id);
  assert.equal(cleared.when, undefined);
  assert.equal(cleared.expires_at, null);
  await ana.revokeRecordShare('pursuit:launch', link.share_id);
  await assert.rejects(ana.changeRecordShare('pursuit:launch', link.share_id, { expires_at: null }), /not open/);
});

test('the sheet says each value in words: a state, a day, a size and a kind of file, never the stored form', () => {
  const decision = previewOf({ kind: 'decision', title: 'Pick the venue', body: { status: 'needs_decision', created_at: '2026-10-05T23:27:09.928Z' } });
  assert.deepEqual(decision.fields.map(field => field.value), ['Not decided yet', 'October 5, 2026']);
  const file = previewOf({ kind: 'file', title: 'Proposal', body: { byte_length: 48, media_type: 'text/plain; charset=utf-8' } });
  assert.deepEqual(file.fields.map(field => field.value), ['48 bytes', 'Text']);
  assert.deepEqual(previewOf({ kind: 'file', body: { byte_length: 2_400_000, media_type: 'application/pdf' } }).fields.map(field => field.value), ['2.4 MB', 'PDF'], 'the longest start that fits names the kind');
  assert.equal(previewOf({ kind: 'decision', body: { status: 'some_new_state' } }).fields[0].value, 'some_new_state', 'a value with no words yet still shows');
});

test('a field shared to match only reaches others as a mark: equal values match, the value never shows, and a value someone knows can be checked', async () => {
  const { net, relays, space, ana, people } = await world();
  const key = 'ab'.repeat(32);
  for (const one of [ana, people.bo]) one.env = { ...one.env, SHARE_MATCH_KEY: key };
  await assert.rejects(ana.setRecordSharing('pursuit:launch', { spaces: [space], leave_out: ['now'], match_only: ['now'] }), /both left out and shared to match only/);
  await ana.setRecordSharing('pursuit:launch', { spaces: [space], match_only: ['now'] });
  const sheet = await ana.sharingSheet('pursuit:launch');
  assert.equal(sheet.fields.find(field => field.id === 'now').match_only, true);
  const [item] = (await net.spaceItems({ relay: relays.bo, space_id: space })).items;
  const shown = JSON.stringify(item);
  assert.ok(!shown.includes('"0 stores"'), 'the value never leaves');
  assert.match(item.body.now.match, /^1f:[0-9a-f]{64}$/);
  const check = (field, value) => people.bo.matchSharedValue({ space_id: space, item_id: item.item_id, field, value });
  assert.deepEqual(await check('now', '  0 STORES '), { field: 'now', matched: true }, 'a value bo already knows matches, case and spacing ignored');
  assert.deepEqual(await check('now', '1 store'), { field: 'now', matched: false });
  await assert.rejects(check('after', '40 stores'), /not shared to match only/, 'a field shared as words is not a matching oracle');
  await assert.rejects(people.cy.matchSharedValue({ space_id: space, item_id: item.item_id, field: 'now', value: '0 stores' }), /./, 'someone outside the space cannot ask');
  const asked = (await ana.sharingSheet('pursuit:launch')).match_asks;
  assert.deepEqual(asked.map(row => [row.field, row.matched, row.place]), [['now', false, space], ['now', true, space]], 'ana sees every question, newest first');
  assert.ok(asked.every(row => row.asker && row.asker !== 'Someone'));
  assert.throws(() => ana.sql.exec('DELETE FROM match_asks'), /never changed or removed/);
  assert.throws(() => ana.sql.exec('UPDATE match_asks SET matched = 0'), /never changed or removed/);
  ana.env = { ...ana.env, SHARE_MATCH_KEY: undefined };
  ana.shareMatch = undefined;
  await assert.rejects(ana.setRecordSharing('pursuit:health', { spaces: [space], match_only: ['now'] }), /not set up/);
});


test('company attachment batch: the composer and real sharing owner retain every file, order and exact retry', async () => {
  const { net, relays, space, ana } = await world();
  const files = Array.from({ length: 205 }, (_, index) => ({ identity: `1f:${index.toString(16).padStart(64, '0')}`, name: `/new uploads/selection ${index}.dat` }));
  const selected = [...files, files[0]];
  const calls = [];
  const post = async (path, body) => {
    calls.push({ path, body });
    const response = await handleSpacesRequest(ana, new Request(`https://person${path.replace('/work/api', '')}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  };
  const shared = await shareKeptFiles(space, selected, post, 'one-many-file-company-send');
  assert.equal(calls.length, 1, 'one browser owner request shares the selection');
  assert.equal(shared.length, 205, 'the duplicate source creates no second attachment');
  const visible = [];
  let before = null;
  do {
    const page = await net.spaceItems({ relay: relays.bo, space_id: space, kind: 'file', before, limit: 100 });
    visible.push(...page.items);
    before = page.next_before;
  } while (before);
  assert.deepEqual(visible.map(item => item.item_id), shared);
  for (const index of [0, 102, 204]) {
    assert.equal(visible[index].body.identity, files[index].identity);
    const row = net.sql.exec('SELECT source_ref, origin FROM space_items WHERE id = ?', shared[index]).toArray()[0];
    assert.deepEqual({ ...row }, { source_ref: `file:${files[index].identity}`, origin: 'private' });
  }
  assert.deepEqual(await shareKeptFiles(space, selected, post, 'one-many-file-company-send'), shared);
  assert.deepEqual(calls[0], calls[1], 'an exact owner retry retains the same selection');
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 205);
});

test('company attachment batch: the real owner refuses one denied source before placing any uploaded attachment', async () => {
  const { net, space, ana } = await world();
  const files = Array.from({ length: 130 }, (_, index) => ({ identity: `1f:${(index + 1).toString(16).padStart(64, '0')}` }));
  await ana.setRecordSharing(`file:${files.at(-1).identity}`, { network: false, spaces: [] });
  let composed = false;
  const post = async (path, body) => {
    const response = await handleSpacesRequest(ana, new Request(`https://person${path.replace('/work/api', '')}`, {
      method: 'POST', body: JSON.stringify(body),
    }));
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  };
  await assert.rejects(shareKeptFiles(space, files, post, 'all-private-or-none').then(() => { composed = true; }), /not to share this here/);
  assert.equal(composed, false);
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 0);
});

test('company attachment batch: an AI mixed selection uses the real member route and denies an unrelated account', async () => {
  const { net, relays, people, space, ana } = await world();
  const forPerson = person => spaceTools(async (path, body) => {
    const response = await handleSpacesRequest(person, new Request(`https://person${path}`, { method: 'POST', body: JSON.stringify(body) }));
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  }).find(tool => tool.name === 'share_to_space');
  const selection = { space_id: space, request_key: 'AI-full-company-selection', items: [
    { kind: 'file', file: '1f:video' }, { kind: 'record', record: 'pursuit:launch' },
    { kind: 'text', text: 'Review both and reply here' }, { kind: 'link', url: 'https://example.com/artwork' },
  ] };
  await assert.rejects(forPerson(people.cy).run(selection));
  assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 0);
  const answer = await forPerson(ana).run(selection);
  assert.equal(answer.placed.length, 4);
  const page = await net.spaceItems({ relay: relays.bo, space_id: space });
  assert.deepEqual(page.items.map(item => item.item_id), answer.placed.map(item => item.item_id));
  assert.deepEqual(page.items.map(item => item.kind), ['file', 'pursuit', 'text', 'link']);
  assert.deepEqual((await forPerson(ana).run(selection)).placed, answer.placed);
});


test('company attachment batch: malformed or ambiguous selections refuse instead of claiming an empty success', async () => {
  const { net, space, ana } = await world();
  for (const body of [
    { items: { kind: 'file', file: '1f:video' } }, { records: 'pursuit:launch' },
    { items: null }, { records: null },
    { file: '1f:video', items: [{ kind: 'text', text: 'Do not omit the file' }] },
    { record: 'pursuit:launch', records: ['pursuit:health'] },
  ]) {
    const response = await handleSpacesRequest(ana, new Request(`https://person/spaces/${space}/share`, {
      method: 'POST', body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
    assert.equal(net.sql.exec('SELECT COUNT(*) AS count FROM space_items WHERE space_id = ?', space).toArray()[0].count, 0);
  }
});

// Real owner integration: the rehearsal proof must admit the actual saved single-file shape.
test('recipient rehearsal admits the real private file grant and rejects widened or revoked owner state', async () => {
  const { exactPrivateFileGrant } = await import('../scripts/customer-recipient-share-readback.mjs');
  const { ana, relays } = await world();
  const values = new Map();
  ana.env.APP_KV = {
    put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
  };
  const selected = 'file:1f:' + 'a'.repeat(64);
  const link = await ana.createRecordShare(selected, { scope: { kind: 'private', value: relays.cy }, can: ['view'], listed: false });
  const grant = ana.shareLinksOf(selected).find(row => row.share_id === link.share_id);
  assert.deepEqual(grant.records, [selected]);
  assert.deepEqual(grant.entries, [{ kind: 'record', record: selected }]);
  assert.equal(exactPrivateFileGrant(grant, selected, relays.cy), true);
  assert.equal(exactPrivateFileGrant(grant, selected, relays.bo), false);
  const broad = await ana.createRecordShare(selected, { scope: { kind: 'private', value: relays.cy }, records: ['file:second-review'], can: ['view'] });
  assert.equal(exactPrivateFileGrant(ana.shareLinksOf(selected).find(row => row.share_id === broad.share_id), selected, relays.cy), false);
  await ana.revokeRecordShare(selected, link.share_id);
  assert.equal(exactPrivateFileGrant(ana.shareLinksOf(selected).find(row => row.share_id === link.share_id), selected, relays.cy), false);
});

test('installed site view uses the actual recipient grant, refuses unrelated readers and rechecks revocation after source waits', async () => {
  const { ana, relays } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value),
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; } };
  const selected = 'site:' + 'e'.repeat(32);
  const body = { installation_id: 'e'.repeat(32), entry_path: 'index.html', revision: 'saved', draft_revision: null };
  let reads = 0, duringRead = async () => {};
  ana.sharedInstalledSiteCopy = async ref => { assert.equal(ref, selected); return { kind: 'site', private_ref: ref, title: 'Shared site', body }; };
  ana.readSharedInstalledSiteFile = async (picked, path) => { reads++; assert.equal(picked.installation_id, body.installation_id); assert.equal(path, 'index.html');
    await duringRead(); return { ...body, path, media_type: 'text/html', bytes: new TextEncoder().encode('PRIVATE-SITE') }; };
  const link = await ana.createRecordShare(selected, { scope: { kind: 'private', value: relays.cy }, can: ['view'], listed: false });
  assert.equal((await ana.sharedRecordViewForLink(link.code, { relay: relays.cy }, 'index.html')).installation_id, body.installation_id);
  const before = reads;
  await assert.rejects(ana.sharedRecordViewForLink(link.code, { relay: relays.bo }, 'index.html'), /someone else/);
  await assert.rejects(ana.sharedRecordViewForLink(link.code, {}, 'index.html'), /someone else/);
  assert.equal(reads, before, 'refused readers do not touch site bytes');
  duringRead = () => ana.revokeRecordShare(selected, link.share_id);
  await assert.rejects(ana.sharedRecordViewForLink(link.code, { relay: relays.cy }, 'index.html'), /ended/);
});


test('static view RPC carries expected refusal as data and retains storage failures', async () => {
  const expected = { sharedRecordViewForLink: async () => { throw new SharingError('This shared view ended.'); } };
  assert.deepEqual(await recordSharingMethods.sharedRecordViewRequest.call(expected, 'fixture', {}, 'index.html'), { denied: true });
  const storage = new Error('Storage unavailable');
  const failing = { sharedRecordViewForLink: async () => { throw storage; } };
  await assert.rejects(recordSharingMethods.sharedRecordViewRequest.call(failing, 'fixture', {}, 'index.html'), error => error === storage);
});


test('static source is checked again after final asynchronous grant admission before bytes leave', async () => {
  const { ana, relays } = await world();
  const values = new Map();
  ana.env.APP_KV = { put: async (key, value) => values.set(key, value), get: async (key, type) => {
    const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
  } };
  const selected = 'site:' + 'e'.repeat(32);
  let revision = 'saved', bytesRead = false;
  const body = { installation_id: 'e'.repeat(32), entry_path: 'index.html', revision: 'saved', draft_revision: null };
  ana.sharedInstalledSiteCopy = async () => ({ kind: 'site', private_ref: selected, title: 'Site', body });
  ana.readSharedInstalledSiteFile = async (_, path, metadataOnly = false) => {
    if (!metadataOnly) bytesRead = true;
    return { ...body, revision, path, ...(metadataOnly ? {} : { bytes: new TextEncoder().encode('OLD') }) };
  };
  const link = await ana.createRecordShare(selected, { scope: { kind: 'private', value: relays.cy }, can: ['view'] });
  const admit = ana.admittedGrant.bind(ana);
  ana.admittedGrant = async (...args) => { const admitted = await admit(...args); if (bytesRead) revision = 'changed'; return admitted; };
  await assert.rejects(ana.sharedRecordViewForLink(link.code, { relay: relays.cy }, 'index.html'), /source changed/);
});
