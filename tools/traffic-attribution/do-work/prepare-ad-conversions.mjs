// tools/traffic-attribution/do-work/prepare-ad-conversions.mjs
//
// The Workshop tool "Prepare conversions to send back to ad platforms". argv[2] is one JSON input:
//   { project: { id, currency? }, destinations?: [{ id, shape, on, account, events: { <outcome>: <target> } }],
//     visits: [{ visitor, signals, at? }], conversions: [{ visitor, outcome, at, value?, event_id?, email?, phone? }], now? }
// Sending is off until a destination says `on: true`: with none, nothing is prepared and the answer says so. For each
// destination that is on, every conversion whose outcome it maps becomes one event of its platform's shape
// (read-data/ad-conversions.json), carrying the click ids of the visitor's first touch and the email and phone made
// plain by that platform's rule and hashed with SHA-256 (the platforms' own requirement); the plain email and phone
// never appear in the answer. The answer is the sends: each a connection tool and its exact input, batched to the
// platform's limit. An event's id is the conversion's event_id, else project:visitor:outcome, so running the same
// conversions again sends the same ids and the platform counts each once; a conversion an outcome records more than
// once (each monthly payment) needs its own event_id. A conversion that cannot be sent is listed in `skipped` with why.
import { createHash } from 'node:crypto';
import settings from '../read-data/ad-conversions.json' with { type: 'json' };
import { isValidProjectId } from '../read-data/traffic-address.ts';
import { clickIdsOf, clickIdsToAdd } from '../read-data/click-ids.ts';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const OMIT = Symbol('left out');
const DAY_MS = 86_400_000;

// The platforms' plain-form rules, step by step (each shape names its steps).
const EMAIL_STEPS = {
  trim: value => value.trim(),
  'trim-all': value => value.replace(/\s+/g, ''),
  lowercase: value => value.toLowerCase(),
  'gmail-local': value => {
    const [local, domain] = value.split('@');
    return domain && settings.plain_mail_domains.includes(domain) ? `${local.split('+')[0].replace(/\./g, '')}@${domain}` : value;
  },
};
// A phone number is taken only in international form (+, the country code, then the number); no country is guessed.
const PHONE_STEPS = {
  e164: value => `+${value.replace(/\D/g, '')}`,
  digits: value => value.replace(/\D/g, ''),
};
function plain(value, steps, rules, what) {
  return steps.reduce((done, step) => {
    if (!rules[step]) throw new Error(`ad-conversions.json names a ${what} step "${step}" this tool does not have.`);
    return rules[step](done);
  }, value);
}

/** The event: { from } leaves filled from the facts, an absent fact left out, an emptied object or list left out. */
function fill(template, facts) {
  if (Array.isArray(template)) {
    const items = template.map(item => fill(item, facts)).filter(item => item !== OMIT);
    return items.length ? items : OMIT;
  }
  if (!object(template)) return template;
  if (Object.keys(template).length === 1 && typeof template.from === 'string') return facts[template.from] ?? OMIT;
  const entries = Object.entries(template).map(([key, item]) => [key, fill(item, facts)]).filter(([, item]) => item !== OMIT);
  return entries.length ? Object.fromEntries(entries) : OMIT;
}

