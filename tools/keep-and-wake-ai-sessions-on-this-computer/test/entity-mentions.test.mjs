// Ported from old trillion test/entity-mentions.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. resolveKnownEntities is this tool's src/entity-mentions.mjs and makeLists is
// tools/keep-lists-of-rows/lists.mjs (old src/lists.mjs). Left out: the eight tests that sent words through the store's
// arrival door (old src/inbound.mjs `inbound`, with resolveKeptMessage on its kept messages): that door is gone and no
// running code ingests an arrival through resolveKeptMessage (searched the three repos for inbound.mjs, `inbound({`,
// resolveKeptMessage and arrivalsOf: only this module and held copies). The six tests over the lists' rows and
// resolveKnownEntities are the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { resolveKnownEntities } from '../src/entity-mentions.mjs';
// This file writes made-up fields onto real kinds to prove a projection keeps fields it does not own, not shapes the
// product writes, so the deploy guard's strict model (src/record-engine.mjs RECORD_MODEL_STRICT) is off here.
process.env.RECORD_MODEL_STRICT = '';

function setup() {
  const store = localStore(':memory:');
  const eeaf = store.eeaf;
  const lists = makeLists({ eeaf });
  lists.save({ id: 'people', label: 'People', title_field: 'name', fields: [
    { id: 'name', label: 'Name', kind: 'text' }, { id: 'aliases', label: 'Aliases', kind: 'text' },
  ] });
  return { eeaf, lists };
}

test('a row changed, renamed or removed is found, or no longer found, by its new spellings', () => {
  const { eeaf, lists } = setup();
  lists.putRows('people', { rows: [{ id: 'dad', values: { name: 'Alex Rivera', aliases: 'Alexi' } }] });
  const seen = text => resolveKnownEntities(eeaf, text).mentions.map(mention => mention.id);
  assert.deepEqual(seen('Alexi called, and Alex Rivera too.'), ['record:people:dad', 'record:people:dad']);
  lists.putRows('people', { rows: [{ id: 'dad', values: { aliases: 'Dad' } }] });
  assert.deepEqual(seen('Alexi called.'), [], 'an alias taken away no longer names the row');
  assert.deepEqual(seen('Dad called.'), ['record:people:dad']);
  lists.putRows('people', { rows: [{ id: 'dad', values: { name: 'Alex Q Rivera' } }] });
  assert.deepEqual(seen('Alex Rivera called.'), [], 'a title changed is no longer the old name');
  assert.deepEqual(seen('Alex Q Rivera called.'), ['record:people:dad']);
  lists.putRows('people', { rows: [], remove: ['dad'] });
  assert.deepEqual(seen('Dad and Alex Q Rivera called.'), [], 'a removed row names nothing');
});

test('rows a list held before its index existed are indexed a page at a time as words are checked', () => {
  const { eeaf, lists } = setup();
  // Rows written some other way than lists.putRows (an older store) have no index entries.
  for (let n = 0; n < 250; n += 1) eeaf.write([{ id: `record:people:old${n}`, type: 'record:people', value: { name: `Person Number${n} Kept` } }], { actor: { by: 'test' } });
  const seen = text => resolveKnownEntities(eeaf, text).mentions.map(mention => mention.id);
  const found = [];
  for (let step = 0; step < 4; step += 1) found.push(seen('Person Number0 Kept and Person Number249 Kept'));
  assert.deepEqual(found.at(-1).sort(), ['record:people:old0', 'record:people:old249'], 'every row was indexed after a few checks');
  assert.ok(found[0].length < 2, 'one check does not read the rows of the whole list');
});

