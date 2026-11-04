import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../src/local-store.mjs';
import {keptRuns} from '../parts/record-log/do-work/kept-runs.mjs';
test('a warm catalogue reload refuses a newly unsupported format before reusing its cached dense run',t=>{
 const host=sqliteHost(':memory:');t.after(()=>host.db.close());
 const owner=keptRuns(host.sql,{transaction:host.transaction,prefix:'warm_format',cache_bytes:4096});owner.put('a-public',{keep:1});owner.flush();assert.deepEqual(owner.get('a-public'),{keep:1});
 host.sql.exec('ALTER TABLE warm_format_runs ADD COLUMN page_format INTEGER NOT NULL DEFAULT 0');owner.reloadCatalog();assert.deepEqual(owner.get('a-public'),{keep:1});
 host.sql.exec('UPDATE warm_format_runs SET page_format=2');const before=host.sql.exec('SELECT * FROM warm_format_runs').toArray(),execute=host.sql.exec,effects=[];
 host.sql.exec=(query,...args)=>{if(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(query))effects.push(query);return execute(query,...args);};
 try{assert.throws(()=>owner.reloadCatalog(),error=>error.message==='Unsupported kept page format.');assert.deepEqual(effects,[]);}finally{host.sql.exec=execute;}
 assert.deepEqual(host.sql.exec('SELECT * FROM warm_format_runs').toArray(),before);
});
