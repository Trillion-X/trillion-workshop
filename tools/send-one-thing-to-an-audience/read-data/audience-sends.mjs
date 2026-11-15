// src/audience-sends.mjs
//
// PURPOSE
//   Sending one thing a person can share (a sales contract, a document, a decision, any shareable record) to an
//   audience: one person, people named by address, everyone in a list or a list view, the people an earlier send
//   reached in a given state, less anyone named in `except`. Each person gets their own link (src/record-sharing.mjs),
//   by every chosen channel, on an explicit run, now, at a time, or as each new person joins the list; with two or more prices, each person
//   lands on one price for good (src/price-experiments.mjs) and the results say sent, opened, signed and paid per price.
//   It is tool:send-to-an-audience; the Sales contracts screen's Send step and any AI reach this same owner.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One person is reached at most once per send, however often it runs: a delivery row is claimed (written) before
//      anything goes out, a run skips every person with a row, and a claim older than stale_claim_minutes is taken
//      again with the link it already made.
//   2. A run reaches at most page_size people, then sets itself to run again a minute later while people remain, so an
//      audience of any size and a run cut off midway both finish with the same code.
//   3. Channels, address kinds, audience states and words are DATA (src/audience-sends.json). A channel is a row whose
//      road is one of the delivery roads the host hands in; a send may also name any Workshop tool as its own channel.
//      Nothing here names a payment service, a messaging service or a record kind.
//   4. Timing uses the account's one rule and schedule owner (src/automations.mjs); there is no second scheduler.
//   5. Results are read from each link's own state and the price experiment's events, never kept twice.
//
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { audiencePolicy as bootstrap } from './audience-policy.mjs';
const databaseInputIdentity = value => makeHashCodeHexFromJson(value).slice(3);

export class AudienceSendError extends Error {}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sayWith = (settings, key, facts = {}) => String(settings.words[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(facts, name) ? String(facts[name]) : whole));
const refuseWith = (settings, key, facts) => { throw new AudienceSendError(sayWith(settings, key, facts)); };
const hash = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice(3, 27);

const normal = {
  email: value => String(value ?? '').trim().toLowerCase(),
  phone: value => String(value ?? '').replace(/[^\d+]/g, ''),
  postal: value => String(value ?? '').trim(),
};
const addressWith = (settings, kind, value) => {
  const clean = (normal[kind] ?? (v => String(v ?? '').trim()))(value);
  return clean && settings.addresses[kind] && new RegExp(settings.addresses[kind].pattern).test(clean) ? clean : null;
};
/** The one key a person is known by in a send: their email, else their phone, else their postal address. */
const keyOf = person => person.email ?? person.phone ?? person.postal ?? person.source_key ?? null;

const pathParts = path => typeof path === 'string' && /^(?:\$\.)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path)
  && !path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) ? path.replace(/^\$\./, '').split('.') : null;
export const audienceValueAt = (value, path) => pathParts(path)?.reduce((item, key) => item?.[key], value);
export function fillAudienceInput(value, facts) {
  if (typeof value === 'string') {
    const exact = /^\{([a-zA-Z0-9_.]+)\}$/.exec(value);
    if (exact) {
      const found = audienceValueAt(facts, exact[1]);
      if (found === undefined) throw new AudienceSendError(`The current audience facts lack ${exact[1]}.`);
      return found;
    }
    return value.replace(/\{([a-zA-Z0-9_.]+)\}/g, (whole, path) => {
      const found = audienceValueAt(facts, path);
      if (found === undefined) throw new AudienceSendError(`The current audience facts lack ${path}.`);
      return String(found);
    });
  }
  if (Array.isArray(value)) return value.map(item => fillAudienceInput(item, facts));
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillAudienceInput(item, facts)])) : value;
}

function cleanProjection(raw) {
  if (!object(raw) || !text(raw.tool_id) || !pathParts(raw.rows_path) || !object(raw.bindings)
      || !pathParts(raw.bindings.key) || !Object.entries(raw.bindings).every(([key, path]) => /^[a-zA-Z0-9_]+$/.test(key) && pathParts(path)))
    throw new AudienceSendError('A tool-backed audience needs its tool, row path and exact field bindings including a stable key.');
  if (raw.page && (!object(raw.page) || !pathParts(raw.page.next_cursor) || !pathParts(raw.page.complete) || !/^[a-zA-Z0-9_]+$/.test(raw.page.cursor_input)
      || ['__proto__', 'prototype', 'constructor'].includes(raw.page.cursor_input)))
    throw new AudienceSendError('A paged audience needs complete, next_cursor and cursor_input bindings.');
  if (raw.rules && (!object(raw.rules) || !Array.isArray(raw.fields) || !raw.fields.every(field => object(field) && text(field.id) && text(field.kind))))
    throw new AudienceSendError('An audience rule needs its declared fields and kinds.');
  return { tool_id: raw.tool_id.trim(), input: object(raw.input) ? raw.input : {}, rows_path: raw.rows_path,
    bindings: raw.bindings, ...(raw.page ? { page: raw.page } : {}), ...(object(raw.rules) ? { rules: raw.rules, fields: raw.fields ?? [] } : {}) };
}

