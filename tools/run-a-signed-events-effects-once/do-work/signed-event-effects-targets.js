// parts/signed-event-effects/do-work/signed-event-effects-targets.js
//
// Admit signed events as effects, and list a subject's effects, through descriptors installed with this part
// (../records.json). Every call to a verifier, writer or reader goes through the caller's `send`; this part has
// no transport of its own, so a caller that passes none is refused.
import packageContract from '../records.json' with { type: 'json' };

class SignedEventEffectsRejectedError extends Error {
  constructor(message) {
    super(message);
    this.publicStatus = 422;
  }
}

function requireSender(send) {
  if (typeof send !== 'function') throw new SignedEventEffectsRejectedError('send is required: this part has no transport of its own.');
  return send;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasValue(value) {
  return value !== undefined
    && value !== null
    && !(typeof value === 'string' && value.trim().length === 0)
    && !(typeof value === 'number' && !Number.isFinite(value));
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new SignedEventEffectsRejectedError(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label) {
  const text = readString(value);
  if (!text) throw new SignedEventEffectsRejectedError(`${label} is required.`);
  return text;
}

function readRows(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['effects', 'items', 'records', 'rows', 'things']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function packageRecords() {
  return Array.isArray(packageContract.things)
    ? packageContract.things.filter(isRecord)
    : [];
}

function configuredDescriptor(kind, requestedId, label) {
  const id = requireString(requestedId, label);
  const matches = packageRecords()
    .map((thing) => thing.payload)
    .filter((payload) => isRecord(payload) && payload.kind === kind && payload.id === id);
  if (matches.length !== 1) {
    throw new SignedEventEffectsRejectedError(`${label} is not an installed descriptor.`);
  }
  return matches[0];
}

function payloadOf(value) {
  return isRecord(value) && isRecord(value.payload) ? value.payload : value;
}

function decodeTargetPayload(payload) {
  if (payload instanceof Uint8Array) {
    const text = new TextDecoder().decode(payload).trim();
    return text ? JSON.parse(text) : {};
  }
  if (typeof payload === 'string') {
    return payload.trim() ? JSON.parse(payload) : {};
  }
  return payload ?? {};
}

function valueAtPath(value, path) {
  if (!path) return value;
  return String(path).split('.').filter(Boolean).reduce((cursor, segment) => {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return undefined;
    return cursor[segment];
  }, value);
}

function stableText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`;
}

function stableIdPart(value) {
  const text = stableText(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function cleanKind(value) {
  const text = readString(value);
  return text ? text.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : 'effect';
}

function readEvent(input, index) {
  const event = requireRecord(input, `events[${index}]`);
  const payload = requireRecord(event.payload, `events[${index}].payload`);
  const facts = Array.isArray(payload.facts) ? payload.facts.map((fact, factIndex) => {
    const record = requireRecord(fact, `events[${index}].payload.facts[${factIndex}]`);
    return {
      attributes: isRecord(record.attributes) ? record.attributes : {},
      fact_id: requireString(record.fact_id, `events[${index}].payload.facts[${factIndex}].fact_id`),
      object: requireString(record.object, `events[${index}].payload.facts[${factIndex}].object`),
      relation: requireString(record.relation, `events[${index}].payload.facts[${factIndex}].relation`),
      subject: requireString(record.subject, `events[${index}].payload.facts[${factIndex}].subject`),
    };
  }) : [];
  return {
    payload: {
      event_id: requireString(payload.event_id, `events[${index}].payload.event_id`),
      facts,
      idempotency_key: requireString(payload.idempotency_key, `events[${index}].payload.idempotency_key`),
      namespace: requireString(payload.namespace, `events[${index}].payload.namespace`),
      occurred_at: requireString(payload.occurred_at, `events[${index}].payload.occurred_at`),
      supersedes: Array.isArray(payload.supersedes) ? payload.supersedes.filter((item) => typeof item === 'string') : [],
    },
    proof: isRecord(event.proof) ? event.proof : {},
  };
}

function ruleMatches(rule, fact) {
  const relation = readString(rule.relation);
  const relations = Array.isArray(rule.relations) ? rule.relations.map(readString).filter(Boolean) : [];
  const relationMatched = relation ? relation === fact.relation : relations.includes(fact.relation);
  if (!relationMatched) return false;
  const objects = Array.isArray(rule.objects) ? rule.objects.map(readString).filter(Boolean) : [];
  if (objects.length && !objects.includes(fact.object)) return false;
  const requiredAttributes = Array.isArray(rule.required_attributes)
    ? rule.required_attributes.map(readString).filter(Boolean)
    : [];
  return requiredAttributes.every((key) => hasValue(fact.attributes?.[key]));
}

function selectedValue(selector, event, fact) {
  if (selector === null || selector === undefined) return undefined;
  if (typeof selector === 'string') return selector;
  if (!isRecord(selector)) return undefined;
  const source = readString(selector.from);
  let value;
  if (source === 'attribute') {
    value = fact.attributes?.[requireString(selector.key, 'selector.key')];
  } else if (source === 'event') {
    value = valueAtPath(event.payload, selector.path);
  } else if (source === 'proof') {
    value = valueAtPath(event.proof, selector.path);
  } else if (source === 'fact') {
    value = valueAtPath(fact, selector.path);
  }
  if ((value === undefined || value === null || value === '') && selector.fallback !== undefined) {
    return selectedValue(selector.fallback, event, fact);
  }
  return value;
}

function selectedText(selector, event, fact, label) {
  const value = selectedValue(selector, event, fact);
  return requireString(value, label);
}

function includeFields(target, fields, source, prefix = '') {
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = readString(field);
    if (!key) continue;
    const value = valueAtPath(source, key);
    if (value !== undefined) target[prefix ? `${prefix}${key}` : key] = value;
  }
}

function materialFor(rule, event, fact) {
  const descriptor = isRecord(rule.material) ? rule.material : {};
  const material = {
    ...(isRecord(descriptor.constants) ? descriptor.constants : {}),
    ...(descriptor.include_attributes === false ? {} : fact.attributes),
  };
  includeFields(material, descriptor.include_event_fields, event.payload);
  includeFields(material, descriptor.include_fact_fields, fact);
  return material;
}

function effectFor(rule, event, fact, canonicalHash) {
  const source = {
    event_id: event.payload.event_id,
    fact_id: fact.fact_id,
    relation: fact.relation,
    subject: fact.subject,
    object: fact.object,
  };
  return {
    effect_id: `${cleanKind(rule.effect_id_prefix ?? rule.effect_kind ?? fact.relation)}:${stableIdPart(source)}`,
    kind: readString(rule.effect_kind) ?? cleanKind(fact.relation),
    material: materialFor(rule, event, fact),
    object: selectedText(rule.object ?? { from: 'fact', path: 'object' }, event, fact, 'effect object'),
    proof: {
      canonical_hash: canonicalHash,
      signer_id: readString(event.proof.signer_id),
      signature_ref: readString(event.proof.signature_hex),
    },
    source_event_ids: [event.payload.event_id],
    subject: selectedText(rule.subject ?? { from: 'fact', path: 'subject' }, event, fact, 'effect subject'),
  };
}

function effectsFromEvents(descriptor, verifiedEvents) {
  const rules = Array.isArray(descriptor.effect_rules) ? descriptor.effect_rules.filter(isRecord) : [];
  if (!rules.length) throw new SignedEventEffectsRejectedError('descriptor.effect_rules must include at least one rule.');
  const effects = [];
  for (const { canonicalHash, event } of verifiedEvents) {
    for (const fact of event.payload.facts) {
      for (const rule of rules) {
        if (ruleMatches(rule, fact)) effects.push(effectFor(rule, event, fact, canonicalHash));
      }
    }
  }
  return [...new Map(effects.map((effect) => [effect.effect_id, effect])).values()];
}

function decodedReply(reply) {
  if (isRecord(reply) && 'payload' in reply) return decodeTargetPayload(reply.payload);
  return decodeTargetPayload(reply);
}

async function verifyEvents(descriptor, events, send) {
  const target = requireString(descriptor.verifier_target, 'descriptor.verifier_target');
  const verified = [];
  for (const event of events) {
    const reply = decodedReply(await send({
      target,
      payload: {
        body: { events: [event] },
        request_id: event.payload.event_id,
      },
    }));
    const evaluation = requireRecord(reply.evaluation, 'authority.evaluation');
    const hashes = requireRecord(evaluation.event_hashes, 'authority.evaluation.event_hashes');
    const canonicalHash = requireString(
      hashes[event.payload.event_id],
      `authority.evaluation.event_hashes.${event.payload.event_id}`,
    );
    verified.push({ canonicalHash, event });
  }
  return verified;
}

function fillTemplate(value, variables) {
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, variables));
  if (!isRecord(value)) return value;
  if (value.$kind === 'input') return valueAtPath(variables, value.path);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, fillTemplate(item, variables)]),
  );
}

function targetPayloadForWritePath(path, effect) {
  if (isRecord(path.payload)) return fillTemplate(path.payload, { effect });
  return {
    operation: readString(path.operation),
    definition_id: readString(path.definition_id),
    include_output: path.include_output !== false,
    input: effect,
  };
}

function assertDeclaredWritePath(policy, path) {
  const target = requireString(path.target, 'descriptor.write_path.target');
  const definitionId = requireString(path.definition_id, 'descriptor.write_path.definition_id');
  const allowed = Array.isArray(policy.allowed_write_paths)
    ? policy.allowed_write_paths.filter(isRecord)
    : [];
  const declared = allowed.some((item) => (
    readString(item.target) === target && readString(item.definition_id) === definitionId
  ));
  if (!declared) throw new SignedEventEffectsRejectedError('descriptor.write_path is not declared by dispatch policy.');
  return target;
}

async function writeEffects(policy, path, effects, send) {
  const target = assertDeclaredWritePath(policy, path);
  const replies = [];
  for (const effect of effects) {
    const reply = await send({
      target,
      payload: targetPayloadForWritePath(path, effect),
    });
    replies.push(decodedReply(reply));
  }
  return replies;
}

export async function admitSignedEventEffects(input = {}, _context) {
  if (Object.prototype.hasOwnProperty.call(input, 'descriptor')) {
    throw new SignedEventEffectsRejectedError('Caller-provided descriptors are not accepted.');
  }
  const descriptor = configuredDescriptor(
    'signed-event-effects-admission-descriptor',
    input.descriptor_ref,
    'descriptor_ref',
  );
  const policy = configuredDescriptor(
    'signed-event-effects-dispatch-policy',
    descriptor.dispatch_policy_ref,
    'descriptor.dispatch_policy_ref',
  );
  const send = requireSender(input.send);
  const body = isRecord(input.body) ? input.body : input;
  const events = readRows(body.events).map(readEvent);
  const verifiedEvents = await verifyEvents(descriptor, events, send);
  const effects = effectsFromEvents(descriptor, verifiedEvents);
  const writePath = requireRecord(descriptor.write_path, 'descriptor.write_path');
  const writeReplies = await writeEffects(policy, writePath, effects, send);
  return {
    admitted_count: effects.length,
    effects,
    request_id: readString(input.request_id),
    write_replies: writeReplies,
  };
}

export async function listSignedEventEffects(input = {}, _context) {
  if (Object.prototype.hasOwnProperty.call(input, 'descriptor')) {
    throw new SignedEventEffectsRejectedError('Caller-provided descriptors are not accepted.');
  }
  const descriptor = configuredDescriptor(
    'signed-event-effects-list-descriptor',
    input.descriptor_ref,
    'descriptor_ref',
  );
  const send = requireSender(input.send);
  const subject = requireString(input.subject, 'subject');
  const target = requireString(descriptor.reader_target, 'descriptor.reader_target');
  const query = fillTemplate(
    isRecord(descriptor.query) ? descriptor.query : {},
    { subject },
  );
  const reply = await send({ target, payload: query });
  const decoded = decodedReply(reply);
  const effects = readRows(decoded).map(payloadOf).filter(isRecord);
  return {
    account_id: subject,
    effects,
  };
}
