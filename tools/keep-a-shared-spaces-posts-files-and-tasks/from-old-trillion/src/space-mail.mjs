// src/space-mail.mjs
//
// Purpose
//   A business's own email, read and answered together in a space. Two account actions, each a Workshop tool
//   (records/workshop-account-tool-records.json):
//     add-to-a-space           one thing added to a space this person is in, from any rule or AI: words, a title, the
//                              fields it carries, where it came from (source_ref, so the same thing twice is kept once)
//                              and what it answers (reply_to_source). Mail is one use; any event source can feed it.
//     connect-mail-to-a-space  reads which domains the business's own mail service keeps (the account's connection,
//                              never Trillion's), then sets two rules over owners that already exist: mail arriving at
//                              those addresses becomes a message in the space (events listen + an event rule running
//                              add-to-a-space), and a reply written there to a mail goes out through the service (a
//                              space-item rule running the service's send tool) from the address the mail came to.
//
// Non-Negotiable Invariants
//   - Every mail service is a row of src/space-mail.json providers; nothing here names one.
//   - Mail is sent and read only with the connecting person's own connection; credentials never pass through here.
//   - Setting the rules again (the same space) replaces them, so connecting twice never sends twice.
//
// Key Concepts
//   The arriving and send shapes are DATA (src/space-mail.json arrived, send): which event field fills which body field.
import settings from './space-mail.json' with { type: 'json' };
import { selectDeclaredValue } from '../../../ui/read-data/declared-selector.ts';

