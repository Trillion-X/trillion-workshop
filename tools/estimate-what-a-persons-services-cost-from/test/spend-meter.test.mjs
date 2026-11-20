// What a person's services cost is read line by line, priced past what the plan includes, and capped by budget rows
// (src/spend-meter.mjs), with the formula engine deciding coverage: a provider's usage answer is read once for every
// line that shares it, a line that cannot be read is never shown as zero, and a reached service budget tells its
// operators without stopping anyone's work.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initSync, compileRules as engineCompileRules, filterRows as engineFilterRows } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { dollarsFor, historyDaysAt, periodsAt, spendBudgetRow, spendDayOf, spendDays, spendMeter, SpendMeterError } from '../src/spend-meter.mjs';
import data from '../../shared-code/src/spend-meter.json' with { type: 'json' };

initSync({ module: readFileSync(new URL(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url))) });
const matches = (tree, fields, row) => engineFilterRows({ rows: [row], binding: engineCompileRules({ tree, fields }).binding }).matches.length === 1;
// 2026-10-04 12:00 UTC, in a billing month that started on the 26th.
const NOON = Date.parse('2026-10-04T12:00:00Z');
// Cloudflare's own answer shape (a real read of 2026-10-04, trimmed), for one day and for the month so far.
const usage = ({ rowsWritten, rowsRead, requests, neurons }) => ({ data: { viewer: { accounts: [{
  durable_objects: [{ sum: { rowsRead, rowsWritten, duration: 1000 } }],
  durable_object_requests: [{ sum: { requests: 1000 } }],
  workers: [{ sum: { requests, cpuTimeUs: 1000 } }],
  workers_ai: [{ sum: { totalNeurons: neurons } }],
  kv_operations: [{ dimensions: { actionType: 'read' }, sum: { requests: 10 } }, { dimensions: { actionType: 'write' }, sum: { requests: 4_000_000 } }],
  r2_operations: [{ dimensions: { actionType: 'PutObject' }, sum: { requests: 10 } }, { dimensions: { actionType: 'GetObject' }, sum: { requests: 10 } }],
  r2_storage: [{ max: { payloadSize: 539_408_096_684, metadataSize: 1_634_103 } }],
} ] } } });
const today = usage({ rowsWritten: 74_834_997, rowsRead: 77_484_063_156, requests: 1_647_228, neurons: 5_450_770 });
const month = usage({ rowsWritten: 239_579_000, rowsRead: 263_953_000_000, requests: 9_000_000, neurons: 9_320_000 });

function meterWith({ service = true, connected = true, budgets = [], own = {}, fly = { state: 'not-connected', connection: 'fly' } } = {}) {
  const reads = [];
  const flyReads = [];
  const told = [];
  const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: {
      service: async (reading, period) => {
        if (reading.connection === 'fly') { flyReads.push(period.id); return fly; }
        reads.push(period.id); return connected ? (period.id === 'today' ? today : month) : { state: 'not-connected', connection: reading.connection };
      },
      'model-calls': async () => ({ amount: 1_000_000 }),
      'store-work': async () => ({ amount: 5 }),
      'own-api': async (reading, period) => ({ rows: own[period.id] ?? [] }),
    },
    matches, tell: async notice => { told.push(notice); }, budgets: () => budgets, cycleDay: () => 26, service: () => service, now: () => NOON,
  });
  return { meter, reads, told, flyReads };
}
const item = (answer, id) => answer.items.find(row => row.id === id);
const modelCallsLine = `line:${data.lines.find(line => line.reading.kind === 'model-calls').id}`;
const planDailyCap = data.budgets.find(row => row.id === 'plan-daily-cap');
const PAID_BY_THIS_OWNER = planDailyCap.stop.rules.find(rule => rule.field === 'paid_by').params.values[0];
const PLAN_DAILY_CAP_LABEL = planDailyCap.label;