test('checking words for names reads the same for 50 rows as for 200', () => {
  const costOf = rows => {
    const { eeaf, lists } = setup();
    lists.putRows('people', { rows: Array.from({ length: rows }, (_, n) => ({ id: `p${n}`, values: { name: `Person Number${n} Kept`, aliases: `Pn${n}` } })) });
    const text = 'Person Number3 Kept said Pn7 should call Person Number40 Kept about the plan for the trip next week.';
    for (let step = 0; step < 4; step += 1) resolveKnownEntities(eeaf, text);
    let looked = 0;
    const { read, ids } = eeaf;
    const { fieldsOf } = eeaf.fields;
    eeaf.read = id => { looked += 1; return read.call(eeaf, id); };
    eeaf.ids = (...args) => { looked += 1000; return ids.apply(eeaf, args); };
    eeaf.fields.fieldsOf = (type, wanted, names) => { looked += wanted.length; return fieldsOf.call(eeaf.fields, type, wanted, names); };
    const mentions = resolveKnownEntities(eeaf, text).mentions;
    eeaf.read = read; eeaf.ids = ids; eeaf.fields.fieldsOf = fieldsOf;
    assert.equal(mentions.length, 3);
    return looked;
  };
  const small = costOf(50);
  const large = costOf(200);
  assert.equal(large, small, `a check read ${small} records with 50 rows and ${large} with 200`);
});

test('presentation saves preserve completed matching while title and alias changes rebuild', () => {
  const { eeaf, lists } = setup();
  const fields = [{id:'name',label:'Name',kind:'text'}, {id:'aliases',label:'Aliases',kind:'text'},
    {id:'display',label:'Display name',kind:'text'}, {id:'other',label:'Contact notes',kind:'text'}];
  lists.save({id:'people',fields});
  lists.putRows('people',{rows:Array.from({length:120},(_,n)=>({id:`p${n}`,values:{
    name:`Person Number${n} Kept`,aliases:`Pn${n}`,display:`New Title${n} Kept`,other:`Alternate${n}`}}))});
  const words='Person Number0 Kept and Pn0 called.';
  for(let n=0;n<3;n++) resolveKnownEntities(eeaf,words);
  const completed=eeaf.read('entity-list:people');
  assert.equal(completed.complete,true);
  const {ids,write}=eeaf, scans=[], indexWrites=[];
  eeaf.ids=(...args)=>{scans.push(args[0]);return ids.apply(eeaf,args);};
  eeaf.write=(rows,options)=>{if(options?.actor?.by==='entity-index')indexWrites.push(...rows);return write.call(eeaf,rows,options);};
  try {
    lists.save({id:'people'});
    lists.save({id:'people',label:'Contacts',icon:'person',about:'People to call',fields:[fields[3],fields[2],
      {...fields[1],label:'Also known as'},{...fields[0],label:'Shown name'}]});
    assert.deepEqual(eeaf.read('entity-list:people'),completed);
    assert.deepEqual(indexWrites,[],'presentation saves neither invalidate nor rebuild');
    scans.length=0;
    assert.equal(resolveKnownEntities(eeaf,words).mentions.length,2);
    assert.deepEqual(scans,[],'the next arrival walks neither lists nor rows');
    lists.save({id:'people',title_field:'display'});
    assert.equal(eeaf.read('entity-list:people').complete,false);
    scans.length=0;
    for(let n=0;n<3;n++)resolveKnownEntities(eeaf,'New Title0 Kept');
    assert.ok(scans.includes('record:people'));
    assert.deepEqual(resolveKnownEntities(eeaf,'Person Number0 Kept').mentions,[]);
    assert.deepEqual(resolveKnownEntities(eeaf,'Pn0').mentions.map(r=>[r.id,r.name]),[['record:people:p0','New Title0 Kept']]);
    assert.deepEqual(resolveKnownEntities(eeaf,'Alternate0').mentions,[]);
    lists.save({id:'people',fields:fields.map(f=>f.id==='other'?{...f,label:'Aka'}:f)});
    assert.equal(eeaf.read('entity-list:people').complete,false,'a label can change alias classification');
    for(let n=0;n<3;n++)resolveKnownEntities(eeaf,'Alternate0');
    assert.deepEqual(resolveKnownEntities(eeaf,'Alternate0').mentions.map(r=>r.id),['record:people:p0']);
    lists.save({id:'people',fields});
    assert.equal(eeaf.read('entity-list:people').complete,false);
    for(let n=0;n<3;n++)resolveKnownEntities(eeaf,'Alternate0');
    assert.deepEqual(resolveKnownEntities(eeaf,'Alternate0').mentions,[]);
  }finally{eeaf.ids=ids;eeaf.write=write;}
});

