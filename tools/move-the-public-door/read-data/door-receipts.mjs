// The receipts one door run needs between its own steps (a host lease, a DNS cutover, the move's journal), held in this
// run's memory and answered with the run's result. A receipt from an earlier run comes in as the run's input (`seed`,
// receipt name -> value); nothing is kept anywhere after the run. A receipt names provider identities, addresses and
// states, never a credential.
const receiptName = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** One receipt as a lease store { read(), save(lease) } (what the lease functions of tools/start-a-computer keep a lease in). */
export const receiptStore = (receipts, name) => ({ read: () => receipts.read(name), save: value => receipts.save(name, value) });

/** { read(name) -> value | null, save(name, value), all() -> { name: value } } over `seed`. */
export function keptReceipts(seed = {}) {
  const held = new Map(Object.entries(structuredClone(seed)));
  const check = name => {
    if (!receiptName.test(name ?? '')) throw new Error(`A receipt name is lower-case words joined by dashes; ${JSON.stringify(name)} was refused.`);
    return name;
  };
  return {
    read: async name => (held.has(check(name)) ? structuredClone(held.get(name)) : null),
    save: async (name, value) => { held.set(check(name), JSON.parse(JSON.stringify(value))); return structuredClone(held.get(name)); },
    all: () => Object.fromEntries(structuredClone([...held])),
  };
}
