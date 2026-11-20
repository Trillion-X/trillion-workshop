// A made-up Namecheap zone behind the engine's call (the provider description tools/start-a-computer/providers/namecheap.json,
// read as it is): `call` answers each run as the engine's tools:run does, and every tool is kept by name. Nothing reaches the
// network and no real domain is named. Shared by the DNS client tests and the computer-row names test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dnsClient } from '../do-work/portable-dns-cutover.mjs';

export const provider = JSON.parse(readFileSync(new URL('../../start-a-computer/providers/namecheap.json', import.meta.url), 'utf8'));
export const zone = 'example.org', host = 'files.example.org';
export const ROW = '198.51.100.4', OLD = '203.0.113.7';

// The zone's records as the provider lists them (relative names); `text` answers the tool's result as text instead of structure.
export function namecheapWorld(records, { text = false } = {}) {
  const state = { records, calls: [], saves: [], deletes: [] };
  const call = async run => {
    assert.equal(run.address, provider.base, 'the engine call names the provider address');
    const name = run.tool.slice('mcp.namecheap.com/'.length), args = run.input;
    assert.equal(run.tool, `mcp.namecheap.com/${name}`);
    state.calls.push(name);
    let result;
    if (name === 'domains_list') result = { items: args.domain === zone ? [{ name: zone }] : [], total: args.domain === zone ? 1 : 0 };
    else if (name === 'dns_records_get') result = { items: state.records.slice(args.skip, args.skip + args.take), total: state.records.length };
    else if (name === 'dns_records_save') { state.saves.push(args.records); state.records.push(...args.records); result = { saved: args.records.length, failed: [] }; }
    else if (name === 'dns_records_delete') {
      state.deletes.push(args.records);
      let deleted = 0;
      for (const wanted of args.records) {
        const at = state.records.findIndex(row => row.type === wanted.type && row.name === wanted.name && row.address === wanted.address);
        if (at >= 0) { state.records.splice(at, 1); deleted += 1; }
      }
      result = { deleted, notFound: [] };
    }
    else throw Error(`no tool ${name} in the fake`);
    return { headers: {}, replayed: false, status: 'ok', tool: run.tool, result: text ? { content: [{ type: 'text', text: JSON.stringify(result) }] } : { structuredContent: result } };
  };
  return { state, call, client: () => dnsClient(null, { provider, call }) };
}
