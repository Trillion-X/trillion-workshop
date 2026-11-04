// tools/move-the-public-door/read-data/door-receipts.mjs
//
// The receipts a door move keeps between runs (a host lease, a DNS cutover, the move's own journal), each one row of the
// person's Public door receipts list (rows of type record:public-door-receipt) through the records door. Each save is
// conditioned on the value this store last read or wrote, so a receipt another run changed meanwhile is refused, never
// written over. A receipt names provider identities, addresses and states, never a credential.
export const receiptsType = 'record:public-door-receipt';
const receiptName = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** { read(name) -> value | null, save(name, value) } over the person's records door. */
export function doorReceipts(door) {
  const held = new Map();
  const idOf = name => {
    if (!receiptName.test(name ?? '')) throw new Error(`A receipt name is lower-case words joined by dashes; ${JSON.stringify(name)} was refused.`);
    return `${receiptsType}:${name}`;
  };
  async function read(name) {
    const value = (await door.readRecord(receiptsType, idOf(name)))?.value ?? null;
    held.set(name, value);
    return value === null ? null : structuredClone(value);
  }
  async function save(name, value) {
    if (!held.has(name)) await read(name);
    const before = held.get(name), next = JSON.parse(JSON.stringify(value));
    await door.write([{ id: idOf(name), type: receiptsType, value: next, expected: before === null ? null : { type: receiptsType, value: before } }]);
    held.set(name, next);
    return structuredClone(next);
  }
  return { read, save };
}
