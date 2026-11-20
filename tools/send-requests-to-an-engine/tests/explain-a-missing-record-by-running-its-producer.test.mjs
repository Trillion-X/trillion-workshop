// packages/send-requests-to-an-engine/tests/explain-a-missing-record-by-running-its-producer.test.mjs
//
// Runs the tool as a PROCESS, the way a caller runs it. Every defect this lane has produced in a
// tool of this shape was a top-level argv or import error that no imported function could have
// raised, so the entry point itself is what gets exercised.
//
// The cases that matter are the ones where it must do NOTHING, because this tool WRITES: it runs a
// producer against a live app. A speculative run, or a run against a row it was not asked about, is
// a side effect nobody requested, and that is worse than a missing diagnosis.

import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, '..', 'do-work', 'explain-a-missing-record-by-running-its-producer.mjs');

const run = (args) => {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  let verdict = null;
  try { verdict = JSON.parse(result.stdout); } catch { /* asserted by the caller */ }
  return { ...result, verdict };
};

/// A producers document written per test, so no case depends on what another package ships today.
function producersDocument(rows, key = 'required_current_records') {
  const folder = tempFolder(join(tmpdir(), 'producers-'));
  const path = join(folder, 'producers.json');
  writeFileSync(path, JSON.stringify({ [key]: rows }, null, 2));
  return path;
}

/// The missing addresses arrive as the verifier's own verdict document, so these cases feed the tool
/// the same shape the proof feeds it rather than a convenience encoding invented for the test.
function verdictDocument(missingRecords) {
  const folder = tempFolder(join(tmpdir(), 'verdict-'));
  const path = join(folder, 'required-records.json');
  writeFileSync(path, JSON.stringify({ present: false, missingRecords }, null, 2));
  return path;
}

// A status file that cannot resolve is used wherever the case must not reach an app. If a case ever
// starts reaching one, these assertions fail rather than quietly writing to somebody's runtime.
const noApp = join(here, 'no-such-app', 'runtime-app-authority-status.json');

test('an empty missing list runs NOTHING, because this tool writes and must never run speculatively', () => {
  const producers = producersDocument([
    { address: 'scene', produced_by: { definition_id: 'action:would-be-a-mistake-to-run' } },
  ]);
  const answer = run(['--status-file', noApp, '--producers-file', producers, '--missing-records-from', verdictDocument([])]);
  assert.ok(answer.verdict, `no JSON verdict: ${answer.stdout}${answer.stderr}`);
  assert.equal(answer.verdict.status, 'nothing-to-explain');
  assert.deepEqual(answer.verdict.explained, []);
  assert.equal(answer.status, 0);
  // The declared producer above exists precisely so this case would FAIL if the tool ran producers
  // for every declared row rather than only the ones it was told are missing.
});

