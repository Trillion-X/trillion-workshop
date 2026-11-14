import { blake3 } from '@noble/hashes/blake3.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;
const here = path.dirname(fileURLToPath(import.meta.url));

// A browser lives wherever the person who installed it put it, so DATA says
// where to look and this reads the actual location at run time. Writing the
// absolute path into DATA resolves on exactly one computer and silently
// resolves nowhere else, including inside a container built from the same
// checkout.
//
// `choose: "highest-sorting-child"` exists because installers that version
// their directories (chromium-1124, chromium-1187) otherwise force a DATA edit
// on every update, which is a version number standing in for "the current one".
export async function resolveProviderExecutable(provider) {
  if (typeof provider.executable === 'string' && provider.executable.length > 0) {
    return provider.executable;
  }
  const under = provider.executable_under_home;
  if (!under || typeof under !== 'object') {
    throw new BrowserPoolError(
      'invalid_provider',
      `provider "${provider.id}" names no executable and no executable_under_home`,
    );
  }
  const home = os.homedir();
  const entryPaths = under.entry_relative_paths ?? [under.entry_relative_path];
  if (!under.directory) return path.join(home, entryPaths[0]);

  const searchRoot = path.join(home, under.directory);
  let children;
  try {
    children = await readdir(searchRoot);
  } catch {
    throw new BrowserPoolError(
      'provider_not_installed',
      `provider "${provider.id}" looked in ${under.directory} and found nothing there`,
    );
  }
  // Newest first, and the newest one that actually has a binary wins. An
  // installer is free to change its layout between versions, and this machine
  // has both: the older builds keep Chromium.app under chrome-mac, the newer
  // ones ship Google Chrome for Testing.app under chrome-mac-arm64. Taking the
  // highest version blindly picked a directory with neither and failed with
  // ENOENT, which reads as "no browser installed" while three working ones sat
  // beside it.
  const candidates = children
    .filter((name) => name.startsWith(under.child_prefix ?? ''))
    .sort()
    .reverse();
  for (const child of candidates) {
    for (const entryPath of entryPaths) {
      const executable = path.join(searchRoot, child, entryPath);
      try {
        await stat(executable);
        return executable;
      } catch {}
    }
  }
  throw new BrowserPoolError(
    'provider_not_installed',
    `provider "${provider.id}" found no runnable entry under ${under.directory}/${under.child_prefix ?? ''}*`,
  );
}

export class BrowserPoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserPoolError';
    this.code = code;
  }
}

export function buildPoolRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new BrowserPoolError('invalid_request', 'request must be an object');
  }
  const operation = request.operation;
  const VALID_OPERATIONS = ['pool.status', 'page.fetch', 'pages.fetch-many', 'cache.clear'];
  if (!VALID_OPERATIONS.includes(operation)) {
    throw new BrowserPoolError('unknown_operation', `unknown operation "${String(operation)}"`);
  }
  if (operation === 'pool.status' || operation === 'cache.clear') {
    return { operation };
  }
  if (operation === 'page.fetch') {
    return { operation, ...validateFetchRequest(request) };
  }
  if (operation === 'pages.fetch-many') {
    if (!Array.isArray(request.urls) || request.urls.length === 0) {
      throw new BrowserPoolError('missing_urls', 'request.urls must be a non-empty array');
    }
    if (request.urls.length > 100) {
      throw new BrowserPoolError('too_many_urls', 'request.urls exceeds 100');
    }
    return {
      operation,
      urls: request.urls.map((entry) => {
        if (typeof entry !== 'string') throw new BrowserPoolError('invalid_url', 'urls must be strings');
        const url = new URL(entry);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          throw new BrowserPoolError('invalid_url', `url must be http(s): ${entry}`);
        }
        return url.toString();
      }),
    };
  }
  throw new BrowserPoolError('unknown_operation', `unhandled operation "${String(operation)}"`);
}

function validateFetchRequest(request) {
  if (typeof request.url !== 'string' || request.url.length === 0) {
    throw new BrowserPoolError('missing_url', 'request.url is required');
  }
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BrowserPoolError('invalid_url', 'request.url must be http(s)');
  }
  return {
    url: url.toString(),
    ...(request.dump ? { dump: String(request.dump) } : { dump: 'text' }),
    ...(request.provider_id ? { provider_id: String(request.provider_id) } : {}),
    ...(Array.isArray(request.steps) ? { steps: request.steps.map(readStep) } : {}),
  };
}

/**
 * A step says what to do, never how. The runner below holds one handler per
 * verb, so a new verb is a handler and a DATA row rather than a branch inside
 * whatever asked for the page.
 */