/** A channel as the send keeps it: a row id, or a Workshop tool named as its own channel. */
function cleanChannelWith(settings, raw) {
  const CHANNELS = new Map(settings.channels.map(row => [row.id, row]));
  if (typeof raw === 'string' && CHANNELS.has(raw)) return raw;
  if (object(raw) && raw.road === 'tool' && text(raw.tool_id)) {
    if (raw.outcome && (!pathParts(raw.outcome.sent) || (raw.outcome.unknown && !pathParts(raw.outcome.unknown)))) throw new AudienceSendError('A tool channel outcome needs explicit sent and optional unknown paths.');
    return { road: 'tool', tool_id: raw.tool_id.trim(), label: text(raw.label) ? raw.label.trim() : raw.tool_id.trim(), address: Object.hasOwn(settings.addresses, raw.address) ? raw.address : 'email', ...(object(raw.input) ? { input: raw.input } : {}), ...(raw.outcome ? { outcome: raw.outcome } : {}) };
  }
  return refuseWith(settings, 'bad_channel', { channel: JSON.stringify(raw), channels: [...CHANNELS.keys()].join(', ') });
}
export const channelRow = (channel, settings = bootstrap) => (typeof channel === 'string' ? settings.channels.find(row => row.id === channel) : { ...channel, id: `tool:${channel.tool_id}` });
const channelId = channel => typeof channel === 'string' ? channel : `tool:${channel.tool_id}`;

/** A successful Workshop contract is distinct from the destination acknowledging delivery. */
export function audienceToolOutcome(task, row) {
  if (task.state !== 'completed' || task.contract?.passed !== true) return { sent: false, unknown: true, said: task.error ?? `${row.label}'s delivery result is not known.` };
  const sent = audienceValueAt(task.output, row.outcome?.sent ?? 'sent');
  const unknown = audienceValueAt(task.output, row.outcome?.unknown ?? 'unknown');
  return { sent: sent === true, ...(unknown === true || typeof sent !== 'boolean' ? { unknown: true } : {}), ...(task.output?.suppressed === true ? { suppressed: true } : {}), said: task.output?.said ?? task.output?.error ?? (sent === true ? `Sent through ${row.label}.` : `${row.label} did not confirm delivery.`) };
}

function cleanSourceWith(settings, raw, index) {
  if (object(raw) && raw.tool_id) return cleanProjection(raw);
  if (object(raw) && text(raw.list_id)) return { list_id: raw.list_id.trim(), ...(text(raw.view_id) ? { view_id: raw.view_id.trim() } : {}), ...(object(raw.rules) ? { rules: raw.rules } : {}) };
  if (object(raw) && Array.isArray(raw.people)) {
    const people = raw.people.map(person => ({
      ...(text(person?.name) ? { name: person.name.trim() } : {}),
      ...(addressWith(settings, 'email', person?.email) ? { email: addressWith(settings, 'email', person.email) } : {}),
      ...(addressWith(settings, 'phone', person?.phone) ? { phone: addressWith(settings, 'phone', person.phone) } : {}),
      ...(addressWith(settings, 'postal', person?.postal) ? { postal: addressWith(settings, 'postal', person.postal) } : {}),
    })).filter(keyOf);
    if (!people.length) refuseWith(settings, 'bad_source', { index: index + 1 });
    return { people };
  }
  if (object(raw) && text(raw.send_id) && Object.hasOwn(settings.audience_states, raw.state ?? 'sent')) return { send_id: raw.send_id.trim(), state: raw.state ?? 'sent' };
  return refuseWith(settings, 'bad_source', { index: index + 1 });
}

function cleanWhenWith(settings, raw, audience, now) {
  const kind = object(raw) ? raw.kind : raw ?? 'now';
  if (!settings.timings.includes(kind)) refuseWith(settings, 'bad_timing');
  if (kind === 'at') {
    const at = Date.parse(raw.at);
    if (!Number.isFinite(at) || at <= now()) refuseWith(settings, 'bad_time');
    return { kind, at: new Date(at).toISOString() };
  }
  if (kind === 'each_new' && !audience.some(source => source.list_id)) refuseWith(settings, 'each_new_needs_list');
  return { kind };
}