test('a provider answer is read once per period for every line sharing it, and priced past what the plan includes', async () => {
  const { meter, reads } = meterWith();
  const answer = await meter.read();
  assert.deepEqual(reads.sort(), ['month', 'today']);
  // Rows written: 239.579M this month, 50M included, $1 a million.
  assert.equal(Math.round(item(answer, 'line:cloudflare-do-rows-written').month_dollars * 100), 18958);
  // Today's share: all of today's 74.8M rows are past the monthly allowance already used.
  assert.equal(Math.round(item(answer, 'line:cloudflare-do-rows-written').today_dollars * 100), 7483);
  // Workers AI has a daily allowance: 9 days x 10,000 neurons are free this month.
  assert.equal(Math.round(item(answer, 'line:cloudflare-workers-ai').month_dollars * 100), Math.round((9_320_000 - 90_000) * 11 / 1e6 * 100));
  // KV writes are counted only where the kind is one of the line's; reads are their own line.
  assert.equal(item(answer, 'line:cloudflare-kv-changes').month_amount, '4M operations');
  assert.equal(item(answer, 'line:cloudflare-kv-reads').month_amount, '10 reads');
  // A line that breaks another down is shown but not added to the total.
  const counted = answer.items.filter(row => row.kind === 'line' && data.lines.find(line => `line:${line.id}` === row.id).in_total);
  assert.ok(Math.abs(answer.total.month - counted.reduce((sum, row) => sum + row.month_dollars, 0)) < 1e-9);
  assert.ok(item(answer, modelCallsLine).month_dollars > 0);
  assert.equal(item(answer, 'line:cloudflare-plan').month_dollars, 5);
  // Every row says its dollars in words, and each service is one row summing its own lines, for glance surfaces.
  assert.equal(item(answer, 'line:cloudflare-plan').cost, '$0.00 estimated today, $5.00 estimated this billing cycle');
  assert.match(answer.dollars_basis, /not a provider invoice/);
  assert.ok(Math.abs(answer.groups.reduce((sum, row) => sum + row.month_dollars, 0) - answer.total.month) < 1e-9);
  const cloudflare = answer.groups.find(row => row.id === 'Cloudflare');
  assert.ok(Math.abs(cloudflare.month_dollars - counted.filter(row => row.group === 'Cloudflare').reduce((sum, row) => sum + row.month_dollars, 0)) < 1e-9);
  assert.match(cloudflare.cost, /^\$[\d,.]+ estimated today, \$[\d,.]+ estimated this billing cycle$/);
  assert.equal(answer.cycle_start, '2026-09-26');
});

test('a service not connected is asked for once, never shown as costing nothing', async () => {
  const { meter } = meterWith({ connected: false });
  const answer = await meter.read();
  assert.equal(item(answer, 'line:cloudflare-do-rows-read'), undefined);
  assert.deepEqual(answer.items.filter(row => row.kind === 'connect').map(row => row.id), ['connect:cloudflare', 'connect:fly'], 'one card per service, however many lines it bills');
  assert.equal(item(answer, 'connect:cloudflare').state, 'not-connected');
  // Its plan is billed with it, so it counts only once the account is read: nobody else is shown its $5.
  assert.equal(item(answer, 'line:cloudflare-plan'), undefined);
  assert.equal(answer.total.month, 0);
});

test('a reached service budget tells the operators once and stops no one\'s work', async () => {
  // The Workshop's own cost is a watch: past its day line the operators are told, and no person's store work or model call waits.
  // Customer work past a service line is never refused (2026-10-19: the day stop refused a restore's store writes).
  const { meter, told } = meterWith();
  const answer = await meter.read();
  const day = answer.budgets.find(row => row.id === 'service-day');
  assert.equal(day.state, 'reached');
  assert.ok(told.some(notice => notice.key === 'spend-budget:service-day:2026-10-04:reached'), 'the operators are told');
  assert.equal(answer.budgets.find(row => row.id === 'service-model-day').state, 'reached');
  assert.equal(answer.stops.some(stop => stop.budget === 'service-day' || stop.budget === 'service-model-day'), false, 'no service line stops work');
  assert.equal(answer.stops.length, 0);
  const someone = await meterWith({ service: false }).meter.read();
  assert.equal(someone.stops.length, 0);
  // Only their own: a budget for each API account they pay for, shown before any account has cost anything.
  assert.deepEqual(someone.budgets.map(row => row.id), ['plan-daily-cap', 'own-api-day']);
});

