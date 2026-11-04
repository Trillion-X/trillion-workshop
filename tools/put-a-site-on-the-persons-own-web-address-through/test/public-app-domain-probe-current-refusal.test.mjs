// AUTHORED ONLY, UNPARSED/UNRUN. Real domain algorithm and legacy SQLite,
// with explicit simulated DNS/provider/HTTPS transport. No original provider,
// native inventory, CAS, grant, quota or production effect is supplied.
// Production's HTTP constructor uses default global fetch. WorkFailure/current
// errors below exercise this explicit dependency boundary, not live fetch reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {WorkFailure,failureOf} from '../../keep-and-wake-ai-sessions-on-this-computer/src/failure.mjs';
import {publicAppDomains,publicAppDomainKey,publicAppDomainProbePath} from '../src/public-app-domains.mjs';

const host='shop.example.com',installationId='a'.repeat(32),ownerUserId='domain-probe-owner',token='fixture-probe-proof';
const target={host,installationId,ownerUserId},key=publicAppDomainKey(host);
const cname='This domain does not reach the public app host yet. Check its CNAME and host connection.';
function fixture(t,{status='awaiting_dns',probe}={}){
 const db=sqliteHost(':memory:');t.after(()=>db.db.close());
 db.sql.exec('CREATE TABLE legacy_probe_domain(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const trace={puts:0,dns:0,probes:0,provider:[]};let attached=status==='active';
 const write=(key,value)=>db.sql.exec('INSERT INTO legacy_probe_domain VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);
 write(key,JSON.stringify({installation_id:installationId,owner_user_id:ownerUserId,status,token,created_at:'2026-10-16T00:00:00.000Z',...(status==='active'?{attached_at:'2026-10-15T00:00:00.000Z'}:{})}));
 const storage={get:async(name,type)=>{const value=db.sql.exec('SELECT value FROM legacy_probe_domain WHERE key=?',name).toArray()[0]?.value??null;return type==='json'?JSON.parse(value??'null'):value;},
  put:async(name,value)=>{trace.puts++;write(name,value);}};
 const provider={
  read:async input=>{trace.provider.push('read');assert.deepEqual(input,{host,installationId});return {host,status:attached?'attached':'absent',...(attached?{installation_id:installationId}:{}),provider:'fixture'};},
  attach:async input=>{trace.provider.push('attach');assert.equal(input.host,host);assert.equal(input.installationId,installationId);attached=true;},
  detach:async()=>{trace.provider.push('detach');throw Error('The activation probe must never detach.');},
 };
 const fetcher=async(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url.startsWith('https://cloudflare-dns.com/')){trace.dns++;return Response.json({Answer:[{type:16,data:'"trillion-public-app='+token+'"'}]});}
  assert.equal(url,'https://'+host+publicAppDomainProbePath);assert.equal(options.headers.accept,'text/plain');trace.probes++;return probe();
 };
 const row=()=>JSON.parse(db.sql.exec('SELECT value FROM legacy_probe_domain WHERE key=?',key).toArray()[0].value);
 return {domains:publicAppDomains({storage,provider,fetcher}),row,trace,attached:()=>attached};
}
function retained(f,status){
 const row=f.row();
 assert.equal(row.status,status==='active'?'active':'awaiting_attachment');
 assert.equal(row.installation_id,installationId);assert.equal(row.owner_user_id,ownerUserId);assert.equal(row.token,token);
 assert.equal(row.attached_at,status==='active'?'2026-10-15T00:00:00.000Z':undefined);assert.equal(row.ended_at,undefined);
 assert.deepEqual(row.provider_readback,{host,status:'attached',installation_id:installationId,provider:'fixture'});
 assert.equal(typeof row.provider_checked_at,'string');assert.equal(f.attached(),true);
 assert.equal(f.trace.puts,2);assert.equal(f.trace.dns,1);assert.equal(f.trace.probes,1);
 assert.deepEqual(f.trace.provider,status==='active'?['read']:['read','attach','read']);
}

test('HTTPS probe retains actual shared temporary/storage failures after attachment and live recheck',async t=>{
 for(const code of ['service-interrupted','service-busy','resource-exhausted','use-budget-reached','store-full'])for(const status of ['awaiting_dns','active']){
  const error=new WorkFailure(code,'Fixture original shared failure during HTTPS challenge.');
  if(code==='use-budget-reached')error.retry_at=Date.parse('2100-01-01T00:00:00.000Z');
  assert.equal(failureOf(error).tries_again_later,true);
  const f=fixture(t,{status,probe:async()=>{throw error;}});
  await assert.rejects(f.domains.activate(target),actual=>actual===error);
  retained(f,status);
 }
});

test('HTTPS probe retains current typed source, rights, conflict and erased-original refusals',async t=>{
 for(const statusCode of [403,409,410,503])for(const status of ['awaiting_dns','active']){
  const error=Object.assign(new Error('Fixture current source or original authority refused the HTTPS challenge.'),{status:statusCode,...(statusCode===503?{code:'account_app_original_state_pending'}:{})});
  const f=fixture(t,{status,probe:async()=>{throw error;}});
  await assert.rejects(f.domains.activate(target),actual=>actual===error);
  retained(f,status);
 }
});

test('ordinary unclassified HTTPS fetch failure retains the exact CNAME guidance and provider state',async t=>{
 const error=new Error('Fixture HTTPS challenge is unreachable.');
 assert.equal(failureOf(error).code,'unexpected');
 const f=fixture(t,{probe:async()=>{throw error;}});
 await assert.rejects(f.domains.activate(target),actual=>actual!==error&&actual.message===cname&&actual.status===undefined);
 retained(f,'awaiting_dns');
});

test('an HTTP challenge refusal or wrong proof remains a CNAME failure after provider readback',async t=>{
 for(const [status,body]of [[403,'Fixture challenge refused'],[200,'wrong-proof']]){
  const f=fixture(t,{probe:async()=>new Response(body,{status})});
  await assert.rejects(f.domains.activate(target),actual=>actual.message===cname&&actual.status===undefined);
  retained(f,'awaiting_dns');
 }
});