/**
 * The audience sends of one account.
 * eeaf: { read, write, ids }; lists: { rowsOf(list_id) → { list, rows: [{ id, values }] } };
 * filterRows({ tree, fields, rows }) → { matches }; ruleKindOf(fieldKind) → the formula engine's kind;
 * isShareable(record) → { title } (throws when it cannot be shared); isPriced(record) → boolean;
 * makeLink({ send, person, arm }) → { share_id, address }; linkOpen(record, share_id) → boolean;
 * linkState(record, share_id) → { opened, signed, paid } | null;
 * roads: { [road]: (row, { send, person, link, share_id, attempt, delivery_words }) → { sent, said } } (row is the channel row; attempt is
 * that channel's try count for this person, 1 then 2 and so on, so a host can vary its request key on a retry; a road
 * that throws is recorded unknown and is not called again);
 * experiments: { save, assign, record, results }; automations: { schedule({ once_at, input, label }) → { schedule_id },
 * watch({ recorded, input, label }) → { rule_id }, forget({ rule_id?, schedule_id? }) };
 * ownAddresses() → [addresses]; now() → ms.
 */
export function makeAudienceSends(options) {
  // Content reads belong to this independently addressed consumer, only when an
  // operation needs current defaults. Historical receipts and stops remain usable
  // even while a publisher is unavailable. No module-global catalogue is changed.
  if (typeof options.readContent === 'function') {
    const { readContent, ...host } = options;
    const retained = makeAudienceSends(host);
    const selected = async () => makeAudienceSends({ ...host, content: await readContent(), readContentForDispatch: readContent });
    return { ...retained,
      ...Object.fromEntries(['save', 'run', 'list', 'audience'].map(operation => [operation, async input => (await selected())[operation](input)])),
    };
  }
  return audienceSendsWithContent(options);
}

