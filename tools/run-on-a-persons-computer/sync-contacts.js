// computer/sync-contacts.js
//
// Purpose: reads the contacts on this Mac (every account Contacts shows: iCloud, so the iPhone's too, Google, Exchange)
// through the Contacts framework, and prints what changed since the last sync as request bodies for the person's list,
// one JSON line per batch. Run by computer/sync-contacts.zsh as `osascript -l JavaScript sync-contacts.js <settings>
// <state> <pending>`; the zsh sends each line and, once every line is accepted, makes <pending> the new <state>.
//
// Non-Negotiable Invariants:
//   1. The Contacts framework is the only reader: macOS lets a background program read contacts this way once the
//      person allows it, and refuses the Contacts database files to it.
//   2. Only contacts whose sent values changed are printed, except once every `resend_all_every_hours`, when all are,
//      so a list the person emptied fills again. A contact deleted here is not removed from the list.
//   3. Nothing is sent from here and no key is read here; the state holds only what was sent, on this Mac.
//   4. `personOf` and `plan` are plain functions of plain values, so they are checked without a Mac
//      (test/sync-contacts.test.mjs); only `readContacts` and `run` touch the Mac.

/** One contact as the list's person: its key and the values the list fills. Null when it names nobody. */
function personOf(contact) {
  const clean = value => (typeof value === 'string' ? value.trim() : '');
  const phones = (contact.phones || []).map(clean).filter(Boolean);
  const emails = (contact.emails || []).map(clean).filter(Boolean);
  const organization = clean(contact.organization);
  const name = [contact.given, contact.middle, contact.family].map(clean).filter(Boolean).join(' ')
    || clean(contact.nickname) || organization || phones[0] || emails[0] || '';
  if (!name && !phones.length && !emails.length) return null;
  const person = { key: contact.identifier, name };
  if (phones.length) person.phones = phones;
  if (emails.length) person.emails = emails;
  if (organization) person.organization = organization;
  if (clean(contact.job_title)) person.job_title = clean(contact.job_title);
  return person;
}

/**
 * contacts: [{ identifier, given, middle, family, nickname, organization, job_title, phones, emails }]
 * state:    { sent: { key: JSON text }, all_sent_at } or null
 * settings: sync-contacts.json; setup: { list: { id, label } }; now: an ISO time
 * → { bodies: [request body], pending: next state (with how many people it holds), people, changed }
 */
function plan(contacts, state, settings, setup, now) {
  const sent = (state && state.sent) || {};
  const lastAll = state && state.all_sent_at ? Date.parse(state.all_sent_at) : 0;
  const everyone = !lastAll || Date.parse(now) - lastAll >= settings.resend_all_every_hours * 3600000;
  const current = {};
  const changed = [];
  for (const contact of contacts) {
    const person = personOf(contact);
    if (!person) continue;
    const text = JSON.stringify(person);
    current[person.key] = text;
    if (everyone || sent[person.key] !== text) changed.push(person);
  }
  const bodies = [];
  for (let at = 0; at < changed.length; at += settings.batch_size) {
    bodies.push({ list_label: setup.list.label, source: settings.source, people: changed.slice(at, at + settings.batch_size) });
  }
  const people = Object.keys(current).length;
  return { bodies, pending: { sent: current, all_sent_at: everyone ? now : state.all_sent_at, people }, people, changed: changed.length };
}

/** Every contact on this Mac, as plain values; throws a word from settings when the person has not allowed it. */
function readContacts(settings) {
  ObjC.import('Contacts');
  const allowed = $.CNContactStore.authorizationStatusForEntityType($.CNEntityTypeContacts);
  if (allowed === $.CNAuthorizationStatusDenied || allowed === $.CNAuthorizationStatusRestricted) throw new Error(settings.words.no_access);
  const keys = ['identifier', 'givenName', 'middleName', 'familyName', 'nickname', 'organizationName', 'jobTitle', 'phoneNumbers', 'emailAddresses'].map(key => $(key));
  const request = $.CNContactFetchRequest.alloc.initWithKeysToFetch($(keys));
  const failed = $();
  const contacts = [];
  const values = (list, read) => { const out = []; for (let at = 0; at < list.count; at += 1) out.push(read(list.objectAtIndex(at).value)); return out; };
  const read = $.CNContactStore.alloc.init.enumerateContactsWithFetchRequestErrorUsingBlock(request, failed, contact => {
    contacts.push({
      identifier: ObjC.unwrap(contact.identifier),
      given: ObjC.unwrap(contact.givenName),
      middle: ObjC.unwrap(contact.middleName),
      family: ObjC.unwrap(contact.familyName),
      nickname: ObjC.unwrap(contact.nickname),
      organization: ObjC.unwrap(contact.organizationName),
      job_title: ObjC.unwrap(contact.jobTitle),
      phones: values(contact.phoneNumbers, value => ObjC.unwrap(value.stringValue)),
      emails: values(contact.emailAddresses, value => ObjC.unwrap(value)),
    });
  });
  if (!read) throw new Error(settings.words.no_access);
  return contacts;
}

const readJson = path => {
  const text = $.NSString.stringWithContentsOfFileEncodingError($(path).stringByExpandingTildeInPath, $.NSUTF8StringEncoding, null);
  return text.isNil() ? null : JSON.parse(ObjC.unwrap(text));
};
const writeJson = (path, value) => $(JSON.stringify(value)).writeToFileAtomicallyEncodingError($(path).stringByExpandingTildeInPath, true, $.NSUTF8StringEncoding, null);

// eslint-disable-next-line no-unused-vars -- osascript calls run(argv).
function run(argv) {
  const [settingsPath, setupPath, statePath, pendingPath] = argv;
  const settings = readJson(settingsPath);
  const planned = plan(readContacts(settings), readJson(statePath), settings, readJson(setupPath), new Date().toISOString());
  writeJson(pendingPath, planned.pending);
  return planned.bodies.map(body => JSON.stringify(body)).join('\n');
}
