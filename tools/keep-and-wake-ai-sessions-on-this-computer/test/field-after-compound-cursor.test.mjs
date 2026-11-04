import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorFixture, message, TIME, BEFORE } from './compound-field-cursor-for-tests.mjs';

for (const engine of ['record-log', 'eeaf']) {
  test(`${engine}: compound page retains tied and longer prefix IDs; scalar callers stay strict`, () => {
    const { host, open } = cursorFixture(engine);
    try {
      let { records, fields } = open();
      records.write(['a', 'a0', 'a00', 'b', 'é', 'Ω'].map(id => message(id)));
      records.write([message('later', { recorded_at: new Date(Date.parse(TIME) + 1).toISOString() })]);
      records.checkpoint?.();
      ({ records, fields } = open());
      assert.deepEqual(fields.after('message', 'recorded_at', TIME, [], { limit: 3 }).map(row => row.id), ['later']);
      assert.deepEqual(fields.after('message', 'recorded_at', TIME, [], { after_id: 'a', limit: 2 }).map(row => row.id), ['a0', 'a00']);
      assert.deepEqual(fields.after('message', 'recorded_at', TIME, [], { after_id: 'a0', limit: 2 }).map(row => row.id), ['a00', 'b']);
      assert.deepEqual(fields.after('message', 'recorded_at', TIME, [], { after_id: 'b', limit: 2 }).map(row => row.id), ['é', 'Ω']);
      records.write([{ id: 'a0', type: 'message', value: null }]);
      assert.deepEqual(fields.after('message', 'recorded_at', TIME, [], { after_id: 'a0', limit: 2 }).map(row => row.id), ['a00', 'b'], 'a cursor remains usable when its exact row was deleted');
      for (const after_id of ['', null, 0, {}, 'a\u0000b']) assert.throws(() => fields.after('message', 'recorded_at', TIME, [], { after_id, limit: 2 }), /after_id/);
      assert.throws(() => fields.after('message', 'recorded_at', undefined, [], { after_id: 'a', limit: 2 }), /after_id/);
    } finally { host.db.close(); }
  });

  test(`${engine}: more than a page of identical values drains with exact limits after restart`, () => {
    const { host, open } = cursorFixture(engine);
    try {
      let { records } = open();
      const expected = Array.from({ length: 407 }, (_, n) => `m${String(n).padStart(4, '0')}`);
      records.write(expected.map(id => message(id)));
      records.checkpoint?.();
      const got = [];
      let after = BEFORE, after_id;
      for (let page = 0; page < 5; page++) {
        const { fields } = open();
        const rows = fields.after('message', 'recorded_at', after, ['speaker'], { limit: 100, ...(after_id ? { after_id } : {}) });
        assert.ok(rows.length <= 100);
        got.push(...rows.map(row => row.id));
        if (!rows.length) break;
        after = rows.at(-1).recorded_at; after_id = rows.at(-1).id;
      }
      assert.deepEqual(got, expected);
      assert.deepEqual(open().fields.after('message', 'recorded_at', after, [], { after_id, limit: 100 }), []);
    } finally { host.db.close(); }
  });
}

for (const engine of ['record-log', 'eeaf']) {
  test(`${engine}: selected fields preserve deduplication, membership and recovery`, () => {
    const { host, open } = cursorFixture(engine);
    try {
      let { records, fields } = open();
      records.write([message('wanted'), { id:'other', type:'note', value:{speaker:'wrong type'} }]);
      records.checkpoint?.();
      ({records,fields}=open());
      const ids=['wanted','absent','other','wanted'];
      assert.deepEqual(fields.fieldsOf('message', ids, ['speaker','speaker','missing']),new Map([['wanted',{id:'wanted',speaker:'ai'}]]));
      assert.deepEqual(fields.fieldsOf('message', ids, []),new Map([['wanted',{id:'wanted'}]]));
      assert.deepEqual(fields.fieldsOf('message', [], ['speaker']),new Map());
      assert.throws(()=>host.transaction(()=>{records.write([{id:'wanted',type:'message',value:null}]);throw Error('rollback fields');}),/rollback fields/);
      records.forgetCached?.();
      ({records,fields}=open());
      assert.equal(fields.fieldsOf('message',['wanted'],['speaker']).get('wanted').speaker,'ai');
      records.write([{id:'wanted',type:'message',value:null}]);
      assert.equal(fields.fieldsOf('message',['wanted'],['speaker']).size,0);
      records.write([message('wanted',{speaker:'person'})]);records.checkpoint?.();
      assert.equal(open().fields.fieldsOf('message',['wanted'],['speaker']).get('wanted').speaker,'person');
    } finally {host.db.close();}
  });
}
