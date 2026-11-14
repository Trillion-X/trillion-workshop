// This asserted the shape of three published records AND hand-rolled a directory walk over the
// package source, matching 13 regexes against every file. The walk is gone. Those 13 regexes were
// THREE invariants, and they are now `source-file-rule` records in `../things-to-store-and-run.json`
// where the declared runner collects them with every other source rule in the corpus.
//
// The walk existed because the rule collector once read a single manifest, so a package could not
// declare a rule about its own source. That changed, and eighteen packages had written this same
// walk by then.
//
// The blindness reasoning did NOT come with it as a comment, it moved into the rules' own `why`
// fields, including the one that matters most: `proof/harness/` is judged and only
// `proof/harness/out/` is skipped, because that bundle vendors React and React's DOM event dispatch
// contains `case "focus":`, the browser focus EVENT rather than a notification mode.
//
// `boundary-rules-fire-on-the-thing-they-forbid.test.mjs` is what keeps the three honest: all three
// match zero source lines today, and a rule reporting nothing looks exactly like one that cannot.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const contract = JSON.parse(readFileSync(join(root, 'things-to-store-and-run.json'), 'utf8'));

function payload(address) {
  return contract.things.find((thing) => thing.address === address)?.payload;
}

const graph = payload('package::notifications::published-record::record-policy-action-graph::settings-policy');
const sideEffectRoute = payload('package::notifications::published-record::side-effect-intent-route::authority-owned-action');
const setting = payload('package::notifications::published-record::setting-control::notification-mode');

assert.equal(setting.write.target, 'slot::workflow');
assert.equal(setting.write.payload.operation, 'execute_definition');
assert.equal(setting.write.payload.definition_id, 'action:update-workspace-notification-mode');
assert.deepEqual(setting.write.value_path, ['input', 'mode_id']);

assert.equal(graph.kind, 'record-policy-action-graph');
assert.equal(graph.rules[0].method, 'value-is-one-of-described-options');
assert.equal(graph.action_routes[0].target, 'slot::workflow');
assert.equal(graph.action_routes[0].method, 'execute_definition');
assert.equal(graph.action_routes[0].bindings.definition_id, 'action:update-workspace-notification-mode');
assert.equal(graph.projections[0].method, 'project-setting-policy-state');

assert.equal(sideEffectRoute.kind, 'side-effect-intent-route');
assert.equal(sideEffectRoute.intent.single_execution_owner, 'workflow');
assert.equal(sideEffectRoute.route.target, 'slot::workflow');
assert.equal(sideEffectRoute.receipt.address, 'owner-action-event-log');

console.log('notifications published-record shapes asserted');
