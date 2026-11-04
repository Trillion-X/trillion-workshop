// What a maker of paid Marketplace tools is owed, and the setup that lets them be paid (src/maker-payouts.json).
// Earnings come from the shared pool's sale rows; a payee account is opened, read and set up only through the
// payment provider's operation rows the settings name, so nothing here knows which provider it is.
import settings from './maker-payouts.json' with { type: 'json' };

const at = (value, path) => path.reduce((item, key) => (item == null ? undefined : item[key]), value);
const money = micros => `$${(micros / 1e6).toFixed(4)}`;

/** A kept payee and what the provider last said about it → { state, needs }. */
export function payeeState(payee, config = settings) {
  if (!payee?.payee_ref) return { state: 'not_set_up', needs: [] };
  if (payee.ready) return { state: 'ready', needs: [] };
  return { state: 'needs_details', needs: payee.needs ?? [] };
}

/** Sale rows and the kept payee → what the maker earned, what was given back, what is owed and what can be paid now. */
export function payoutStatus({ sales = [], payee = null, config = settings }) {
  const kept = sales.filter(sale => !sale.refunded_at && sale.currency === config.currency);
  const earned = kept.reduce((sum, sale) => sum + sale.micros, 0);
  const refunded = sales.filter(sale => sale.refunded_at).reduce((sum, sale) => sum + sale.micros, 0);
  const paid = Number.isSafeInteger(payee?.paid_micros) ? payee.paid_micros : 0;
  const owed = Math.max(earned - paid, 0);
  const setup = payeeState(payee, config);
  const payable = setup.state === 'ready' && owed >= config.minimum_micros ? owed : 0;
  const next = setup.state === 'not_set_up' ? 'Set up payouts to be paid what your tools earn.'
    : setup.state === 'needs_details' ? 'Finish payout setup: the payment page still needs some details.'
    : payable ? 'Ready to be paid.' : `Paid once ${money(config.minimum_micros)} is owed.`;
  return {
    earned: money(earned), earned_micros: earned, given_back: money(refunded), paid: money(paid),
    owed: money(owed), owed_micros: owed, payable: money(payable), payable_micros: payable,
    minimum: money(config.minimum_micros), currency: config.currency,
    payee: setup, next,
  };
}

/**
 * maker     the maker's opaque identity (the seller on its sale rows)
 * sales     () → this maker's sale rows
 * payee     { read() → kept payee | null, keep(payee) }
 * provider  { run({ operation_id, input_facts, idempotency_key }) → the provider's JSON } or null when payouts are not open
 */
export function makeMakerPayouts({ maker, sales, payee, provider = null, config = settings, now = () => new Date() }) {
  const ops = config.operations;
  const need = () => {
    if (!provider) throw new Error('Payouts are not open on this Trillion yet. What your tools earn is kept and shown here until they are.');
  };

  async function refresh(kept) {
    const account = await provider.run({ operation_id: ops.read_payee, input_facts: { provider_object_ref: kept.payee_ref } });
    const ready = at(account, config.ready_when.path) === config.ready_when.equals;
    const needs = [].concat(at(account, config.needs_path) ?? []);
    const next = { ...kept, ready, needs, checked_at: now().toISOString() };
    await payee.keep(next);
    return next;
  }

  return {
    async status() { return payoutStatus({ sales: await sales(), payee: await payee.read(), config }); },

    // Open the payee account once, then hand back the provider's page: its setup page while details are missing,
    // its dashboard sign-in once it can be paid.
    async setUp({ origin, email = null, country = null }) {
      need();
      let kept = await payee.read();
      if (!kept?.payee_ref) {
        const opened = await provider.run({
          operation_id: ops.open_payee,
          input_facts: { operation_subject: { country: country ?? config.country, ...(email ? { email } : {}), ...config.payee_settings, metadata: { maker } } },
          idempotency_key: `payee:${maker}`,
        });
        if (!opened?.id) throw new Error('The payment service did not open a payout account.');
        kept = { payee_ref: opened.id, opened_at: now().toISOString(), ready: false, needs: [] };
        await payee.keep(kept);
      }
      kept = await refresh(kept);
      const back = `${origin}${config.return_path}`;
      const page = kept.ready
        ? await provider.run({ operation_id: ops.payee_dashboard, input_facts: { provider_object_ref: kept.payee_ref } })
        : await provider.run({ operation_id: ops.payee_form, input_facts: { operation_subject: { account: kept.payee_ref, type: 'account_onboarding', return_url: back, refresh_url: back } } });
      if (!page?.url) throw new Error('The payment service did not give a page to open.');
      return { url: page.url, ...payoutStatus({ sales: await sales(), payee: kept, config }) };
    },
  };
}
