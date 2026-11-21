// Ported from old trillion test/business-screen.test.mjs (Trillion-X/trillion before 4ffa1dc4a2).
//
// Business (do-work/business-screen.mjs) is every signed-in person's screen about their own business, a catalogue
// screen (tool:business in tools/show-my-screens-from-a-catalogue-of-reads-and-layouts) drawn from one read,
// tool:read-business: the read sums this month's money from the person's own Stripe connection per currency; a person
// with nothing connected is sent to Connections; a failed read says so with no number; the operator still sees
// Trillion's paid plans, price tests and use. Every description matches what businessScreen drew
// (fixtures/business-descriptions.json, the old golden, unchanged).
//
// Adapted:
// - The old test ran the read through the old Worker's Workshop with a mocked HTTP box, so it saw the request Stripe was
//   sent. The money read is now the engine's http run of tool:stripe-events-read_money_since (the engine fills and sends
//   it); here the read's runner answers what that run answers, and the request is checked on the row's own template.
// - Which services the person connected has no owner a Workshop run can reach (old: the account's held-values connection
//   summaries). The tests that give a list of connections draw exactly as before; the screen's own read has none, so
//   each service's connection is unknown, its money is read, and a read that fails is drawn as a failed read.
// - The operator's part (old: the service's payment config, call pool and price-test book) has no owner here, so the
//   operator test draws from the facts operatorBusiness gathered from the old test's pool, not from that pool.
// - The routing assertions (own-resource-compatibility, account-routes, the Worker's screens list) are the engine's
//   generic screen host now; what stays is the row the host reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { FIND_ACCOUNT, LIST_CONNECTIONS, businessFacts, moneyServices, moneyWords, monthStart, readBusiness, readBusinessForScreen, workshopRows } from '../do-work/business-screen.mjs';
import { listConnections } from '../../connections/do-work/list-connections.mjs';
import { findTheAccountOfAService } from '../../connections/do-work/find-the-account-of-a-service.mjs';
import { catalogueRows, drawCatalogueScreen } from './draw-catalogue-screen.mjs';

const SCREENS = { connections: 'trillion.connections' };
const rows = workshopRows();
const MONEY_READ = 'tool:stripe-events-read_money_since';

// A Stripe balance-transaction list as Stripe answers it (docs.stripe.com/api/balance_transactions/list).
const txn = (reporting_category, amount, fee, currency = 'usd') => ({ object: 'balance_transaction', amount, fee, net: amount - fee, currency, reporting_category, type: reporting_category });
const MONTH = [
  txn('charge', 10000, 320), txn('charge', 5050, 176), txn('refund', -2000, 0), txn('payout', -8000, 0),
  txn('charge', 3000, 120, 'eur'),
];

// One account whose Stripe connection (if any) answers `answer()` as the money read's run answers: its connections
// and its tool runner. `runs` keeps each run asked for. A run that failed (Stripe refused, the engine held no key)
// throws, as a nested run's refusal does.
function account({ connected, answer }) {
  const runs = [];
  return {
    runs,
    connections: connected ? [{ connection_id: 'conn-stripe', vendor: 'stripe', service: 'Stripe', status: 'connected' }] : [],
    run: async (toolId, input) => {
      runs.push({ toolId, input });
      const [status, reply] = answer();
      if (status < 200 || status >= 300) throw new Error(`The tool answered ${status}.`);
      return reply;
    },
  };
}

async function screenOf(someone) {
  const facts = await readBusiness({ rows, connections: someone.connections, run: someone.run });
  return drawCatalogueScreen('tool:business', { business: facts });
}

const since = monthStart(new Date());
const sinceWords = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(since);
const golden = JSON.parse(readFileSync(new URL('./fixtures/business-descriptions.json', import.meta.url), 'utf8')).cases;

test('the layout draws every description businessScreen drew', () => {
  assert.equal(golden.length, 9);
  golden.forEach((one, index) => assert.deepEqual(drawCatalogueScreen('tool:business', { business: businessFacts(one.facts) }), one.description, `case ${index}`));
});

