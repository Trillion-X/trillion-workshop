import { pageFile, rewrite } from 'trillion-workshop/tools/copy-a-site/do-work/copy-addresses.mjs';

const MAX_PAGES = 100_000; // The indexed app import is the shared page and file bound.
const MAX_ROUTE_RETRIES = 2;
const pathOf = (value, origin) => {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.search || url.hash) throw new Error('A copied page has an invalid address.');
  return url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
};
const checkedBatch = (batch, origin) => {
  if (batch?.result?.origin !== origin || !Array.isArray(batch.result.pages) ||
      !Array.isArray(batch.result.remaining_paths) || !batch.site?.files ||
      typeof batch.site.files !== 'object' || Array.isArray(batch.site.files)) {
    throw new Error('This saved copy cannot continue. Start a fresh copy with the current site tool.');
  }
  return batch;
};
const checkedBatchMetadata = (batch, origin) => {
  if (batch?.result?.origin !== origin || !Array.isArray(batch.result.pages) ||
      !Array.isArray(batch.result.remaining_paths) || (!batch.site?.files && typeof batch.identity !== 'string')) {
    throw new Error('This saved copy cannot continue. Start a fresh copy with the current site tool.');
  }
  return batch;
};
function pageFailures(batches, origin) {
  const failures = new Map();
  for (const batch of batches) for (const row of batch.result.all_skipped ?? batch.result.skipped ?? []) {
    if (row?.kind !== 'page' || typeof row.address !== 'string' || typeof row.reason !== 'string' ||
        /not copied because the \d+-page limit was reached/.test(row.reason)) continue;
    try {
      const url = new URL(row.address);
      if (url.origin !== origin || url.search) continue;
      const path = pathOf(url.href, origin);
      const list = failures.get(path) ?? [];
      list.push(row);
      failures.set(path, list);
    } catch { /* Invalid source addresses are not routes to retry. */ }
  }
  return failures;
}

const failedPagePaths = (batches, origin) => {
  const failed = new Set([...pageFailures(batches, origin)]
    .filter(([, rows]) => rows.some(row => row.retryable !== true) || rows.length > MAX_ROUTE_RETRIES)
    .map(([path]) => path));
  // Older saved runs did not type failures; preserve their terminal behavior when resuming them.
  for (const batch of batches) for (const row of batch.result.all_skipped ?? batch.result.skipped ?? []) {
    if (row?.kind || typeof row?.address !== 'string' || typeof row?.reason !== 'string' ||
        /not copied because the \d+-page limit was reached/.test(row.reason)) continue;
    try {
      const url = new URL(row.address);
      if (url.origin === origin && !url.search) failed.add(pathOf(url.href, origin));
    } catch { /* Invalid source addresses are not routes. */ }
  }
  return failed;
};

const retryablePagePaths = (batches, origin) => [...pageFailures(batches, origin)]
  .filter(([, rows]) => rows.length <= MAX_ROUTE_RETRIES && rows.every(row => row.retryable === true))
  .map(([path]) => path);

export function copiedSiteContinuation(batches, sourceUrl, maxPages = 60) {
  const origin = new URL(sourceUrl).origin;
  if (!Number.isInteger(maxPages) || maxPages < 2 || maxPages > MAX_PAGES) throw new Error('Copy at least two and at most 100,000 pages per run.');
  if (!batches.length) return { url: sourceUrl, max_pages: maxPages };
  for (const batch of batches) checkedBatchMetadata(batch, origin);
  const copied = new Set(batches.flatMap(batch => batch.result.pages.map(path => pathOf(path, origin))));
  const failed = failedPagePaths(batches, origin);
  const retry = retryablePagePaths(batches, origin).filter(path => !copied.has(path));
  const waiting = [...new Set(batches.flatMap(batch => (batch.result.remaining_paths ?? []).map(path => pathOf(path, origin))))]
    .filter(path => !copied.has(path) && !failed.has(path));
  const pending = [...new Set([...waiting, ...retry])].filter(path => !failed.has(path));
  if ((!pending.length && !waiting.length) || copied.size >= MAX_PAGES) return null;
  return { url: sourceUrl, max_pages: Math.min(maxPages, 1 + MAX_PAGES - copied.size),
    paths: pending.slice(0, MAX_PAGES), exclude_paths: [...copied].filter(path => path !== '/').slice(0, MAX_PAGES) };
}

