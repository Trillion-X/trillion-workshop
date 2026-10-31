// tools/paid-access/read-data/payment-effects.mjs
//
// Payment events through rule DATA into effects. Ported from bitfield-packages packages/signed-event-effects (the
// projection: `ruleMatches`, selectors, `materialFor`, `effectFor`, `effectsFromEvents`). The package asked a signed
// event authority to verify each event and a workflow slot to store each effect; neither is carried. A payment event
// is believed before it is kept (tools/take-payments checks its age and signature), so this folder reads kept
// `payment-event` records and projects them; an effect is worked out each time, never stored.
//
//   effectsFromPaymentEvents(paymentEvents, rules) -> { effects, problems }
//
// A rule is the person's data: which event kind it reads (`relation` or `relations`), which attributes the event must
// carry (`required_attributes`), what the effect is called (`effect_kind`) and where its subject and object come
// from (`subject`, `object`: a literal, or { from: 'attribute' | 'event' | 'fact', key | path, fallback? }). Nothing
// here names a provider, a product or an event kind.
//
// Changed from the package: the effect id is `<prefix>:<event id>:<fact id>` where the package hashed those ids into
// 32 bits (two events could meet at one id and one effect would hide the other); an effect whose subject or object
// cannot be read is reported in `problems` and skipped, where the package refused the whole batch.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const present = value => value !== undefined && value !== null
  && !(typeof value === 'string' && value.trim().length === 0)
  && !(typeof value === 'number' && !Number.isFinite(value));

function valueAtPath(value, path) {
  if (!path) return value;
  return String(path).split('.').filter(Boolean).reduce((cursor, segment) => (object(cursor) || Array.isArray(cursor) ? cursor[segment] : undefined), value);
}

/** One kept payment-event record as the event with one fact the rules read: the event kind is the fact's relation. */
export function eventOfPaymentEvent(record) {
  const attributes = object(record?.attributes) ? record.attributes : {};
  const eventId = text(record?.event_id);
  const kind = text(record?.event_kind);
  const occurredAt = text(record?.occurred_at);
  if (!eventId || !kind || !occurredAt) return null;
  return { event_id: eventId, occurred_at: occurredAt, facts: [{ fact_id: eventId, relation: kind, object: text(attributes.offer_id) ?? '', subject: '', attributes }] };
}

function ruleMatches(rule, fact) {
  const relations = Array.isArray(rule.relations) ? rule.relations.map(text).filter(Boolean) : [];
  const relation = text(rule.relation);
  if (!(relation ? relation === fact.relation : relations.includes(fact.relation))) return false;
  const objects = Array.isArray(rule.objects) ? rule.objects.map(text).filter(Boolean) : [];
  if (objects.length && !objects.includes(fact.object)) return false;
  const required = Array.isArray(rule.required_attributes) ? rule.required_attributes.map(text).filter(Boolean) : [];
  return required.every(key => present(fact.attributes?.[key]));
}

function selectedValue(selector, event, fact) {
  if (selector === null || selector === undefined) return undefined;
  if (typeof selector === 'string') return selector;
  if (!object(selector)) return undefined;
  const from = text(selector.from);
  const value = from === 'attribute' ? fact.attributes?.[text(selector.key) ?? '']
    : from === 'event' ? valueAtPath(event, selector.path)
      : from === 'fact' ? valueAtPath(fact, selector.path) : undefined;
  return !present(value) && selector.fallback !== undefined ? selectedValue(selector.fallback, event, fact) : value;
}

function includeFields(target, fields, source) {
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = text(field);
    const value = key ? valueAtPath(source, key) : undefined;
    if (value !== undefined) target[key] = value;
  }
}

function materialFor(rule, event, fact) {
  const descriptor = object(rule.material) ? rule.material : {};
  const material = { ...(object(descriptor.constants) ? descriptor.constants : {}), ...(descriptor.include_attributes === false ? {} : fact.attributes) };
  includeFields(material, descriptor.include_event_fields, event);
  includeFields(material, descriptor.include_fact_fields, fact);
  return material;
}

const cleanKind = value => (text(value) ? text(value).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : 'effect');

function effectFor(rule, event, fact) {
  const subject = text(selectedValue(rule.subject ?? { from: 'fact', path: 'subject' }, event, fact));
  const target = text(selectedValue(rule.object ?? { from: 'fact', path: 'object' }, event, fact));
  if (!subject) throw new Error('its subject cannot be read');
  if (!target) throw new Error('its object cannot be read');
  return {
    effect_id: `${cleanKind(rule.effect_id_prefix ?? rule.effect_kind ?? fact.relation)}:${event.event_id}:${fact.fact_id}`,
    kind: text(rule.effect_kind) ?? cleanKind(fact.relation),
    material: materialFor(rule, event, fact),
    object: target,
    source_event_ids: [event.event_id],
    subject,
  };
}

export function effectsFromPaymentEvents(paymentEvents, rules) {
  const usable = (Array.isArray(rules) ? rules : []).filter(object);
  const effects = new Map();
  const problems = [];
  for (const record of Array.isArray(paymentEvents) ? paymentEvents : []) {
    const event = eventOfPaymentEvent(record);
    if (!event) {
      problems.push({ event_id: text(record?.event_id) ?? text(record?.id) ?? '', problem: 'a payment event needs event_id, event_kind and occurred_at' });
      continue;
    }
    for (const fact of event.facts) {
      for (const rule of usable.filter(item => ruleMatches(item, fact))) {
        try {
          const effect = effectFor(rule, event, fact);
          effects.set(effect.effect_id, effect);
        } catch (error) {
          problems.push({ event_id: event.event_id, rule_id: text(rule.rule_id) ?? '', problem: `${error.message}, so this event gives no effect under this rule` });
        }
      }
    }
  }
  return { effects: [...effects.values()], problems };
}