export class SpaceMailError extends Error {
  constructor(message, next_call = null) { super(message); this.status = 400; this.next_call = next_call; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
// The first of a value or list of values that holds words.
const firstText = value => [value].flat().find(each => typeof each === 'string' && each.trim() !== '') ?? null;
const present = value => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);
const addressOf = text => (String(text).match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? String(text).trim()).toLowerCase();
const domainOf = address => addressOf(address).split('@')[1] ?? '';
const fill = (from, field) => ({ fill: { from, field } });

export const providerById = id => settings.providers.find(row => row.id === id) ?? null;

/** One thing added to a space this person is in. → { space_id, item_id, added } */
export async function addToSpace(store, { space_id: spaceId, kind, title, text, body, source_ref: sourceRef, reply_to: replyTo, reply_to_source: replyToSource, app } = {}) {
  if (!firstText(spaceId)) throw new SpaceMailError('space_id names a pursuit this person is in.', { tool: 'list_pursuits', arguments: {} });
  const said = firstText(text);
  const fields = Object.fromEntries(Object.entries(object(body) ? body : {}).filter(([, value]) => present(value)));
  const item = {
    kind: firstText(kind) ?? 'message',
    ...(firstText(title) ? { title: firstText(title) } : {}),
    body: { ...fields, ...(said ? { text: said } : {}) },
    ...(firstText(sourceRef) ? { source_ref: firstText(sourceRef) } : {}),
    ...(firstText(replyTo) ? { reply_to: firstText(replyTo) } : present(replyToSource) ? { reply_to_source: [replyToSource].flat().filter(present) } : {}),
  };
  const { added, ids } = await store.network().addSpaceItems({ relay: store.relay(), space_id: spaceId, items: [item], app: firstText(app) });
  return { space_id: spaceId, item_id: ids[0], added: added.length === 1 };
}

// The arriving rule's input: every field filled from the event as src/space-mail.json `arrived` says, with what a
// reply needs (`reply_with`) sent from `sendAs` when the rule is for one address, else from the address it came to.
function arrivingInput(spaceId, provider, sendAs) {
  const { arrived } = settings;
  const fromEvent = field => fill('event', field);
  const mapped = map => Object.fromEntries(Object.entries(map).map(([name, field]) => [name, fromEvent(field)]));
  return {
    space_id: spaceId, kind: arrived.kind, app: provider.app,
    title: fromEvent(arrived.title),
    text: arrived.text.map(fromEvent),
    source_ref: arrived.source_ref.map(fromEvent),
    reply_to_source: arrived.reply_to_source.map(fromEvent),
    body: { ...mapped(arrived.body), reply_with: { send_as: sendAs ?? fromEvent(arrived.send_as_field), ...mapped(arrived.reply_with) } },
  };
}
// The sending rule's input: the send tool's fields filled from the item as `send.input` says.
const sendingInput = () => Object.fromEntries(Object.entries(settings.send.input).map(([name, field]) => [name, fill('item', field)]));

/**
 * Connects a space to the business's own mail. input: { space_id, provider?, addresses?: [address], send_as? }.
 * addresses left out means every address on every domain that receives; send_as is the address replies go out from
 * unless a message names another (the first address when left out). Arriving rules this space no longer wants are
 * retired. → { space_id, addresses, send_as, rules, retired, said }
 */
export async function connectMail(store, { space_id: spaceId, provider: providerId = settings.providers[0].id, addresses, send_as: sendAs } = {}) {
  const provider = providerById(providerId);
  if (!provider) throw new SpaceMailError(`provider is one of ${settings.providers.map(row => row.id).join(', ')}.`);
  if (!firstText(spaceId)) throw new SpaceMailError('space_id names a pursuit this person is in.', { tool: 'list_pursuits', arguments: {} });
  const named = { provider: provider.label, keys_at: provider.keys_at, receiving_help: provider.receiving_help };
  const read = await store.workshop().run({ tool_id: provider.domains_tool_id, input: {}, request_key: `space-mail-domains:${spaceId}:${crypto.randomUUID()}`, wait_seconds: 30, job: `read which domains ${provider.label} keeps` });
  if (read.state !== 'completed') throw new SpaceMailError(words(settings.words.not_connected, named), { tool: 'connect_service', arguments: { service: provider.vendor } });
  const domains = [selectDeclaredValue(read.output, provider.domains_selector)].flat().filter(object);
  if (!domains.length) throw new SpaceMailError(words(settings.words.no_domain, named));
  const nameOf = domain => String(domain[provider.domain_name_field] ?? '').toLowerCase();
  const receives = domain => provider.receiving_field.reduce((at, key) => at?.[key], domain) === provider.receiving_on;
  const wanted = [addresses].flat().filter(firstText).map(addressOf);
  for (const address of wanted) {
    if (!domains.some(domain => nameOf(domain) === domainOf(address))) throw new SpaceMailError(words(settings.words.not_on_domain, { ...named, address, domains: domains.map(nameOf).join(', ') }));
  }
  const used = wanted.length ? domains.filter(domain => wanted.some(address => domainOf(address) === nameOf(domain))) : domains.filter(receives);
  const off = (used.length ? used : domains).find(domain => !receives(domain));
  if (off || !used.length) throw new SpaceMailError(words(settings.words.receiving_off, { ...named, domain: nameOf(off ?? domains[0]) }));
  const from = firstText(sendAs) ?? (wanted[0] ? wanted[0] : null);
  if (from && !domains.some(domain => nameOf(domain) === domainOf(from))) throw new SpaceMailError(words(settings.words.not_on_domain, { ...named, address: addressOf(from), domains: domains.map(nameOf).join(', ') }));

  await store.eventRules().listen({ source_id: provider.event_source_id });
  // One arriving rule per address, so a reply goes out from the address the mail came to; with no addresses, one rule
  // for every address on the receiving domains.
  const arriving = [];
  for (const address of wanted.length ? wanted : [null]) {
    arriving.push(await store.automations().setRule({
      rule_id: `mail-in:${spaceId}:${address ?? 'all'}`,
      label: `Mail to ${address ?? used.map(nameOf).map(name => `@${name}`).join(', ')} arrives in this space`,
      when: { source_id: provider.event_source_id, event: provider.event, ...(address ? { words: [address], whole_word: false, field: 'to' } : {}) },
      then: { tool_id: 'tool:add-to-a-space', input: arrivingInput(spaceId, provider, address ? (addressOf(from ?? '') === address ? from : address) : from) },
    }));
  }
  // The arriving rules this space made before that are no longer wanted (the all-address rule once addresses are named,
  // or an address no longer named) are retired; another space's rules and the other prefixes are not this connection's.
  const retired = [];
  for (const rule of (await store.automations().listRules()).rules) {
    const id = String(rule.rule_id ?? '');
    if (!id.startsWith(`mail-in:${spaceId}:`) || arriving.some(kept => kept.rule_id === id)) continue;
    await store.automations().removeRule({ rule_id: id });
    retired.push(id);
  }
  const sending = await store.automations().setRule({
    rule_id: `mail-out:${spaceId}`,
    label: `Mail written in this space goes out through ${provider.label}`,
    when: { space_id: spaceId, kind: settings.arrived.kind, where: [{ field: settings.send.where_field, present: true }] },
    then: { tool_id: provider.send_tool_id, input: sendingInput() },
  });
  const shown = wanted.length ? wanted : used.map(domain => `@${nameOf(domain)}`);
  const said = words(settings.words.connected, { addresses: shown.join(', '), send_as: from ?? shown[0] });
  // The space says once that its mail comes in here now, in the words every member reads; connecting again adds nothing.
  await store.network().addSpaceItems({ relay: store.relay(), space_id: spaceId, app: provider.app, items: [{ kind: settings.arrived.kind, source_ref: `mail-connected:${provider.id}:${shown.join(',')}`, body: { text: said } }] });
  return {
    space_id: spaceId, provider: provider.id, addresses: shown, send_as: from,
    rules: [...arriving.map(rule => rule.rule_id), sending.rule_id].filter(Boolean),
    retired,
    said,
  };
}

/** The account actions (placement:this-account) a person store mixes in. */
export const spaceMailActions = store => ({
  'add-to-a-space': input => addToSpace(store, input ?? {}),
  'connect-mail-to-a-space': input => connectMail(store, input ?? {}),
});