export function joinCopiedSiteBatches(batches, sourceUrl, { remainingReason = 'not copied because this site has reached its page limit; its link stays on the original site' } = {}) {
  if (!batches.length) throw new Error('The site has no completed copy.');
  const origin = new URL(sourceUrl).origin;
  const files = {};
  const copied = new Set();
  const discovered = new Set();
  const addressToFile = new Map();
  const findings = [];
  const routeFailures = pageFailures(batches, origin);
  for (const { result, site } of batches) {
    checkedBatch({ result, site }, origin);
    for (const path of result.pages ?? []) {
      const route = pathOf(path, origin);
      copied.add(route);
      if (!Object.hasOwn(site.files, pageFile(route))) throw new Error(`${route} has no copied page.`);
      addressToFile.set(route, route);
    }
    for (const path of result.remaining_paths ?? []) discovered.add(pathOf(path, origin));
    for (const asset of result.asset_paths ?? []) {
      const url = new URL(asset.address);
      if (url.origin !== origin || !Object.hasOwn(site.files, asset.file)) throw new Error('A copied file has an invalid source address.');
      addressToFile.set(url.pathname + url.search, `/${asset.file}`);
    }
    for (const [path, content] of Object.entries(site.files)) {
      if (Object.hasOwn(files, path) && files[path] !== content) {
        throw new Error(`${path} changed while the site was being copied. Start a fresh copy to keep one consistent version.`);
      }
      files[path] = content;
    }
    for (const row of result.all_skipped ?? result.skipped ?? []) {
      if (/not copied because the \d+-page limit was reached/.test(row.reason)) continue;
      if (row.kind === 'page') {
        try {
          const path = pathOf(row.address, origin);
          if (copied.has(path)) continue;
          const attempts = routeFailures.get(path) ?? [];
          if (row.retryable === true) {
            if (attempts.length <= MAX_ROUTE_RETRIES || attempts.at(-1) !== row) continue;
            findings.push({ ...row, reason: `the page still failed after ${MAX_ROUTE_RETRIES} retries: ${row.reason}` });
            continue;
          }
        } catch { /* Keep malformed findings visible below. */ }
      }
      findings.push(row);
    }
  }
  const failed = failedPagePaths(batches, origin);
  const missing = [...discovered].filter(path => !copied.has(path) && !failed.has(path));
  for (const path of missing) findings.push({ address: origin + path, reason: remainingReason });
  const fileOf = rest => {
    const url = new URL(rest, origin);
    const key = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
    return addressToFile.get(url.pathname + url.search) ?? (url.search ? null : addressToFile.get(key)) ?? null;
  };
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.html') || path.endsWith('.css')) files[path] = rewrite(content, origin, fileOf);
  }
  const unique = [...new Map(findings.map(row => [`${row.address}\0${row.reason}`, row])).values()];
  const skipped = unique.length <= 100 ? unique : [...unique.slice(0, 99), { address: origin,
    reason: `${unique.length - 99} more pages or files were not copied; their links stay on the original site` }];
  return { site: { files }, skipped, pages: [...copied], remaining_paths: missing,
    complete: missing.length === 0 && skipped.length === 0 };
}

const checkpointKey = sourceUrl => `trillion:site-copy:${new URL(sourceUrl).href}`;

function copyRunResult(run) {
  if (run?.output?.result) return run.output.result;
  const line = run?.lines?.find(item => item.label === 'Result')?.text;
  try { return JSON.parse(line); } catch { return null; }
}

function copyRunIdentity(run) {
  return run?.output?.files?.site?.identity ?? run?.files?.find(file =>
    file.media_type === 'application/json' || file.name?.endsWith('.json'))?.identity;
}

/** The cursor lives across browser restarts; the completed page batches remain account-owned Namespace files. */
export const localHints = {
  getItem: key => { try { return globalThis.localStorage.getItem(key); } catch { return null; } },
  setItem: (key, value) => { try { globalThis.localStorage.setItem(key, value); } catch { /* Checked by keep before starting a task. */ } },
  removeItem: key => { try { globalThis.localStorage.removeItem(key); } catch { /* Nothing was kept to remove. */ } },
};

