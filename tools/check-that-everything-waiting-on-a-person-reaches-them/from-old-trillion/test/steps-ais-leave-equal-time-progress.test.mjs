import test from 'node:test';
import assert from 'node:assert/strict';
import { weighStepsAisLeft, stepsAisLeaveSettings as settings } from '../src/steps-ais-leave.mjs';
import { cursorFixture, message, TIME, BEFORE, CLOCK } from '../../../keep-and-wake-ai-sessions-on-this-computer/test/compound-field-cursor-for-tests.mjs';

const PLACE = 'setting:sweep-fixture-place';
for (const engine of ['record-log', 'eeaf']) {
  for (const count of [7, 25, settings.scan + 7]) {
    test(`${engine}: ${count} old tied turn ends each drain once through durable exact progress`, async () => {
      const { host, open } = cursorFixture(engine);
      try {
        let { records } = open();
        const ids = Array.from({ length: count }, (_, n) => `m${String(n).padStart(4, '0')}`);
        records.write([...ids.map(id => message(id)), { id: PLACE, type: 'setting', value: { through: BEFORE } }]);
        const asked = [], handed = [], pairs = [];
        let clock = CLOCK, answer;
        for (let turn = 0; turn <= Math.ceil(count / settings.most_per_run) + 1; turn++) {
          records.checkpoint?.();
          const owner = open(); records = owner.records;
          const kept = records.read(PLACE);
          answer = await weighStepsAisLeft({ fields: owner.fields, readMessage: id => records.read(id), kept,
            keptNow: () => records.read(PLACE), now: () => clock++,
            ask: async input => { asked.push(input.state.match(/Answer for (m\d+)/)[1]); return 0.95; },
            handOff: job => { handed.push(job.once_per); return { handoff_id: job.once_per }; },
            keep: value => records.write([{ id: PLACE, type: 'setting', value }]),
          });
          assert.ok(answer.read <= settings.scan);
          const place = records.read(PLACE);
          pairs.push([place.through, place.through_id]);
          if (!answer.again) break;
        }
        assert.equal(answer.again, null);
        assert.deepEqual(asked, ids);
        assert.deepEqual(handed, ids.map(id => `steps-ais-leave:${id}`));
        assert.equal(new Set(asked).size, count);
        assert.equal(records.read(PLACE).through, TIME);
        assert.equal(records.read(PLACE).through_id, ids.at(-1));
        assert.equal(pairs.length, Math.ceil(count / settings.most_per_run));
      } finally { host.db.close(); }
    });
  }

  test(`${engine}: silent retry stays before tied undecided row and preserves direct-final merging`, async () => {
    const { host, open } = cursorFixture(engine);
    try {
      const { records, fields } = open();
      records.write(['a', 'b', 'c'].map(id => message(id)));
      records.write([message('fresh', { final_reply: true }), { id: PLACE, type: 'setting', value: { through: BEFORE } }]);
      let clock = CLOCK, asks = 0;
      const run = async (extra = {}) => weighStepsAisLeft({ fields, readMessage: id => records.read(id), kept: records.read(PLACE),
        keptNow: () => records.read(PLACE), now: () => clock, ask: async () => { asks++; return null; },
        handOff: () => assert.fail('silent classifier must not hand off'),
        keep: value => records.write([{ id: PLACE, type: 'setting', value }]), ...extra });
      const first = await run();
      assert.equal(asks, 1);
      assert.equal(records.read(PLACE).through, BEFORE);
      assert.equal(records.read(PLACE).through_id, undefined);
      clock += 1;
      const quiet = await run();
      assert.equal(asks, 1);
      assert.deepEqual(quiet.again, first.again);
      const beforeDirect = records.read(PLACE);
      await run({ messageId: 'fresh' });
      const afterDirect = records.read(PLACE);
      assert.equal(afterDirect.through, beforeDirect.through);
      assert.equal(afterDirect.through_id, beforeDirect.through_id);
      assert.ok(afterDirect.waiting.some(row => row.id === 'fresh'));
      clock = Date.parse(first.again.at);
      const decided = await run({ ask: async () => { asks++; return 0.04; } });
      assert.equal(decided.again, null);
      assert.deepEqual(decided.weighed.map(row => row.message_id), ['a', 'b', 'c']);
      assert.equal(records.read(PLACE).through_id, 'fresh', 'the sweep skips the direct-final row while deciding its page');
    } finally { host.db.close(); }
  });

  test(`${engine}: young tied end retains quiet deadline and a failed keep leaves the durable pair`, async () => {
    const { host, open } = cursorFixture(engine);
    try {
      let { records, fields } = open();
      const youngAt = new Date(CLOCK - 30_000).toISOString();
      records.write([message('a', { speaker: 'person', recorded_at: youngAt }), message('b', { recorded_at: youngAt }),
        { id: PLACE, type: 'setting', value: { through: BEFORE } }]);
      const call = async (extra = {}) => weighStepsAisLeft({ fields, readMessage: id => records.read(id), kept: records.read(PLACE), keptNow: () => records.read(PLACE),
        now: () => CLOCK, ask: async () => assert.fail('the young turn must wait'), handOff: () => assert.fail('young'),
        keep: value => records.write([{ id: PLACE, type: 'setting', value }]), ...extra });
      const first = await call();
      assert.equal(first.again.at, new Date(Date.parse(youngAt) + settings.quiet_minutes * 60_000).toISOString());
      const before = records.read(PLACE);
      assert.equal(before.through, youngAt); assert.equal(before.through_id, 'a');
      await assert.rejects(call({ now: () => CLOCK + 600_000, ask: async () => 0.04,
        keep: value => host.transaction(() => { records.write([{ id: PLACE, type: 'setting', value }]); throw Error('injected failed cursor commit'); }) }), /injected failed cursor commit/);
      records.forgetCached();
      ({ records, fields } = open());
      assert.deepEqual(records.read(PLACE), before);
      const retried = await call({ now: () => CLOCK + 600_000, ask: async () => 0.04 });
      assert.deepEqual(retried.weighed.map(row => row.message_id), ['b']);
      assert.equal(records.read(PLACE).through_id, 'b');
    } finally { host.db.close(); }
  });
}