// On 2026-10-04 the day reached $215 while the $25 day budget told only at half of it. The pace state tells within the
// hour the rate so far would carry the day past its budget.
test('a day heading past its budget at the rate so far tells once, before half of it is used', async () => {
  const run = async (hour, most) => {
    const told = [];
    const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
      readers: {
        service: async (reading, period) => (reading.connection === 'fly' ? { state: 'not-connected', connection: 'fly' } : period.id === 'today' ? today : month),
        'model-calls': async () => ({ amount: 0 }), 'store-work': async () => ({ amount: 0 }), 'own-api': async () => ({ rows: [] }),
      },
      matches, tell: async notice => { told.push(notice); }, cycleDay: () => 26, service: () => true, now: () => Date.parse(`2026-10-04T${hour}:00:00Z`),
      budgets: () => [{ id: 'service-day', label: 'A day', scope: 'service', when: null, period: 'day', most_dollars: most, alert_at: 0.5, stop: null }],
    });
    const answer = await meter.read();
    return { day: answer.budgets.find(row => row.id === 'service-day'), told };
  };
  // What the day's reading costs; read at 03:00 it is heading for 8 times that.
  const used = (await run('03', 1e9)).day.used_dollars;
  const heading = await run('03', used * 7);
  assert.equal(heading.day.state, 'pace');
  const told = heading.told.filter(notice => notice.key.startsWith('spend-budget:service-day:'));
  assert.deepEqual(told.map(notice => notice.key), ['spend-budget:service-day:2026-10-04:pace']);
  assert.match(told[0].body, /At this rate the day ends near \$/);
  // A rate that ends under the budget says nothing.
  assert.equal((await run('03', used * 9)).day.state, 'ok');
  // In the day's first hour the rate is not read: a burst after midnight is not a day.
  assert.equal((await run('00', used * 3)).day.state, 'ok');
});

test('a person\'s own budget row replaces a starting one and is checked', async () => {
  const row = spendBudgetRow({ id: 'service-day', most_dollars: 1000, period: 'day' });
  assert.equal(row.scope, 'service');
  const { meter } = meterWith({ budgets: [row] });
  const answer = await meter.read();
  assert.equal(answer.budgets.find(budget => budget.id === 'service-day').state, 'ok');
  assert.equal(answer.stops.filter(stop => stop.budget === 'service-day').length, 0);
  assert.throws(() => spendBudgetRow({ id: 'x', most_dollars: 0 }), /most_dollars/);
  assert.throws(() => spendBudgetRow({ id: 'Bad Id', most_dollars: 5 }), /id/);
});

test('the month runs from the cycle day, and something kept is billed by its share of the month', () => {
  const periods = periodsAt(NOON, 26);
  assert.deepEqual([periods.month.since, periods.month.until, periods.month.days, periods.month.length_days], ['2026-09-26', '2026-10-04', 9, 30]);
  const kept = data.lines.find(line => line.id === 'cloudflare-r2-storage');
  const { today, month } = dollarsFor(kept, { today: 539.4, month: 539.4 }, periods);
  assert.ok(Math.abs(today - (529.4 * 0.015) / 30) < 1e-9);
  assert.ok(Math.abs(month - (529.4 * 0.015 * 9) / 30) < 1e-9);
});

