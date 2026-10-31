// tools/take-payments/do-work/connect-payees.mjs
//
// Pay other people through Stripe Connect: a payee account, its Stripe-hosted onboarding, a checkout whose money goes
// to the payee with the platform's fee kept back (a destination charge), a share of that fee paid on to someone else,
// and the readiness check that says when a payee can be paid.
//
// Everything a platform chooses is DATA handed in by the caller: the payee account settings (country, controller
// properties, requested capabilities) and the fee (`{ percent }`). Nothing here names a platform, an app, a product
// or a price. Each function builds the subject of one Stripe operation in `read-data/stripe-operation-map.json`; the
// caller sends it with `call` (build-stripe-http-request.mjs) and the person's own key. This module holds no secret
// and makes no network call itself.
//
//   payeeAccountSubject({ settings, email, owner, payee_ref })            → operation:create-connected-account subject
//   onboardingLinkSubject({ account, refresh_url, return_url })            → operation:create-account-link subject
//   feeCents({ amount_cents, fee })                                        → the platform's cut of one payment
//   destinationCheckoutSubject({ offer, option, payee_account, fee, payer_ref, success_url, cancel_url, metadata })
//                                                                          → operation:create-session subject
//   shareTransferSubject({ amount_cents, currency, destination, source_transaction, metadata })
//                                                                          → operation:create-transfer subject
//   payeeReadiness(account)                                                → { can_be_paid, onboarding_done, due }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const INTERVALS = new Set(['day', 'week', 'month', 'year']);

/** A payee account from the platform's settings row: `{ country, controller, capabilities: [names] }`. */
export function payeeAccountSubject({ settings, email, owner, payee_ref }) {
  if (!object(settings) || typeof settings.country !== 'string' || !object(settings.controller)) throw new Error('Payee account settings need a country and controller properties.');
  if (typeof payee_ref !== 'string' || !payee_ref) throw new Error('payee_ref names whose account this is.');
  return {
    country: settings.country,
    ...(typeof email === 'string' && email ? { email } : {}),
    controller: settings.controller,
    capabilities: Object.fromEntries((settings.capabilities ?? []).map(name => [name, { requested: true }])),
    metadata: { owner, payee_ref },
  };
}

export function onboardingLinkSubject({ account, refresh_url, return_url }) {
  if (typeof account !== 'string' || !account) throw new Error('account is the payee account id.');
  return { account, refresh_url, return_url, type: 'account_onboarding', collection_options: { fields: 'eventually_due' } };
}

/** The platform's cut of one payment, in whole cents, from a fee row `{ percent }`. Never more than the amount. */
export function feeCents({ amount_cents, fee }) {
  if (!Number.isInteger(amount_cents) || amount_cents < 0) throw new Error('amount_cents must be a whole number of cents.');
  const percent = Number(fee?.percent);
  if (!(percent >= 0 && percent <= 100)) throw new Error('A fee is { percent } between 0 and 100.');
  return Math.min(amount_cents, Math.round((amount_cents * percent) / 100));
}

/**
 * One Stripe Checkout for one priced option. With a payee, the money goes to the payee's account and the platform's
 * fee is kept back (a destination charge); without one, the platform is paid. `option.payment_timing: 'subscription'`
 * (with `interval`) makes a subscription; anything else is paid once. The price is written inline, so no product or
 * price has to exist in Stripe first.
 */
export function destinationCheckoutSubject({ offer, option, payee_account = null, fee = null, payer_ref, success_url, cancel_url, metadata = {} }) {
  if (!object(offer) || typeof offer.id !== 'string') throw new Error('offer needs an id.');
  if (!object(option) || !Number.isInteger(option.amount_cents) || option.amount_cents <= 0 || typeof option.currency !== 'string') throw new Error(`${option?.id ?? 'The option'} needs a positive amount_cents and a currency to be paid for.`);
  if (typeof payer_ref !== 'string' || !payer_ref) throw new Error('payer_ref names who pays.');
  const recurring = option.payment_timing === 'subscription';
  if (recurring && !INTERVALS.has(option.interval)) throw new Error(`${option.id} is a subscription without a day, week, month or year interval.`);
  if (payee_account && !fee) throw new Error('A payment to a payee needs the platform fee row.');
  // The payer is named in the metadata too, because a renewal's invoice carries the subscription's metadata and not the
  // checkout's client_reference_id.
  const tags = { offer_id: offer.id, price_option_id: option.id, payer_ref, ...(payee_account ? { payee_account } : {}), ...metadata };
  const price_data = {
    currency: option.currency.toLowerCase(),
    unit_amount: option.amount_cents,
    product_data: { name: option.label ? `${offer.label ?? offer.id}: ${option.label}` : (offer.label ?? offer.id) },
    ...(recurring ? { recurring: { interval: option.interval } } : {}),
  };
  const toPayee = payee_account ? { transfer_data: { destination: payee_account } } : {};
  return {
    mode: recurring ? 'subscription' : 'payment',
    client_reference_id: payer_ref,
    line_items: [{ quantity: 1, price_data }],
    success_url,
    cancel_url,
    metadata: { ...tags, ...(payee_account ? { platform_fee_cents: String(feeCents({ amount_cents: option.amount_cents, fee })) } : {}) },
    ...(recurring
      ? { subscription_data: { metadata: tags, ...(payee_account ? { application_fee_percent: Number(fee.percent), ...toPayee } : {}) } }
      : { payment_intent_data: { metadata: tags, ...(payee_account ? { application_fee_amount: feeCents({ amount_cents: option.amount_cents, fee }), ...toPayee } : {}) } }),
  };
}

/** A share paid on from the platform's balance to another payee, tied to the payment it came from when known. */
export function shareTransferSubject({ amount_cents, currency, destination, source_transaction = null, metadata = {} }) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw new Error('A share is a positive whole number of cents.');
  if (typeof destination !== 'string' || !destination) throw new Error('destination is the payee account the share goes to.');
  return { amount: amount_cents, currency: String(currency).toLowerCase(), destination, ...(source_transaction ? { source_transaction } : {}), metadata };
}

/** Whether a payee account can be paid now, whether they finished onboarding, and what Stripe still needs. */
export function payeeReadiness(account) {
  const transfers = account?.capabilities?.transfers;
  return {
    can_be_paid: transfers === 'active',
    onboarding_done: account?.details_submitted === true,
    payouts_enabled: account?.payouts_enabled === true,
    due: [...new Set([...(account?.requirements?.currently_due ?? []), ...(account?.requirements?.past_due ?? [])])],
  };
}
