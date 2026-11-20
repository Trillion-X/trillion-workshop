// The two reads of the person's own payment service that the sales contract builder's offers and customers come from:
// which tool runs, with what input, under which connection, and where its list sits in the answer.
// Port of the Stripe sources in the builder DATA (src/sales-contract-builder.json at 3b7063d6f3). Storage-free and
// run-free: this names the reads; the builder's reader runs them and marks each one's state.
import data from './stripe-price-and-customer-reads.json' with { type: 'json' };

/** → [{ id, group, label, connection, run: { tool_id, input }, items }], one per Stripe source, in the DATA's order. */
export function stripeReadPlan() {
  return data.sources.map(source => ({
    id: source.id,
    group: source.group,
    label: source.label,
    connection: source.connection,
    run: { tool_id: source.tool_id, input: structuredClone(source.input) },
    items: [...source.items],
  }));
}
