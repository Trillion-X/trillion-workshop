// Billing reads editable service pricing through the invoking operator's actual
// Workshop records door. Neither the screen request nor a rule's client scope
// supplies seller authority. Saving remains the published tool's operation.
import { usagePricingControls } from './usage-pricing-controls.mjs';

const TOOL = 'tool:manage-usage-pricing';
const PAGE = 100;

export async function readBillingPricingControls(host, { now = () => new Date().toISOString() } = {}) {
  // This host predicate is derived from the admitted account/resource identity,
  // not an editable customer record. A customer's own pricing records are not
  // Trillion's service pricing and are never fetched for this section.
  if (typeof host.isOperator !== 'function' || host.isOperator() !== true) return null;
  const answer = await host.runTool(TOOL, { action: 'list', limit: PAGE });
  if (!answer || !Array.isArray(answer.rules) || answer.rules.length > PAGE
    || (answer.next != null && typeof answer.next !== 'string')) {
    throw Object.assign(new Error('The current usage pricing rules could not be read.'), { status: 503 });
  }
  // A bounded first page keeps Billing responsive. The existing Manage pricing
  // rules action owns paging and the complete create/read/edit/retire lifecycle.
  // No supplier invoice, customer usage or other account's door is read here.
  return usagePricingControls({ can_edit: true, rules: answer.rules, effective_at: now() });
}