test('long repeated text reads each matching and ambiguous spelling once per resolution, and no absent one', () => {
  const {eeaf,lists}=setup();
  lists.putRows('people',{rows:[{id:'dad',values:{name:'Alex Rivera',aliases:'Alexi'}},
    {id:'one',values:{name:'Sam North',aliases:'Sammy'}},{id:'two',values:{name:'Sam South',aliases:'Sammy'}}]});
  resolveKnownEntities(eeaf,'Alexi');
  const original=eeaf.fields.fieldsOf, reads=new Map(), held=new Set(), absent=new Set();
  eeaf.fields.fieldsOf=(type,wanted,names)=>{
    const values=original.call(eeaf.fields,type,wanted,names);
    if(type==='entity-spelling')for(const id of wanted){reads.set(id,(reads.get(id)??0)+1);(values.has(id)?held:absent).add(id);}
    return values;
  };
  const sentence='Alexi spoke with Alex Rivera while Phantom and Sammy were away. ';
  try{
    const result=resolveKnownEntities(eeaf,sentence.repeat(100));
    assert.equal(result.text,sentence.replace('Alexi','Alex Rivera').repeat(100));
    assert.equal(result.mentions.length,200);
    assert.ok(result.mentions.every(r=>r.id==='record:people:dad'));
    assert.ok(held.size);
    assert.equal(absent.size,0,'a spelling nobody has is never read');
    assert.ok([...reads.values()].every(n=>n===1),'page boundaries repeat neither matches nor misses');
    const cost=[...reads.values()].reduce((a,b)=>a+b,0);
    reads.clear();held.clear();absent.clear();
    resolveKnownEntities(eeaf,sentence.repeat(10));
    assert.equal([...reads.values()].reduce((a,b)=>a+b,0),cost,'ten times repeated text has the same index read cost');
  }finally{eeaf.fields.fieldsOf=original;}
  lists.putRows('people',{rows:[{id:'dad',values:{aliases:'Phantom'}}]});
  assert.deepEqual(resolveKnownEntities(eeaf,'Alexi Phantom').mentions.map(r=>r.said),['Phantom']);
  lists.putRows('people',{rows:[],remove:['dad']});
  assert.deepEqual(resolveKnownEntities(eeaf,'Phantom').mentions,[]);
});

test('a long message looks up only the spellings someone has, and finds the same names', () => {
  const { eeaf, lists } = setup();
  lists.putRows('people', { rows: [{ id: 'dad', values: { name: 'Alex Rivera', aliases: 'Alexi' } }, { id: 'sam', values: { name: 'Sam Ortiz' } }] });
  const filler = Array.from({ length: 3000 }, (_, i) => `word${i % 97}`).join(' ');
  const text = `${filler} then Alexi met Sam Ortiz. ${filler}`;
  const own = eeaf.fields.fieldsOf.bind(eeaf.fields);
  let looked = 0;
  eeaf.fields.fieldsOf = (type, ids, names) => { if (type === 'entity-spelling') looked += ids.length; return own(type, ids, names); };
  const resolved = resolveKnownEntities(eeaf, text);
  assert.deepEqual(resolved.mentions.map(mention => mention.id), ['record:people:dad', 'record:people:sam']);
  assert.ok(looked <= 10, `looked up ${looked} spellings for a 6000-word message`);
  lists.putRows('people', { rows: [{ id: 'kai', values: { name: 'Kai Lund' } }] });
  assert.deepEqual(resolveKnownEntities(eeaf, `${filler} Kai Lund said`).mentions.map(mention => mention.id), ['record:people:kai']);
});