test('Business is a reads screen the generic screen host answers at /work/api/screens/business, from one read', () => {
  const business = catalogueRows.find(row => row.id === 'tool:business');
  assert.equal(business.kind, 'ai-tool-descriptor');
  assert.equal(business.label, 'Business');
  assert.equal(business.screen.kind, 'reads');
  assert.equal(business.screen.shown_when, undefined, 'every account is shown it');
  assert.equal(business.invoke, undefined, 'a screen row runs nothing itself');
  assert.deepEqual(business.screen.reads, [{ id: 'business', tool: 'tool:read-business', input: {} }]);
});

test('Stripe can be read for money: the read is one tool row on the Stripe connection', () => {
  const services = moneyServices(rows, [{ vendor: 'stripe', connection_id: 'service_connection:stripe:shop' }, { vendor: 'notion', connection_id: 'service_connection:notion' }]);
  assert.deepEqual(services.map(service => [service.read.tool_id, service.label, service.connected, service.accounts]), [[MONEY_READ, 'Stripe', true, ['service_connection:stripe:shop']]]);
  assert.equal(moneyServices(rows, [])[0].connected, false);
  assert.equal(moneyServices(rows, null)[0].connected, null, 'connections that cannot be read leave each service unknown');
});

test('a customer with nothing connected is sent to Connections, and no money is read', async () => {
  const someone = account({ connected: false, answer: () => [500, {}] });
  const shown = await screenOf(someone);
  assert.equal(shown.title, 'Business');
  assert.deepEqual(shown.sections.map(section => section.heading), ['Money this month'], 'a customer sees no operator parts');
  assert.deepEqual(shown.sections[0].rows, [{ id: 'connect', title: 'Stripe is not connected', actions: [{ label: 'Open Connections', tone: 'primary', open: SCREENS.connections }] }]);
  assert.deepEqual(someone.runs.length, 0);
});

test('a customer\'s own Stripe money this month is summed per currency, and a read cut short says so', async () => {
  const someone = account({ connected: true, answer: () => [200, { object: 'list', has_more: true, data: MONTH }] });
  const shown = await screenOf(someone);
  assert.deepEqual(someone.runs, [{ toolId: MONEY_READ, input: { since: since.getTime() / 1000 } }]);
  // The request the engine sends for that run: read from the 1st of this month, UTC, at most 100 entries.
  const read = rows.tools.find(row => row.id === MONEY_READ);
  const asked = new URL(read.invoke.url.replace('{since}', String(since.getTime() / 1000)));
  assert.equal(asked.pathname, '/v1/balance_transactions');
  assert.equal(asked.searchParams.get('created[gte]'), String(since.getTime() / 1000), 'read from the 1st of this month, UTC');
  assert.equal(asked.searchParams.get('limit'), '100');
  const [section] = shown.sections;
  assert.equal(section.heading, `Stripe since ${sinceWords}`);
  assert.deepEqual(section.stats.map(tile => [tile.label, tile.value]), [
    ['Money in (USD)', '$150.50'], ['Stripe fees (USD)', '$4.96'], ['Refunded (USD)', '$20'], ['Net (USD)', '$125.54'],
    ['Money in (EUR)', '€30'], ['Stripe fees (EUR)', '€1.20'], ['Net (EUR)', '€28.80'],
    ['Payments', '3'],
  ], 'a payout moves money already taken in and is not counted');
  assert.equal(section.note, 'These figures count the latest 100 entries on Stripe; there were more this month.');
});

test('a read that fails says the money could not be read, with no number', async () => {
  for (const someone of [account({ connected: true, answer: () => [401, { error: { message: 'Invalid API Key' } }] }),
    account({ connected: true, answer: () => [200, {}] }),
    { ...account({ connected: true, answer: () => [200, {}] }), run: async () => { throw new Error('the account\'s tool runner refused'); } }]) {
    const [section] = (await screenOf(someone)).sections;
    assert.deepEqual(section.rows, [{ id: 'unread:Stripe', title: 'Your Stripe money could not be read just now' }]);
    assert.equal(section.stats, undefined);
  }
});

