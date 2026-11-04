// computer/host-log.mjs
//
// PURPOSE
//   What the Mac host (computer/mac-tools.mjs) does with each line it logs, beyond printing it: keeps it in a sealed local log that
//   only the holder of the reader's private key can read (computer/sealed-log.mjs), and sends a sampled, scrubbed report for a line
//   that names a failure (computer/sampled-report.mjs). Both are off until their DATA row is filled in (mac-tools.json `host_log`:
//   a reader public key; reports need a sink in computer/sampled-report.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which lines are failures, where the sealed file lives and which reader opens it are DATA; nothing here names a line.
//   2. The line is passed to the original log first and always; sealing or reporting that fails never loses it or stops the host.
//   3. A line is reported only if its kind's sampling says this launch sends, scrubbed by the report rows; the credential in a sink can
//      write a report and read nothing back.
//
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSealedLog } from './sealed-log.mjs';
import { makeReporter } from './sampled-report.mjs';

const installIdOf = (settings, home) => {
  const scope = settings.computer_scope;
  try { return String(JSON.parse(readFileSync(join(home, scope.file), 'utf8'))?.[scope.field] ?? 'unknown'); } catch { return 'unknown'; }
};

const postReport = async (sink, report) => {
  const answer = await fetch(sink.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
  if (!answer.ok) throw new Error(`answered ${answer.status}`);
};

/** `log` wrapped with the host_log rows of `settings`; the wrapper has `close()` to flush the sealed file. */
export function hostLog({ settings, log, home = homedir(), launchId = randomBytes(8).toString('hex'), send = postReport, reporter = null } = {}) {
  const rows = settings.host_log ?? {};
  let sealed = null;
  if (rows.sealed?.reader_public_key) {
    try { sealed = createSealedLog({ file: join(home, rows.sealed.file), publicKey: Buffer.from(rows.sealed.reader_public_key, 'base64'), keyId: Buffer.from(rows.sealed.key_id ?? '0000000000000000', 'hex') }); } catch { sealed = null; }
  }
  const failure = rows.report_when ? new RegExp(rows.report_when.pattern) : null;
  let reports = reporter;
  if (failure && !reports) {
    try { reports = makeReporter({ installId: installIdOf(settings, home), launchId, send }); } catch { reports = null; }
  }
  const wrapped = line => {
    log(line);
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    try { sealed?.append(text); } catch { /* the line is already logged */ }
    if (reports && failure?.test(text)) reports.report(rows.report_when.kind, text).catch(() => {});
  };
  wrapped.close = () => { try { sealed?.close(); } catch { /* nothing more to keep */ } };
  return wrapped;
}
