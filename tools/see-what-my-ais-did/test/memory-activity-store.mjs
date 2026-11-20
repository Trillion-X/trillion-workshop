// An in-memory store with the methods the activity rules use (read-data/activity-generations.mjs). Made-up data only.
export function memoryStore() {
  const gens = new Map();
  const visible = () => [...gens.keys()].sort((a, b) => a - b).slice(-2);
  const all = () => visible().flatMap(n => gens.get(n).rows.map(row => ({ n, ...row })));
  const links = () => visible().flatMap(n => gens.get(n).links.map(link => ({ n, ...link })));
  return {
    gens,
    async generations() { return [...gens.keys()].sort((a, b) => a - b); },
    async createGeneration(n) { if (!gens.has(n)) gens.set(n, { rows: [], links: [], counts: new Map() }); },
    async refreshViews() {},
    async roll(previous, next) {
      await this.createGeneration(next);
      for (const n of [...gens.keys()]) if (n < previous) gens.delete(n);
    },
    async count(n) { return gens.get(n).rows.length; },
    async maxSeq() { return all().reduce((top, row) => Math.max(top, row.seq), 0); },
    async insertRow(n, row) { gens.get(n).rows.push(row); },
    async insertLinks(n, seq, list) { for (const link of list) gens.get(n).links.push({ seq, ...link }); },
    async bumpCounts(n, ids) { for (const id of ids) gens.get(n).counts.set(id, (gens.get(n).counts.get(id) ?? 0) + 1); },
    async list({ before, app, failed, forIds, limit }) {
      const forSeqs = new Set(links().filter(link => link.role === 'for' && forIds.includes(link.id)).map(link => link.seq));
      return all()
        .filter(row => before === null || row.seq < before)
        .filter(row => app === null || row.app === app)
        .filter(row => !failed || row.ok === 0)
        .filter(row => !forIds.length || forSeqs.has(row.seq))
        .sort((a, b) => b.seq - a.seq).slice(0, limit)
        .map(row => ({ seq: row.seq, row: row.row }));
    },
    async links({ id, roles, newest, limit }) {
      return links().filter(link => link.id === id && roles.includes(link.role))
        .sort((a, b) => (newest ? b.seq - a.seq : a.seq - b.seq)).slice(0, limit).map(({ seq, role }) => ({ seq, role }));
    },
    async rowsBySeq(seqs) {
      return new Map(all().filter(row => seqs.includes(row.seq)).map(row => [row.seq, row.row]));
    },
  };
}