test('a month with no payments says so', async () => {
  const shown = await screenOf(account({ connected: true, answer: () => [200, { data: [], has_more: false }] }));
  assert.deepEqual(shown.sections[0].rows, [{ id: 'none:Stripe', title: `No payments since ${sinceWords}` }]);
});

test('the operator sees their own money and still sees Trillion\'s paid plans and use', async () => {
  const facts = await readBusiness({ rows, ...account({ connected: true, answer: () => [200, { has_more: false, data: [txn('charge', 10000, 320)] }] }) });
  // What old operatorBusiness gathered from the old test's pool ({ days: [{ calls: 7, refused: 1 }, { calls: 5, refused: 0 }],
  // apps: [{ app: 'Claude', calls: 12 }] }), an empty payment config and no price tests.
  assert.equal(facts.operator, null, 'the operator\'s part is not read: it has no owner here');
  const operator = { payment_service: { label: 'Stripe', connected: true }, payments: null, usage: { calls_7d: 12, refused_7d: 1, apps: [{ app: 'Claude', calls: 12 }] }, price_tests: [] };
  const raw = { since: since.toISOString(), services: [{ label: 'Stripe', connected: true, money: { currencies: [{ currency: 'usd', money_in: 10000, fees: 320, refunded: 0, net: 9680 }], payments: 1, more: false, at_most: 100 } }], operator };
  const shown = drawCatalogueScreen('tool:business', { business: businessFacts(raw) });
  assert.deepEqual(shown.sections.map(section => section.heading), [`Stripe since ${sinceWords}`, 'Paid plans', 'How people use Trillion']);
  assert.deepEqual(shown.sections[0].stats.map(tile => tile.value), ['$100', '$3.20', '$96.80', '1']);
  assert.equal(shown.sections[2].rows[0].title, '12 answers from AIs in the last 7 days');
});

test('amounts are written in each currency\'s own smallest unit', () => {
  assert.equal(moneyWords(123456, 'usd'), '$1,234.56');
  assert.equal(moneyWords(5000, 'jpy'), '¥5,000');
  assert.equal(moneyWords(-400, 'usd'), '-$4');
});

test('the operator sees each price test: every price, who saw it and paid, money per person shown, and can end it on one', () => {
  const operator = { payment_service: { label: 'Stripe', connected: true }, payments: null, usage: { calls_7d: 0, refused_7d: 0, apps: [] },
    price_tests: [{ id: 'experiment:plan', label: 'Plan price', state: 'running', optimizing_for: 'Money per person shown.', leading: 'offer:b',
      arms: [{ arm: 'offer:a', label: '$100 a spot', shown: 3, paid: 0, money_cents: 0, money_per_shown_cents: 0, open: true },
        { arm: 'offer:b', label: '$150 a spot', shown: 2, paid: 1, money_cents: 15000, money_per_shown_cents: 7500, open: false }] }] };
  const draw = facts => drawCatalogueScreen('tool:business', { business: businessFacts(facts) });
  const shown = draw({ since: new Date().toISOString(), services: [], operator });
  const test = shown.sections.find(section => section.heading === 'Plan price');
  assert.equal(test.rows[1].detail, '2 people shown · 1 paid · $150 in · $75 per person shown · waiting for its payment link');
  assert.equal(test.rows[1].status.label, 'Leading');
  assert.deepEqual(test.rows[0].actions[0].send.body, { experiment_id: 'experiment:plan', winner: 'offer:a' });
  const unread = draw({ since: new Date().toISOString(), services: [], operator: { ...operator, price_tests: null } });
  assert.match(unread.sections.find(section => section.heading === 'Price tests').note, /could not be read/);
});

// The screen's own read, as the engine runs it: the connections list and each money read are nested runs through the run's host actions.
function runAnswering(answer) {
  const runs = [];
  return { runs, host: { run: async (tool, input, options) => { runs.push({ tool, input, options }); return answer(tool, input); } } };
}

