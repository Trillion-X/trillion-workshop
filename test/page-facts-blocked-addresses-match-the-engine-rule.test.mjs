// The page reader's copy of the blocked addresses and names (browse-public-page page-conventions.json, blocked_addresses)
// must equal the one service rule the engine applies (refuse-requests-to-private-addresses public-address.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const rule = json('../tools/refuse-requests-to-private-addresses/public-address.json');
const copy = json('../tools/browse-public-page/do-work/page-conventions.json').blocked_addresses;

test('the page reader blocks the same names and ranges as the service rule', () => {
  assert.deepEqual(copy.names, rule.private_names);
  assert.deepEqual(copy.ipv4, rule.blocked_ipv4.map(({ range }) => range));
  assert.deepEqual(copy.ipv6, rule.blocked_ipv6.map(({ range }) => range));
  assert.deepEqual(copy.ipv4_inside_ipv6, rule.ipv4_inside_ipv6.map(({ prefix }) => prefix));
});