function readStep(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.do !== 'string') {
    throw new BrowserPoolError('invalid_step', 'every step needs a "do"');
  }
  return { ...raw, do: raw.do };
}

const PAGE_STEPS = {
  click: async (page, step) => {
    if (typeof step.text === 'string') {
      await page.getByText(step.text, { exact: step.exact !== false }).first().click({ timeout: step.timeout_ms ?? 15000 });
      return;
    }
    await page.locator(String(step.selector)).first().click({ timeout: step.timeout_ms ?? 15000 });
  },
  wait: async (page, step) => { await page.waitForTimeout(Number(step.ms ?? 1000)); },
  wait_for_text: async (page, step) => {
    await page.getByText(String(step.text), { exact: step.exact === true })
      .first().waitFor({ timeout: step.timeout_ms ?? 30000 });
  },
  press: async (page, step) => { await page.keyboard.press(String(step.key)); },
  fill: async (page, step) => { await page.locator(String(step.selector)).first().fill(String(step.value)); },
};

// The browser is part of the answer, not a detail of how it was produced. Two
// browsers return different bytes for the same page, and one of them can be
// missing a capability the page needs: a runtime with no WebSocket renders a
// live app's failure screen and caches it as if it were the page. Keying the
// cache by url alone would then serve that to the next caller asking through a
// browser that would have rendered it correctly.
export function cacheKeyFor(url, dump, providerId = '', steps = null) {
  const journey = steps ? JSON.stringify(steps) : '';
  return Buffer.from(blake3(Buffer.from(`${url}|${dump}|${providerId}|${journey}`, 'utf8'))).toString('hex');
}

export class BrowserPool {
  constructor(options = {}) {
    this.poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.providersDoc = options.providersDoc ?? null;
    this.provider = options.provider ?? null;
    this.cacheDir = options.cacheDir ?? path.join(os.tmpdir(), 'browser-pool-cache');
    this.activeProcesses = new Set();
    this.stats = { hits: 0, misses: 0, parallel_dispatches: 0, total_requests: 0 };
  }

  async resolveProvider(requestedProviderId = null) {
    if (this.provider && !requestedProviderId) return this.provider;
    if (!this.providersDoc) {
      const raw = await readFile(path.join(here, '..', 'browser-pool-providers.json'), 'utf8');
      this.providersDoc = JSON.parse(raw);
    }
    const providerId = requestedProviderId ?? this.providersDoc.default_provider;
    const provider = this.providersDoc.providers.find((p) => p.id === providerId);
    if (!provider) throw new BrowserPoolError('invalid_provider', `provider "${providerId}" not found in DATA`);
    if (!requestedProviderId) this.provider = provider;
    return provider;
  }

  async status() {
    await this.ensureCacheDir();
    let cacheEntries = 0;
    try {
      const files = await readdir(this.cacheDir);
      cacheEntries = files.filter((f) => f.endsWith('.json')).length;
    } catch {}
    return {
      ok: true,
      pool_size: this.poolSize,
      active_processes: this.activeProcesses.size,
      cache_entries: cacheEntries,
      cache_ttl_ms: this.cacheTtlMs,
      stats: { ...this.stats },
    };
  }

  async fetch(request) {
    this.stats.total_requests++;
    // A provider that writes its answer to a file returns no content, so a
    // cache entry for it holds an empty string and a hit silently skips the
    // write. The caller then reads whatever was on disk from an earlier run and
    // has no way to tell a stale picture from a fresh one.
    const provider = await this.resolveProvider(request.provider_id ?? null);
    if (provider.dump_is_output_path) {
      this.stats.misses++;
      const written = await this.fetchFresh(
        request.url, request.dump, request.provider_id ?? null, request.steps ?? null,
      );
      return { ok: true, source: 'network', url: request.url, content: written, wrote: request.dump };
    }
    const key = cacheKeyFor(request.url, request.dump, request.provider_id ?? '', request.steps ?? null);
    const cached = await this.readCache(key);
    if (cached) {
      this.stats.hits++;
      return { ok: true, source: 'cache', url: request.url, content: cached.content, cached_at: cached.cached_at };
    }
    this.stats.misses++;
    const content = await this.fetchFresh(
      request.url, request.dump, request.provider_id ?? null, request.steps ?? null,
    );
    await this.writeCache(key, content);
    return { ok: true, source: 'network', url: request.url, content };
  }

  async fetchMany(request) {
    this.stats.parallel_dispatches++;
    const results = await Promise.all(
      request.urls.map(async (url) => {
        try {
          const result = await this.fetch({ url, dump: 'text' });
          return { url, ...result };
        } catch (error) {
          return { url, ok: false, error: error.message };
        }
      })
    );
    return { ok: true, results };
  }

