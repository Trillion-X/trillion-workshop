// Who pays for one tool call, and the charge that pays for it.
//
// The runner (src/workshop.mjs) tries payers in this order:
//   1. the person's own connected account, when every connection the tool names is in their locked box: not charged;
//   2. Trillion credit, when the tool's row names a payer that Trillion can stand in for: Trillion's own account at a
//      gateway whose terms allow it (`tool-gateway.resale.allowed`) and whose key the platform box holds, or a maker's
//      price on a tool they published;
//   3. the maker's own billing, when the tool's row says the maker bills directly: the reply names where;
//   4. otherwise the reply names exactly what is missing: a sign-in to connect, credit, or the spend limit.
// A tool whose row says it is charged per gateway call (`billing.per: "gateway-call"`: a container that makes several
// calls, such as one picture per call) is not charged as a whole: each call it sends through the gateway (the
// Workshop's relay) is its own charge, keyed `<task id>~<n>`, and the task's reply adds them up.
// A charge is taken before the paid work starts, keyed by the task, so a retry or two AI apps sending the same task are
// charged once; it is given back when the work fails, and lowered to what the call actually cost when that is less.
import { chargeRefusal, creditOf, dollars, withMarkup } from '../../price-and-sell-by-contract/src/credit.mjs';
import { WorkshopError } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop.mjs';
import { deliveredIdentities } from '../../shared-code/src/sold-copies.mjs';

/** A tool charged per call it sends through the gateway, not as a whole (`billing.per`). */
export const PER_GATEWAY_CALL = 'gateway-call';

/**
 * credit     () → { effects, offer, access, lifecycle }: what the credit is read from
 * charges    { read(task_id), write(charge), list() }: this person's charge entries
 * limits     () → { limits, own }: the credit offer's spend limits and the person's own
 * gateways   () → gateway rows
 * platform   { holds(secret_name) → boolean }: whether the platform box holds a gateway key
 * sales      { post(sale) }: where a maker's earning from a charge is recorded
 * topUp      the words and call that add credit
 */
