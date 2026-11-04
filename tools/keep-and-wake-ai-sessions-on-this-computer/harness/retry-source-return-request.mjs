const BUSY_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30, 60];

export function retryAfterSeconds(value, now = Date.now()) {
  if (value == null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : 0;
}

export async function postWithBusyRetry(url, body, { key, send = fetch,
  wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
  backoffSeconds = BACKOFF_SECONDS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await send(url, { method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    } catch (error) {
      if (attempt >= backoffSeconds.length) throw error;
      await wait(backoffSeconds[attempt]);
      continue;
    }
    if (response.ok) return response.json();
    if (!BUSY_STATUS.has(response.status)) return null;
    if (attempt >= backoffSeconds.length) throw new Error(`Trillion is still busy (${response.status})`);
    await wait(Math.max(backoffSeconds[attempt], retryAfterSeconds(response.headers?.get?.('retry-after'))));
  }
}
