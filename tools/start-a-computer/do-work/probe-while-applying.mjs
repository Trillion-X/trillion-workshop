// probe-while-applying.mjs [--every-ms N] [--slow-ms N] [--lag-ms N] [--log FILE] URL...: while a computer's apply runs, one GET
// every `every-ms` (50), round-robin over the URLs, until SIGTERM; prints one JSON summary on stdout and, with --log, writes
// every request as its own JSON line ({at, url, status, ms, answered_by, lag_ms}), so a slow request names its target and time.
// The prober's own lateness is measured too: a timer that fires `lag_ms` late means the computer running the probe was busy
// (Nov 21 2026: a probe run on a Mac at load 54 counted 64 requests over 1 s during an apply that restarted nothing the probe
// reached), so a request sent while the prober lagged more than `lag-ms` (250) is kept but counted apart (`slow_while_lagging`)
// and never as the served computer's slowness. `answered_by` is the response's `x-answered-by` header, when its server says.
// A GET whose connection the server closed before any answer is asked once more on a new connection, as a browser does
// (Nov 21 2026, 4:02:26 PM CST: a front door's graceful reload closed the kept-alive connections idle at that instant, and a
// request sent on one just then failed in 71 ms; a browser would have asked again). The request keeps `retried` (the first
// error) and its `ms` covers both tries, so the summary counts the retries and their wait.
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The probe's settings from its arguments: flags first, then the URLs. */
export function parseArgs(argv) {
  const given = { every_ms: 50, slow_ms: 1000, lag_ms: 250, log: null, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].match(/^--(every-ms|slow-ms|lag-ms|log)$/)?.[1];
    if (!flag) { given.urls.push(argv[i]); continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    if (flag === 'log') given.log = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--${flag} is a whole number of milliseconds above 0`);
      given[flag.replace('-', '_')] = n;
    }
  }
  if (!given.urls.length) throw new Error('name at least one URL to probe');
  return given;
}

const CLOSED_BEFORE_ANSWER = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/** One GET of `url` as the probe keeps it ({status, ms, answered_by} or {error, ms}, with `retried` when asked twice). */
export async function askOnce(url, fetchImpl = fetch) {
  const t = performance.now(), kept = {};
  for (let tries = 1; ; tries++) {
    try {
      const r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer();
      return Object.assign(kept, { status: r.status, ms: Math.round(performance.now() - t), answered_by: r.headers.get('x-answered-by') });
    } catch (error) {
      const code = String(error.cause?.code ?? error.name ?? error).slice(0, 80);
      if (tries === 1 && CLOSED_BEFORE_ANSWER.has(code)) { kept.retried = code; continue; }
      return Object.assign(kept, { error: code, ms: Math.round(performance.now() - t) });
    }
  }
}

/** The summary of every request kept: counts, percentiles of the ones sent while the prober kept time, and each slow one. */
export function summarize(requests, { slow_ms, lag_ms }, started, stopped) {
  const timely = requests.filter(r => r.lag_ms <= lag_ms);
  const ms = timely.filter(r => typeof r.ms === 'number').map(r => r.ms).sort((a, b) => a - b);
  const at = q => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]) : null);
  const failed = requests.filter(r => r.error || r.status >= 500);
  const slow = timely.filter(r => r.ms > slow_ms);
  const retried = requests.filter(r => r.retried);
  return {
    // A request that needed a retry is its own number and never ok: a browser would have asked again, but the bar is 0 of them.
    started, stopped, sent: requests.length, ok: requests.length - failed.length - retried.filter(r => !failed.includes(r)).length, failed: failed.length,
    retried: retried.length,
    slow_over_ms: slow_ms, slow: slow.length, slow_while_lagging: requests.filter(r => r.lag_ms > lag_ms && r.ms > slow_ms).length,
    p50_ms: at(0.5), p99_ms: at(0.99), max_ms: ms.length ? Math.round(ms[ms.length - 1]) : null,
    most_lag_ms: requests.reduce((most, r) => Math.max(most, r.lag_ms), 0),
    slow_requests: slow.slice(0, 50), failures: failed.slice(0, 50), retried_requests: retried.slice(0, 50),
  };
}

async function main() {
  const given = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString(), requests = [], inFlight = new Set();
  let i = 0, due = performance.now();
  const once = async (url, lag) => {
    const kept = { at: new Date().toISOString(), url, lag_ms: Math.round(lag), ...await askOnce(url) };
    requests.push(kept);
    if (given.log) appendFileSync(given.log, `${JSON.stringify(kept)}\n`);
  };
  const timer = setInterval(() => {
    const now = performance.now(), lag = Math.max(0, now - due - given.every_ms);
    due = now;
    const p = once(given.urls[i++ % given.urls.length], lag);
    inFlight.add(p); p.finally(() => inFlight.delete(p));
  }, given.every_ms);
  process.on('SIGTERM', async () => {
    clearInterval(timer);
    await Promise.allSettled([...inFlight]);
    process.stdout.write(`${JSON.stringify(summarize(requests, given, started, new Date().toISOString()))}\n`);
    process.exit(0);
  });
}

// Run as a program by its real path, so a linked path runs it too (Nov 21 2026: started as /tmp/..., a link to /private/tmp,
// it compared unequal and exited at once, with no summary).
if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
