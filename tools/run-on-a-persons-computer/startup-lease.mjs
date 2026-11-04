// computer/startup-lease.mjs
//
// PURPOSE
//   A helper that starts and then hangs looks alive to its supervisor (the process is there, nothing is logged).
//   Each startup phase holds a lease; when a phase does not finish inside its lease the helper says which phase and
//   leaves with a restart exit code, so launchd (or the app) sees a failed start and starts it again.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Seconds, extensions and the exit code are DATA (computer/mac-tools.json startup_leases); a phase with no row
//      has no lease, so a phase that legitimately waits (the owner being busy) is simply not listed.
//   2. A phase that reports progress (renew()) gets its lease again, at most `extensions` times, so slow but moving
//      work is not killed and stuck work cannot hold on for ever.
//   3. An expiry is said (log) before the helper leaves; a phase that finishes first leaves nothing behind.
export function makeStartupLeases({ settings, expire, log = () => {}, timers = { setTimeout, clearTimeout } }) {
  const rows = settings?.phases ?? {};
  async function lease(name, work) {
    const row = rows[name];
    if (!row) return work({ renew: () => {} });
    let left = row.extensions ?? 0;
    let timer;
    const arm = () => {
      timer = timers.setTimeout(() => {
        log({ startup_lease_expired: name, seconds: row.seconds, extensions_used: (row.extensions ?? 0) - left });
        expire({ phase: name, exit_code: settings.exit_code });
      }, row.seconds * 1000);
      timer.unref?.();
    };
    arm();
    try {
      return await work({ renew: () => { if (left <= 0) return false; left -= 1; timers.clearTimeout?.(timer); arm(); return true; } });
    } finally { timers.clearTimeout?.(timer); }
  }
  return { lease };
}