// The person's connections as tool:list-connections answers them (tools/connections), or a refusal.
const LISTED = { connections: [{ connection_id: 'service_connection:stripe', service: 'Stripe', vendor: 'stripe', status: 'connected', can_send: true, grant_scopes_known: false }] };
const listing = (listed, money) => (tool, input) => (tool === LIST_CONNECTIONS ? (listed instanceof Error ? (() => { throw listed; })() : listed) : money(tool, input));

// The two lists the caller's AI hands in: the person's connection records and the vault's held connection names.
const HELD = [{ connection_id: 'service_connection:stripe', fields: ['secret_key'] }];
const LISTS = { connection_records: [], held_connections: HELD };

test('the screen\'s read hands both lists to tool:list-connections, which answers them, and reads the money with the person\'s own connection', async () => {
  // tool:list-connections itself (tools/connections) answers the nested run, so a call it would refuse fails here.
  const { runs, host } = runAnswering((tool, input) => (tool === LIST_CONNECTIONS ? listConnections(input) : { object: 'list', has_more: false, data: MONTH }));
  const facts = await readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z', ...LISTS }, host);
  const october = Date.UTC(2026, 9, 1) / 1000;
  assert.deepEqual(runs, [
    { tool: LIST_CONNECTIONS, input: LISTS, options: { key: `${LIST_CONNECTIONS}:${JSON.stringify(LISTS)}` } },
    { tool: MONEY_READ, input: { since: october, connection: { connection_id: 'service_connection:stripe' } }, options: { key: `${MONEY_READ}:${JSON.stringify({ since: october, connection: { connection_id: 'service_connection:stripe' } })}` } },
  ]);
  const listed = await listConnections(runs[0].input);
  assert.deepEqual(listed.connections.map(row => row.vendor), ['stripe'], 'the held Stripe connection is listed, not refused');
  assert.equal(facts.since_words, 'October 1');
  assert.deepEqual(facts.service_names, ['Stripe']);
  assert.equal(facts.operator, null);
  const [section] = drawCatalogueScreen('tool:business', { business: facts }).sections;
  assert.equal(section.heading, 'Stripe since October 1');
  assert.deepEqual(section.stats.map(tile => tile.value), ['$150.50', '$4.96', '$20', '$125.54', '€30', '€1.20', '€28.80', '3']);
});