test('each API account the person pays for is its own line in dollars, with its own day budget, and kept apart from the owner\'s own bill', async () => {
  const own = {
    today: [{ key: 'google', label: 'Google AI (Gemini)', amount: 7.5, shown: '310 calls' }, { key: 'openai', label: 'OpenAI', amount: 1 }],
    month: [{ key: 'google', label: 'Google AI (Gemini)', amount: 103 }, { key: 'openai', label: 'OpenAI', amount: 4 }],
  };
  const { meter, told } = meterWith({ own });
  const answer = await meter.read();
  const google = item(answer, 'line:own-api:google');
  assert.equal(google.today_dollars, 7.5);
  assert.equal(google.month_dollars, 103);
  assert.equal(google.today_amount, '310 calls');
  assert.equal(google.group, 'Your API accounts');
  const caps = answer.budgets.filter(row => row.id.startsWith('own-api-day:'));
  // Every API account starts with $0 a day: nothing is sent on a key billed by the word until the person sets a budget.
  assert.deepEqual(caps.map(row => [row.id, row.state]), [['own-api-day:google', 'reached'], ['own-api-day:openai', 'reached']]);
  assert.ok(told.some(notice => notice.key === 'spend-budget:own-api-day:google:2026-10-04:reached'));
  // The Workshop's own day budget counts Cloudflare only: the person's $7.50 of Gemini is not the Workshop's spend.
  const cloudflareToday = answer.items.filter(row => row.kind === 'line' && row.group === 'Cloudflare' && data.lines.find(line => `line:${line.id}` === row.id)?.in_total).reduce((sum, row) => sum + row.today_dollars, 0);
  assert.ok(Math.abs(answer.budgets.find(row => row.id === 'service-day').used_dollars - cloudflareToday) < 1e-9);
  // The cap a send asks for: one per account, stopping API calls only.
  assert.deepEqual(await meter.capsFor({ line: 'own-api', group: 'Your API accounts', kind: 'own-api', key: 'google' }, { kind: 'api-call', purpose: 'google', entry: 'send', paid_by: 'person' }), [{ id: 'own-api-day:google', label: 'Day budget', most_dollars: 0, alert_at: 0.5, period: 'day' }]);
  assert.deepEqual(await meter.capsFor({ line: 'own-api', group: 'Your API accounts', kind: 'own-api', key: 'google' }, { kind: 'store-work', purpose: 'x', entry: 'alarm', paid_by: PAID_BY_THIS_OWNER }), [{ id: 'plan-daily-cap', label: PLAN_DAILY_CAP_LABEL, most_dollars: 25, alert_at: 0.5, period: 'day' }]);
});

test('a host billed per machine is read once, each machine priced by its own size and region, and a stopped one costs only its volume', async () => {
  // The Machines API's own shapes, after the reading listed each app's machines and volumes on its own.
  const machine = (state, region, cpu_kind, cpus, memory_mb) => ({ state, region, config: { guest: { cpu_kind, cpus, memory_mb } } });
  const fly = { apps: [
    { name: 'site', machines: [machine('started', 'ord', 'performance', 2, 8192)], volumes: [{ size_gb: 20 }] },
    { name: 'small', machines: [machine('started', 'iad', 'shared', 1, 256)], volumes: [{ size_gb: 1 }] },
    { name: 'resting', machines: [machine('stopped', 'ord', 'shared', 2, 4096)], volumes: [{ size_gb: 40 }] },
  ] };
  const { meter, flyReads } = meterWith({ fly });
  const answer = await meter.read();
  assert.deepEqual(flyReads, ['today'], 'a snapshot is read once for both periods');
  const month = id => item(answer, `line:${id}`).month_dollars;
  const periods = periodsAt(NOON, 26);
  const share = periods.month.days / periods.month.length_days;
  // performance-2x 8GB in ord: (2 x $33 + 4 GB beyond the 4 included x $6.003) x 1.25 = $112.52 a month.
  assert.ok(Math.abs(month('fly-performance-cpus') - 2 * 33 * 1.25 * share) < 0.01);
  assert.ok(Math.abs(month('fly-performance-memory') - 4 * 6.003 * 1.25 * share) < 0.01);
  // shared-1x 256MB in iad: $2.19, nothing beyond the 0.25 GB included; the stopped machine adds no CPU or memory.
  assert.ok(Math.abs(month('fly-shared-cpus') - 2.1941 * share) < 0.01);
  assert.equal(month('fly-shared-memory'), 0);
  // Every volume is billed whether its machine runs: 61 GB x $0.15.
  assert.ok(Math.abs(month('fly-volumes') - 61 * 0.15 * share) < 0.01);
  assert.equal(item(answer, 'line:fly-volumes').group, 'Fly.io');
});