export function makePayers({ credit, charges, limits, gateways, platform, sales = null, topUp, now = () => new Date() }) {
  async function state() {
    if(typeof charges.balance==='function')return charges.balance();
    return creditOf({ ...(await credit()), charges: await charges.list() });
  }

  async function plan({ tool }) {
    const billing = tool.billing;
    if (!billing) return null;
    const allowed = billing.payers ?? [];
    if (allowed.includes('gateway-account') && billing.gateway) {
      const gateway = (await gateways()).find(item => item.id === billing.gateway);
      if (gateway?.resale.allowed && await platform.holds(gateway.credential.secret_name)) {
        if (billing.per === PER_GATEWAY_CALL) return { paid_by: 'trillion-credit', through: gateway.id, through_label: gateway.label, currency: 'usd', per: PER_GATEWAY_CALL, seller: 'platform' };
        const unquoted = Number(gateway.settings?.max_cost_usd_when_unquoted ?? 0) * 1e6;
        const base = Number.isSafeInteger(billing.price_micros) && billing.price_micros > 0 ? billing.price_micros : Math.round(unquoted);
        return { paid_by: 'trillion-credit', through: gateway.id, through_label: gateway.label, quote_micros: withMarkup(base, gateway.markup), currency: 'usd', per: billing.per ?? 'call', seller: 'platform' };
      }
    }
    if (allowed.includes('trillion-credit') && Number.isSafeInteger(billing.price_micros)) {
      return { paid_by: 'trillion-credit', quote_micros: billing.price_micros, currency: 'usd', per: billing.per ?? 'call', seller: billing.seller ?? 'platform' };
    }
    if (billing.maker_billing_url) {
      throw new WorkshopError(`${tool.label ?? tool.id} is paid to its maker directly, at ${billing.maker_billing_url}. Once the person has an account there, connect it and this tool runs on it.`);
    }
    return null;
  }

  // Take the charge for a task before its paid work starts. The same task is charged once.
  async function take(task) {
    const payer = task.payer;
    if (payer?.paid_by !== 'trillion-credit' || payer.per === PER_GATEWAY_CALL) return null;
    if(typeof charges.reserve==='function'){
      // Independent resources share the monetary invariant at its actual
      // account owner. A separate read/check/write sequence cannot reserve it.
      const result=await charges.reserve({task,at:now().toISOString()});
      const refusal=result?.refusal;
      if(refusal?.missing==='credit')throw new WorkshopError(`${task.label??task.tool_id} costs ${dollars(payer.quote_micros)} a ${payer.per}, and this account has ${dollars(Math.max(refusal.credit_micros,0))} of Trillion credit left. ${topUp.words}`,topUp.next_call);
      if(refusal)throw new WorkshopError(`This would pass the spend limit of ${dollars(refusal.limit_micros)} ${refusal.per==='once'?'in total':`a ${refusal.per}`}${refusal.scope==='app'?' for this AI app':''}: ${dollars(refusal.used_micros)} is already spent. The person can change their limit on their Trillion page.`);
      if(result?.charge?.task_id!==task.task_id||result.charge.given_back_at)throw new WorkshopError('The account monetary owner did not reserve this original tool call. Nothing was dispatched.');
      return result.charge;
    }
    const earlier = await charges.read(task.task_id);
    if (earlier && !earlier.given_back_at) return earlier;
    const at = now().toISOString();
    const { limits: rows, own } = await limits();
    const refusal = chargeRefusal({ credit: await state(), micros: payer.quote_micros, app: task.caller_app ?? null, at, charges: await charges.list(), limits: rows, ownLimits: own });
    if (refusal?.missing === 'credit') throw new WorkshopError(`${task.label ?? task.tool_id} costs ${dollars(payer.quote_micros)} a ${payer.per}, and this account has ${dollars(Math.max(refusal.credit_micros, 0))} of Trillion credit left. ${topUp.words}`, topUp.next_call);
    if (refusal) throw new WorkshopError(`This would pass the spend limit of ${dollars(refusal.limit_micros)} ${refusal.per === 'once' ? 'in total' : `a ${refusal.per}`}${refusal.scope === 'app' ? ' for this AI app' : ''}: ${dollars(refusal.used_micros)} is already spent. The person can change their limit on their Trillion page.`);
    const charge = { task_id: task.task_id, tool_id: task.tool_id, micros: payer.quote_micros, currency: payer.currency, app: task.caller_app ?? null, at, ...(payer.through ? { through: payer.through } : {}), seller: payer.seller };
    await charges.write(charge);
    return charge;
  }

  // After the work: a failed run gives the charge back; a cheaper actual cost lowers it; a maker's price is recorded
  // as that maker's earning. Returns what the reply says about payment.
  async function settle(task, { failed, actual_micros }) {
    const payer = task.payer;
    if (!payer) return null;
    if (payer.paid_by !== 'trillion-credit') return { paid_by: payer.paid_by };
    if(typeof charges.settle==='function'){
      const result=await charges.settle({task,failed,actual_micros});
      if(!result?.payment)throw new WorkshopError('The account monetary owner did not settle this original tool call.');
      if(result.pending)return {...result.payment,pending:true};
      if(result.sale&&sales)await sales.post({...result.sale,files:deliveredIdentities(task.output)});
      if(result.refund_sale_id&&sales?.refund)await sales.refund(result.refund_sale_id);
      return result.payment;
    }
    if (payer.per === PER_GATEWAY_CALL) return settleCalls(task, { failed });
    let charge = await charges.read(task.task_id);
    if (charge && failed && !charge.given_back_at) {
      charge = { ...charge, given_back_at: now().toISOString() };
      await charges.write(charge);
    } else if (charge && !failed && Number.isFinite(actual_micros) && payer.through) {
      const actual = withMarkup(actual_micros, (await gateways()).find(item => item.id === payer.through)?.markup);
      if (actual < charge.micros) { charge = { ...charge, micros: actual, quoted_micros: charge.micros }; await charges.write(charge); }
    }
    if (charge?.given_back_at && charge.seller !== 'platform' && sales?.refund) await sales.refund(task.task_id);
    if (charge && !failed && !charge.given_back_at && charge.seller !== 'platform' && sales) await sales.post({ sale_id: task.task_id, tool_id: task.tool_id, seller: charge.seller, micros: charge.micros, currency: charge.currency, at: charge.at, files: deliveredIdentities(task.output) });
    const left = await state();
    return {
      paid_by: 'trillion-credit', ...(payer.through ? { through: payer.through_label } : {}),
      charged: charge && !charge.given_back_at ? dollars(charge.micros) : '$0.00',
      ...(charge?.given_back_at ? { given_back: true } : {}),
      credit_left: dollars(left.micros),
    };
  }

  // A task charged per gateway call: each call was settled as it came back; a task that failed gives them all back.
  async function settleCalls(task, { failed }) {
    const prefix = `${task.task_id}~`;
    let calls = (await charges.list()).filter(charge => String(charge.task_id).startsWith(prefix));
    if (failed) {
      const at = now().toISOString();
      calls = await Promise.all(calls.map(async charge => {
        // Gateway callbacks already refund an actual refused/unsent call.
        // A failed parent cannot refund one that succeeded or remains unknown.
        if (charge.given_back_at || charge.through) return charge;
        const back = { ...charge, given_back_at: at };
        await charges.write(back);
        return back;
      }));
    }
    const kept = calls.filter(charge => !charge.given_back_at);
    const payer = task.payer;
    return {
      paid_by: 'trillion-credit', through: payer.through_label,
      charged: dollars(kept.reduce((sum, charge) => sum + charge.micros, 0)),
      ...(calls.length && !kept.length ? { given_back: true } : {}),
      credit_left: dollars((await state()).micros),
    };
  }

  return { plan, take, settle, credit: state };
}
