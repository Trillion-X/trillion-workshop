// Explicit release acceptance: no installed-account reads or processes run in the ordinary test suite.
// Set WORKFLOW_ACCEPTANCE_RELEASE_TREE and WORKFLOW_ACCEPTANCE_COMPONENT_BLAKE3 to test those exact bytes.
// Effects are inspected, never delivered. Native journals, settlement and kept-value injection need their native fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const COMPONENT = 'tools/build-engine-modules-for-web-hosts/built-stored-bytes/workflow-component/workflow_component.wasm';
const SOURCE = 'tools/workflows/crates/workflow-component/src/main.rs';
const ROWS = 'tools/workflows/tool-rows.json';
const FORMULA = 'tools/formula-engine/built-stored-bytes/formula-engine';
const CHOOSER = 'tools/workflows/read-data/choose-the-workflows-that-fire.mjs';
const ACTOR = 'synthetic:acceptance-answerer';
const STARTED_AT = '2026-11-17T06:00:00.000Z';
const SEVEN_DAYS_LATER = Date.parse(STARTED_AT) + 7 * 24 * 60 * 60 * 1000;
const SHAPES = [null, false, 0, '', [], {}, '雪\nbody', { nested: [false, null, 0] }];
const configured = Boolean(process.env.WORKFLOW_ACCEPTANCE_RELEASE_TREE || process.env.WORKFLOW_ACCEPTANCE_COMPONENT_BLAKE3);
const hash = bytes => makeHashCodeHexFromBytes(bytes).slice(3);
const binding = (from, path, key) => ({ $kind: 'binding', select: { from, path, ...(key ? { key } : {}) } });
const definition = (id, steps, edges = [], kind = 'workflow') => ({ id, name: id, kind, is_active: true, version: 1, steps, edges });
const ask = (id, input = {}, name = ACTOR) => ({ id, kind: 'ask', config: { name, input } });
const returns = (id, value) => ({ id, kind: 'return', config: { value } });
const always = (from, to) => ({ from, to, kind: 'always' });