  async fetchFresh(url, dump, requestedProviderId = null, steps = null) {
    const provider = await this.resolveProvider(requestedProviderId);
    if (provider.kind === 'scripted_browser') return this.walkPage(provider, url, dump, steps);
    // Substitution happens inside the string, not only when the whole argument
    // is the placeholder. A browser that takes its output path as part of one
    // argument (--screenshot=<path>) could not be described at all while only a
    // whole-argument match was supported, which quietly limited the DATA to the
    // one browser whose flags happened to be separate words.
    const args = provider.fetch_args.map((arg) =>
      String(arg).replaceAll('{url}', url).replaceAll('{dump}', dump)
    );
    const executable = await resolveProviderExecutable(provider);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: provider.timeout_ms ?? 30000,
      });
      this.activeProcesses.add(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { if (stdout.length < 262144) stdout += chunk; });
      child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
      child.on('close', (exitCode) => {
        this.activeProcesses.delete(child);
        if (exitCode === 0) resolve(stdout);
        else reject(new BrowserPoolError('fetch_failed', stderr || `exit ${exitCode}`));
      });
      child.on('error', (error) => {
        this.activeProcesses.delete(child);
        reject(new BrowserPoolError('fetch_failed', error.message));
      });
    });
  }

  /**
   * Some pages only show what you came for after somebody does something: an
   * intro that covers the whole screen until it is dismissed, a list behind a
   * sign-in, a panel that opens on click. A one-shot command-line browser can
   * never reach those, and its screenshot of the cover looks exactly like the
   * page being empty.
   *
   * The journey is request DATA, so this stays one runner rather than a script
   * per page, and it is the same browser binary the other providers resolve.
   */
  async walkPage(provider, url, dump, steps) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: await resolveProviderExecutable(provider),
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: provider.viewport ?? { width: 1440, height: 900 },
      });
      // A page that fails says why in its console, and that console dies with
      // the window. A screenshot of the failure card is the one thing that
      // survives, and it is the one thing that cannot tell an empty scene from
      // a scene whose mount threw, which have opposite fixes.
      const said = [];
      page.on('console', (message) => {
        if (said.length < 400) said.push(`[${message.type()}] ${message.text()}`);
      });
      page.on('pageerror', (error) => { said.push(`[pageerror] ${error.message}`); });
      await page.goto(url, { waitUntil: 'networkidle', timeout: provider.timeout_ms ?? 60000 });
      for (const step of steps ?? []) {
        const run = PAGE_STEPS[step.do];
        if (!run) throw new BrowserPoolError('unknown_step', `no handler for step "${step.do}"`);
        await run(page, step);
      }
      if (provider.dump_is_output_path) {
        await page.screenshot({ path: dump, fullPage: provider.full_page === true });
        return said.join('\n');
      }
      return await page.content();
    } finally {
      await browser.close();
    }
  }

  async ensureCacheDir() {
    try { await mkdir(this.cacheDir, { recursive: true }); } catch {}
  }

  async readCache(key) {
    const entryPath = path.join(this.cacheDir, `${key}.json`);
    try {
      const raw = await readFile(entryPath, 'utf8');
      const entry = JSON.parse(raw);
      if (Date.now() - entry.cached_at > this.cacheTtlMs) return null;
      return entry;
    } catch { return null; }
  }

  async writeCache(key, content) {
    await this.ensureCacheDir();
    const entry = { content, cached_at: Date.now() };
    const entryPath = path.join(this.cacheDir, `${key}.json`);
    await writeFile(entryPath, JSON.stringify(entry));
    await this.trimCache();
  }

  async trimCache() {
    try {
      const files = await readdir(this.cacheDir);
      const cacheFiles = files.filter((f) => f.endsWith('.json'));
      if (cacheFiles.length <= this.maxCacheEntries) return;
      const entries = await Promise.all(
        cacheFiles.map(async (f) => {
          const s = await stat(path.join(this.cacheDir, f));
          return { file: f, mtime: s.mtimeMs };
        })
      );
      entries.sort((a, b) => a.mtime - b.mtime);
      const toRemove = entries.slice(0, entries.length - this.maxCacheEntries);
      for (const entry of toRemove) {
        await unlink(path.join(this.cacheDir, entry.file)).catch(() => {});
      }
    } catch {}
  }

  async clearCache() {
    try {
      const files = await readdir(this.cacheDir);
      for (const f of files) {
        if (f.endsWith('.json')) await unlink(path.join(this.cacheDir, f)).catch(() => {});
      }
    } catch {}
    this.stats = { hits: 0, misses: 0, parallel_dispatches: 0, total_requests: 0 };
    return { ok: true, cleared: true };
  }
}
