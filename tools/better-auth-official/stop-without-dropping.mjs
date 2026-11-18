// The sign-in tool's stop (plan: a deploy never drops anything, Z4). On SIGTERM each listener's `/readyz` answers 503 while
// the listeners keep taking calls for `stop.hold_ms` (long enough for the front door's health check to send new work to the
// other slot); then they take no new connection, and the calls they hold get up to `stop.grace_ms` before the rest are ended.
// Only then does `after` run (the store's pool ends) and the process exit. Both numbers are this tool's settings.

/** Whether this process is stopping: its `/readyz` answers 503 from the moment SIGTERM arrives. */
let stopping = false;

/** `/readyz` for `request`, or null for any other address: 200 while serving, 503 once stopping. */
export function readiness(request, response) {
  if (request.url !== '/readyz' || !['GET', 'HEAD'].includes(request.method)) return null;
  return response.writeHead(stopping ? 503 : 200, { 'content-type': 'application/json' }).end(request.method === 'HEAD' ? undefined : JSON.stringify({ stopping }));
}

/** Stop `servers` without dropping a call they hold, when `signal` arrives. */
export function stopWithoutDropping(servers, { hold_ms, grace_ms }, after = async () => {}, { signal = 'SIGTERM', exit = code => process.exit(code), on = process } = {}) {
  on.once(signal, async () => {
    stopping = true;
    await new Promise(done => setTimeout(done, hold_ms));
    const closed = servers.map(server => new Promise(done => server.close(() => done())));
    for (const server of servers) server.closeIdleConnections?.();
    const cut = setTimeout(() => { for (const server of servers) server.closeAllConnections?.(); }, grace_ms);
    await Promise.all(closed);
    clearTimeout(cut);
    await after().catch(() => {});
    exit(0);
  });
}
