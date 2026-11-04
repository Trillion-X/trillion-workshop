// tools/pair-unknown-senders/read-data/pairing-tools.mjs
//
// The four rows over the person's own records: makeSenderPairing (sender-pairing.mjs, moved unchanged) is handed
// facts kept as records of one kind, `sender-pairing`, whose id is the fact's name. The newest value per name is
// current, as the moved code expects; a write is sent with a key made from its name and value, so sending it again
// changes nothing.
import { makeSenderPairing } from './sender-pairing.mjs';

export const PAIRING_TYPE = 'sender-pairing';

/** facts over a records door: { read(name), list(prefix), write(name, value) }. */
export function factsOverDoor(door, type = PAIRING_TYPE) {
  return {
    read: name => door.read(type, name),
    async list(prefix) {
      const rows = [];
      for await (const row of door.list({ type, prefix })) rows.push(row.value);
      return rows;
    },
    write: (name, value) => door.write([{ id: name, type, value }], { key: `${name}:${JSON.stringify(value)}` }),
  };
}

const pairingFor = door => makeSenderPairing({ facts: factsOverDoor(door) });

/** tool:pair-an-unknown-sender: the code waiting for a sender, a new one, { paired: true } or { full: true }. */
export const requestPairing = (input, { door }) => pairingFor(door).request(input ?? {});
/** tool:approve-a-pairing-code: the person's yes to one waiting code. */
export const approvePairing = (input, { door }) => pairingFor(door).approve(input ?? {});
/** tool:unpair-a-sender: a paired sender is unknown again. */
export const revokePairing = (input, { door }) => pairingFor(door).revoke(input ?? {});
/** tool:list-paired-senders: what is waiting and who is paired, for one source or all. */
export async function listPairing(input, { door }) {
  const pairing = pairingFor(door);
  const listed = await pairing.list(input ?? {});
  if (input?.sender && input?.source_id) return { ...listed, is_paired: await pairing.isPaired(input) };
  return listed;
}
