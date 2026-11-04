// src/sender-pairing.mjs
//
// PURPOSE
//   An event rule that names `paired_senders` (src/events.mjs) answers only senders the person has paired. An unknown
//   sender's event is held, not run: the sender gets a short code (src/sender-pairing.json), and the person approving
//   that code adds the sender to the source's paired list. Nothing here names a source or a platform; sources and senders
//   are the event's own ids.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Alphabet, length, lifetime and the cap on waiting codes are DATA. A sender with a code waiting gets the same code
//      again (asking twice makes no second code); a source with `max_pending` waiting codes issues no more.
//   2. A code works once, only before it expires, and only for the source it was issued for.
//   3. Pairing is per source and sender, kept as facts the person can list and revoke; a revoked sender is unknown again.
//   4. The clock and the randomness are injected.
//
//   facts: { read(name), list(prefix), write(name, value) } (the newest value per name is current)
//   makeSenderPairing({ facts, now, random? }) → { request, approve, revoke, list, isPaired }
import settings from '../../pair-unknown-senders/read-data/sender-pairing.json' with { type: 'json' };

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const pairedName = (source, sender) => `pairing-paired:${source}:${sender}`;
const waitingPrefix = source => `pairing-waiting:${source}:`;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

export function makeSenderPairing({ facts, now = () => new Date(), random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32, rules = settings }) {
  const codeFrom = () => Array.from({ length: rules.length }, () => rules.alphabet[Math.floor(random() * rules.alphabet.length)]).join('');
  const live = row => row && !row.removed && Date.parse(row.expires_at) > now().getTime();
  const waiting = async source => (await facts.list(waitingPrefix(source))).filter(live);
  const needSource = (source, sender) => { if (!nonempty(source) || !nonempty(sender)) throw failure('A pairing needs the source and the sender.'); };

  return {
    /** The code waiting for a sender (a new one when none is), or { paired: true } when they already are. */
    async request({ source_id, sender }) {
      needSource(source_id, sender);
      if (await this.isPaired({ source_id, sender })) return { paired: true };
      const rows = await waiting(source_id);
      const same = rows.find(row => row.sender === sender);
      if (same) return { code: same.code, expires_at: same.expires_at, said: fill(rules.words.waiting, same) };
      if (rows.length >= rules.max_pending) return { full: true, said: fill(rules.words.full, { max: rules.max_pending, source: source_id }) };
      let code = codeFrom();
      while (rows.some(row => row.code === code)) code = codeFrom();
      const row = { source_id, sender, code, expires_at: new Date(now().getTime() + rules.expires_minutes * 60_000).toISOString() };
      await facts.write(`${waitingPrefix(source_id)}${code}`, row);
      return { code, expires_at: row.expires_at, said: fill(rules.words.waiting, row) };
    },
    /** The person's yes to one waiting code: its sender is paired for its source. */
    async approve({ code, source_id }) {
      const wanted = String(code ?? '').toUpperCase().replace(/\s+/g, '');
      const rows = (await facts.list('pairing-waiting:')).filter(row => live(row) && row.code === wanted && (!nonempty(source_id) || row.source_id === source_id));
      if (rows.length !== 1) throw failure(fill(rules.words.unknown_code, { code: wanted }), 404);
      const [row] = rows;
      await facts.write(pairedName(row.source_id, row.sender), { source_id: row.source_id, sender: row.sender, paired_at: now().toISOString() });
      await facts.write(`${waitingPrefix(row.source_id)}${row.code}`, { ...row, removed: true });
      return { source_id: row.source_id, sender: row.sender, said: fill(rules.words.approved, { sender: row.sender, source: row.source_id }) };
    },
    async revoke({ source_id, sender }) {
      needSource(source_id, sender);
      await facts.write(pairedName(source_id, sender), { source_id, sender, removed: true, at: now().toISOString() });
      return { source_id, sender, said: fill(rules.words.revoked, { sender, source: source_id }) };
    },
    /** What is waiting and who is paired, for one source or all. */
    async list({ source_id } = {}) {
      const scope = nonempty(source_id) ? source_id : null;
      const rows = (await facts.list('pairing-waiting:')).filter(live).filter(row => !scope || row.source_id === scope);
      const paired = (await facts.list('pairing-paired:')).filter(row => !row.removed && (!scope || row.source_id === scope));
      return { waiting: rows.map(({ source_id: source, sender, code, expires_at }) => ({ source_id: source, sender, code, expires_at })), paired: paired.map(({ source_id: source, sender, paired_at }) => ({ source_id: source, sender, paired_at })) };
    },
    async isPaired({ source_id, sender }) {
      const row = await facts.read(pairedName(source_id, sender));
      return Boolean(row && !row.removed);
    },
  };
}
