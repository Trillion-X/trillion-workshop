// Ported from old trillion test/search-source-clock-recovery.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. searchFeedWriter and ensureSearchFeed are this tool's src/search-feed.mjs (old
// src/search-feed.mjs); the store is keep-and-wake's sqliteHost on a real file, as before. The old results store
// (src/namespace-results.mjs resultsStore) is gone: `resultsStore` below stands in for the two things these tests used,
// its construction (the results table, then ensureSearchFeed, as old resultsStore began) and put/remove of a row keyed by
// the BLAKE3 of its value. Tests 1 and 3 keep every assertion.
// Left out: the three tests that booted the retired PersonStore (bootPerson) to prove its constructor's DDL ledger
// (schema_version ddl) recovers a missing clock: searched the three repos for schema_version, bootPerson and
// search_feed_source_clock; the only schema_version rows left are list descriptors' (keep-lists-of-rows) and trillion-rust
// record sources', and no running constructor keeps a deferred-DDL ledger for this clock.
// Persistent source-clock recovery. Synthetic rows only; actual local PersonStore boot, no external call.
// These cases use the actual SQLite owners and execute no copied search/schema implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {blake3} from '@noble/hashes/blake3.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {ensureSearchFeed,searchFeedWriter} from '../src/search-feed.mjs';

// The old resultsStore as these tests used it: made, it holds the results table and the feed's triggers; put keeps a row
// only when its value changed (value_identity is the BLAKE3 of the value); remove deletes one.
function resultsStore(sql){
 sql.exec('CREATE TABLE IF NOT EXISTS namespace_results (identity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, produced_by TEXT, value_identity TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (identity, kind))');
 ensureSearchFeed(sql);
 return {
  put(rows){for(const row of rows){const value=JSON.stringify(row.value),value_identity=`1f:${bytesToHex(blake3(new TextEncoder().encode(value)))}`;
   sql.exec(`INSERT INTO namespace_results (identity,kind,value,produced_by,value_identity,recorded_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(identity,kind) DO UPDATE SET value=excluded.value,produced_by=excluded.produced_by,value_identity=excluded.value_identity,recorded_at=excluded.recorded_at
    WHERE namespace_results.value_identity IS NOT excluded.value_identity`,row.identity,row.kind,value,row.produced_by??null,value_identity,new Date().toISOString());}},
  remove(identity,kind){sql.exec('DELETE FROM namespace_results WHERE identity=? AND kind=?',identity,kind);},
 };
}

const own=n=>`1f:${n.toString(16).padStart(64,'0')}`;
const OLD_RESULTS='CREATE TABLE namespace_results (identity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, produced_by TEXT, value_identity TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (identity, kind))';
// Exact namespaceStore file-table shape at the source basis; no live/private file is copied.
const OLD_FILES='CREATE TABLE namespace_files (identity TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, media_type TEXT, origin TEXT NOT NULL, key TEXT NOT NULL, part_bytes INTEGER NOT NULL, stored_at TEXT NOT NULL, checked_at TEXT NOT NULL, checked_part INTEGER, prefix_identity TEXT, arrival_revision TEXT, arrival_completed_revision TEXT)';
const table=(sql,name)=>sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name).toArray().length===1;
const columns=sql=>sql.exec('PRAGMA table_info(search_feed_source_clock)').toArray().map(row=>row.name);
const clock=sql=>({...sql.exec('SELECT revision,watch_files FROM search_feed_source_clock WHERE singleton=1').one()});
function persistent(t){
 const directory=mkdtempSync(join(tmpdir(),'trillion-source-clock-')),file=join(directory,'store.sqlite');let current=null;
 const close=()=>{if(current){current.host.db.close();current=null;}};
 const open=()=>{
  assert.equal(current,null,'close the old database and its prepared/counted owners before reopening');
  const host=sqliteHost(file);current={host,sql:host.sql,transaction:host.transaction};return current;
 };
 t.after(()=>{close();t.diagnostic('retained synthetic disk fixture: '+directory);});return {open,close};
}
function failAfter(f,pattern,error){
 let reached=0;
 return {sql:{exec(query,...params){
  const cursor=f.sql.exec(query,...params);
  if(pattern.test(query)){assert.equal(f.host.db.isTransaction,true,'the real SQLite BEGIN is active at the failpoint');reached++;throw error;}
  return cursor;
 }},reached:()=>reached};
}
const filePut=(sql,id)=>sql.exec("INSERT INTO namespace_files (identity,byte_length,media_type,origin,key,part_bytes,stored_at,checked_at) VALUES (?,10,'video/mp4','small','synthetic',10,'now','now')",id);

