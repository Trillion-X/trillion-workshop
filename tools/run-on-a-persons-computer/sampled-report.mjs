// computer/sampled-report.mjs
//
// PURPOSE
//   Decides at the edge (on this computer) whether a problem report is sent at all, removes the person's own paths and names from
//   it, and sends it only to a sink whose credential can write a report and nothing else.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Sampling is local and deterministic: BLAKE3 of the install id and launch id picks a point in [0, 1); a kind sends when it is
//      below its rate. Rate 0 never sends, rate 1 always does.
//   2. A sink row may hold only the fields in `allowed_sink_fields`, its scope must be `ingest` and its address https. A row with a
//      password, token, secret or any other field is refused when read, so a shipped config cannot carry a reading key.
//   3. Reports are scrubbed by the DATA rows before they leave and cut at `max_chars`.
//   4. Blind: kinds, rates, sinks and scrub rows are computer/sampled-report.json.
//
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const reportSettings = () => JSON.parse(readFileSync(join(HERE, 'sampled-report.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });

/** Only the sinks that are safe to ship; throws for the first that is not. */
export function readSinks(settings = reportSettings()) {
  return settings.sinks.map(row => {
    const stray = Object.keys(row).find(field => !settings.allowed_sink_fields.includes(field));
    if (stray) throw refusal(fill(settings.words.sink_field, { id: row.id, field: stray }));
    if (row.scope !== 'ingest') throw refusal(fill(settings.words.sink_scope, { id: row.id }));
    if (!String(row.url ?? '').startsWith('https://')) throw refusal(fill(settings.words.sink_url, { id: row.id }));
    return row;
  });
}

/** A point in [0, 1) that this install and launch always give. */
export function launchPoint(installId, launchId) {
  const bytes = Buffer.from(makeHashCodeHexFromBytes(new TextEncoder().encode(`${installId}\0${launchId}`)).slice(3), 'hex');
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 2 ** 32;
}

export function makeReporter({ settings = reportSettings(), installId, launchId, send = async () => {} } = {}) {
  const sinks = readSinks(settings);
  const scrubbers = settings.scrub.map(row => ({ expression: new RegExp(row.pattern, 'g'), replace: row.replace }));
  const clean = text => scrubbers.reduce((value, row) => value.replace(row.expression, row.replace), String(text).slice(0, settings.max_chars)).slice(0, settings.max_chars);
  return {
    /** Whether this launch sends reports of `kind`. */
    sampled(kind) {
      const row = settings.kinds[kind];
      if (!row) throw refusal(fill(settings.words.unknown_kind, { kind }), 404);
      return launchPoint(installId, launchId) < row.rate;
    },
    /** Sends one report if this launch is sampled for its kind: { sent, reason? }. */
    async report(kind, body) {
      if (!this.sampled(kind)) return { sent: false, reason: 'not sampled' };
      const sink = sinks.find(row => row.id === settings.kinds[kind].sink);
      if (!sink) throw refusal(fill(settings.words.no_sink, { kind }), 404);
      await send(sink, { kind, ingest_id: sink.ingest_id, body: clean(typeof body === 'string' ? body : JSON.stringify(body)) });
      return { sent: true };
    },
  };
}
