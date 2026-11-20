// This one reaches the real provider with a real key, so the checks that
// matter are the ones that stop it reaching the WRONG account. A live key here
// would create real prices, a real customer and a real schedule while
// everybody believed they were looking at a rehearsal.

import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  testModeKey,
  formBody,
  tryAPaymentScheduleInTestMode,
} from './try-a-payment-schedule-in-test-mode.mjs';

function configHolding(text) {
  const path = join(tempFolder(join(tmpdir(), 'stripe-config-')), 'config.toml');
  writeFileSync(path, text);
  return path;
}

test('reads a test key', () => {
  assert.equal(
    testModeKey(configHolding("[p]\ntest_mode_api_key = 'sk_test_abc'\n")),
    'sk_test_abc',
  );
});

test('refuses a live key even when it is sitting in the test field', () => {
  // The field name is not the check. Somebody pasting a live key into the
  // wrong line is exactly how a rehearsal becomes real money.
  assert.throws(
    () => testModeKey(configHolding("[p]\ntest_mode_api_key = 'sk_live_abc'\n")),
    /not a test key/i,
  );
});

test('refuses when there is no test key at all', () => {
  assert.throws(
    () => testModeKey(configHolding("[p]\nlive_mode_api_key = 'sk_live_abc'\n")),
    /No test_mode_api_key/,
  );
});

test('refuses to build anything without a product name', async () => {
  // This package is reusable, so it holds no app's identity. A default name
  // here would put one product's name in every product's code.
  await assert.rejects(
    tryAPaymentScheduleInTestMode({ phases: [], key: 'sk_test_x', fetchImplementation: async () => ({}) }),
    /product name is required/,
  );
});

test('writes nested fields the way the provider reads them', () => {
  // Phases are nested arrays of objects. Getting this shape wrong sends a
  // schedule the provider silently reads as something else.
  const body = formBody({
    customer: 'cus_1',
    phases: [
      { items: [{ price: 'price_1', quantity: 1 }], duration: { interval: 'week', interval_count: 1 } },
      { items: [{ price: 'price_2', quantity: 1 }] },
    ],
  }).toString();

  assert.match(body, /phases%5B0%5D%5Bitems%5D%5B0%5D%5Bprice%5D=price_1/);
  assert.match(body, /phases%5B0%5D%5Bduration%5D%5Binterval%5D=week/);
  assert.match(body, /phases%5B1%5D%5Bitems%5D%5B0%5D%5Bprice%5D=price_2/);
  // The second phase has no duration and must not acquire one.
  assert.ok(!body.includes('phases%5B1%5D%5Bduration%5D'));
});

test('leaves out a field that was not set rather than sending it empty', () => {
  // An empty value is a value. Sending one tells the provider something the
  // caller never said.
  const body = formBody({ a: 1, b: null, c: undefined, d: 'x' }).toString();
  assert.equal(body, 'a=1&d=x');
});