test('missing and revision-only old clocks roll back failed initialization and recover across actual disk reopen',t=>{
 {
 const disk=persistent(t);let f=disk.open();f.sql.exec(OLD_RESULTS);
 f.sql.exec('INSERT INTO namespace_results VALUES (?,?,?,?,?,?)',own(1),'transcript','{"text":"synthetic older result"}',null,own(101),'same-time');
 assert.equal(table(f.sql,'search_feed_source_clock'),false);
 const error=new Error('synthetic failure after actual clock seed'),failed=failAfter(f,/^INSERT OR IGNORE INTO search_feed_source_clock\b/,error);
 assert.throws(()=>f.transaction(()=>searchFeedWriter(failed.sql).sourceRevision()),caught=>caught===error,'initialization propagates the actual failure');
 assert.equal(failed.reached(),1);assert.equal(f.host.db.isTransaction,false);
 assert.equal(table(f.sql,'search_feed_source_clock'),false,'CREATE and seed were rolled back, not accepted as an empty answer');
 assert.equal(f.sql.exec('SELECT value FROM namespace_results WHERE identity=? AND kind=?',own(1),'transcript').one().value,'{"text":"synthetic older result"}');
 disk.close();f=disk.open();assert.equal(table(f.sql,'search_feed_source_clock'),false,'the rollback is durable in the real file');
 const feed=searchFeedWriter(f.sql);assert.equal(feed.sourceRevision(),0);assert.deepEqual(clock(f.sql),{revision:0,watch_files:0});
 assert.equal(table(f.sql,'search_feed'),false,'reader bootstrap supplies the clock, not result triggers or registration');
 const results=resultsStore(f.sql);feed.register(['transcript']);
 results.put([{identity:own(1),kind:'transcript',value:{text:'synthetic new result'}}]);assert.equal(feed.sourceRevision(),1);
 disk.close();f=disk.open();assert.equal(searchFeedWriter(f.sql).sourceRevision(),1,'a new SQL/count/statement owner preserves the recovered frontier');
 }
 {
 const disk=persistent(t);let f=disk.open();f.sql.exec(OLD_RESULTS);
 f.sql.exec('CREATE TABLE search_feed_source_clock (singleton INTEGER PRIMARY KEY CHECK (singleton=1),revision INTEGER NOT NULL)');
 f.sql.exec('INSERT INTO search_feed_source_clock VALUES (1,7)');
 const error=new Error('synthetic failure after actual watch_files ALTER'),failed=failAfter(f,/^ALTER TABLE search_feed_source_clock ADD COLUMN watch_files\b/,error);
 assert.throws(()=>f.transaction(()=>searchFeedWriter(failed.sql).sourceRevision()),caught=>caught===error);
 assert.equal(failed.reached(),1);assert.equal(f.host.db.isTransaction,false);assert.equal(columns(f.sql).includes('watch_files'),false);
 disk.close();f=disk.open();assert.equal(columns(f.sql).includes('watch_files'),false);
 assert.equal(f.sql.exec('SELECT revision FROM search_feed_source_clock WHERE singleton=1').one().revision,7);
 const feed=searchFeedWriter(f.sql);assert.equal(feed.sourceRevision(),7);assert.deepEqual(clock(f.sql),{revision:7,watch_files:0});
 feed.watchFiles();assert.deepEqual(clock(f.sql),{revision:7,watch_files:1});
 disk.close();f=disk.open();const cold=searchFeedWriter(f.sql);assert.equal(cold.sourceRevision(),7);assert.deepEqual(clock(f.sql),{revision:7,watch_files:1});
 resultsStore(f.sql);searchFeedWriter(f.sql);assert.deepEqual(clock(f.sql),{revision:7,watch_files:1},'later result construction and repeat writer opens reset neither persisted field');
 assert.equal(f.sql.exec('SELECT count(*) AS n FROM search_feed_source_clock').one().n,1);
 }
});

