// tools/customer-follow-up/do-work/see-where-each-customer-is.mjs
//
// Where each customer is: their steps newest first, their latest step and product, and each product's progress toward
// its customer target (a purchase step counts a customer once). Run by the Workshop tool `tool:see-where-each-customer-is`
// in the tool container:
//
//   node do-work/see-where-each-customer-is.mjs < <the input as JSON>
//
// The records (customer-contact, customer-product-target and customer-step rows, bare or as { payload }) come in the
// input's `records`, or as a JSON file from the person's own files (`records_file`, read through the address the
// Workshop hands the run). When the caller sends neither, the Workshop fills `records` with the person's own customer
// records (the row's `x-your-records`). Prints the views as JSON on its last line.
import { text } from 'node:stream/consumers';
import { customerFollowUpViews, readCustomerFollowUpState } from '../read-data/read-customer-follow-up.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
const listed = value => (Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : []);
// A file the caller named wins over `records`, which the Workshop fills with the person's own records when not sent.
const rows = input.records_file ? listed(await (await fetch(input.records_file)).json()) : input.records ?? [];
const views = customerFollowUpViews(readCustomerFollowUpState(rows), input.contact_id);
console.log(JSON.stringify({ ...views, customer_count: views.contacts.length }));
