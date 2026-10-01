// tools/customer-follow-up/do-work/set-a-customer-target.mjs
//
// How many customers a product aims for, as the customer-product-target record to keep. A product has one target, so
// setting it again replaces the earlier one. Run by the Workshop tool `tool:set-a-customer-target` in the tool
// container:
//
//   node do-work/set-a-customer-target.mjs < <the input as JSON>
//
// and prints { target_id, target_record } as JSON on its last line. The Workshop keeps the record in the person's own
// records (the row's `keeps_records`); see-where-each-customer-is counts each product's customers against it.
import { text } from 'node:stream/consumers';

const input = JSON.parse((await text(process.stdin)) || '{}');
const productId = typeof input.product_id === 'string' ? input.product_id.trim() : '';
const productLabel = typeof input.product_name === 'string' ? input.product_name.trim() : '';
if (!productId || !productLabel) throw new Error('Give the product\'s id and its name.');
if (!(Number.isInteger(input.customers) && input.customers >= 1)) throw new Error('Give how many customers the product aims for, a whole number of at least 1.');
const targetId = `target:${productId}`;
console.log(JSON.stringify({ target_id: targetId, target_record: { kind: 'customer-product-target', targetId, productId, productLabel, targetCount: input.customers, active: input.active !== false } }));
