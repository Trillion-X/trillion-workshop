import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {originalWorkInstallationBucket,originalWorkInstallationShard,originalWorkInstallationShardName} from '../src/original-work-installation-shard.mjs';

test('independent reservation survives interruption and transfer freeze without a catalogue write',()=>{
 const owner='person:7',resource='work:a',bucket=originalWorkInstallationBucket(owner,resource);
 const h=sqliteHost(':memory:');try{
  const shard=originalWorkInstallationShard(h.sql,h.transaction,owner,bucket);
  assert.match(originalWorkInstallationShardName(owner,bucket),/^original-work-installation:/);
  assert.deepEqual(shard.reserve('initial',resource),{reserved:true,repeated:false,state:'pending'});
  assert.deepEqual(shard.reserve('initial',resource),{reserved:true,repeated:true,state:'pending'});
  assert.deepEqual(shard.page('initial').resources.map(row=>[row.resource,row.state]),[[resource,'pending']]);
  assert.deepEqual(shard.freeze('initial','person:recipient'),{frozen:true,generation:'initial',to_owner:'person:recipient',bucket});
  let another='work:b';while(originalWorkInstallationBucket(owner,another)!==bucket)another+='b';
  assert.throws(()=>shard.reserve('initial',another),/frozen for transfer/);
  assert.throws(()=>shard.reserve('initial',resource),/frozen for transfer/);
  assert.throws(()=>shard.freeze('initial','person:another'),/Another account move/);
  assert.throws(()=>shard.install('initial',resource),/Only the proved receiving move/);
  assert.deepEqual(shard.install('initial',resource,{transfer_recovery:{to_owner:'person:recipient'}}),{installed:true,repeated:false});
  assert.equal(shard.installed('initial',resource),true);
  assert.deepEqual(shard.install('initial',resource,{transfer_recovery:{to_owner:'person:recipient'}}),{installed:true,repeated:true});
  assert.deepEqual(shard.page('initial').resources.map(row=>row.state),['installed']);
 }finally{h.db.close();}
});
