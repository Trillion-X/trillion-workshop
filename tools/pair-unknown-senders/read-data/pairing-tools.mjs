// tools/pair-unknown-senders/read-data/pairing-tools.mjs
//
// The four rows over the person's own Postgres: makeSenderPairing (sender-pairing.mjs, moved unchanged) is handed facts
// kept as rows of the table sender_pairing (sql/100-sender-pairing.sql), whose id is the fact's name. A name holds one row,
// so the newest value is the current one, as the moved code expects; writing a fact again changes nothing.
import { makeSenderPairing } from './sender-pairing.mjs';

/** facts over the person's database: { read(name), list(prefix), write(name, value) }. */
export function factsOver(sql) {
  return {
    async read(name) {
      const [row] = await sql('select value from sender_pairing where id = $1', [name]);
      return row?.value ?? null;
    },
    async list(prefix) {
      return (await sql('select value from sender_pairing where starts_with(id, $1) order by id', [prefix])).map(row => row.value);
    },
    async write(name, value) {
      await sql('insert into sender_pairing (id, value) values ($1, $2::jsonb) on conflict (id) do update set value = excluded.value, updated_at = now()', [name, JSON.stringify(value)]);
    },
  };
}

const pairingFor = sql => makeSenderPairing({ facts: factsOver(sql) });

/** tool:pair-an-unknown-sender: the code waiting for a sender, a new one, { paired: true } or { full: true }. */
export const requestPairing = ({ input }, { sql }) => pairingFor(sql).request(input ?? {});
/** tool:approve-a-pairing-code: the person's yes to one waiting code. */
export const approvePairing = ({ input }, { sql }) => pairingFor(sql).approve(input ?? {});
/** tool:unpair-a-sender: a paired sender is unknown again. */
export const revokePairing = ({ input }, { sql }) => pairingFor(sql).revoke(input ?? {});
/** tool:list-paired-senders: what is waiting and who is paired, for one source or all. */
export async function listPairing({ input }, { sql }) {
  const pairing = pairingFor(sql);
  const listed = await pairing.list(input ?? {});
  if (input?.sender && input?.source_id) return { ...listed, is_paired: await pairing.isPaired(input) };
  return listed;
}
