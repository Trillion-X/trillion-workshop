/**
 * file: tools/media-composition/do-work/detect-events.mjs
 *
 * PURPOSE: Finds events in a recording with the detector a row of read-data/detect-events.json names, and answers them in one
 * shape: { kind, time, confidence } in source seconds. Three kinds of detector row exist (a STREAM row walks feature frames through
 * stream-core.mjs with the encoder, core and heads of the `streams` row it names), and a new detector is a
 * new row: a PROGRAM row (`program`, `export`) is a module of this folder whose function takes (video, { from, to }) and answers a
 * list of moments with a time and a 0..1 strength; a JOB row (`job`) is a local-model job the caller's `askModel(job, request)`
 * answers with a list of events. No model weights ship with this tool.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Blind: no sport, event or model is named here. 2. Times are inside [from, to]; a moment without a finite time or confidence
 * is dropped, never repaired. 3. A detector that fails is an error in words; there is no silent empty answer.
 *
 * Usage: node detect-events.mjs VIDEO [--detector ID] [--from S] [--to S]
 * Output (stdout, JSON): { detector, from, to, events: [{ kind, time, confidence }] }
 */
import settings from '../read-data/detect-events.json' with { type: 'json' };
import { run as runStream } from './stream-core.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp01 = value => Math.max(0, Math.min(1, value));

function streamOf(config, name, id) {
  const found = config.streams?.[name];
  if (!found) throw Object.assign(new Error(`The detector ${id} names a stream, ${name}, that is not kept.`), { status: 500 });
  return found;
}

export async function detectEvents({ detector: id, video, from = 0, to, askModel, config = settings } = {}) {
  const row = config.detectors.find(item => item.id === id);
  if (!row) throw Object.assign(new Error(`No detector named ${id} is kept.`), { status: 404 });
  let moments;
  if (row.program) {
    const module = await import(new URL(`./${row.program}`, import.meta.url).href);
    const found = await module[row.export](video, { from, to });
    moments = (found[row.moments_key] ?? []).map(moment => ({ kind: row.event_kind, time: moment.time, confidence: moment[row.confidence_field] }));
  } else if (row.stream) {
    // A stream detector: the encoder's frames walk through the core and heads of the row it names, state carried frame to frame.
    const stream = streamOf(config, row.stream, id);
    const module = await import(new URL(stream.encoder.module, import.meta.url).href);
    const frames = await module[stream.encoder.export](video, { from, to, step_s: stream.encoder.step_s });
    moments = runStream(stream, frames).events;
  } else if (row.job) {
    if (typeof askModel !== 'function') throw Object.assign(new Error(`The detector ${id} needs a model job and none can be asked.`), { status: 503, retry: true });
    const answer = await askModel(row.job, { video, from, to });
    moments = (answer?.[row.events_key] ?? []).map(event => ({ kind: event.kind, time: event.time, confidence: event.confidence,
      ...(typeof event.device === 'string' ? { device: event.device } : {}), ...(Array.isArray(event.at) && event.at.length === 2 ? { at: event.at } : {}) }));
  } else throw Object.assign(new Error(`The detector ${id} names no program, stream or job.`), { status: 500 });
  return moments.filter(event => typeof event.kind === 'string' && finite(event.time) && finite(event.confidence)
    && event.time >= from && (to === undefined || event.time <= to)).map(event => ({ ...event, confidence: clamp01(event.confidence) }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [video, ...rest] = process.argv.slice(2);
  const options = new Map();
  for (let at = 0; at < rest.length; at += 2) options.set(rest[at].replace(/^--/, ''), rest[at + 1]);
  const number = name => (options.get(name) === undefined || options.get(name) === '' ? undefined : Number(options.get(name)));
  try {
    if (!video) throw new Error('usage: detect-events.mjs VIDEO [--detector ID] [--from S] [--to S]');
    const detector = options.get('detector') || settings.default_detector;
    const from = number('from') ?? 0;
    const to = number('to');
    const events = await detectEvents({ detector, video, from, to });
    process.stdout.write(`${JSON.stringify({ detector, from, to: to ?? null, events })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