test('a missing row with NO declared producer is named, never silently skipped', () => {
  // This is the gap that puts a future run back to reporting a bare absence with nothing to say
  // about it, so it has to be visible in the answer rather than absent from it.
  const producers = producersDocument([{ address: 'something-else', produced_by: { definition_id: 'action:x' } }]);
  const answer = run(['--status-file', noApp, '--producers-file', producers, '--missing-records-from', verdictDocument(['scene'])]);
  assert.ok(answer.verdict, `no JSON verdict: ${answer.stdout}${answer.stderr}`);
  assert.equal(answer.verdict.status, 'partly-explained');
  assert.deepEqual(answer.verdict.explained, []);
  assert.equal(answer.verdict.unexplained.length, 1);
  assert.equal(answer.verdict.unexplained[0].address, 'scene');
  assert.match(answer.verdict.unexplained[0].why, /produced_by/);
  assert.equal(answer.status, 69);

  // ⛔ AND THE VERDICT SAYS WHAT ITS RECEIPTS ARE, ON THE SAME DOCUMENT. A receipt from this tool is
  // a later, deliberate execution, never the app's own startup attempt; read as the latter it
  // diagnoses the wrong moment in the app's life. This assertion is here rather than in a case of
  // its own because a reachable app is needed to produce a receipt, and the sentence that tells a
  // reader how to read one ships on every verdict.
  assert.match(answer.verdict.how_to_read_this, /DELIBERATE RERUN/);
  assert.match(answer.verdict.how_to_read_this, /not the\s+app's own startup attempt/);
});

test('the rows are DATA, so the key they live under is a caller choice and not a constant', () => {
  const producers = producersDocument([{ address: 'scene' }], 'whatever_this_caller_calls_them');
  const answer = run([
    '--status-file', noApp,
    '--producers-file', producers,
    '--rows-key', 'whatever_this_caller_calls_them',
    '--missing-records-from', verdictDocument(['scene']),
  ]);
  assert.ok(answer.verdict, `no JSON verdict: ${answer.stdout}${answer.stderr}`);
  assert.equal(answer.verdict.unexplained[0].address, 'scene');

  // And the same document read under the DEFAULT key is a usage error, not an empty result. An
  // absent list must never read as "no rows declared", which would make every missing record
  // unexplained for a reason that has nothing to do with the app.
  const wrongKey = run(['--status-file', noApp, '--producers-file', producers, '--missing-records-from', verdictDocument(['scene'])]);
  assert.equal(wrongKey.status, 2, 'a producers document with no list at the key is a CALLER error');
});

test('usage is refused with its own exit code, so a caller bug never reads as a finding', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--status-file', noApp]).status, 2, 'no producers file is a usage error');
  const producers = producersDocument([]);
  assert.equal(
    run(['--producers-file', producers, '--missing-records-from', verdictDocument(['scene'])]).status, 2,
    'no status file is a usage error',
  );
});

test('an address carrying a comma, a quote or a backslash reaches the tool BYTE FOR BYTE', () => {
  // ⛔ THIS CASE EXISTS BECAUSE THE CALLER USED TO JOIN THESE WITH COMMAS. Under that encoding the
  // first address below arrived as two addresses and the second lost its escapes, so the tool
  // reported producers missing for strings the verifier never emitted: a fabricated finding, which
  // is worse than no finding. Reading the array out of the verdict with JSON.parse is what makes
  // this case pass, and an address is an opaque label, so no shape of it may be assumed here.
  const awkward = ['scene,with-a-comma', 'label"with-a-quote', 'path\\with\\backslashes'];
  const producers = producersDocument([{ address: 'unrelated', produced_by: { definition_id: 'action:x' } }]);
  const answer = run([
    '--status-file', noApp, '--producers-file', producers,
    '--missing-records-from', verdictDocument(awkward),
  ]);
  assert.ok(answer.verdict, `no JSON verdict: ${answer.stdout}${answer.stderr}`);
  // None declare a producer, so each comes back named, which is what makes the addresses readable
  // in the answer and therefore checkable against what went in.
  assert.deepEqual(answer.verdict.unexplained.map((row) => row.address).sort(), [...awkward].sort());
});

test('an app that cannot be reached is UNREACHABLE, and explains nothing rather than inventing a cause', () => {
  const producers = producersDocument([
    { address: 'scene', produced_by: { definition_id: 'action:build-this-apps-screen' } },
  ]);
  const answer = run(['--status-file', noApp, '--producers-file', producers, '--missing-records-from', verdictDocument(['scene'])]);
  assert.ok(answer.verdict, `no JSON verdict: ${answer.stdout}${answer.stderr}`);
  assert.equal(answer.verdict.status, 'unreachable');
  // ⛔ NOT "unexplained". Nothing was tried, so nothing is known about whether a producer would have
  // explained it. Reporting these as unexplained would blame the caller's DATA for a dead socket,
  // which is the same class of mistranslation as calling a stopped app an empty one.
  assert.deepEqual(answer.verdict.unexplained, []);
  assert.deepEqual(answer.verdict.explained, []);
  assert.equal(answer.status, 69);
});