test('recovered result and file triggers retain genuine source currentness through ack rollback and cold reopen',t=>{
 const disk=persistent(t);let f=disk.open();f.sql.exec(OLD_RESULTS);f.sql.exec(OLD_FILES);
 let feed=searchFeedWriter(f.sql),results=resultsStore(f.sql);feed.register(['transcript']);assert.equal(feed.sourceRevision(),0);
 results.put([{identity:own(1),kind:'transcript',value:{text:'first synthetic source'}}]);assert.equal(feed.sourceRevision(),1);
 results.put([{identity:own(2),kind:'transcript',produced_by:'search:meaning',value:{text:'synthetic derived output'}}]);
 results.put([{identity:own(3),kind:'unregistered',value:{text:'synthetic untracked output'}}]);assert.equal(feed.sourceRevision(),1,'derived/unregistered writes do not masquerade as new source');
 results.put([{identity:own(1),kind:'transcript',value:{text:'first synthetic source'}}]);assert.equal(feed.sourceRevision(),1,'identical source is not a source change');
 results.put([{identity:own(1),kind:'transcript',value:{text:'changed synthetic source'}}]);assert.equal(feed.sourceRevision(),2);
 results.remove(own(1),'transcript');assert.equal(feed.sourceRevision(),3);
 filePut(f.sql,own(10));assert.equal(feed.sourceRevision(),3,'file watching starts only when the genuine reader enables it');
 feed.watchFiles();filePut(f.sql,own(11));assert.equal(feed.sourceRevision(),4);
 f.sql.exec("UPDATE namespace_files SET checked_at='later' WHERE identity=?",own(11));assert.equal(feed.sourceRevision(),4,'unrelated file bookkeeping is not source content');
 f.sql.exec("UPDATE namespace_files SET media_type='audio/wav' WHERE identity=?",own(11));assert.equal(feed.sourceRevision(),5);
 f.sql.exec('UPDATE namespace_files SET byte_length=11 WHERE identity=?',own(11));assert.equal(feed.sourceRevision(),6);
 f.sql.exec('UPDATE namespace_files SET identity=? WHERE identity=?',own(12),own(11));assert.equal(feed.sourceRevision(),7);
 f.sql.exec('DELETE FROM namespace_files WHERE identity=?',own(12));assert.equal(feed.sourceRevision(),8);
 const pending=feed.feed(0,100);assert.ok(pending.length>0);feed.ack(pending.at(-1).seq);assert.deepEqual(feed.feed(0,100),[]);assert.equal(feed.sourceRevision(),8,'acknowledging feed rows cannot rewind source currentness');
 const error=new Error('synthetic rollback after genuine source changes');
 assert.throws(()=>f.transaction(()=>{results.put([{identity:own(4),kind:'transcript',value:{text:'must roll back'}}]);filePut(f.sql,own(13));assert.equal(feed.sourceRevision(),10);throw error;}),caught=>caught===error);
 assert.equal(feed.sourceRevision(),8);assert.deepEqual(feed.feed(0,100),[]);
 assert.equal(f.sql.exec('SELECT count(*) AS n FROM namespace_results WHERE identity=?',own(4)).one().n,0);
 assert.equal(f.sql.exec('SELECT count(*) AS n FROM namespace_files WHERE identity=?',own(13)).one().n,0);
 disk.close();f=disk.open();feed=searchFeedWriter(f.sql);assert.deepEqual(clock(f.sql),{revision:8,watch_files:1});
 filePut(f.sql,own(14));assert.equal(feed.sourceRevision(),9,'persisted file triggers work before resultsStore reopens in this isolate');
 results=resultsStore(f.sql);results.put([{identity:own(5),kind:'transcript',value:{text:'cold synthetic source'}}]);assert.equal(feed.sourceRevision(),10,'idempotent trigger construction advances once per source change');
});
