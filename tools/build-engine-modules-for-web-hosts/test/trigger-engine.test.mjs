// The trigger engine ported from bitfield-packages (crates/trigger-engine), built as the WebAssembly module a Worker
// loads (crates/trigger-engine-web, `web` shape): a person's `trigger-rule` records stay resident, each changed record
// is checked against every rule, and a matched rule's request is handed to the JavaScript host's answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrateForAWebHost } from '../build/build-crate-for-a-web-host.mjs';

const wonLead = {
  id: 'tell-me-when-a-lead-is-won',
  match_condition: { conditions: [{ $bind: { select: { from: 'change', path: 'stage' }, transform: [{ op: 'op:core.equals', args: { value: 'won' } }] } }] },
  dispatch: {
    target: 'tool:send-message',
    output_template: {
      about: { $bind: { select: { from: 'envelope', path: 'address_text' } } },
      value: { $bind: { select: { from: 'change', path: 'value' } } },
    },
  },
};

test('the ported trigger engine runs in WebAssembly and hands a matched rule to the JavaScript host', { timeout: 900_000 }, async () => {
  const built = await buildCrateForAWebHost({ crate: 'trigger-engine-web', bindgenTarget: 'web' });
  assert.deepEqual(built.importModules.filter(name => name.startsWith('slots:') || name.startsWith('$root')), [], 'no slot-world imports reach a web module');
  built.bindings.initSync({ module: new WebAssembly.Module(built.wasmBytes) });
  const asked = [];
  const engine = new built.bindings.TriggerEngine('person:test', async request => {
    asked.push(JSON.parse(request));
    await new Promise(resolve => setTimeout(resolve, 5));
    return { sent: true };
  });
  const apply = async changes => JSON.parse(await engine.apply(JSON.stringify(changes)));

  await apply([{ address: 'rule:won', path: ['trigger-rule'], value: wonLead }]);
  await apply([{ address: 'lead:acme', value: { stage: 'open', value: 10 } }]);
  assert.deepEqual(asked, [], 'a change the rule does not match sends nothing');

  const result = await apply([{ address: 'lead:acme', value: { stage: 'won', value: 12 } }]);
  assert.deepEqual(asked, [{ kind: 'send', target: 'tool:send-message', later: false, payload: { about: 'lead:acme', value: 12 } }]);
  assert.equal(result.status, 'ok');
  const outcome = result.writes.find(write => write.payload.kind === 'trigger-dispatch-outcome');
  assert.equal(outcome.payload.status, 'succeeded');
  assert.equal(outcome.payload.rule_id, 'tell-me-when-a-lead-is-won');

  // A host that cannot answer is a failed dispatch the engine reports and records, never a hang or a silent success.
  const failing = new built.bindings.TriggerEngine('person:test', async () => { throw new Error('the Mac is asleep'); });
  await failing.apply(JSON.stringify([{ address: 'rule:won', path: ['trigger-rule'], value: wonLead }]));
  const failed = JSON.parse(await failing.apply(JSON.stringify([{ address: 'lead:acme', value: { stage: 'won' } }])));
  assert.match(JSON.stringify(failed.dispatch_failures), /the Mac is asleep/);
  assert.ok(failed.writes.some(write => write.payload.kind === 'trigger-dispatch-outcome' && write.payload.status === 'failed'), JSON.stringify(failed.writes).slice(0, 400));
  console.log(`trigger-engine-web wasm: ${built.wasmBytes.length} bytes`);
});