function componentHarness(tree, identity) {
  const file = join(tree, COMPONENT);
  const calls = [];
  function run(given) {
    const input = JSON.stringify({ context: { actor: ACTOR }, ...given });
    const started = performance.now();
    const child = spawnSync('wasmtime', ['run', file], {
      input, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    assert.equal(child.signal, null, `component ended by ${child.signal}: ${child.stderr}`);
    assert.ok(child.stdout.trim(), `component returned no JSON: ${child.stderr}`);
    const body = JSON.parse(child.stdout.trim().split('\n').at(-1));
    calls.push({
      wall_ms: performance.now() - started, input_bytes: Buffer.byteLength(input), output_bytes: Buffer.byteLength(child.stdout),
      effect_envelopes: body.wake_effects?.length ?? 0,
    });
    return { exit: child.status, body };
  }
  function answer(waiting, fields, atMs = SEVEN_DAYS_LATER) {
    const told = structuredClone(waiting.told_as);
    Object.assign(told.payload, fields);
    return run({ input: {}, cause: {
      key: told.event_id, at_ms: atMs,
      detail: { kind: told.source, event_id: told.event_id, payload: told.payload },
    } });
  }
  function report(t, before, extra = {}) {
    const observed = calls.slice(before);
    t.diagnostic(JSON.stringify({
      target: identity, component_processes: observed.length,
      wall_ms: Math.round(observed.reduce((sum, item) => sum + item.wall_ms, 0)),
      stdin_bytes: observed.reduce((sum, item) => sum + item.input_bytes, 0),
      stdout_bytes: observed.reduce((sum, item) => sum + item.output_bytes, 0),
      effect_envelopes_emitted: observed.reduce((sum, item) => sum + item.effect_envelopes, 0),
      external_effects_delivered: 0, native_journal_or_host_restart_proved: false, ...extra,
    }));
  }
  return { run, answer, report, count: () => calls.length };
}

function paused(pass) {
  assert.equal(pass.exit, 0, JSON.stringify(pass.body));
  assert.equal(pass.body.result.status, 'paused', JSON.stringify(pass.body));
  assert.ok(pass.body.result.waiting.length, 'a paused component must name what it waits for');
  assert.equal(pass.body.wake_effects.length, 1, 'only one pending effect is handed out per pass');
  return pass.body.result.waiting[0];
}

function completed(pass) {
  assert.equal(pass.exit, 0, JSON.stringify(pass.body));
  assert.equal(pass.body.result.status, 'completed', JSON.stringify(pass.body));
  assert.deepEqual(pass.body.wake_effects, []);
  return pass.body.result;
}

function frozenDefinition(body, version = 1) {
  return { ...definition('workflow:synthetic-frozen-content', [
    ask('wait', { do: 'Return the synthetic fixture.' }),
    returns('original', { body, version }),
  ], [always('wait', 'original')]), version };
}

function readFixture(harness, original, suffix) {
  const reader = {
    tool: 'synthetic:definition-reader', input: { recipe: null }, recipe_at: 'recipe',
    definition_at: 'rows.0.definition', version_at: 'rows.0.version',
  };
  const start = harness.run({ input: {
    run: `f0-released-acceptance-${suffix}`, recipe: original.id, read_definition: reader, input: {},
  } });
  const waiting = paused(start);
  assert.equal(waiting.step, 'read-definition');
  const read = harness.answer(waiting, { result: { rows: [{ definition: original, version: 'v1' }] } });
  assert.equal(paused(read).step, 'wait');
  return read;
}

test('current released workflow component acceptance', {
  skip: configured ? false : 'Explicit release tree and expected component BLAKE3 are required; no live state was read.',
  timeout: 240_000,
}, async t => {
  const tree = process.env.WORKFLOW_ACCEPTANCE_RELEASE_TREE;
  const expected = process.env.WORKFLOW_ACCEPTANCE_COMPONENT_BLAKE3;
  assert.ok(tree, 'give WORKFLOW_ACCEPTANCE_RELEASE_TREE; there is no checkout fallback');
  assert.match(expected ?? '', /^[0-9a-f]{64}$/, 'give the exact WORKFLOW_ACCEPTANCE_COMPONENT_BLAKE3');
  const root = resolve(tree);
  const fingerprint = path => hash(readFileSync(join(root, path)));
  const identity = {
    tree: root, component_blake3: fingerprint(COMPONENT), component_bytes: readFileSync(join(root, COMPONENT)).length,
    component_source_blake3: fingerprint(SOURCE), rows_blake3: fingerprint(ROWS),
    formula_blake3: fingerprint(`${FORMULA}/formula_engine_bg.wasm`), chooser_blake3: fingerprint(CHOOSER),
  };
  assert.equal(identity.component_blake3, expected, 'the requested target must match before any component executes');
  const runtime = spawnSync('wasmtime', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (runtime.error) throw runtime.error;
  assert.equal(runtime.status, 0, runtime.stderr);
  t.diagnostic(JSON.stringify({ ...identity, runtime: runtime.stdout.trim(), scope: 'isolated component and SQL fixtures, not native durability' }));
  t.after(() => assert.equal(fingerprint(COMPONENT), expected, 'the tested component changed during acceptance'));
  const harness = componentHarness(root, identity);

  await t.test('the released recipe source invokes the network-free component runner', child => {
    const rows = JSON.parse(readFileSync(join(root, ROWS), 'utf8')).records.map(row => row.payload ?? row);
    const source = rows.find(row => row.id === 'source:workflow-recipes');
    const runner = rows.find(row => row.id === 'tool:run-a-workflow');
    assert.equal(source?.invoke_with, runner?.id);
    assert.equal(runner?.id, 'tool:run-a-workflow');
    assert.equal(runner.invoke.argv[0], 'component');
    assert.equal(runner.invoke.internet, false);
    child.diagnostic(JSON.stringify({ target: identity, declaration_only: true, live_wake_invocation_proved: false }));
  });

  await t.test('a disk-saved waiting envelope resumes in a fresh process seven simulated days later', child => {
    const before = harness.count();
    const content = { body: 'Line one\nLine two — 雪\n\u0000 preserved', nested: [null, false, 0, {}, []] };
    const original = definition('workflow:synthetic-persisted-wait', [
      ask('wait', { do: 'Return the synthetic fixture.' }),
      returns('after', { answer: binding('steps', 'output', 'wait'), started_at: binding('start', 'started_at') }),
    ], [always('wait', 'after')]);
    const first = harness.run({ input: {
      definition: original, run: 'f0-released-acceptance-disk-wait', started_at: STARTED_AT, input: {},
    } });
    const waiting = paused(first);
    const folder = mkdtempSync(join(tmpdir(), 'component-release-wait-'));
    child.after(() => rmSync(folder, { recursive: true, force: true }));
    const file = join(folder, 'waiting.json');
    writeFileSync(file, JSON.stringify(waiting));
    const restored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(restored.told_as.payload.run.started_at, STARTED_AT);
    const result = completed(harness.answer(restored, { result: content }));
    assert.deepEqual(result.steps.after.output, { answer: content, started_at: STARTED_AT });
    assert.deepEqual(Buffer.from(result.steps.after.output.answer.body), Buffer.from(content.body));
    harness.report(child, before, { simulated_days: 7, disk_envelope_read_back: true, content_exact: true });
  });

  await t.test('top-level loops and subworkflow branches preserve every JSON shape and pending identity', child => {
    const before = harness.count();
    const items = SHAPES.map((value, id) => ({ id, value, pass: id % 3 !== 1 }));
    const good = binding('input', 'output.pass');
    const bad = { ...good, transform: [{ op: 'op:core.not' }] };
    const rootDefinition = definition('workflow:synthetic-shaped-loop', [{ id: 'each', kind: 'loop', config: {
      definition_id: 'action:synthetic-shaped-leaf', source: binding('start', 'input.items'),
      item_var: 'item', max_iterations: SHAPES.length, parallel: false, inputs: { item: binding('loop', 'item') },
    } }]);
    const leaf = definition('action:synthetic-shaped-leaf', [
      returns('decide', { pass: binding('start', 'input.item.pass') }),
      ask('keep', { id: binding('start', 'input.item.id'), value: binding('start', 'input.item.value') }),
      returns('skip', { id: binding('start', 'input.item.id'), skipped: true }),
    ], [{ from: 'decide', to: 'keep', kind: 'on_result', config: good },
      { from: 'decide', to: 'skip', kind: 'on_result', config: bad }], 'action');
    let pass = harness.run({ input: {
      definitions: [rootDefinition, leaf], run: 'f0-released-acceptance-shaped-loop', input: { items },
    } });
    const identities = new Set();
    for (let count = 0; pass.body.result.status === 'paused' && count < SHAPES.length; count += 1) {
      const waiting = paused(pass);
      assert.equal(waiting.for, ACTOR);
      assert.ok(!identities.has(waiting.step), `nested identity repeated: ${waiting.step}`);
      identities.add(waiting.step);
      pass = harness.answer(waiting, { result: { id: waiting.asks.id, value: waiting.asks.value } });
    }
    const result = completed(pass);
    assert.equal(identities.size, items.filter(item => item.pass).length);
    assert.deepEqual(result.steps.each.output, items.map(item => item.pass
      ? { id: item.id, value: item.value } : { id: item.id, skipped: true }));
    harness.report(child, before, { cases: items.length, distinct_pending_identities: [...identities], branches: ['keep', 'skip'] });
  });

  await t.test('a loop inside an action executes its child instead of returning the unprocessed source', child => {
    const before = harness.count();
    const definitions = [
      definition('workflow:synthetic-nested-root', [{ id: 'call', kind: 'action', config: {
        definition_id: 'action:synthetic-nested-middle', inputs: { items: [1, 2] },
      } }]),
      definition('action:synthetic-nested-middle', [{ id: 'each', kind: 'loop', config: {
        definition_id: 'action:synthetic-nested-child', source: binding('start', 'input.items'),
        item_var: 'item', max_iterations: 4, parallel: false,
      } }], [], 'action'),
      definition('action:synthetic-nested-child', [returns('answer', { marker: 'child-return' })], [], 'action'),
    ];
    const result = completed(harness.run({ input: { definitions, run: 'f0-released-acceptance-nested-loop' } }));
    const expectedOutput = [{ marker: 'child-return' }, { marker: 'child-return' }];
    harness.report(child, before, { actual_output: result.steps.call.output, expected_output: expectedOutput });
    assert.deepEqual(result.steps.call.output, expectedOutput, 'completed must mean the nested body actually ran');
  });

  await t.test('small in-flight definitions keep their original content after a source edit or withdrawal', child => {
    const before = harness.count();
    const original = frozenDefinition('Original content — 雪\nkept');
    const waiting = paused(readFixture(harness, original, 'small-frozen'));
    for (const rows of [[{ definition: frozenDefinition('Changed content', 2), version: 'v2' }], []]) {
      let pass = harness.answer(waiting, { result: { ack: true } });
      if (pass.body.result?.waiting?.[0]?.step === 'read-definition') {
        pass = harness.answer(paused(pass), { result: { rows } });
      }
      assert.deepEqual(completed(pass).steps.original.output, { body: original.steps[1].config.value.body, version: 1 });
    }
    harness.report(child, before, { source_mutations: ['edit', 'withdrawal'], original_content_exact: true });
  });

  await t.test('large in-flight definitions retain their original content at the component handoff', child => {
    const before = harness.count();
    const original = frozenDefinition('Original paragraph — 雪\n'.repeat(1800));
    const read = readFixture(harness, original, 'large-frozen');
    const waiting = paused(read);
    const carried = waiting.told_as.payload.run;
    if (typeof carried.definitions_kept === 'string') {
      const kept = read.body.keep?.find(item => item.key === carried.definitions_kept);
      assert.ok(kept, 'the component must emit the definition bytes it asks the native host to keep');
      assert.equal(hash(Buffer.from(kept.text)), kept.key);
      const definitions = JSON.parse(kept.text);
      assert.ok(isDeepStrictEqual(definitions.find(item => item.id === original.id), original), 'the kept definition must contain the complete original content');
      harness.report(child, before, {
        original_body_bytes: Buffer.byteLength(original.steps[1].config.value.body), kept_key: kept.key,
        boundary: 'component keep protocol only; native storage, injection and restart belong to the native acceptance owner',
      });
      return;
    }
    const definitions = carried.definitions ?? (carried.definition ? [carried.definition] : []);
    if (!definitions.some(item => item.id === original.id)) {
      const next = harness.answer(waiting, { result: { ack: true } });
      const reread = paused(next);
      assert.equal(reread.step, 'read-definition');
      const changed = harness.answer(reread, { result: { rows: [{ definition: frozenDefinition('Changed content', 2), version: 'v2' }] } });
      const withdrawn = harness.answer(reread, { result: { rows: [] } });
      harness.report(child, before, {
        original_body_bytes: Buffer.byteLength(original.steps[1].config.value.body),
        reread_after_wait: true, changed_error: changed.body.error, withdrawn_error: withdrawn.body.error,
      });
    }
    assert.ok(isDeepStrictEqual(definitions.find(item => item.id === original.id), original),
      'a source edit or withdrawal must not replace or stop the original in-flight definition');
    const result = completed(harness.answer(waiting, { result: { ack: true } }));
    assert.ok(isDeepStrictEqual(result.steps.original.output, original.steps[1].config.value), 'the original output content must survive intact');
    harness.report(child, before, { original_body_bytes: Buffer.byteLength(original.steps[1].config.value.body), original_content_exact: true });
  });

  await t.test('invalid typed answers fail before a later step can run', child => {
    const before = harness.count();
    const original = definition('workflow:synthetic-shaped-answer', [
      ask('checked', { do: 'Return the synthetic fixture.', submit: {
        type: 'object', additionalProperties: false, required: ['accepted'], properties: { accepted: { const: true } },
      } }), returns('after', { must_not_run: true }),
    ], [always('checked', 'after')]);
    const waiting = paused(harness.run({ input: { definition: original, run: 'f0-released-acceptance-invalid-answer' } }));
    for (const answer of [null, {}, { accepted: false }, { accepted: 'true' }]) {
      const rejected = harness.answer(waiting, { result: answer });
      assert.equal(rejected.exit, 1, JSON.stringify(rejected.body));
      assert.equal(rejected.body.result.status, 'failed');
      assert.match(rejected.body.error, /does not fit what it asks for/);
      assert.ok(!Object.hasOwn(rejected.body.result.steps, 'after'));
      assert.deepEqual(rejected.body.wake_effects ?? [], []);
    }
    harness.report(child, before, { synthetic_invalid_answers: 4, downstream_effects: 0, native_answer_retention_proved: false });
  });

  await t.test('synthetic missing-tool and unreachable-host replies fail without redispatching the tool', child => {
    const before = harness.count();
    const name = 'tool:synthetic-unavailable';
    const original = definition('workflow:synthetic-host-refusal', [ask('outside', {}, name), returns('after', { must_not_run: true })], [always('outside', 'after')]);
    const first = harness.run({ input: { definition: original, run: 'f0-released-acceptance-host-refusal' } });
    const waiting = paused(first);
    assert.equal(first.body.wake_effects[0].wake.tool, name);
    for (const error of ['not-found', 'unreachable']) {
      const rejected = harness.answer(waiting, { error, said: 'Synthetic host refusal; no tool was dispatched.' });
      assert.equal(rejected.exit, 1, JSON.stringify(rejected.body));
      assert.equal(rejected.body.result.status, 'failed');
      assert.ok(rejected.body.error.includes(error), rejected.body.error);
      assert.ok(!Object.hasOwn(rejected.body.result.steps, 'after'));
      assert.deepEqual(rejected.body.wake_effects ?? [], []);
    }
    harness.report(child, before, { host_refusal_fixtures: ['not-found', 'unreachable'], actual_missing_tool_or_network_probe: false });
  });

  await t.test('formula-generated shapes reach the released chooser and component and exact SQL result rows', async child => {
    const before = harness.count();
    const formula = await import(pathToFileURL(join(root, `${FORMULA}/formula_engine.js`)).href);
    formula.initSync({ module: readFileSync(join(root, `${FORMULA}/formula_engine_bg.wasm`)) });
    const { chooseTheWorkflowsThatFire } = await import(pathToFileURL(join(root, CHOOSER)).href);
    const { PGlite } = await import('@electric-sql/pglite');
    const seeds = SHAPES.map((value, id) => ({ id, n: id - 3, value }));
    const text = 'MAP(seeds, |s| => #{case_id: s.id, route: IF(s.n >= 0, "accept", "reject"), amount: s.n, value: s.value})';
    const cases = formula.evaluate({ text, input: { seeds } }).value;
    assert.deepEqual(cases, seeds.map(seed => ({ case_id: seed.id, route: seed.n >= 0 ? 'accept' : 'reject', amount: seed.n, value: seed.value })));
    const own = ['accept', 'reject'].map(route => {
      const recipe = `workflow:synthetic-generated-${route}`;
      return { id: recipe, value: { recipe, title: route,
        definition: definition(recipe, [returns('out', { route, case: binding('start', 'input.case') })]),
        fires_when: [{ label: `case route is ${route}`, state: 'On', made_by: 'synthetic acceptance', condition: {
          fields: [{ id: 'route', kind: 'choice', path: ['route'] }],
          tree: { kind: 'group', combinator: 'and', negate: false,
            rules: [{ kind: 'rule', field: 'route', operator: 'is_any_of', params: { values: [route] } }] },
        } }],
      } };
    });
    const choices = await chooseTheWorkflowsThatFire({ parts: cases, own, installed: false });
    assert.deepEqual(choices.chosen.map(choice => choice.part).sort((a, b) => a - b), cases.map((_, index) => index));
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE acceptance_results (case_id integer PRIMARY KEY, source jsonb NOT NULL, expected jsonb NOT NULL, actual jsonb NOT NULL, workflow text NOT NULL, status text NOT NULL)');
      for (const choice of choices.chosen) {
        const item = cases[choice.part];
        const expectedOutput = { route: item.amount >= 0 ? 'accept' : 'reject', case: item };
        const result = completed(harness.run({ input: {
          definition: choice.definition, input: { case: item }, run: `f0-released-acceptance-generated-${item.case_id}`,
        } }));
        assert.deepEqual(result.steps.out.output, expectedOutput);
        await db.query('INSERT INTO acceptance_results VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6)', [
          item.case_id, JSON.stringify(item), JSON.stringify(expectedOutput), JSON.stringify(result.steps.out.output), choice.workflow, result.status,
        ]);
      }
      const readback = await db.query('SELECT case_id, status, expected = actual AS content_exact, actual FROM acceptance_results ORDER BY case_id');
      assert.equal(readback.rows.length, cases.length);
      assert.ok(readback.rows.every(row => row.status === 'completed' && row.content_exact));
      assert.deepEqual(readback.rows.map(row => row.actual.case.value), SHAPES);
      harness.report(child, before, { formula: text, generated_cases: cases.length, result_rows: readback.rows,
        live_native_wake_admission_or_row_noticer_proved: false });
    } finally { await db.close(); }
  });
});
