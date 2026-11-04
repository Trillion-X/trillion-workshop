#!/usr/bin/env node
// tools/keep-lists-of-rows/prove-seven-views.mjs
//
// Purpose: the visual database proved on a real computer, on an account this proof makes and deletes. It signs up with a
// simulated passkey at the computer the caller names, signs in to that account, then: makes a list, adds a field, edits a
// cell, reorders rows, saves a view, and switches the saved view through grid, board, timeline, schedule, form, node graph
// and metric. After each step it reads the step back twice, from the page and from the list's own records (the same
// door reads the web shell's list road makes: trillion-apps web/src/workspace/list-records.ts over records-door.ts),
// checks both, keeps a screenshot, and prints one line. It stops at the first readback that fails and exits 1.
//
// Run: node tools/keep-lists-of-rows/prove-seven-views.mjs --origin <https://computer> --shots <dir>
//      (or TRILLION_PROOF_ORIGIN=<https://computer>; no origin is written here).
//
// Non-negotiable invariants:
// - Every request goes to the account this proof made (`<origin>/a/<address>`), with that account's own session.
// - The account is registered for deletion before the sign-up press, and test-helpers/passkey-account.mjs deletes it
//   when the browser closes (its close reports, and this exits non-zero, when it could not).
// - Words, paths, record types and selectors are DATA (prove-seven-views.json); a line never prints a credential.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyBetween } from './do-work/fractional-order.ts';

export const data = JSON.parse(readFileSync(new URL('./prove-seven-views.json', import.meta.url), 'utf8'));

