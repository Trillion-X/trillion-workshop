import {blake3} from '@noble/hashes/blake3.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export const ORIGINAL_WORK_INSTALLATION_SHARDS=64;
export const originalWorkInstallationKey=(owner,resource)=>bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([owner,resource]))));
export const originalWorkInstallationBucket=(owner,resource)=>Number.parseInt(originalWorkInstallationKey(owner,resource).slice(0,2),16)%ORIGINAL_WORK_INSTALLATION_SHARDS;
export const originalWorkInstallationShardName=(owner,bucket)=>{
  if(typeof owner!=='string'||!owner||!Number.isInteger(bucket)||bucket<0||bucket>=ORIGINAL_WORK_INSTALLATION_SHARDS)throw new TypeError('A bounded original installation shard is required.');
  return `original-work-installation:${JSON.stringify([owner,bucket])}`;
};
const fail=message=>Object.assign(new Error(message),{status:409});
export function originalWorkInstallationShard(sql,transaction,owner,bucket){
  sql.exec('CREATE TABLE IF NOT EXISTS original_work_installations (generation TEXT NOT NULL,resource_key TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(generation,resource_key),UNIQUE(generation,resource))');
  sql.exec('CREATE TABLE IF NOT EXISTS original_work_installation_transfer (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL,to_owner TEXT NOT NULL)');
  const keyFor=resource=>{
    if(typeof resource!=='string'||!resource||resource.length>200||originalWorkInstallationBucket(owner,resource)!==bucket)throw fail('The independent resource belongs to another installation shard.');
    return originalWorkInstallationKey(owner,resource);
  };
  return {
    reserve(generation,resource){const key=keyFor(resource);return transaction(()=>{
      if(sql.exec('SELECT 1 FROM original_work_installation_transfer WHERE singleton=1 LIMIT 1').toArray().length)throw fail('The original account installation shard is frozen for transfer.');
      const prior=sql.exec('SELECT resource,state FROM original_work_installations WHERE generation=? AND resource_key=? LIMIT 1',generation,key).toArray()[0];
      if(prior){if(prior.resource!==resource)throw fail('A different original resource owns this installation identity.');return {reserved:true,repeated:true,state:prior.state};}
      sql.exec("INSERT INTO original_work_installations VALUES(?,?,?,'pending')",generation,key,resource);
      return {reserved:true,repeated:false,state:'pending'};
    });},
    install(generation,resource,{transfer_recovery=null}={}){const key=keyFor(resource);return transaction(()=>{
      const transfer=sql.exec('SELECT generation,to_owner FROM original_work_installation_transfer WHERE singleton=1 LIMIT 1').toArray()[0];
      if(transfer&&(transfer.generation!==generation||transfer.to_owner!==transfer_recovery?.to_owner))throw fail('Only the proved receiving move may finish a frozen installation.');
      const prior=sql.exec('SELECT resource,state FROM original_work_installations WHERE generation=? AND resource_key=? LIMIT 1',generation,key).toArray()[0];
      if(!prior||prior.resource!==resource)throw fail('This original work has no durable source reservation.');
      if(prior.state==='installed')return {installed:true,repeated:true};
      if(prior.state!=='pending')throw fail('The original installation state is unknown.');
      sql.exec("UPDATE original_work_installations SET state='installed' WHERE generation=? AND resource_key=? AND state='pending'",generation,key);
      return {installed:true,repeated:false};
    });},
    installed(generation,resource){keyFor(resource);return sql.exec("SELECT 1 FROM original_work_installations WHERE generation=? AND resource=? AND state='installed' LIMIT 1",generation,resource).toArray().length===1;},
    freeze(generation,to_owner){if(typeof to_owner!=='string'||!to_owner)throw fail('The receiving account is required.');return transaction(()=>{
      const prior=sql.exec('SELECT generation,to_owner FROM original_work_installation_transfer WHERE singleton=1 LIMIT 1').toArray()[0];
      if(prior&&(prior.generation!==generation||prior.to_owner!==to_owner))throw fail('Another account move owns this installation shard.');
      if(!prior)sql.exec('INSERT INTO original_work_installation_transfer VALUES(1,?,?)',generation,to_owner);
      return {frozen:true,generation,to_owner,bucket};
    });},
    page(generation,{after='',limit=100}={}){
      if(typeof after!=='string'||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Read at most 100 original installation rows.');
      const rows=sql.exec('SELECT resource_key,resource,state FROM original_work_installations WHERE generation=? AND resource_key>? ORDER BY resource_key LIMIT ?',generation,after,limit+1).toArray();
      return {generation,bucket,resources:rows.slice(0,limit),after:rows.length>limit?rows[limit-1].resource_key:null};
    },
    at(generation,key){if(typeof key!=='string'||!key)throw fail('The source installation key is required.');return sql.exec('SELECT resource_key,resource,state FROM original_work_installations WHERE generation=? AND resource_key=? LIMIT 1',generation,key).toArray()[0]??null;},
  };
}

