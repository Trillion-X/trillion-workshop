// packages/stripe-payment-provider/processes/try-a-payment-schedule-in-test-mode.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build an offer's phases at the real provider, in TEST MODE, and report what
// the provider says it will charge and when.
//
// Everything else that checks this reads our own functions with our own
// functions. That proves the arithmetic agrees with itself and says nothing
// about what a card is charged. This asks the provider.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. TEST MODE ONLY, enforced twice: the test key is the only one read, and
//    the key is checked to start with a test prefix before anything is sent.
//    A live key reaching this would create real prices and real schedules on
//    the real account.
// 2. Reports what the PROVIDER said, never what we expected. The point is to
//    find out where those differ.
// 3. No product or customer identity lives here. The name on a test product is
//    the caller's to supply, because this package is reusable and a name in it
//    would be one app's identity in everyone's code.
//
// =============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STRIPE_API = 'https://api.stripe.com/v1';

/** The TEST key, and only the test key. */
export function testModeKey(configPath = join(homedir(), '.config', 'stripe', 'config.toml')) {
  const text = readFileSync(configPath, 'utf8');
  const line = text.split('\n').find((row) => row.trim().startsWith('test_mode_api_key'));
  const key = line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
  if (!key) throw new Error(`No test_mode_api_key in ${configPath}.`);
  if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    throw new Error('The key read was not a test key. Refusing to send anything.');
  }
  return key;
}

/** Stripe takes form bodies, and nested fields are bracketed paths. */
export function formBody(value, prefix = '', into = new URLSearchParams()) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (item === undefined || item === null) continue;
    if (Array.isArray(item)) {
      item.forEach((row, index) => {
        if (row && typeof row === 'object') formBody(row, `${name}[${index}]`, into);
        else into.append(`${name}[${index}]`, String(row));
      });
    } else if (typeof item === 'object') {
      formBody(item, name, into);
    } else {
      into.append(name, String(item));
    }
  }
  return into;
}

async function askStripe(path, body, key, fetchImplementation = fetch) {
  const reply = await fetchImplementation(`${STRIPE_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? formBody(body).toString() : undefined,
  });
  const answer = await reply.json();
  if (answer.error) throw new Error(`${answer.error.type}: ${answer.error.message}`);
  return answer;
}

/**
 * Build these phases at the provider and report what it says.
 *
 * Returns the provider's own view: each phase with when it starts and the
 * amount it bills, measured in days from the first phase.
 */
export async function tryAPaymentScheduleInTestMode({
  phases,
  productName,
  currency = 'usd',
  key = testModeKey(),
  fetchImplementation = fetch,
}) {
  if (!productName) throw new Error('a product name is required; this package holds no app identity');
  const ask = (path, body) => askStripe(path, body, key, fetchImplementation);

  const customer = await ask('/customers', { description: 'payment schedule check, test mode' });
  const product = await ask('/products', { name: productName });

  const priced = [];
  for (const phase of phases) {
    const price = await ask('/prices', {
      currency,
      unit_amount: Number(phase.amountCents),
      product: product.id,
      recurring: { interval: phase.recurring.interval, interval_count: phase.recurring.interval_count },
    });
    priced.push({ phase, priceId: price.id });
  }

  const schedule = await ask('/subscription_schedules', {
    customer: customer.id,
    start_date: 'now',
    end_behavior: 'release',
    phases: priced.map(({ phase, priceId }) => ({
      items: [{ price: priceId, quantity: 1 }],
      ...(phase.duration
        ? { duration: { interval: phase.duration.interval, interval_count: phase.duration.interval_count } }
        : {}),
    })),
  });

  const first = schedule.phases?.[0]?.start_date;
  return {
    schedule_id: schedule.id,
    status: schedule.status,
    what_the_provider_says: (schedule.phases ?? []).map((phase, index) => ({
      phase: index,
      amount_cents: Number(priced[index]?.phase.amountCents ?? 0),
      days_after_start: first ? Math.round((phase.start_date - first) / 86400) : 0,
    })),
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const [phasesText, productName] = process.argv.slice(2);
  const phases = JSON.parse(phasesText ?? '[]').map((phase) => ({
    ...phase,
    amountCents: BigInt(phase.amountCents),
  }));
  if (phases.length === 0 || !productName) {
    console.error('usage: try-a-payment-schedule-in-test-mode.mjs <phases json> <product name>');
    process.exit(2);
  }
  tryAPaymentScheduleInTestMode({ phases, productName })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
}
