// Every completed checkout since a time and every subscription that ended since a time, read from a stand-in Stripe
// whose answers are shaped like Stripe test mode (cs_test_..., sub_test_...). No key and no network: the stand-in
// records the built requests and answers from a queue. Proves the query sent, the paging, the offer filter, the
// fields that come back (and the ones that do not), the order, and where the next read starts.
import { describe, expect, it } from './expect.mjs';
import { listCompletedHostedSessions, listEndedSubscriptions } from '../do-work/hosted-session.ts';

type Sent = { method: string; url: string; headers: Record<string, string>; body?: string };

function stripe(...replies: Array<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const send = async (request: Sent) => { sent.push(request); return queue.shift() ?? {}; };
  return { sent, send };
}

const session = (id: string, created: number, offer: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'checkout.session', livemode: false, status: 'complete', created, amount_total: 29900, currency: 'usd',
  customer_details: { email: `${id}@example.com`, address: { country: 'US' }, phone: '+15555550100' },
  payment_method_types: ['card'], subscription: `sub_test_${id}`, metadata: { offer_id: offer, price_option_id: 'price:seat-monthly' },
  ...extra,
});

describe('completed checkouts since a time', () => {
  it('sends status=complete and the time, reads every page, keeps one offer, and returns oldest first', async () => {
    const { sent, send } = stripe(
      { data: [session('cs_test_c', 1790000300, 'offer:seat'), session('cs_test_x', 1790000200, 'offer:other')], has_more: true },
      { data: [session('cs_test_a', 1790000100, 'offer:seat')], has_more: false },
    );
    const read = await listCompletedHostedSessions({ created_after_unix: 1790000000, offer_id: 'offer:seat' }, { send });
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('/v1/checkout/sessions');
    expect(sent[0].url).toContain('status=complete');
    expect(decodeURIComponent(sent[0].url)).toContain('created[gte]=1790000000');
    expect(sent[1].url).toContain('starting_after=cs_test_x');
    expect(read.checkouts.map(item => item.provider_session_id)).toEqual(['cs_test_a', 'cs_test_c']);
    expect(read).toMatchObject({ complete: true, pages_read: 2, next_created_after_unix: 1790000300 });
    expect(read.checkouts[0]).toEqual({
      provider_session_id: 'cs_test_a', created: 1790000100, customer_email: 'cs_test_a@example.com', offer_id: 'offer:seat',
      price_option_id: 'price:seat-monthly', amount_total_cents: 29900, currency: 'usd', subscription_id: 'sub_test_cs_test_a',
    });
    expect(JSON.stringify(read)).not.toContain('+15555550100');
    expect(JSON.stringify(read)).not.toContain('country');
  });

  it('a read cut short says so and starts the next read at the same time; an empty read keeps the time', async () => {
    const pages = Array.from({ length: 3 }, (_, index) => ({ data: [session(`cs_test_${index}`, 1790000100 + index, 'offer:seat')], has_more: true }));
    const cut = await listCompletedHostedSessions({ created_after_unix: 1790000000, max_pages: 3 }, stripe(...pages));
    expect(cut).toMatchObject({ complete: false, pages_read: 3, next_created_after_unix: 1790000000 });
    const empty = await listCompletedHostedSessions({ created_after_unix: 1790000000 }, stripe({ data: [], has_more: false }));
    expect(empty).toMatchObject({ checkouts: [], complete: true, next_created_after_unix: 1790000000 });
  });

  it('refuses without a time before sending anything', async () => {
    const { sent, send } = stripe();
    await expect(listCompletedHostedSessions({ offer_id: 'offer:seat' }, { send })).rejects.toThrow(/created_after_unix/);
    expect(sent.length).toBe(0);
  });
});

describe('subscriptions that ended since a time', () => {
  it('sends status=canceled, keeps only those that ended after the time, oldest first, with their metadata', async () => {
    const { sent, send } = stripe({ data: [
      { id: 'sub_test_b', object: 'subscription', livemode: false, status: 'canceled', ended_at: 1790000500, metadata: { offer_id: 'offer:seat' }, customer: 'cus_test_b' },
      { id: 'sub_test_old', object: 'subscription', status: 'canceled', ended_at: 1789999000, metadata: {} },
      { id: 'sub_test_a', object: 'subscription', status: 'canceled', ended_at: 1790000400, metadata: { offer_id: 'offer:seat' } },
    ], has_more: false });
    const read = await listEndedSubscriptions({ ended_after_unix: 1790000000 }, { send });
    expect(sent[0].url).toContain('/v1/subscriptions');
    expect(sent[0].url).toContain('status=canceled');
    expect(read.ended).toEqual([
      { subscription_id: 'sub_test_a', ended_at: 1790000400, metadata: { offer_id: 'offer:seat' } },
      { subscription_id: 'sub_test_b', ended_at: 1790000500, metadata: { offer_id: 'offer:seat' } },
    ]);
    expect(JSON.stringify(read)).not.toContain('cus_test_b');
    await expect(listEndedSubscriptions({}, stripe())).rejects.toThrow(/ended_after_unix/);
  });
});

describe('checking a listed checkout before following it up', () => {
  // A per-person monthly price with a 7-day trial, sold through a payment link with an adjustable quantity. The offer
  // says it is per person as DATA: one person is included in amount_cents and each more person adds unit_cents.
  const offers = [{ kind: 'commercial-offer', id: 'offer:seat', label: 'Seat', price_options: [
    { id: 'price:seat-monthly', label: '$299/month per person', currency: 'usd', payment_timing: 'subscription', interval: 'month', amount_cents: 29900, included_units: 1, unit_price_curve: [{ up_to_units: null, unit_cents: 29900 }], trial_days: 7 },
  ] }];

  it('a paid checkout for whole people matches; a trial checkout is checked by its subscription amount; a price swap does not', async () => {
    const { checkWhatWasPaid } = await import('../do-work/take-payments.mjs');
    expect(await checkWhatWasPaid({ offer_id: 'offer:seat', offers, paid: { amountCents: 89700, currency: 'usd' } }, {})).toMatchObject({ matches: true });
    // A trial checkout's amount_total is 0; its subscription's recurring amount (tool:look-up-a-stripe-checkout) is what is checked.
    expect(await checkWhatWasPaid({ offer_id: 'offer:seat', offers, paid: { amountCents: 29900 * 3, currency: 'usd' } }, {})).toMatchObject({ matches: true });
    expect(await checkWhatWasPaid({ offer_id: 'offer:seat', offers, paid: { amountCents: 5000, currency: 'usd' } }, {})).toMatchObject({ matches: false });
    expect(await checkWhatWasPaid({ offer_id: 'offer:seat', offers, paid: { amountCents: 29900, currency: 'eur' } }, {})).toMatchObject({ matches: false });
  });
});