/** Resume a Workshop copy after a page reload or an interrupted response without starting a duplicate paid run. */
export async function resumeCopiedSite({ sourceUrl, storage, start, poll, readFile, onProgress = () => {},
  wait = ms => new Promise(done => setTimeout(done, ms)), makeKey = () => crypto.randomUUID(), maxPages = 5, returnBatches = false }) {
  const key = checkpointKey(sourceUrl);
  let saved;
  try { saved = JSON.parse(storage.getItem(key)); } catch { /* A broken local hint is never a source of truth. */ }
  if (saved?.source_url !== sourceUrl || !Array.isArray(saved.batches)) saved = { source_url: sourceUrl, batches: [], active: null };
  const keep = () => {
    saved.updated_at = Date.now();
    const serialized = JSON.stringify(saved);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('The copy could not save its resume point in this browser. No new batch was started.');
  };
  const batches = saved.batches.map(row => checkedBatchMetadata({ ...row, identity: row.identity }, new URL(sourceUrl).origin));
  for (let runs = 0; runs < 8; runs++) {
    const input = copiedSiteContinuation(batches, sourceUrl, maxPages);
    if (!input && !saved.active) {
      if (returnBatches) return { batches: saved.batches, pages: batches.flatMap(item => item.result.pages),
        skipped: batches.flatMap(item => item.result.all_skipped ?? item.result.skipped ?? []), complete: true };
      const hydrated = [];
      for (const row of saved.batches) hydrated.push({ result: row.result, site: await readFile(row.identity) });
      const joined = joinCopiedSiteBatches(hydrated, sourceUrl);
      return { ...joined, site_file_identity: batches.length === 1 ? saved.batches[0].identity : undefined };
    }
    if (!saved.active) {
      saved.active = { input, request_key: `copy-site:${makeKey()}` };
      keep();
    }
    let run;
    if (saved.active.task_id) run = await poll(saved.active.task_id);
    else run = await start(saved.active.input, saved.active.request_key);
    if (run.task_id && !saved.active.task_id) { saved.active.task_id = run.task_id; keep(); }
    const startedAt = Date.now();
    while (!copyRunIdentity(run) && !run.error && run.state !== 'failed') {
      if (!saved.active.task_id) throw new Error('The site copy did not return a Workshop task. Try again with the same address.');
      if (Date.now() - startedAt >= 15 * 60 * 1000) throw new Error('The site copy is still running in Workshop. Try this address again to resume it.');
      await wait(3000);
      run = await poll(saved.active.task_id);
    }
    if (run.error || run.state === 'failed') {
      saved.active = null;
      keep();
      throw new Error(run.error || 'The site copy failed. Check its Workshop run.');
    }
    const identity = copyRunIdentity(run);
    const result = copyRunResult(run);
    if (!identity || !result) throw new Error('The site copy finished without its saved pages or result.');
    checkedBatchMetadata({ identity, result }, new URL(sourceUrl).origin);
    const knownPages = new Set(batches.flatMap(batch => batch.result.pages.map(path => pathOf(path, new URL(sourceUrl).origin))));
    const knownRemaining = new Set(batches.flatMap(batch => batch.result.remaining_paths.map(path => pathOf(path, new URL(sourceUrl).origin))));
    const copiedNow = new Set(result.pages.map(path => pathOf(path, new URL(sourceUrl).origin)));
    const knownAssets = new Map(batches.flatMap(batch => batch.result.asset_paths ?? []).map(asset => [asset.address, asset]));
    const assetUpdates = new Map();
    for (const asset of result.asset_paths ?? []) {
      if (JSON.stringify(knownAssets.get(asset.address)) !== JSON.stringify(asset)) assetUpdates.set(asset.address, asset);
    }
    const compactResult = { ...result,
      pages: result.pages.filter(path => !knownPages.has(pathOf(path, new URL(sourceUrl).origin))),
      remaining_paths: result.remaining_paths.filter(path => {
        const route = pathOf(path, new URL(sourceUrl).origin);
        return !knownRemaining.has(route) && !knownPages.has(route) && !copiedNow.has(route);
      }),
      asset_paths: [...assetUpdates.values()] };
    const completedBatch = { identity, result: compactResult };
    batches.push(completedBatch);
    saved.batches.push(completedBatch);
    saved.active = null;
    keep();
    onProgress(`${new Set(batches.flatMap(item => item.result.pages)).size} pages copied.`);
  }
  if (returnBatches) return { batches: saved.batches, pages: batches.flatMap(item => item.result.pages),
    skipped: batches.flatMap(item => item.result.all_skipped ?? item.result.skipped ?? []), complete: false, paused: true };
  const hydrated = [];
  for (const row of saved.batches) hydrated.push({ result: row.result, site: await readFile(row.identity) });
  const joined = joinCopiedSiteBatches(hydrated, sourceUrl, {
    remainingReason: 'copy paused after eight runs; its link stays on the original site until the copy resumes',
  });
  return { ...joined, complete: false, paused: true };
}

export function clearCopiedSiteCheckpoint(storage, sourceUrl) {
  storage.removeItem(checkpointKey(sourceUrl));
}