test('a line built from kept readings says when its readings were read, the older of its two periods', async () => {
  const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: {
      service: async (reading, period, which) => (reading.connection === 'cloudflare'
        ? { kept: period.id === 'today' ? today : month, read_at: which.period === 'today' ? '2026-10-04T11:55:00.000Z' : '2026-10-04T11:40:00.000Z' }
        : { state: 'not-connected', connection: reading.connection }),
      'model-calls': async () => ({ amount: 0 }),
      'store-work': async () => ({ amount: 0 }),
      'own-api': async () => ({ rows: [] }),
    },
    matches, cycleDay: () => 26, now: () => NOON,
  });
  const answer = await meter.read();
  assert.equal(item(answer, 'line:cloudflare-do-rows-read').read_at, '2026-10-04T11:40:00.000Z');
  assert.equal(item(answer, 'total').read_at, '2026-10-04T11:40:00.000Z', 'a freshly calculated total does not claim its saved source was read now');
  assert.equal(answer.groups.find(row => row.id === 'Cloudflare').read_at, '2026-10-04T11:40:00.000Z');
  assert.equal(answer.read_at, new Date(NOON).toISOString(), 'the response still distinguishes calculation time from source time');
  assert.equal(Math.round(item(answer, 'line:cloudflare-do-rows-written').month_dollars * 100), 18958, 'a kept answer prices as a fresh one');
  assert.equal(item(answer, modelCallsLine).read_at, new Date(NOON).toISOString(), 'a count read now says now');
});

test('each day keeps what every service cost that day, and the charts read them as one row per service per day', () => {
  const day = spendDayOf({ today: '2026-10-05', total: { today: 1.234 }, groups: [{ group: 'Cloudflare', today_dollars: 1.004 }, { group: 'Fly.io', today_dollars: 0.23 }] });
  assert.deepEqual(day, { day: '2026-10-05', total: 1.23, groups: { Cloudflare: 1, 'Fly.io': 0.23 } });
  const kept = [day, { day: '2026-10-04', groups: { Cloudflare: 2 } }, null, { day: 'no-day' }];
  assert.deepEqual(spendDays(kept).map(row => [row.day, row.group, row.dollars]), [['2026-10-04', 'Cloudflare', 2], ['2026-10-05', 'Cloudflare', 1], ['2026-10-05', 'Fly.io', 0.23]]);
  assert.equal(spendDays(kept, { data: { ...data, keep_days: 1 } }).length, 2, 'only the newest kept days');
});

test('past days are read from where they are counted, priced inside their own billing month, and settle once', async () => {
  // One line (Durable Object rows written, $1 per million past 50 million a month), 20 million rows every day.
  const one = { ...data, history_days: 3, lines: data.lines.filter(line => line.id === 'cloudflare-do-rows-written') };
  assert.deepEqual(historyDaysAt(NOON, 26, one), ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
    'from the start of the billing month three days back falls in, to yesterday');
  let connected = true;
  const asked = [];
  const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: {
      service: async (reading, period, which) => {
        asked.push(which.period);
        if (!connected) return { state: 'not-connected', connection: reading.connection };
        const answer = usage({ rowsWritten: 20_000_000, rowsRead: 0, requests: 0, neurons: 0 });
        // Yesterday was last read three hours after it ended, before the provider settled it.
        return period.since === '2026-10-03' ? { kept: answer, read_at: '2026-10-04T03:00:00.000Z' } : answer;
      },
    },
    matches, cycleDay: () => 26, now: () => NOON, data: one,
  });
  const rows = await meter.history();
  assert.ok(asked.every(name => /^day:\d{4}-\d{2}-\d{2}$/.test(name)), 'each past day is its own period');
  assert.deepEqual(rows.map(row => [row.day, row.total]), [['2026-09-26', 0], ['2026-09-27', 0], ['2026-09-28', 10], ['2026-09-29', 20], ['2026-09-30', 20], ['2026-10-01', 20], ['2026-10-02', 20], ['2026-10-03', 20]],
    'the month\'s 50 million included rows are used up in order, then each day pays for its own');
  assert.deepEqual(rows.find(row => row.day === '2026-09-28').groups, { Cloudflare: 10 });
  assert.equal(rows.find(row => row.day === '2026-10-02').final, true);
  assert.equal(rows.find(row => row.day === '2026-10-03').final, false, 'a day read before it settled is read again');
  const kept = Object.fromEntries(rows.map(row => [row.day, row]));
  assert.deepEqual((await meter.history({ kept })).map(row => row.day), ['2026-10-03'], 'only the unsettled day is answered again');

  // Someone who had not connected the service: each day settles with the line missing, and is read again once it counts.
  connected = false;
  const bare = await meter.history();
  assert.ok(bare.every(row => row.final && row.total === 0 && row.missing.includes('cloudflare-do-rows-written')));
  const keptBare = Object.fromEntries(bare.map(row => [row.day, row]));
  assert.deepEqual(await meter.history({ kept: keptBare }), [], 'settled days are not read again');
  assert.equal((await meter.history({ kept: keptBare, counted: ['cloudflare-do-rows-written'] })).length, 8, 'a line connected since is read into every past day');

  // A source that cannot answer a day after it settled (it keeps only so far back) settles that day without the line.
  const old = await spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: { service: async () => ({ kept: { state: 'unread', error: 'date out of range' }, read_at: '2026-10-04T05:00:00.000Z' }) },
    matches, cycleDay: () => 26, now: () => NOON, data: one,
  }).history();
  assert.ok(old.filter(row => row.day < '2026-10-03').every(row => row.final && row.missing.includes('cloudflare-do-rows-written')));
  assert.equal(old.find(row => row.day === '2026-10-03').final, false, 'yesterday read before it settled is asked again');
});