function audienceSendsWithContent({ eeaf, lists, readTool, filterRows, ruleKindOf = kind => kind, isShareable, isPriced, makeLink, linkOpen = () => true, linkState, roads, experiments, automations, ownAddresses = () => [], now = () => Date.now(), newId = () => crypto.randomUUID(), content = bootstrap, readContentForDispatch }) {
  const settings = content;
  const say = (key, facts) => sayWith(settings, key, facts);
  const refuse = (key, facts) => refuseWith(settings, key, facts);
  const address = (kind, value) => addressWith(settings, kind, value);
  const cleanChannel = raw => cleanChannelWith(settings, raw);
  const cleanSource = (raw, index) => cleanSourceWith(settings, raw, index);
  const cleanWhen = (raw, audience, now) => cleanWhenWith(settings, raw, audience, now);
  const CHANNELS = new Map(settings.channels.map(row => [row.id, row]));
  const currentChannel = channel => channelRow(channel, settings);
  const sendId = id => `${settings.send_type}:${String(id ?? '').replace(new RegExp(`^${settings.send_type}:`), '')}`;
  const deliveryType = id => `${settings.delivery_type}:${id}`;
  const deliveryId = (id, key) => `${deliveryType(id)}:${hash(key)}`;
  const iso = () => new Date(now()).toISOString();
  const write = (id, type, value) => eeaf.write([{ id, type, value }], { actor: { by: 'audience-sends' } });

  async function read(id) {
    const send = await eeaf.read(sendId(id));
    if (!send) refuse('no_send', { send_id: id ?? '(none)' });
    return send;
  }
  const deliveriesOf = async id => (await Promise.all((await eeaf.ids(deliveryType(id))).map(row => eeaf.read(row)))).filter(Boolean);
  const stoppedAddress = async value => Boolean(await eeaf.read(`${settings.do_not_send_type}:${hash(value)}`));

  async function peopleOfTool(source, facts = {}) {
    if (!readTool) throw new AudienceSendError('This account cannot read the current tool-backed audience.');
    const input = fillAudienceInput(source.input, facts), seen = new Set(), rows = [];
    let cursor;
    for (let page = 0; page < settings.most_source_pages; page += 1) {
      const output = await readTool(source.tool_id, { ...input, ...(cursor ? { [source.page.cursor_input]: cursor } : {}) });
      const found = audienceValueAt(output, source.rows_path);
      if (!Array.isArray(found) || found.length > settings.most_source_rows_per_page) throw new AudienceSendError('The current audience tool did not return a bounded row page.');
      rows.push(...found);
      if (!source.page) break;
      const complete = audienceValueAt(output, source.page.complete);
      if (complete === true) break;
      const next = audienceValueAt(output, source.page.next_cursor);
      if (complete !== false || !text(next) || seen.has(next) || page + 1 === settings.most_source_pages)
        throw new AudienceSendError('The current audience is incomplete; no delivery can use this read.');
      seen.add(next); cursor = next;
    }
    const result = source.rules ? await filterRows({ tree: source.rules, fields: source.fields, rows }) : { matches: rows.map((_, index) => index) };
    if (result.incomplete?.length || !Array.isArray(result.matches) || result.matches.some(index => !Number.isSafeInteger(index) || index < 0 || index >= rows.length))
      throw new AudienceSendError('The current audience eligibility rule could not be checked.');
    return result.matches.map(index => {
      const values = Object.fromEntries(Object.entries(source.bindings).map(([key, path]) => [key, audienceValueAt(rows[index], path)]));
      if (!text(values.key)) throw new AudienceSendError('Every audience row needs its stable source key.');
      const person = { source_key: values.key, facts: values };
      if (text(values.name)) person.name = values.name;
      for (const kind of Object.keys(settings.addresses)) if (address(kind, values[kind])) person[kind] = address(kind, values[kind]);
      return person;
    });
  }

  async function currentPerson(send, person) {
    if (!send.eligibility) return person;
    const found = await peopleOfTool(send.eligibility, { ...person.facts, ...person });
    const matching = found.filter(row => keyOf(row) === person.key && (!person.source_key || row.source_key === person.source_key));
    if (matching.length !== 1 || Object.keys(settings.addresses).some(kind => person[kind] && person[kind] !== matching[0][kind])) return null;
    return { ...person, ...matching[0], key: person.key };
  }

  /** Rows of one list as people, through its view's rules (or rules given) by the formula engine. */
  async function peopleOfList(source) {
    const { list, rows } = await lists.rowsOf(source.list_id);
    const saved = source.rules ? null : (list.views ?? []).find(view => view.id === source.view_id);
    if (saved?.unresolved_filters?.length) throw new Error(`The view ${saved.id} uses a saved filter that is gone; mend it before sending to it.`);
    const tree = source.rules ?? saved?.rules ?? null;
    const kept = tree ? (await filterRows({ tree, fields: list.fields.map(field => ({ id: field.id, kind: ruleKindOf(field.kind) })), rows: rows.map(row => row.values) })).matches.map(index => rows[index]) : rows;
    const fieldFor = kind => list.fields.find(field => settings.addresses[kind].field_kinds.includes(field.kind))?.id;
    const fields = Object.fromEntries(Object.keys(settings.addresses).map(kind => [kind, fieldFor(kind)]));
    return kept.map(row => {
      const person = { row_ref: `${source.list_id}:${row.id}`, ...(row.values?.[list.title_field] ? { name: String(row.values[list.title_field]) } : {}) };
      for (const [kind, field] of Object.entries(fields)) if (field && address(kind, row.values?.[field])) person[kind] = address(kind, row.values[field]);
      return person;
    });
  }
  async function peopleOfSend(source) {
    const send = await read(source.send_id);
    const people = [];
    for (const row of (await deliveriesOf(source.send_id)).filter(row => row.state === 'sent')) {
      const state = row.share_id ? await linkState(send.record, row.share_id) ?? {} : {};
      if (source.state !== 'sent' && !{ opened: state.opened, not_opened: !state.opened, signed: state.signed, paid: state.paid, not_paid: !state.paid }[source.state]) continue;
      const { name, email, phone, postal, row_ref } = row;
      people.push({ name, email, phone, postal, row_ref });
    }
    return people;
  }
  async function peopleOf(sources) {
    const found = new Map();
    for (const source of sources) {
      const people = source.tool_id ? await peopleOfTool(source) : source.list_id ? await peopleOfList(source) : source.send_id ? await peopleOfSend(source) : source.people;
      for (const person of people) {
        const key = keyOf(person);
        // A row with no address is still one of the audience: the run says why it was skipped.
        found.set(key ?? `row:${person.row_ref}`, { ...found.get(key), ...Object.fromEntries(Object.entries(person).filter(([, value]) => value !== undefined)), key: key ?? `row:${person.row_ref}` });
      }
    }
    return found;
  }
  async function audienceOf(send) {
    const people = await peopleOf(send.audience);
    for (const key of (await peopleOf(send.except ?? [])).keys()) people.delete(key);
    return [...people.values()];
  }

  async function arrange(send) {
    for (const id of send.rule_ids ?? []) await automations.forget({ rule_id: id }).catch(() => null);
    for (const id of send.schedule_ids ?? []) await automations.forget({ schedule_id: id }).catch(() => null);
    const input = { operation: 'run', send_id: send.id };
    if (send.when.kind === 'at') {
      const { schedule_id } = await automations.schedule({ once_at: send.when.at, input, label: `Send ${send.title}` });
      return { schedule_ids: [schedule_id], rule_ids: [] };
    }
    if (send.when.kind === 'each_new') {
      const rule_ids = [];
      for (const source of send.audience.filter(item => item.list_id)) {
        const { list } = await lists.rowsOf(source.list_id);
        rule_ids.push((await automations.watch({ recorded: `record:${list.row_type}`, input, label: `Send ${send.title} to each new person in ${list.label}` })).rule_id);
      }
      return { schedule_ids: [], rule_ids };
    }
    return { schedule_ids: [], rule_ids: [] };
  }

  /** Save (or change) a send. `manual` keeps it without dispatch or scheduling; `now` also runs its first page. */
  async function save(input = {}) {
    if (!text(input.record)) refuse('needs_record');
    const shared = await isShareable(input.record.trim());
    const audience = (Array.isArray(input.audience) ? input.audience : []).map(cleanSource);
    if (!audience.length) refuse('needs_audience');
    const except = (Array.isArray(input.except) ? input.except : []).map(cleanSource);
    const channels = (Array.isArray(input.channels) ? input.channels : []).map(cleanChannel);
    if (!channels.length) refuse('needs_channel', { channels: [...CHANNELS.keys()].join(', ') });
    for (const channel of channels) {
      const row = currentChannel(channel);
      if (!Object.hasOwn(roads, row.road) || typeof roads[row.road] !== 'function')
        throw new AudienceSendError('This audience channel has no admitted delivery road.');
    }
    const when = cleanWhen(input.when, audience, now);
    const prices = input.prices === undefined || input.prices === null ? [] : input.prices;
    if (!Array.isArray(prices) || (prices.length && (prices.length < 2 || prices.length > settings.most_prices)) || prices.some(cents => !Number.isSafeInteger(cents) || cents < 1)) refuse('bad_prices', { most: settings.most_prices });
    if (prices.length && !await isPriced(input.record.trim())) refuse('prices_need_contract');
    // How long each person's link stays open (until) and what it lets them do (can): the link owner's own fields
    // (src/record-sharing.mjs), carried on every link this send makes, so a send can end and can let people act.
    const until = input.until === undefined || input.until === null ? null : String(input.until);
    if (until !== null && !(Date.parse(until) > now())) refuse('bad_until');
    const can = input.can === undefined || input.can === null ? null : input.can;
    if (can !== null && (!Array.isArray(can) || !can.length || can.some(item => !text(item)))) refuse('bad_can');
    const id = text(input.send_id) ? sendId(input.send_id) : sendId(newId());
    const earlier = await eeaf.read(id);
    const title = text(input.title) ? input.title.trim() : shared.title ?? input.record;
    let experiment_id = text(input.experiment_id) ? input.experiment_id.trim() : earlier?.experiment_id ?? null;
    if (prices.length) {
      const currency = text(input.currency) ? input.currency.trim().toLowerCase() : 'usd';
      experiment_id = (await experiments.save({ experiment_id: experiment_id ?? `experiment:${id}`, label: title, arms: prices.map((cents, index) => ({ id: `price-${index + 1}`, amount_cents: cents, currency })) })).experiment.id;
    }
    const send = {
      id, record: input.record.trim(), title, audience, ...(except.length ? { except } : {}), channels, when,
      channel_definitions: Object.fromEntries(channels.filter(channel => typeof channel === 'string').map(channel => [channel, databaseInputIdentity(currentChannel(channel))])),
      ...(input.eligibility ? { eligibility: cleanProjection(input.eligibility) } : {}),
      ...(text(input.note) ? { note: input.note.trim().slice(0, 2000) } : {}),
      ...(until !== null ? { until: new Date(until).toISOString() } : {}), ...(can !== null ? { can: can.map(item => item.trim()) } : {}),
      ...(experiment_id ? { experiment_id } : {}), ...(text(input.funnel_id) ? { funnel_id: input.funnel_id.trim() } : {}),
      state: 'saved', created_at: earlier?.created_at ?? iso(), updated_at: iso(), rule_ids: earlier?.rule_ids ?? [], schedule_ids: earlier?.schedule_ids ?? [],
    };
    await write(id, settings.send_type, send);
    const arranged = await arrange(send);
    const kept = { ...send, ...arranged };
    await write(id, settings.send_type, kept);
    const matching = (await audienceOf(kept)).length;
    if (when.kind === 'now') return { send: await eeaf.read(id), matching, ...(await run({ send_id: id })) };
    return { send: kept, matching, said: say('saved', { count: matching }) };
  }

  const stale = row => row.state === 'claimed' && now() - Date.parse(row.claimed_at) > settings.stale_claim_minutes * 60_000;
  /** The channels of one row a run may call again: answered no (not unknown), with the tries left. */
  const retryable = channels => Object.keys(channels ?? {}).filter(id => !channels[id].sent && !channels[id].unknown && channels[id].attempts !== undefined && channels[id].attempts < settings.most_channel_attempts);

  /** One page of the send: claim, link, deliver by every channel, keep what happened. */
  async function run({ send_id } = {}) {
    const send = await read(send_id);
    if (send.state === 'stopped') refuse('stopped');
    const people = await audienceOf(send);
    const own = new Set((await ownAddresses()).map(value => String(value).toLowerCase()));
    const counts = { sent: 0, skipped: 0, failed: 0, unknown: 0 };
    let handled = 0;
    let remaining = 0;
    let retrying = false;
    for (const person of people) {
      const id = deliveryId(send.id, person.key);
      const earlier = await eeaf.read(id);
      const again = retryable(earlier?.channels);
      if (earlier && !stale(earlier) && !(['sent', 'failed', 'unknown'].includes(earlier.state) && again.length)) continue;
      if (handled >= settings.page_size) { remaining += 1; continue; }
      handled += 1;
      // The door claims the delivery by comparing the exact earlier observation before anything leaves.
      const claim = { send_id: send.id, ...person, state: 'claimed', claim_token: crypto.randomUUID(), claimed_at: iso(), ...(earlier?.share_id ? { share_id: earlier.share_id, link: earlier.link, arm: earlier.arm } : {}), ...(earlier?.channels ? { channels: earlier.channels } : {}) };
      if (!await eeaf.claim(id, deliveryType(send.id), claim)) continue;
      const skip = async reason => { await write(id, deliveryType(send.id), { ...claim, state: 'skipped', reason, done_at: iso() }); counts.skipped += 1; };
      if (!keyOf(person)) { await skip(say('no_address', { address: 'address' })); continue; }
      if ([person.email, person.phone].some(value => value && own.has(value))) { await skip(say('yourself')); continue; }
      if ((await Promise.all([person.email, person.phone, person.postal].filter(Boolean).map(stoppedAddress))).some(Boolean)) { await skip(say('asked_not_to')); continue; }
      try {
        const arm = claim.arm ?? (send.experiment_id ? await experiments.assign({ experiment_id: send.experiment_id, observer: person.key }) : null);
        const reuse = claim.share_id && await linkOpen(send.record, claim.share_id);
        const link = reuse ? { share_id: claim.share_id, address: claim.link } : await makeLink({ send, person, arm });
        if (!reuse) await eeaf.write([{ id: `${settings.share_index_type}:${link.share_id}`, type: settings.share_index_type, value: { send_id: send.id, delivery: id } }], { actor: { by: 'audience-sends' } });
        // Channels that sent, or may have, keep their earlier answer; a channel that answered no is called again.
        const through = { ...earlier?.channels };
        for (const channel of send.channels) {
          const row = currentChannel(channel), idOfChannel = channelId(channel);
          if (earlier?.channels?.[idOfChannel] && !again.includes(idOfChannel)) continue;
          // A removed/replaced default never retargets a queued delivery. Private
          // tool channel objects keep their own definition and canonical gates.
          const original = null; // A receipt without its accepted definition cannot adopt a newly published default.
          const accepted = typeof channel === 'string' ? send.channel_definitions?.[channel] ?? (original ? databaseInputIdentity(original) : null) : null;
          const changed = !row || !Object.hasOwn(roads, row.road) || typeof roads[row.road] !== 'function'
            || typeof channel === 'string' && accepted !== databaseInputIdentity(row);
          if (changed) { through[idOfChannel] = { sent: false, said: 'The selected delivery channel changed; create a new send before sending.', attempts: settings.most_channel_attempts }; continue; }
          const attempts = (earlier?.channels?.[row.id]?.attempts ?? 0) + 1;
          let current;
          try {
            current = await currentPerson(send, person);
            // A still-open link is not current content approval. Recheck the
            // same share owner before every channel, including reused links.
            await isShareable(send.record);
            if (typeof channel === 'string' && readContentForDispatch) {
              const fresh = channelRow(channel, await readContentForDispatch({ dispatch: true }));
              if (!fresh || databaseInputIdentity(fresh) !== databaseInputIdentity(row)) throw Object.assign(new AudienceSendError('The selected delivery channel changed before dispatch.'), { channel_changed: true });
            }
          }
          catch (error) {
            through[row.id] = { sent: false, said: String(error?.message ?? error), attempts: error?.channel_changed ? settings.most_channel_attempts : earlier?.channels?.[row.id]?.attempts ?? 0 };
            continue;
          }
          if (!current) { through[row.id] = { sent: false, said: 'The current recipient is not eligible for this delivery.', attempts: settings.most_channel_attempts }; continue; }
          if ((await Promise.all([current.email, current.phone, current.postal].filter(Boolean).map(stoppedAddress))).some(Boolean)) { through[row.id] = { sent: false, said: say('asked_not_to'), attempts: settings.most_channel_attempts }; continue; }
          const to = row.address ? current[row.address] : null;
          if (row.address && !to) { through[row.id] = { sent: false, said: say('no_address', { address: row.address }), attempts }; continue; }
          if (row.road === 'tool' && !row.tool_id) { through[row.id] = { sent: false, said: say('not_connected', { label: row.label, needs: row.needs }), attempts }; continue; }
          try {
            // Keep possible dispatch before the effect. Recovery must never replay an effect whose result was lost.
            through[row.id] = { sent: false, unknown: true, said: 'The delivery was dispatched; its result is not yet known.', attempts };
            await write(id, deliveryType(send.id), { ...claim, share_id: link.share_id, link: link.address, channels: { ...through } });
            const outcome = await roads[row.road](row, { send, person: current, to, link: link.address, share_id: link.share_id, attempt: attempts, delivery_words: settings.words });
            // Every road needs a typed acknowledgement. Tool completion or a
            // truthy string cannot prove an effect, or authorize its replay.
            through[row.id] = { ...outcome, sent: outcome?.sent === true,
              ...(outcome?.unknown === true || typeof outcome?.sent !== 'boolean' ? { unknown: true } : {}), attempts };
            if (through[row.id].suppressed === true && to) {
              await doNotSend({ address: to });
              through[row.id].attempts = settings.most_channel_attempts;
            }
          } catch (error) {
            through[row.id] = { sent: false, unknown: true, said: String(error?.message ?? error), attempts };
          }
        }
        const reached = Object.values(through).some(item => item.sent === true);
        const state = reached ? 'sent' : Object.values(through).some(item => item.unknown) ? 'unknown' : 'failed';
        await write(id, deliveryType(send.id), {
          ...claim, share_id: link.share_id, link: link.address, ...(arm?.arm ? { arm: { arm: arm.arm, label: arm.label, amount_cents: arm.amount_cents, currency: arm.currency } } : claim.arm ? { arm: claim.arm } : {}),
          channels: through, state, ...(reached ? {} : { reason: Object.values(through).map(item => item.said).filter(Boolean).join(' ') }), done_at: iso(),
        });
        if (earlier?.state !== state) counts[state] += 1;
        if (retryable(through).length) retrying = true;
      } catch (error) {
        await write(id, deliveryType(send.id), { ...claim, state: 'failed', reason: String(error?.message ?? error), done_at: iso() });
        counts.failed += 1;
      }
    }
    let next = null;
    const later = remaining ? settings.next_page_after_seconds : retrying ? settings.retry_after_seconds : null;
    if (later) next = (await automations.schedule({ once_at: new Date(now() + later * 1000).toISOString(), input: { operation: 'run', send_id: send.id }, label: `Keep sending ${send.title}` })).schedule_id;
    const after = { ...await read(send.id), state: remaining || retrying || send.when.kind === 'each_new' ? 'sending' : 'sent', last_run_at: iso() };
    await write(send.id, settings.send_type, after);
    return { send_id: send.id, ...counts, remaining, ...(next ? { next_schedule_id: next } : {}), said: remaining ? say('sending', { sent: counts.sent, remaining }) : say('done', { sent: counts.sent, skipped: counts.skipped }) };
  }

  /** Who it reached and what each did, grouped by price, with the price experiment's money. */
  async function results({ send_id } = {}) {
    const send = await read(send_id);
    const rows = await deliveriesOf(send.id);
    const people = await Promise.all(rows.map(async row => {
      const state = row.state === 'sent' && row.share_id ? await linkState(send.record, row.share_id) ?? {} : {};
      return { name: row.name ?? null, address: row.email ?? row.phone ?? row.postal ?? null, state: row.state, reason: row.reason ?? null, price: row.arm?.label ?? null, arm: row.arm?.arm ?? null, opened: Boolean(state.opened), signed: Boolean(state.signed), paid: Boolean(state.paid), channels: row.channels ?? {}, link: row.link ?? null, done_at: row.done_at ?? null,
        ...(row.imported === true ? { imported: true, source_ref: row.source_ref } : {}) };
    }));
    const groups = new Map();
    for (const person of people.filter(row => row.state === 'sent')) {
      const key = person.arm ?? 'one-price';
      const group = groups.get(key) ?? { arm: person.arm, price: person.price, sent: 0, opened: 0, signed: 0, paid: 0 };
      group.sent += 1; group.opened += person.opened ? 1 : 0; group.signed += person.signed ? 1 : 0; group.paid += person.paid ? 1 : 0;
      groups.set(key, group);
    }
    const money = send.experiment_id ? await experiments.results({ experiment_id: send.experiment_id }).catch(() => null) : null;
    const byPrice = [...groups.values()].map(group => ({ ...group, ...(money ? (({ money_cents, money_per_shown_cents }) => ({ money_cents, money_per_shown_cents }))(money.arms.find(arm => arm.arm === group.arm) ?? {}) : {}) }));
    // One successful channel does not acknowledge all the others. Imported
    // sent receipts retain their real historical source instead of invented
    // per-channel answers; unknown/failed history still remains unconfirmed.
    const unconfirmedChannels = rows.reduce((count, row) => count + (row.state === 'skipped' || (row.imported === true && row.state === 'sent' && text(row.source_ref)) ? 0
      : send.channels.filter(channel => row.channels?.[channelId(channel)]?.sent !== true || row.channels?.[channelId(channel)]?.unknown === true).length), 0);
    return { send, totals: { people: people.length, sent: people.filter(row => row.state === 'sent').length, skipped: people.filter(row => row.state === 'skipped').length, failed: people.filter(row => row.state === 'failed').length, unknown: people.filter(row => row.state === 'unknown').length, unconfirmed_channels: unconfirmedChannels }, by_price: byPrice, people, ...(money ? { leading: money.leading } : {}) };
  }

  /** A payment through a send's link counts toward its price. */
  const paid=input=>recordAudiencePayment({eeaf,experiments,settings},input);

  async function stop({ send_id } = {}) {
    const send = await read(send_id);
    for (const rule_id of send.rule_ids ?? []) await automations.forget({ rule_id }).catch(() => null);
    for (const schedule_id of send.schedule_ids ?? []) await automations.forget({ schedule_id }).catch(() => null);
    const kept = { ...send, state: 'stopped', rule_ids: [], schedule_ids: [], updated_at: iso() };
    await write(send.id, settings.send_type, kept);
    return { send: kept };
  }

  async function list() {
    const sends = (await Promise.all((await eeaf.ids(settings.send_type)).map(id => eeaf.read(id)))).filter(Boolean).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { sends, channels: settings.channels, audience_states: settings.audience_states, timings: settings.timings, screen: settings.screen };
  }

  /** Someone who asked not to get these: no send from this account reaches that address again. */
  async function doNotSend({ address: given } = {}) {
    const value = addressWith(settings, 'email', given) ?? addressWith(settings, 'phone', given);
    if (!value) refuseWith(settings, 'bad_source', { index: 1 });
    await write(`${settings.do_not_send_type}:${hash(value)}`, settings.do_not_send_type, { at: iso() });
    return { address: value, kept: true };
  }

  /** Actual legacy delivery evidence is imported into this same ledger before replacing a sender. Never overwrites an attempt. */
  async function importReceipts({ send_id, receipts } = {}) {
    const send = await read(send_id);
    if (!Array.isArray(receipts) || !receipts.length || receipts.length > settings.most_source_rows_per_page)
      throw new AudienceSendError('Import one bounded page of actual delivery receipts.');
    const admitted = receipts.map(receipt => {
      if (!object(receipt) || !text(receipt.key) || !text(receipt.source_ref) || !Number.isFinite(Date.parse(receipt.at))
          || !['sent', 'unknown', 'failed', 'skipped'].includes(receipt.state)) throw new AudienceSendError('Every receipt needs its exact key, source reference, actual time and observed state.');
      const person = Object.fromEntries(Object.keys(settings.addresses).map(kind => [kind, address(kind, receipt[kind])]).filter(([, value]) => value));
      const key = addressWith(settings, 'email', receipt.key) ?? addressWith(settings, 'phone', receipt.key) ?? receipt.key.trim();
      return { key, ...person, ...(text(receipt.name) ? { name: receipt.name.trim() } : {}), ...(text(receipt.reason) ? { reason: receipt.reason } : {}),
        source_ref: receipt.source_ref, state: receipt.state, send_id: send.id, imported: true, done_at: new Date(receipt.at).toISOString(), channels: {} };
    });
    const kept = [], existing = [];
    for (const receipt of admitted) {
      const id = deliveryId(send.id, receipt.key);
      if (await eeaf.read(id)) { existing.push(receipt.key); continue; }
      if (!await eeaf.claim(id, deliveryType(send.id), receipt)) { existing.push(receipt.key); continue; } kept.push(receipt.key);
    }
    return { send_id: send.id, kept, existing };
  }

  return { save, run, results, paid, stop, list, import_receipts: importReceipts, read: ({ send_id } = {}) => read(send_id), do_not_send: doNotSend, audience: async ({ send_id } = {}) => audienceOf(await read(send_id)) };
}

export const audienceSendOperations = ['save', 'run', 'results', 'stop', 'list', 'read', 'do_not_send', 'audience', 'import_receipts'];

export async function recordAudiencePayment({eeaf,experiments,settings=bootstrap}, { share_id, amount_cents, currency, event_id } = {}) {
    const index = await eeaf.read(`${settings.share_index_type}:${share_id}`);
    if (!index) return null;
    const send = await eeaf.read(index.send_id);
    const row = await eeaf.read(index.delivery);
    if (!send?.experiment_id || !row?.arm) return null;
    return experiments.record({ experiment_id: send.experiment_id, observer: row.key, moment: 'paid', amount_cents, currency, event_id: event_id ?? share_id, arm: row.arm.arm });
}
