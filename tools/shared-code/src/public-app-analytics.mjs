// Per-installation analytics for hosted public apps. Visitor identity comes
// from a random first-party cookie supplied by the host; only its BLAKE3 digest
// is stored, and no network metadata or submitted field values enter analytics.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedPublicAppDefinition } from '../../edit-a-site-visually/src/public-app-definition.mjs';
import { publicAppInstallation, setUpPublicAppRecords } from './public-app-records.mjs';

const INSTALLATION_ID = /^[a-f0-9]{32}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const VIEW_ID = /^[A-Za-z0-9_-]{16,200}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const now = () => new Date().toISOString();

export function setUpPublicAppAnalytics(sql) {
  setUpPublicAppRecords(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS public_app_page_views (
    installation_id TEXT NOT NULL,
    view_id TEXT NOT NULL,
    page_path TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, view_id)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS public_app_page_views_by_installation_date ON public_app_page_views (installation_id, viewed_at)');
  sql.exec(`CREATE TABLE IF NOT EXISTS public_app_submission_index (
    installation_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, record_id)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS public_app_submissions_by_installation_date ON public_app_submission_index (installation_id, received_at)');
}

/** Index only the identity and time of a canonical record, never its fields. */
export function indexPublicAppSubmission(sql, { installation_id: id, record_id: recordId, received_at: receivedAt }) {
  setUpPublicAppAnalytics(sql);
  if (!INSTALLATION_ID.test(id ?? '') || typeof recordId !== 'string' || !recordId.startsWith(`public-app:${id}:`)) throw new Error('This response identity is invalid.');
  if (typeof receivedAt !== 'string' || !Number.isFinite(Date.parse(receivedAt))) throw new Error('This response time is invalid.');
  sql.exec('INSERT INTO public_app_submission_index (installation_id, record_id, received_at) VALUES (?, ?, ?) ON CONFLICT (installation_id, record_id) DO NOTHING', id, recordId, receivedAt);
}

function checkedPagePath(value) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || /[?#\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('The page path is invalid.');
  }
  return value;
}

function checkedDate(value, label) {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(`The ${label} date is invalid.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`The ${label} date is invalid.`);
  return value;
}

function period({ from, to } = {}) {
  const end = to === undefined ? now().slice(0, 10) : checkedDate(to, 'end');
  const startDate = from === undefined
    ? new Date(new Date(`${end}T00:00:00.000Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10)
    : checkedDate(from, 'start');
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const endTime = new Date(`${end}T00:00:00.000Z`).getTime();
  if (startTime > endTime) throw new Error('The start date must be on or before the end date.');
  if (endTime - startTime > 365 * 86_400_000) throw new Error('Choose a date range of one year or less.');
  return { from: startDate, to: end };
}

function bounds(range) {
  return [`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`];
}

/** Record one HTML navigation. The host creates visitor_token and view_id. */
export function recordPublicAppPageView(sql, { installation_id: id, page_path: pagePath, visitor_token: token, view_id: viewId, viewed_at: viewedAt = now() }) {
  setUpPublicAppAnalytics(sql);
  if (!INSTALLATION_ID.test(id ?? '')) throw new Error('The installation id is invalid.');
  const installation = publicAppInstallation(sql, id);
  if (!installation || installation.status !== 'active') throw new Error('This app is not accepting visits.');
  const path = checkedPagePath(pagePath);
  if (!OPAQUE_TOKEN.test(token ?? '')) throw new Error('The visitor token is invalid.');
  if (!VIEW_ID.test(viewId ?? '')) throw new Error('The page view id is invalid.');
  const timestamp = new Date(viewedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('The page view time is invalid.');
  const visitorHash = bytesToHex(blake3(new TextEncoder().encode(token)));
  const stored = timestamp.toISOString();
  const earlier = sql.exec('SELECT page_path, visitor_hash, viewed_at FROM public_app_page_views WHERE installation_id = ? AND view_id = ?', id, viewId).toArray()[0];
  if (earlier) {
    if (earlier.page_path !== path || earlier.visitor_hash !== visitorHash) throw new Error('This page view id was already used for a different visit.');
    return { installation_id: id, view_id: viewId, recorded: false };
  }
  sql.exec(`INSERT INTO public_app_page_views (installation_id, view_id, page_path, visitor_hash, viewed_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (installation_id, view_id) DO NOTHING`, id, viewId, path, visitorHash, stored);
  const row = sql.exec('SELECT page_path, visitor_hash, viewed_at FROM public_app_page_views WHERE installation_id = ? AND view_id = ?', id, viewId).toArray()[0];
  if (row.page_path !== path || row.visitor_hash !== visitorHash || row.viewed_at !== stored) throw new Error('This page view id was already used for a different visit.');
  return { installation_id: id, view_id: viewId, recorded: true };
}

/** Compare-and-swap the action schema that validates writes to one installation. */
export function updatePublicAppInstallationDefinition(sql, { installation_id: id, expected_definition: expectedDefinition, definition }) {
  setUpPublicAppAnalytics(sql);
  const installation = publicAppInstallation(sql, id);
  if (!installation) throw new Error('That app installation was not found.');
  const expected = checkedPublicAppDefinition(expectedDefinition);
  const next = checkedPublicAppDefinition(definition);
  // A publish whose answer was lost (the request was cut off after this write) is sent again with the same pair: the
  // store already holds `next`, so the retry is that same write, not a conflict, and the caller can finish its own part.
  if (JSON.stringify(installation.definition) === JSON.stringify(next)) return installation;
  if (JSON.stringify(installation.definition) !== JSON.stringify(expected)) throw new Error('This app changed since you opened it. Reload it and try again.');
  if (JSON.stringify(expected) !== JSON.stringify(next)) {
    sql.exec('UPDATE public_app_installations SET definition = ? WHERE id = ? AND definition = ?', JSON.stringify(next), id, JSON.stringify(expected));
    const current = publicAppInstallation(sql, id);
    if (JSON.stringify(current.definition) !== JSON.stringify(next)) throw new Error('This app changed while it was being saved. Reload it and try again.');
  }
  return publicAppInstallation(sql, id);
}

/** Count page loads, distinct visitors and persisted successful actions for one installation. */
export function publicAppAnalytics(sql, id, options = {}) {
  setUpPublicAppAnalytics(sql);
  if (!INSTALLATION_ID.test(id ?? '')) throw new Error('The installation id is invalid.');
  if (!publicAppInstallation(sql, id)) throw new Error('That app installation was not found.');
  const range = period(options);
  const [start, end] = bounds(range);
  const pageViews = sql.exec(`SELECT page_path, viewed_at, visitor_hash FROM public_app_page_views
    WHERE installation_id = ? AND viewed_at >= ? AND viewed_at <= ? ORDER BY viewed_at`, id, start, end).toArray();
  // Canonical responses live in the account's EEAF records or Space items.
  // The caller reads those from its authorized context and supplies timestamps.
  const indexed = sql.exec('SELECT record_id, received_at FROM public_app_submission_index WHERE installation_id = ? AND received_at >= ? AND received_at <= ?', id, start, end).toArray();
  const byRecord = new Map(indexed.map(row => [row.record_id, row.received_at]));
  for (const row of options.submissions ?? []) {
    if (typeof row?.record_id === 'string' && typeof row.received_at === 'string' && row.received_at >= start && row.received_at <= end) byRecord.set(row.record_id, row.received_at);
  }
  const submissions = [...byRecord.values()];
  const byPage = new Map();
  const byDay = new Map();
  const visitors = new Set();
  for (const row of pageViews) {
    const day = row.viewed_at.slice(0, 10);
    visitors.add(row.visitor_hash);
    if (!byPage.has(row.page_path)) byPage.set(row.page_path, { path: row.page_path, page_views: 0, visitorSet: new Set() });
    const page = byPage.get(row.page_path);
    page.page_views += 1;
    page.visitorSet.add(row.visitor_hash);
    if (!byDay.has(day)) byDay.set(day, { date: day, page_views: 0, visitorSet: new Set(), submissions: 0 });
    const daily = byDay.get(day);
    daily.page_views += 1;
    daily.visitorSet.add(row.visitor_hash);
  }
  for (const at of submissions) {
    const day = at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { date: day, page_views: 0, visitorSet: new Set(), submissions: 0 });
    byDay.get(day).submissions += 1;
  }
  const pages = [...byPage.values()].map(({ visitorSet, ...page }) => ({ ...page, unique_visitors: visitorSet.size })).sort((a, b) => a.path.localeCompare(b.path));
  const days = [...byDay.values()].map(({ visitorSet, ...day }) => ({ ...day, unique_visitors: visitorSet.size })).sort((a, b) => a.date.localeCompare(b.date));
  return { installation_id: id, from: range.from, to: range.to, page_views: pageViews.length, unique_visitors: visitors.size, submissions: submissions.length, pages, days };
}