test('Spend draws its own charts from its days and budgets, every placement a mark the chart family has', () => {
  const marks = ['line', 'area', 'bar', 'stacked-bar', 'sparkline', 'donut', 'heatmap'];
  assert.ok(data.view.charts.length >= 1);
  for (const placement of data.view.charts) assert.ok(marks.includes(placement.mark), placement.id);
});

test('a line opens into its pieces today: each store and hour with its amount and its share of the line\'s cost', async () => {
  const byHour = { data: { viewer: { accounts: [{
    durable_objects_written: [
      { sum: { rowsWritten: 30_000_000, rowsRead: 1 }, dimensions: { datetimeHour: '2026-10-04T10:00:00Z', namespaceId: 'n1', objectId: 'aaaaaaaaaaaaaaaa11111111' } },
      { sum: { rowsWritten: 10_000_000, rowsRead: 1 }, dimensions: { datetimeHour: '2026-10-04T11:00:00Z', namespaceId: 'n1', objectId: 'aaaaaaaaaaaaaaaa11111111' } },
      { sum: { rowsWritten: 34_834_997, rowsRead: 1 }, dimensions: { datetimeHour: '2026-10-04T11:00:00Z', namespaceId: 'n1', objectId: 'bbbbbbbbbbbbbbbb22222222' } },
    ],
    workers: [],
  }] } } };
  const asked = [];
  const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: { service: async (reading, period, which) => {
      asked.push(`${which.id}:${which.period}`);
      if (which.id === 'cloudflare-usage-by-hour') return byHour;
      return period.id === 'today' ? today : month;
    } },
    matches, cycleDay: () => 26, now: () => NOON,
  });
  const list = await meter.read();
  const line = item(list, 'line:cloudflare-do-rows-written');
  assert.equal(line.inside, '/work/api/spend/inside/cloudflare-do-rows-written');
  assert.equal(item(list, 'line:cloudflare-plan').inside, undefined);
  assert.equal(await meter.inside('cloudflare-plan'), null);

  const inside = await meter.inside('cloudflare-do-rows-written');
  assert.ok(asked.includes('cloudflare-usage-by-hour:today'));
  assert.deepEqual(inside.view.group, [{ field: 'store' }]);
  assert.deepEqual(inside.view.fields.map(field => field.id), ['store', 'hour', 'amount', 'dollars']);
  assert.equal(inside.items.length, 3);
  const [first] = inside.items;
  assert.equal(first.store, '…11111111');
  assert.equal(first.hour, '2026-10-04 10:00 UTC');
  assert.equal(first.amount, 30_000_000);
  // The pieces here are all of today's rows written, so their shares add back up to the line's cost today.
  const shares = inside.items.reduce((sum, row) => sum + row.dollars, 0);
  assert.ok(Math.abs(shares - line.today_dollars) < 1e-9);
  // Without its largest pieces listed, a piece's share is still of the line's whole amount, never inflated.
  byHour.data.viewer.accounts[0].durable_objects_written.shift();
  const fewer = await meter.inside('cloudflare-do-rows-written');
  assert.ok(Math.abs(fewer.items[0].dollars / line.today_dollars - 10_000_000 / 74_834_997) < 1e-9);
  assert.ok(Math.abs(first.dollars / line.today_dollars - 30_000_000 / 74_834_997) < 1e-9);

  const unread = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:', readers: { service: async reading => ({ state: 'not-connected', connection: reading.connection }) }, matches, now: () => NOON });
  const nothing = await unread.inside('cloudflare-do-rows-written');
  assert.deepEqual(nothing.items, []);
  assert.equal(nothing.view.empty.title, data.words.inside_unread);
});