/** The list road's records over the made account's own session (`request` is a Playwright APIRequestContext). */
export function recordsOver(request, base, words = data.records) {
  const headers = { origin: new URL(base).origin };
  const door = async (path, input) => {
    const reply = await request.get(`${base}${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
    if (!reply.ok()) throw new Error(`${path} answered HTTP ${reply.status()}`);
    return reply.json();
  };
  return {
    write: async records => {
      const reply = await request.post(`${base}${words.write}`, { data: { records }, headers });
      if (!reply.ok()) throw new Error(`${words.write} answered HTTP ${reply.status()}`);
      return reply.json();
    },
    read: async (id, type) => (await door(words.read, { id, type })).value ?? null,
    list: async input => ((await door(words.list, { ...input, limit: 999 })).records ?? []).filter(record => record.value !== null),
  };
}

const listRecordId = list => `list:${list.id}`;
const rowType = list => `record:${list.row_type}`;
const rowId = (list, id) => `${rowType(list)}:${id}`;
const viewId = (list, id) => `${data.records.view_type}:${list.id}:${id}`;

/** The list's rows as its records hold them, in their order key's order (the key fractional-order.ts gives). */
const rowsOf = async ctx => (await ctx.records.list({ type: rowType(ctx.list), prefix: `${rowType(ctx.list)}:` }))
  .map(record => ({ id: record.id.slice(rowType(ctx.list).length + 1), ...record.value }))
  .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));

const listAddress = (ctx, view) => `${ctx.base}${data.list_screen.address.replace('{list}', encodeURIComponent(ctx.list.id))}${view ? `?${data.list_screen.view_query}=${encodeURIComponent(view)}` : ''}`;
const shown = async (page, text) => page.getByText(text, { exact: false }).first().isVisible({ timeout: data.wait_ms }).catch(() => false);
const openList = async (ctx, view) => { await ctx.page.goto(listAddress(ctx, view), { waitUntil: 'domcontentloaded' }); };
const waitShown = async (page, selector) => page.locator(selector).first().waitFor({ state: 'visible', timeout: data.wait_ms }).then(() => true, () => false);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const saveViewAs = async (ctx, as) => {
  const view = { id: 'proof', label: 'Proof view', search: '', sort: [{ field: 'order', direction: 'asc' }], display: { as } };
  await ctx.records.write([{ id: viewId(ctx.list, 'proof'), type: data.records.view_type, value: { list_id: ctx.list.id, view, order: 'V' } }]);
};
const viewRead = async ctx => (await ctx.records.read(viewId(ctx.list, 'proof'), data.records.view_type))?.view ?? null;

/** One step per thing proved: what it does, what the page shows after, what the records hold after, and whether both
 *  are what it did. */
export const steps = [
  {
    name: 'create a list',
    act: async ctx => {
      const id = `list-proof${ctx.stamp}`;
      ctx.list = { id, label: 'Proof list', row_type: id, title_field: 'name', fields: [{ id: 'name', label: 'Name', kind: 'text' }] };
      const [a, b, c] = [keyBetween(null, null)].flatMap(first => { const second = keyBetween(first, null); return [first, second, keyBetween(second, null)]; });
      await ctx.records.write([
        { id: listRecordId(ctx.list), type: data.records.list_type, value: { label: ctx.list.label, row_type: id, title_field: 'name', fields: ctx.list.fields } },
        ...[['alpha', 'Alpha', a], ['beta', 'Beta', b], ['gamma', 'Gamma', c]].map(([row, name, order]) => ({ id: rowId(ctx.list, row), type: rowType(ctx.list), value: { name, order } })),
      ]);
      await openList(ctx);
    },
    page: async ctx => ({ label: await shown(ctx.page, 'Proof list'), alpha: await shown(ctx.page, 'Alpha') }),
    records: async ctx => ({ label: (await ctx.records.read(listRecordId(ctx.list), data.records.list_type))?.label ?? null, rows: (await rowsOf(ctx)).map(row => row.name) }),
    passes: (page, records) => page.label && page.alpha && records.label === 'Proof list' && sameJson(records.rows, ['Alpha', 'Beta', 'Gamma']),
  },
  {
    name: 'add a field',
    act: async ctx => {
      const kept = await ctx.records.read(listRecordId(ctx.list), data.records.list_type);
      const fields = [...(kept?.fields ?? []), { id: 'due', label: 'Due', kind: 'date' }];
      await ctx.records.write([{ id: listRecordId(ctx.list), type: data.records.list_type, value: { ...kept, fields } }]);
      await openList(ctx);
    },
    page: async ctx => ({ due: await shown(ctx.page, 'Due') }),
    records: async ctx => ({ fields: ((await ctx.records.read(listRecordId(ctx.list), data.records.list_type))?.fields ?? []).map(field => field.id) }),
    passes: (page, records) => page.due && sameJson(records.fields, ['name', 'due']),
  },
  {
    name: 'edit a cell',
    act: async ctx => {
      const kept = await ctx.records.read(rowId(ctx.list, 'alpha'), rowType(ctx.list));
      await ctx.records.write([{ id: rowId(ctx.list, 'alpha'), type: rowType(ctx.list), value: { ...kept, name: 'Alpha edited', due: '2026-11-10' } }]);
      await openList(ctx);
    },
    page: async ctx => ({ edited: await shown(ctx.page, 'Alpha edited') }),
    records: async ctx => { const row = await ctx.records.read(rowId(ctx.list, 'alpha'), rowType(ctx.list)); return { name: row?.name ?? null, due: row?.due ?? null }; },
    passes: (page, records) => page.edited && records.name === 'Alpha edited' && records.due === '2026-11-10',
  },
  {
    name: 'reorder rows',
    act: async ctx => {
      const first = (await rowsOf(ctx))[0];
      const kept = await ctx.records.read(rowId(ctx.list, 'gamma'), rowType(ctx.list));
      await ctx.records.write([{ id: rowId(ctx.list, 'gamma'), type: rowType(ctx.list), value: { ...kept, order: keyBetween(null, first.order) } }]);
      await saveViewAs(ctx, 'table');
      await openList(ctx, 'proof');
    },
    page: async ctx => {
      const tops = [];
      for (const name of ['Gamma', 'Alpha edited', 'Beta']) tops.push((await ctx.page.getByText(name, { exact: true }).first().boundingBox().catch(() => null))?.y ?? null);
      return { tops, ordered: tops.every(top => top !== null) && tops[0] < tops[1] && tops[1] < tops[2] };
    },
    records: async ctx => ({ rows: (await rowsOf(ctx)).map(row => row.name) }),
    passes: (page, records) => page.ordered && sameJson(records.rows, ['Gamma', 'Alpha edited', 'Beta']),
  },
  {
    name: 'save a view',
    act: async ctx => { await saveViewAs(ctx, 'table'); await openList(ctx, 'proof'); },
    page: async ctx => ({ label: await shown(ctx.page, 'Proof view') }),
    records: async ctx => { const view = await viewRead(ctx); return { id: view?.id ?? null, as: view?.display?.as ?? null }; },
    passes: (page, records) => page.label && records.id === 'proof' && records.as === 'table',
  },
  ...data.views.map(view => ({
    name: `switch to ${view.step}`,
    act: async ctx => { await saveViewAs(ctx, view.as); await openList(ctx, view.as); },
    page: async ctx => ({ shows: await waitShown(ctx.page, view.shows) }),
    records: async ctx => ({ as: (await viewRead(ctx))?.display?.as ?? null }),
    passes: (page, records) => page.shows && records.as === view.as,
  })),
];

const slug = words => words.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const said = error => String(error?.message ?? error).split(/\r?\n/, 1)[0].replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]');

/** Runs `stepList` in order on `ctx` ({ page, base, records, stamp }), one line each through `print`, a screenshot
 *  each in `shots`; answers 0 when every step passed, 1 at the first that did not (the rest are not run). */
export async function runSteps(ctx, { shots, print = line => process.stdout.write(`${line}\n`), stepList = steps } = {}) {
  for (const [index, step] of stepList.entries()) {
    const number = String(index + 1).padStart(2, '0');
    let page = null, records = null, ok = false, failed = null;
    try {
      await step.act(ctx);
      page = await step.page(ctx);
      records = await step.records(ctx);
      ok = Boolean(step.passes(page, records, ctx));
    } catch (error) { failed = said(error); }
    if (shots) await ctx.page.screenshot({ path: join(shots, `${number}-${slug(step.name)}.png`), fullPage: true }).catch(() => {});
    print(`${ok ? 'pass' : 'fail'} ${number} ${step.name}: page=${JSON.stringify(page)} records=${JSON.stringify(records)}${failed ? ` error=${JSON.stringify(failed)}` : ''}`);
    if (!ok) return 1;
  }
  return 0;
}

/** Signs up at the computer `origin` with the page's passkey, signs in to the new account, and answers its base
 *  (`<origin>/a/<address>`). The account is registered for deletion before the sign-up press; `made` gets its base and
 *  user id as soon as they are known. */
export async function signUpAtComputer(page, origin, { registerMadeAccount }) {
  const proofName = `trillion-proof+${Date.now()}@example.test`;
  const made = registerMadeAccount(page, origin, { proofName });
  await page.goto(`${origin}${data.sign_up.page}`);
  await page.locator(data.sign_up.name_input).fill(proofName);
  const finished = page.waitForResponse(reply => new URL(reply.url()).pathname === data.sign_up.finish && reply.request().method() === 'POST', { timeout: data.wait_ms });
  await page.locator(data.sign_up.button).click();
  const reply = await finished;
  const address = reply.ok() ? (await reply.json().catch(() => ({}))).address : null;
  if (typeof address !== 'string' || !/^[A-Za-z0-9_-]+$/.test(address)) throw new Error(`sign-up answered no address (HTTP ${reply.status()})`);
  const base = `${origin}/a/${address}`;
  made.origin = base;
  const signInHere = async () => {
    await page.goto(`${base}${data.sign_in.page}`);
    await page.locator(data.sign_in.button).first().click();
    await page.waitForURL(url => !url.pathname.endsWith(data.sign_in.page), { timeout: data.wait_ms });
    const viewer = await page.context().request.get(`${base}/work/api/viewer`, { timeout: 10000 });
    return viewer.ok() ? (await viewer.json().catch(() => ({}))).user_id ?? null : null;
  };
  made.signInAgain = signInHere;
  made.userId = await signInHere();
  if (!made.userId) throw new Error('signed in, but the account\'s viewer named no user');
  return { base, made };
}

const argument = (args, name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

export async function main(args = process.argv.slice(2), env = process.env) {
  const origin = argument(args, '--origin') ?? env.TRILLION_PROOF_ORIGIN;
  const shots = argument(args, '--shots');
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin) || !shots) {
    process.stderr.write('Usage: prove-seven-views.mjs --origin <https://computer> --shots <dir> (or TRILLION_PROOF_ORIGIN)\n');
    return 2;
  }
  mkdirSync(shots, { recursive: true });
  const helper = await import('../../test-helpers/passkey-account.mjs');
  const { browser, page } = await helper.browserWithPasskeyDevice();
  let code = 1;
  try {
    const { base } = await signUpAtComputer(page, origin, helper);
    process.stdout.write(`pass 00 sign up with a passkey: records={"account":"made"}\n`);
    code = await runSteps({ page, base, records: recordsOver(page.context().request, base), stamp: Date.now().toString(36) }, { shots });
  } catch (error) {
    process.stdout.write(`fail 00 sign up with a passkey: error=${JSON.stringify(said(error))}\n`);
  } finally {
    try { await browser.close(); process.stdout.write('pass -- account deleted at close\n'); }
    catch (error) { process.stdout.write(`fail -- account deleted at close: ${said(error)}\n`); code = 1; }
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
