// tools/customer-follow-up/do-work/add-a-customer.mjs
//
// One customer as the customer-contact record to keep: their name, where you reach them, who owns them and where they
// came from, with a fresh id unless one is given (giving the same id again replaces that customer). Run by the Workshop
// tool `tool:add-a-customer` in the tool container:
//
//   node do-work/add-a-customer.mjs < <the input as JSON>
//
// and prints { contact_id, contact_record } as JSON on its last line. The Workshop keeps the record in the person's own
// records (the row's `keeps_records`), where the other customer tools read it.
import { text } from 'node:stream/consumers';

const input = JSON.parse((await text(process.stdin)) || '{}');
const clean = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const displayName = clean(input.name);
if (!displayName) throw new Error('Give the customer\'s name.');
const contactId = clean(input.contact_id) ?? `contact:${crypto.randomUUID()}`;
const record = { kind: 'customer-contact', contactId, displayName, channelLabel: clean(input.reach_them_by), ownerLabel: clean(input.owner), sourceLabel: clean(input.came_from) };
console.log(JSON.stringify({ contact_id: contactId, contact_record: JSON.parse(JSON.stringify(record)) }));