test('a budget over one line counts that line alone, and every starting rule uses an operator its fact offers', async () => {
  // 2026-10-07: the model-work day row asked `is any of` of the `line` fact, which is text; the engine offers
  // that operator for choices only, so the rule matched every line and $10 of store and Fly costs stopped embeddings.
  const quiet = usage({ rowsWritten: 74_834_997, rowsRead: 77_484_063_156, requests: 1_647_228, neurons: 20_000 });
  const meter = spendMeter({ service_label: 'Service group', preference_prefix: 'test-inside:',
    readers: { service: async reading => (reading.connection === 'fly' ? { state: 'not-connected', connection: 'fly' } : quiet),
      'model-calls': async () => ({ amount: 0 }), 'store-work': async () => ({ amount: 0 }), 'own-api': async () => ({ rows: [] }) },
    matches, cycleDay: () => 26, service: () => true, now: () => NOON,
  });
  const answer = await meter.read();
  const line = item(answer, 'line:cloudflare-workers-ai').today_dollars;
  const row = answer.budgets.find(budget => budget.id === 'service-model-day');
  assert.equal(row.used_dollars, line);
  assert.equal(row.state, 'ok');
  assert.equal(answer.stops.some(stop => stop.budget === 'service-model-day'), false);

  const offered = new Map(operators.operators.map(op => [op.id, op.applies_to]));
  const kinds = facts => new Map(facts.map(fact => [fact.id, fact.kind]));
  const walk = (tree, facts, where) => {
    for (const rule of tree?.rules ?? []) {
      if (rule.kind === 'group') { walk(rule, facts, where); continue; }
      const kind = facts.get(rule.field);
      assert.ok(kind, `${where}: ${rule.field} is a fact`);
      assert.ok((offered.get(rule.operator) ?? []).includes(kind), `${where}: ${rule.operator} is offered for ${kind} (${rule.field})`);
    }
  };
  for (const budget of data.budgets) {
    walk(budget.when, kinds(data.line_facts), `${budget.id} when`);
    walk(budget.stop, kinds(data.work_facts), `${budget.id} stop`);
  }
});



test('the caller names the service budget group and the preference prefix; a missing one is refused, never shared by this tool', async () => {
  const base = { readers: {}, matches, service: () => true, now: () => NOON };
  assert.throws(() => spendMeter({ ...base, preference_prefix: 'p:' }), SpendMeterError);
  assert.throws(() => spendMeter({ ...base, service_label: 'Group' }), SpendMeterError);
  assert.throws(() => spendMeter({ ...base, service_label: '  ', preference_prefix: 'p:' }), SpendMeterError);
  assert.throws(() => spendMeter({ ...base, service_label: 'Group', preference_prefix: '' }), SpendMeterError);
  const answer = await spendMeter({ ...base, service_label: 'Caller group', preference_prefix: 'caller-inside:' }).read();
  const budgetRows = answer.items.filter(item => item.kind === 'budget' && item.group !== 'Yours');
  assert.ok(budgetRows.length > 0, 'the shared DATA has service budgets to label');
  assert.ok(budgetRows.every(item => item.group === 'Caller group'));
});