export function prepareAdConversions(input) {
  if (!object(input) || !object(input.project) || !isValidProjectId(input.project.id)) throw new Error('project must say which project the conversions belong to ({ id }), letters, numbers, dots, dashes or underscores.');
  if (!Array.isArray(input.visits)) throw new Error('visits must be a list of { visitor, signals, at? }, the first touches the conversions belong to.');
  if (!Array.isArray(input.conversions)) throw new Error('conversions must be a list of { visitor, outcome, at, value?, event_id?, email?, phone? }.');
  const project = text(input.project.id);
  const currency = text(input.project.currency) || 'USD';
  const now = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('now must be an ISO time when given.');
  const destinations = (Array.isArray(input.destinations) ? input.destinations : []).filter(destination => object(destination) && destination.on === true);
  if (!destinations.length) {
    return { project, sends: [], skipped: [], said: 'Sending conversions to ad platforms is off for this project: no destination is turned on. Add a destination with on: true, its account and which outcome is which event, to send them.' };
  }
  const shapes = destinations.map((destination, index) => {
    const shape = settings.shapes[destination.shape];
    if (!shape) throw new Error(`destinations[${index}].shape must be one of ${Object.keys(settings.shapes).join(', ')}.`);
    const id = text(destination.id) || destination.shape;
    const account = object(destination.account) ? destination.account : {};
    const missing = shape.account.filter(field => !text(account[field]));
    if (missing.length) throw new Error(`destinations[${index}] (${shape.label}) needs account.${missing.join(' and account.')}.`);
    if (!object(destination.events) || !Object.values(destination.events).some(text)) throw new Error(`destinations[${index}] (${shape.label}) needs events: which outcome is which ${shape.send_per_outcome_target ?? 'event name'}, like { "signup": "..." }.`);
    return { id, shape, account, targets: destination.events };
  });

  const firstTouch = new Map();
  for (const visit of input.visits) {
    const visitor = text(visit?.visitor);
    if (visitor && !firstTouch.has(visitor)) firstTouch.set(visitor, { signals: object(visit.signals) ? visit.signals : {}, at: Date.parse(text(visit.at)) });
  }

  const skipped = [];
  const batches = new Map();
  const seen = new Set();
  input.conversions.forEach((conversion, index) => {
    const visitor = text(conversion?.visitor);
    const outcome = text(conversion?.outcome);
    const at = Date.parse(text(conversion?.at));
    const skip = (destination, why) => skipped.push({ ...(destination ? { destination } : {}), conversion: index, visitor, outcome, why });
    if (!visitor || !outcome) return skip(null, 'A conversion needs its visitor and outcome.');
    if (!Number.isFinite(at)) return skip(null, 'A conversion needs at, the ISO time it happened.');
    const eventId = text(conversion.event_id) || `${project}:${visitor}:${outcome}`;
    if (seen.has(eventId)) return skip(null, `Another conversion here has the event id ${eventId}; give each repeat of an outcome its own event_id.`);
    seen.add(eventId);
    const touch = firstTouch.get(visitor);
    const signals = touch?.signals ?? {};
    const clicks = { ...clickIdsOf(signals), ...clickIdsToAdd(signals, { atMs: Number.isFinite(touch?.at) ? touch.at : at }) };
    const email = text(conversion.email);
    const phone = text(conversion.phone);
    if (phone && !phone.startsWith('+')) return skip(null, 'A phone number must be in international form, starting with + and the country code.');
    for (const { id, shape, account, targets } of shapes) {
      const target = text(targets[outcome]);
      if (!target) continue;
      if (shape.oldest_days !== undefined && now - at > shape.oldest_days * DAY_MS) { skip(id, `${shape.label} takes events up to ${shape.oldest_days} days old.`); continue; }
      const facts = {
        event_id: eventId,
        at_seconds: Math.floor(at / 1000),
        at_iso: new Date(at).toISOString(),
        outcome,
        outcome_target: target,
        currency,
        ...(typeof conversion.value === 'number' && Number.isFinite(conversion.value) && conversion.value > 0 ? { value: conversion.value } : {}),
        ...(email.includes('@') ? { email_sha256: sha256(plain(email, shape.email_steps, EMAIL_STEPS, 'email')) } : {}),
        ...(phone ? { phone_sha256: sha256(plain(phone, shape.phone_steps, PHONE_STEPS, 'phone')) } : {}),
        ...Object.fromEntries(Object.entries(clicks).map(([key, value]) => [`click.${key}`, value])),
      };
      if (!shape.needs_any.some(fact => facts[fact] !== undefined)) { skip(id, `${shape.label} matches an event by one of ${shape.needs_any.join(', ')}, and this conversion has none.`); continue; }
      const key = `${id}\n${shape.send_per_outcome_target ? target : ''}`;
      const batch = batches.get(key) ?? batches.set(key, { id, shape, account, target, events: [] }).get(key);
      batch.events.push(fill(shape.event, facts));
    }
  });

  const sends = [];
  for (const { id, shape, account, target, events } of batches.values()) {
    const fields = Object.fromEntries([...shape.account, ...shape.account_optional].filter(field => account[field] !== undefined && account[field] !== '').map(field => [field, account[field]]));
    for (let start = 0; start < events.length; start += shape.most_per_send) {
      const part = events.slice(start, start + shape.most_per_send);
      sends.push({
        destination: id,
        tool_id: shape.tool_id,
        events: part.length,
        input: { ...fields, ...(shape.send_per_outcome_target ? { [shape.send_per_outcome_target]: target } : {}), [shape.events_field]: part },
      });
    }
  }
  const count = sends.reduce((sum, send) => sum + send.events, 0);
  return { project, sends, skipped, said: `${count} event${count === 1 ? '' : 's'} ready in ${sends.length} send${sends.length === 1 ? '' : 's'}; ${skipped.length} conversion${skipped.length === 1 ? '' : 's'} not sent. Run each send's tool with its input; running the same sends again is counted once by each platform.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(prepareAdConversions(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
