// The journey shard's record operations. The caller supplies only its already-authorized operator door.
// One event is one record; generic engine records own durability, history, grants and compare-and-swap.
import { randomUUID } from 'node:crypto';
import { writeBatches } from 'trillion-workshop/tools/records-door/read-data/write-batches.mjs';

const TYPE = 'customer-journey';
const DAY_MS = 86400000;
const conditional = record => ({ id: record.id, type: TYPE, value: null, expected: { type: TYPE, value: record.value } });
export function journeyRecords(door, policy, shard) {
  const prefix = `${TYPE}:${shard}:`;
  async function records(account) {
    const rows = [];
    for await (const record of door.list({ type: TYPE, prefix, ...(account ? { where: { account } } : {}) })) rows.push(record);
    return rows;
  }
  async function remove(rows) {
    for (const batch of rows.length ? writeBatches(rows.map(conditional), { rows: 256, bytes: 60000 }) : []) await door.write(batch);
    return { removed: rows.length };
  }
  return {
    async journeyKeep({ account, events }) {
      if (typeof account !== 'string' || !account) throw new TypeError('An authenticated account is required.');
      const writes = events.map(event => ({ id: `${prefix}${randomUUID()}`, type: TYPE, value: { account, ...event }, expected: null }));
      for (const batch of writes.length ? writeBatches(writes, { rows: 256, bytes: 60000 }) : []) await door.write(batch);
      return { kept: writes.length };
    },
    async journeyForget({ account }) {
      if (typeof account !== 'string' || !account) throw new TypeError('An authenticated account is required.');
      return remove(await records(account));
    },
    async sweep({ now = Date.now() } = {}) {
      return remove((await records()).filter(record => record.value.at < now - policy.keep_days * DAY_MS));
    },
    async journeyRead({ now = Date.now() } = {}) {
      const since = now - policy.struggling.days * DAY_MS;
      const retained = now - policy.keep_days * DAY_MS;
      const groups = new Map();
      for (const record of await records()) {
        const row = record.value;
        if (row.at < retained) continue;
        if (!groups.has(row.account)) groups.set(row.account, []);
        groups.get(row.account).push({ id: record.id, ...row });
      }
      return [...groups].map(([account, events]) => {
        const recent = events.filter(event => event.at >= since);
        const trouble = recent.filter(event => policy.struggling.trouble.some(rule => rule.kind === event.kind && (!rule.labels?.length || rule.labels.includes(event.label)))).length;
        const byKind = new Map();
        for (const event of recent) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
        return { account, last_seen: Math.max(...events.map(event => event.at)), total: events.length, recent: recent.length,
          trouble, struggling: trouble >= policy.struggling.at_least,
          by_kind: Object.fromEntries([...byKind].sort(([a], [b]) => a.localeCompare(b))),
          timeline: events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, policy.timeline).map(({ account: _account, id: _id, ...event }) => event) };
      }).sort((a, b) => b.trouble - a.trouble || b.last_seen - a.last_seen).slice(0, policy.most_customers);
    },
  };
}