test('Stripe not in the person\'s connections is drawn not connected, live, and its money is not read', async () => {
  const { runs, host } = runAnswering(listing({ connections: [{ connection_id: 'service_connection:notion', service: 'Notion', vendor: 'notion', can_send: false, grant_scopes_known: false }] }, () => assert.fail('no money read')));
  const shown = drawCatalogueScreen('tool:business', { business: await readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z', ...LISTS }, host) });
  assert.deepEqual(shown.sections[0].rows, [{ id: 'connect', title: 'Stripe is not connected', actions: [{ label: 'Open Connections', tone: 'primary', open: SCREENS.connections }] }]);
  assert.deepEqual(runs.map(run => run.tool), [LIST_CONNECTIONS]);
  // A Stripe connection whose values were removed is still the person's connection (old list kept it), so it is read.
  const kept = runAnswering(listing({ connections: [{ ...LISTED.connections[0], status: 'disconnected', can_send: false }] }, () => ({ object: 'list', has_more: false, data: [] })));
  await readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z', ...LISTS }, kept.host);
  assert.deepEqual(kept.runs.map(run => run.tool), [LIST_CONNECTIONS, MONEY_READ]);
});

test('with no list of connections, a money read that fails is drawn as a failed read, never as connected or not', async () => {
  // The list cannot be read (the run is refused), and the engine refuses a run whose key it does not hold
  // (tools_tool_credential_unavailable), as any other refusal.
  const { host } = runAnswering(() => { throw Object.assign(new Error('The run refused the call.'), { code: 'tools_tool_credential_unavailable' }); });
  const shown = drawCatalogueScreen('tool:business', { business: await readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z' }, host) });
  assert.deepEqual(shown.sections, [{ heading: 'Stripe since October 1', rows: [{ id: 'unread:Stripe', title: 'Your Stripe money could not be read just now' }] }]);
  await assert.rejects(readBusinessForScreen({ now: 'not a time' }, host), /now must be an ISO time/);
  await assert.rejects(readBusinessForScreen({ held_connections: 'stripe' }, host), /held_connections is a list/);
});

test('a list left out is never taken as no connections: the listing is not run, and each service\'s money is read with the service named and no account', async () => {
  for (const given of [{ connection_records: [] }, {}]) {
    const { runs, host } = runAnswering(listing(new Error('no listing without both lists'), () => ({ object: 'list', has_more: false, data: MONTH })));
    const shown = drawCatalogueScreen('tool:business', { business: await readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z', ...given }, host) });
    assert.deepEqual(runs.map(run => [run.tool, run.input.connection]), [[MONEY_READ, { connection_id: 'service_connection:stripe' }]], JSON.stringify(given));
    assert.equal(shown.sections[0].heading, 'Stripe since October 1', 'never drawn as not connected');
    assert.equal(shown.sections[0].rows?.[0]?.id === 'connect', false);
  }
});

test('with held connections but no records, the account is asked of tool:find-the-account-of-a-service and the money read with it', async () => {
  const shop = 'service_connection:stripe:shop';
  for (const [held, read, title] of [
    [[{ connection_id: shop, fields: ['secret_key'] }], shop, undefined],
    [[{ connection_id: 'service_connection:stripe:a', fields: [] }, { connection_id: 'service_connection:stripe:b', fields: [] }], null, /more than one/],
    [[], null, 'unread'],
  ]) {
    const { runs, host } = runAnswering((tool, input) => (tool === FIND_ACCOUNT ? findTheAccountOfAService(input) : { object: 'list', has_more: false, data: MONTH }));
    const reading = readBusinessForScreen({ now: '2026-10-15T12:00:00.000Z', held_connections: held }, host);
    if (title instanceof RegExp) { await assert.rejects(reading, title); continue; }
    const facts = await reading;
    assert.deepEqual(runs[0], { tool: FIND_ACCOUNT, input: { service: 'service_connection:stripe', held_connections: held }, options: { key: `${FIND_ACCOUNT}:${JSON.stringify({ service: 'service_connection:stripe', held_connections: held })}` } });
    assert.deepEqual(runs.slice(1).map(run => run.input.connection), read ? [{ connection_id: read }] : [], JSON.stringify(held));
    if (title) assert.equal(facts.connected[0].state, title);
  }
});

test('the read row runs only the connections list, the money read and the account finder, holds no records right, and packs every file it imports', () => {
  const read = rows.tools.find(row => row.id === 'tool:read-business');
  assert.deepEqual(read.invoke.records, { fd: 3, runs: [LIST_CONNECTIONS, MONEY_READ, FIND_ACCOUNT] });
  assert.equal(read.invoke.internet, false, 'the money is read by the nested run, which alone reaches Stripe');
  for (const { package: folder, paths } of read.invoke.files.package_files.filter(files => files.package)) {
    for (const path of paths) assert.ok(existsSync(new URL(`../../${folder}/${path}`, import.meta.url)), `${folder}/${path}`);
  }
  const money = rows.tools.find(row => row.id === MONEY_READ);
  assert.equal(money.invoke.kind, 'http');
  assert.equal(money.invoke.connection_id, undefined, 'no bare connection: the input names which Stripe account');
  assert.deepEqual(money.invoke.connection, { vendor: 'stripe', from_input: 'connection' });
  assert.deepEqual(money.invoke.credential_injections.map(item => [item.field_id, item.hosts]), [['secret_key', ['api.stripe.com']]]);
  assert.deepEqual(Object.keys(money.input_schema.properties), ['since', 'connection']);
});
