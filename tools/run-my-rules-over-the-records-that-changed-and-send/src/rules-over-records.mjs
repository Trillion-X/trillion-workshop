// src/rules-over-records.mjs
//
// Purpose: the trigger engine (crates/trigger-engine, run through crates/trigger-engine-web) as one call: rules and
// the records that changed go in, and what the rules send comes out. It is the Workshop tool
// tool:evaluate-rules-over-records (records/workshop-engine-tool-records.json), and a person's rules
// (src/automations.mjs) reach the engine only through that tool.
//
// Non-Negotiable Invariants:
//   1. Each call builds one engine, hands it every rule first (a rule never fires for a record it had not seen), then
//      the changes, and returns every send the rules made as `fires`, with the engine's own records (`writes`) and
//      failures. Nothing is kept between calls.
//   2. Without a host (an AI calling run_tool), nothing is sent anywhere: each send is answered as handed to the caller,
//      a read is answered from the changes and `records` given, and a list from those same records.
//   3. With a host (Trillion itself, in the same process), every request the engine makes goes to `host.answer` as the
//      engine's JSON request text, so the caller reads its own records and runs each send as it happens.
//   4. Nothing here names a rule, a record kind or a target.
//

const RULE_PATH = 'trigger-rule';
const list = value => (Array.isArray(value) ? value : []);

/** engine: () → the trigger engine's bindings ({ TriggerEngine }), or a promise of them. */
export function makeRulesOverRecords(engine) {
  /**
   * input: { rules: [trigger rule], changes: [{ address, path?, value } | { address, removed: true }],
   *          records?: [{ address, path?, value }], partition? }
   * host:  { answer(requestJson) → answer } when Trillion calls in the same process
   */
  async function evaluateRulesOverRecords(input, host = null) {
    const rules = list(input?.rules).map((rule, index) => ({ address: `${RULE_PATH}:${rule?.id ?? index}`, path: [RULE_PATH], value: rule }));
    const changes = list(input?.changes);
    const known = new Map([...list(input?.records), ...changes.filter(change => !change?.removed)].map(item => [item.address, item]));
    const fires = [];
    async function answer(requestJson) {
      const request = JSON.parse(requestJson);
      if (request.kind === 'send') fires.push({ target: request.target, payload: request.payload, later: request.later === true });
      if (host?.answer) return host.answer(requestJson);
      if (request.kind === 'send') return { handed_to_caller: true };
      if (request.kind === 'read') return known.get(request.address)?.value ?? null;
      if (request.kind === 'list') {
        const addresses = list(request.addresses);
        const entries = [...known.values()].filter(item => !addresses.length || addresses.includes(item.address));
        const start = Number(request.cursor ?? 0);
        const limit = Math.max(1, Number(request.limit ?? 100));
        return { entries: entries.slice(start, start + limit).map(item => ({ address: item.address, path: item.path ?? [], value: item.value })), next_cursor: start + limit < entries.length ? start + limit : null };
      }
      throw new Error(`The trigger engine asked for ${request.kind}, which is not answered here.`);
    }
    const { TriggerEngine } = await engine();
    const built = new TriggerEngine(String(input?.partition ?? 'rules'), answer);
    const results = [];
    if (rules.length) results.push(JSON.parse(await built.apply(JSON.stringify(rules))));
    if (changes.length) results.push(JSON.parse(await built.apply(JSON.stringify(changes))));
    return {
      fires,
      dispatch_failures: results.flatMap(result => result.dispatch_failures ?? []),
      writes: results.flatMap(result => result.writes ?? []),
    };
  }
  return { evaluateRulesOverRecords };
}
