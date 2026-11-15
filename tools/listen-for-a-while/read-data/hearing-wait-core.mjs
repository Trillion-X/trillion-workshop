// The original bounded pending-hearing wait, with its status read and clock supplied.
export async function waitForPendingHearing({ readJson, files, now, startedAt, wait, sleep, rows }) {
  let flushed = true;
  while ((readJson(files.status)?.hearing_pending ?? 0) > 0) {
    if (now() - startedAt >= wait) { flushed = false; break; }
    await sleep(rows.asks.poll_ms);
  }
  return flushed;
}
