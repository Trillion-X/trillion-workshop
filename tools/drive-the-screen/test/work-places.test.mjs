// test/work-places.test.mjs
//
// The places the person shares with their AIs (read-data/work-places.mjs) on a pretend computer: the person takes a place
// over (AIs refused with when it ends), the take-over ends by itself, only the key given at take over hands it back, and
// the next AI action is told once; the person's own input holds a shared place; the host's `place` seam
// (read-data/drive-the-screen.mjs makeScreenTools; on the Mac host computer/mac-tools.mjs runHere) refuses a drive of this Mac's screen while the person has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makePlaces, placeSettings } from '../read-data/work-places.mjs';
import { makeScreenTools } from '../read-data/drive-the-screen.mjs';

const ok = (stdout = '') => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' });

/** A pretend computer: `answer(argv)` decides each program's result. */
async function pretend({ answer = () => ok(), settings = placeSettings(), clock = Date.parse('2026-10-21T09:00:00Z') } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'work-places-'));
  let time = clock;
  const places = makePlaces({ settings, home, now: () => time, exec: async argv => answer(argv), key: () => 'the-persons-key' });
  const file = join(home, settings.file.replace(/^~\//, ''));
  return { home, file, places, settings, tick: ms => { time += ms; } };
}
const idleAnswer = ns => argv => (argv[0] === placeSettings().person_input.argv[0] ? ok(`  |   "HIDIdleTime" = ${ns}\n`) : ok());

test('the person takes a place over: AIs are refused until it ends or is handed back with the key, then told once', async () => {
  const { places, tick, file } = await pretend({ answer: idleAnswer(60e9) });
  const taken = await places.take_over({ place: 'this-mac', minutes: 600 });
  assert.equal(taken.hand_back_key, 'the-persons-key');
  assert.ok(Date.parse(taken.until) - Date.parse('2026-10-21T09:00:00Z') <= placeSettings().limits.longest_take_over_minutes * 60_000, 'capped at longest_take_over_minutes');
  const kept = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(kept.places['this-mac'].lease.key, bytesToHex(blake3(new TextEncoder().encode('the-persons-key'))), 'only the BLAKE3 of the key is kept');
  assert.ok(!JSON.stringify(kept).includes('the-persons-key'));

  await assert.rejects(places.handsOn('this-mac'), error => {
    assert.match(error.message, /The person took over this-mac at .* and has it until /);
    assert.equal(error.status, 423);
    assert.equal(error.reaction, 'retry');
    assert.ok(error.retry_after_ms > 0);
    return true;
  });
  await assert.rejects(places.take_over({ place: 'this-mac' }), /already has this-mac until/);
  await assert.rejects(places.hand_back({ place: 'this-mac', key: 'guessed' }), /not the key the person was given/);
  await places.hand_back({ place: 'this-mac', key: 'the-persons-key', note: 'I chose the blue plan' });
  assert.match(await places.handsOn('this-mac'), /The person had this-mac from .* to .* and handed it back: "I chose the blue plan"\. Look at it again before you act\./);
  places.acted('this-mac');
  assert.equal(await places.handsOn('this-mac'), null, 'told once');
  await assert.rejects(places.hand_back({ place: 'this-mac', key: 'the-persons-key' }), /Nobody has taken over this-mac/);

  await places.take_over({ place: 'this-mac', minutes: 5 });
  tick(5 * 60_000 + 1);
  assert.equal(await places.handsOn('this-mac'), null, 'a take-over ends by itself');
  await assert.rejects(places.take_over({ place: 'elsewhere' }), /elsewhere/);
});

test('the person\'s own input holds a shared place for a few seconds; the AI\'s own input does not', async () => {
  let idleNs = 2e9;
  const { places, tick } = await pretend({ answer: argv => idleAnswer(idleNs)(argv) });
  await assert.rejects(places.handsOn('this-mac'), error => {
    assert.match(error.message, /The person is using this-mac right now \(their last input was 2 seconds ago\)\. Wait until they have left it alone for 5 seconds\./);
    assert.equal(error.status, 423);
    assert.equal(error.retry_after_ms, 3000);
    return true;
  });
  idleNs = 6e9;
  assert.equal(await places.handsOn('this-mac'), null);
  // Input made while the AI was acting (its own drive) is the AI's: the next action is not refused for it.
  tick(400);
  places.acted('this-mac');
  tick(1000);
  idleNs = 1.2e9;
  assert.equal(await places.handsOn('this-mac'), null, 'input inside the AI\'s own action is not the person\'s');
  tick(3000);
  idleNs = 0.5e9;
  await assert.rejects(places.handsOn('this-mac'), /The person is using this-mac right now/);
});

test('a places file that cannot be read refuses and is never replaced', async () => {
  const { places, file } = await pretend();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{ not json');
  await assert.rejects(places.take_over({ place: 'this-mac' }), /could not be read, so nothing was changed: not_json/);
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});

test('the host refuses a drive of this Mac\'s screen while the person has it, and the first drive after says so', async () => {
  const { places } = await pretend({ answer: idleAnswer(60e9) });
  // The Mac host's pretend tool ran the harmless `actions` function on the place; here the drive's driver does the same.
  const tools = makeScreenTools({ driver: () => ({ drive: async () => ({ actions: [] }) }), places: () => places });
  await places.take_over({ place: 'this-mac', minutes: 10 });
  const refused = await tools.drive({});
  assert.match(refused.error, /The person took over this-mac at .* and has it until /);
  assert.equal(refused.retry, true);
  assert.ok(refused.retry_after_ms > 0);
  await places.hand_back({ place: 'this-mac', key: 'the-persons-key' });
  const allowed = await tools.drive({});
  assert.equal(allowed.error, undefined);
  assert.match(allowed.told, /The person had this-mac from .* and handed it back\. Look at it again before you act\./);
  const again = await tools.drive({});
  assert.equal(again.told, undefined);
});
