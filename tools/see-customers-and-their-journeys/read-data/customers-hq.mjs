// Source-first port; configuration is supplied by authenticated list rows.

export function createCustomersHQ(reports, { readJourneys, htmlPage }) {
// src/customers-hq.mjs
//
// PURPOSE
//   Trillion HQ's Customers screen: every report from every customer's AI and from the Tell us screen, grouped by what it
//   is and where it happened, then each customer's journey (last seen, the last 7 days counted by kind, whether they are
//   struggling, and their latest events). Customers who are struggling come first.
//     GET /work/customers      the screen, as a page
//     GET /work/api/customers  the same as JSON
//   Reports are read from the operator account's Notes from members list (src/hand-to-an-account.mjs `memberReports`);
//   journeys from every journeys-<n> shard (src/journey.mjs `readJourneys`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the operator account (OPERATOR_ACCOUNT_ID) reads either address; everyone else gets the same "Not found" as
//      an unknown address.
//   2. It shows only what was kept: a journey holds no free text unless that customer allowed it (src/hq-sharing.mjs),
//      and a report's quoted words are present only when the customer allowed them.
//   3. The words on the screen are the `screen` row of records/hq-reports.json.
//

const WORDS = reports.screen;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } });
const notFound = () => json({ error: 'Not found' }, 404);
const when = at => (Number.isFinite(Number(at)) && Number(at) > 0 ? new Date(Number(at)).toISOString().replace('T', ' ').slice(0, 16) : '');

/** Reports grouped by kind (in the order of records/hq-reports.json `kinds`), then by where they happened, newest first. */
function groupReports(rows) {
  const order = reports.kinds.map(kind => kind.label);
  const kinds = new Map();
  for (const row of rows) {
    const kind = String(row.kind ?? '') || 'other';
    if (!kinds.has(kind)) kinds.set(kind, new Map());
    const where = String(row.where ?? '') || 'Unknown';
    const group = kinds.get(kind);
    if (!group.has(where)) group.set(where, []);
    group.get(where).push({ id: row.id, at: row.sent_at ?? '', from: row.from ?? '', account: row.account ?? '', sent_by: row.sent_by ?? 'screen', harness: row.harness ?? '', note: row.note ?? '', their_words: row.their_words ?? '', screen: row.screen ?? '', work_ref: row.work_ref ?? '' });
  }
  return [...kinds.entries()]
    .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(([kind, wheres]) => ({
      kind,
      count: [...wheres.values()].reduce((sum, list) => sum + list.length, 0),
      wheres: [...wheres.entries()].map(([where, list]) => ({ where, count: list.length, reports: list })).sort((a, b) => b.count - a.count),
    }));
}

/** Everything the screen shows: { reports: grouped, customers: journeys with names }. */
/** `own` is the signed-in account's own store: only the operator account is answered (both callers check), so the
 *  reports it read are its own, never another account's store asked for them. */
async function customersAnswer(env, own, now = Date.now()) {
  const operator = own;
  const [rows, journeys] = await Promise.all([operator.memberReports({ limit: WORDS.reports_limit }), readJourneys(env, now)]);
  const names = new Map(await Promise.all(journeys.map(async journey => [journey.account, (await env.accountName(journey.account)) ?? String(journey.account).slice(0, 8)])));
  return {
    reports: groupReports(rows),
    report_count: rows.length,
    customers: journeys.map(journey => ({ ...journey, name: names.get(journey.account) })),
  };
}

const eventLine = event => `${when(event.at)}  ${event.surface}  ${event.kind}${event.label ? `  ${event.label}` : ''}`;

/** The screen as page sections. */
function customersPage(answer, origin) {
  const reportItems = answer.reports.flatMap(group => group.wheres.map(where => ({
    heading: `${group.kind}: ${where.where} (${where.count})`,
    body: where.reports.map(report => `${when(Date.parse(report.at) || report.at)} ${report.from || report.account} via ${report.sent_by}${report.harness ? ` ${report.harness}` : ''}: ${report.note}${report.their_words ? ` | their words: ${report.their_words}` : ''}`).join('\n'),
  })));
  const customerItems = answer.customers.map(customer => ({
    heading: `${customer.struggling ? 'Struggling: ' : ''}${customer.name} (last seen ${when(customer.last_seen)}, ${customer.recent} in 7 days)`,
    body: `${Object.entries(customer.by_kind ?? {}).map(([kind, count]) => `${kind} ${count}`).join(', ')}\n${(customer.timeline ?? []).map(eventLine).join('\n')}`,
  }));
  return htmlPage({
    title: WORDS.heading,
    meta_description: WORDS.lead,
    canonical_origin: origin,
    island: null,
    sections: [
      { heading: WORDS.heading, body: WORDS.lead },
      { heading: WORDS.reports_heading, ...(reportItems.length ? { items: reportItems } : { body: WORDS.empty_reports }) },
      { heading: WORDS.customers_heading, ...(customerItems.length ? { items: customerItems } : { body: WORDS.empty_customers }) },
    ],
  }, { 'x-trillion-privacy': 'customer-scope' });
}

/** GET /work/customers and GET /work/api/customers; null for every other address. */
async function answerCustomers(request, { env, userId, url, origin }) {
  const page = url.pathname === '/work/customers';
  if (!page && url.pathname !== '/work/api/customers') return null;
  if (request.method !== 'GET') return null;
  if (!(Boolean(env.operatorAccount) && userId === env.operatorAccount)) return notFound();
  const answer = await customersAnswer(env, env.own);
  return page ? customersPage(answer, origin) : json(answer);
}

return { groupReports, customersAnswer, customersPage, answerCustomers };
}
