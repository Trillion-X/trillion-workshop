// One person's received moderation labels form one invariant: the global
// distinct-labeler threshold and the asker's current one-step trust suppression.
// This owner contains neither a people directory nor introduction dispatch.
import rules from '../../introduce-two-people/src/network-settings.json' with {type:'json'};
import {identityOf} from '../../shared-code/src/typed-operation-contract.mjs';

const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const labelIds=new Set(rules.labels.map(row=>row.id));
const hiding=rules.labels.filter(row=>row.hides).map(row=>row.id);
// The partial index and query share the exact rules-derived literal predicate.
// Ordering by reporter makes DISTINCT+LIMIT stop at the configured threshold
// without sorting or walking non-hiding labels for this target.
const hidingPredicate=hiding.length?`label IN(${hiding.map(value=>`'${value.replaceAll("'","''")}'`).join(',')})`:'0';
export const nativeModerationReporterIndex=`native_moderation_hiding_reporters_${identityOf(hiding).slice(0,16)}`;
export const nativeModerationReporterQuery=`SELECT DISTINCT by_relay FROM labels INDEXED BY ${nativeModerationReporterIndex} WHERE relay=? AND ${hidingPredicate} ORDER BY by_relay LIMIT ?`;
const reportersOf=(sql,relay)=>sql.exec(nativeModerationReporterQuery,relay,rules.hide_after_labelers).toArray().map(row=>row.by_relay);
const columns=['relay','label','by_relay','at'];
export const nativeNetworkModerationResource=relay=>`network-moderation:${relay}`;
export const nativeModerationPageIdentity=rows=>identityOf(rows.map(row=>Object.fromEntries(columns.map(key=>[key,row[key]]))));
export const nativeModerationCursor=row=>JSON.stringify([row.label,row.by_relay]);
export function readNativeModerationCursor(value){
 if(value===null)return null;
 let cursor;try{cursor=JSON.parse(value);}catch{throw fail('Use the original moderation page cursor.',400);}
 if(!Array.isArray(cursor)||cursor.length!==2||cursor.some(item=>typeof item!=='string'||!item))throw fail('Use the original moderation page cursor.',400);
 return cursor;
}
export function hiddenFor(labels,relay,neighbours){
 const by=new Set(labels.filter(row=>row.relay===relay&&hiding.includes(row.label)).map(row=>row.by));
 return by.size>=rules.hide_after_labelers||[...by].some(labeler=>neighbours.has(labeler));
}
// The labels table itself, shared by the global Network's legacy rows and this owner.
export function setupLabelsTable(sql){
 sql.exec('CREATE TABLE IF NOT EXISTS labels(relay TEXT NOT NULL,label TEXT NOT NULL,by_relay TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(relay,label,by_relay))');
}
export function setupNativeModerationLabels(sql){
 setupLabelsTable(sql);
 sql.exec('CREATE INDEX IF NOT EXISTS labels_by_author ON labels(by_relay,relay,label)');
 sql.exec(`CREATE INDEX IF NOT EXISTS ${nativeModerationReporterIndex} ON labels(relay,by_relay,label) WHERE ${hidingPredicate}`);
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_erased_relays(relay TEXT PRIMARY KEY)');
}

export function nativeNetworkModeration({sql,transaction,target,resource,current,context,relay,neighbours,trust,source,now=()=>new Date().toISOString()}={}){
 if(!sql?.exec||typeof transaction!=='function'||typeof target!=='string'||!target
  ||resource!==nativeNetworkModerationResource(target)||typeof current!=='function'||typeof context!=='function'||typeof relay!=='function')
  throw new TypeError('Moderation requires its exact target, supplied durable transaction and current admitted shared command.');
 setupNativeModerationLabels(sql);
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_identity(id INTEGER PRIMARY KEY CHECK(id=1),relay TEXT NOT NULL,original_target TEXT NOT NULL)');
 sql.exec('INSERT OR IGNORE INTO native_moderation_identity VALUES(1,?,?)',target,target);
 if(sql.exec('SELECT original_target FROM native_moderation_identity WHERE id=1').toArray()[0].original_target!==target)throw fail('The installed moderation address belongs to another original target.');
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_carry(id INTEGER PRIMARY KEY CHECK(id=1),source TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,after_id TEXT,rows INTEGER NOT NULL DEFAULT 0)');
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_pages(after_id TEXT PRIMARY KEY,last_id TEXT,rows INTEGER NOT NULL,page_identity TEXT NOT NULL,exhausted INTEGER NOT NULL)');
 // Scalar custody columns are deliberately the canonical shared identity fields;
 // shared account transfer rewrites them and erasure can inspect exact custody.
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,relay TEXT NOT NULL,label TEXT NOT NULL,by_relay TEXT NOT NULL,at TEXT NOT NULL,permit_id TEXT NOT NULL,action TEXT NOT NULL)');
 sql.exec('CREATE INDEX IF NOT EXISTS native_moderation_history_author ON native_moderation_history(by_relay,sequence)');
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0)');
 sql.exec('INSERT OR IGNORE INTO native_moderation_revision VALUES(1,0)');
 for(const action of ['INSERT','UPDATE','DELETE'])sql.exec(`CREATE TRIGGER IF NOT EXISTS native_moderation_labels_${action.toLowerCase()} AFTER ${action} ON labels BEGIN UPDATE native_moderation_revision SET revision=revision+1 WHERE id=1; END`);
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_visibility(id TEXT PRIMARY KEY,asking_relay TEXT NOT NULL,relay TEXT NOT NULL,reporters_json TEXT NOT NULL,labels_identity TEXT NOT NULL,after_id TEXT,trust_revision INTEGER)');
 sql.exec('CREATE TABLE IF NOT EXISTS native_moderation_dependencies(permit_id TEXT PRIMARY KEY,asking_relay TEXT NOT NULL,relay TEXT NOT NULL,revision INTEGER NOT NULL,trust_input_json TEXT,trust_result_json TEXT)');
 const selected=()=>sql.exec('SELECT relay FROM native_moderation_identity WHERE id=1').toArray()[0].relay;
 const state=()=>sql.exec('SELECT * FROM native_moderation_carry WHERE id=1').toArray()[0];
 const principal=()=>{
  const actor=context(),by=relay();
  if(!actor?.owner||!actor.claims?.sign_in||!actor.permit_id||!by
   ||actor.commitment?.resource!==resource||actor.commitment.address!==resource||(actor.commitment.lifecycle?.network_moderation?.relay??actor.shared_relay)!==by)
   throw fail('Moderation requires its exact current admitted actor and target.',403);
  return {actor,by,identity:identityOf([actor.owner,actor.claims,actor.permit_id,actor.commitment,by])};
 };
 const authorize=async(operation,input)=>{const before=principal();await current(operation,input);const after=principal();if(before.identity!==after.identity)throw fail('The moderation command principal changed.',403);return after;};
 const ready=()=>{if(state()?.state!=='ready')throw fail('The original moderation source has not completed its bounded carry.',503);};
 const change=(label,by,action)=>sql.exec('INSERT INTO native_moderation_history(relay,label,by_relay,at,permit_id,action) VALUES(?,?,?,?,?,?)',selected(),label,by,now(),principal().actor.permit_id,action);

 const carry=async()=>{
  await authorize('network-moderation:carry',{});
  if(state()?.state==='ready')return {ready:true,copied:state().rows};
  if(!source?.begin||!source?.page||!source?.retire)throw fail('The original admitted moderation source is unavailable.',503);
  // A source erasure invalidates its generation, including an already copied
  // destination. Re-read the durable fence on every bounded continuation.
  const original=await source.begin({target:selected(),resource});
  if(original?.target!==selected()||original.resource!==resource||!original.source||!original.generation||original.fenced!==true)throw fail('The original moderation source did not retain its exact target fence.');
  await authorize('network-moderation:carry',{});
  transaction(()=>{
   const prior=state();
   if(prior&&prior.source!==original.source)throw fail('The original moderation source changed.');
   if(prior&&prior.generation!==original.generation){
    sql.exec('DELETE FROM labels');sql.exec('DELETE FROM native_moderation_pages');sql.exec('DELETE FROM native_moderation_carry');
   }
   sql.exec("INSERT OR IGNORE INTO native_moderation_carry(id,source,generation,state) VALUES(1,?,?,'copying')",original.source,original.generation);
  });
  const checkpoint=state();
  if(checkpoint.state==='copied'){
   const proof=await source.retire({target:selected(),resource,source:checkpoint.source,generation:checkpoint.generation,rows:checkpoint.rows});
   if(proof?.pending===true)return {ready:false,pending:true,copied:checkpoint.rows};
   if(proof?.retired!==true||proof.source!==checkpoint.source||proof.generation!==checkpoint.generation)throw fail('The original moderation source has not independently verified its replacement.');
   await authorize('network-moderation:carry',{});
   transaction(()=>{if(identityOf(state())!==identityOf(checkpoint))throw fail('The moderation checkpoint changed.');sql.exec("UPDATE native_moderation_carry SET state='ready' WHERE id=1");});
   return {ready:true,copied:checkpoint.rows};
  }
  const page=await source.page({target:selected(),resource,source:checkpoint.source,generation:checkpoint.generation,after:checkpoint.after_id,limit:16});
  if(page?.source!==checkpoint.source||page.generation!==checkpoint.generation||!Array.isArray(page.rows)||page.rows.length>16||typeof page.exhausted!=='boolean')throw fail('The original moderation carry page changed.');
  if(!page.rows.length&&!page.exhausted)throw fail('A moderation source page must advance or prove exact exhaustion.');
  let cursor=readNativeModerationCursor(checkpoint.after_id);
  for(const row of page.rows){
   if(row.relay!==selected()||columns.some(key=>typeof row[key]!=='string'||!row[key])||!labelIds.has(row.label)
    ||cursor&&(row.label<cursor[0]||row.label===cursor[0]&&row.by_relay<=cursor[1]))throw fail('The original moderation page is not exact ordered target data.');
   cursor=[row.label,row.by_relay];
  }
  await authorize('network-moderation:carry',{});
  return transaction(()=>{
   if(identityOf(state())!==identityOf(checkpoint))throw fail('The moderation checkpoint advanced concurrently.');
   for(const row of page.rows)sql.exec('INSERT INTO labels(relay,label,by_relay,at) VALUES(?,?,?,?)',...columns.map(key=>row[key]));
   const after=page.rows.length?nativeModerationCursor(page.rows.at(-1)):checkpoint.after_id;
   sql.exec('INSERT INTO native_moderation_pages VALUES(?,?,?,?,?)',checkpoint.after_id??'',after,page.rows.length,nativeModerationPageIdentity(page.rows),page.exhausted?1:0);
   sql.exec('UPDATE native_moderation_carry SET after_id=?,rows=rows+?,state=? WHERE id=1',after,page.rows.length,page.exhausted?'copied':'copying');
   return {ready:false,pending:true,copied:checkpoint.rows+page.rows.length};
  });
 };
 const carryProof=async input=>{
  await authorize('network-moderation:carryProof',input);const copied=state();
  if(copied?.state!=='copied'||input.source!==copied.source||input.generation!==copied.generation)throw fail('The actual moderation destination has not copied this original generation.');
  const page=sql.exec('SELECT * FROM native_moderation_pages WHERE after_id=?',input.after??'').toArray()[0];
  if(!page)throw fail('The actual moderation destination has no proof at this original cursor.');
  const lower=readNativeModerationCursor(input.after??null),upper=readNativeModerationCursor(page.last_id);
  const actual=page.exhausted?sql.exec('SELECT relay,label,by_relay,at FROM labels WHERE relay=? AND (? IS NULL OR (label,by_relay)>(?,?)) ORDER BY label,by_relay LIMIT 17',selected(),input.after??null,lower?.[0]??null,lower?.[1]??null).toArray()
   :upper?sql.exec('SELECT relay,label,by_relay,at FROM labels WHERE relay=? AND (? IS NULL OR (label,by_relay)>(?,?)) AND (label,by_relay)<=(?,?) ORDER BY label,by_relay LIMIT 17',selected(),input.after??null,lower?.[0]??null,lower?.[1]??null,...upper).toArray():[];
  const actualIdentity=nativeModerationPageIdentity(actual);
  if(actual.length!==page.rows||actualIdentity!==page.page_identity)throw fail('The actual moderation destination bytes no longer match the original page.');
  return {target:selected(),resource,source:copied.source,generation:copied.generation,state:copied.state,rows:copied.rows,page:{after:input.after??null,last_id:page.last_id,rows:actual.length,identity:actualIdentity,exhausted:page.exhausted===1}};
 };
 const label=async input=>{
  const {by}=await authorize('network-moderation:label',input);ready();
  if(input.relay!==selected())throw fail('The moderation command names another target.',403);
  if(!labelIds.has(input.label))throw fail(`label is one of: ${[...labelIds].join(', ')}`,400);
  if(sql.exec('SELECT 1 FROM native_moderation_erased_relays WHERE relay IN(?,?) LIMIT 1',selected(),by).toArray().length)throw fail('An erased moderation identity cannot publish another label.',410);
  return transaction(()=>{
   principal();const prior=sql.exec('SELECT 1 FROM labels WHERE relay=? AND label=? AND by_relay=?',selected(),input.label,by).toArray()[0];
   if(!prior){sql.exec('INSERT INTO labels(relay,label,by_relay,at) VALUES(?,?,?,?)',selected(),input.label,by,now());change(input.label,by,'label');}
   return {labelled:selected(),label:input.label};
  });
 };
 const hidden=async input=>{
  const original=await authorize('network-moderation:hidden',input);ready();
  if(input.relay!==selected()||input.asker!==original.by)throw fail('Moderation visibility cannot substitute an asker or target.',403);
  if(sql.exec('SELECT 1 FROM native_moderation_erased_relays WHERE relay=?',selected()).toArray().length)return {hidden:true};
  if(typeof trust?.matching==='function'){
   const revision=()=>sql.exec('SELECT revision FROM native_moderation_revision WHERE id=1').toArray()[0].revision;
   const reporters=()=>reportersOf(sql,selected());
   const reported=reporters(),beforeRevision=revision(),labelsIdentity=identityOf(reported);
   if(reported.length>=rules.hide_after_labelers)return {hidden:true};
   if(!reported.length)return {hidden:false};
   let held=null;
   if(input.continuation!==undefined){
    if(typeof input.continuation!=='string')throw fail('Use the exact original moderation visibility continuation.',400);
    held=sql.exec('SELECT * FROM native_moderation_visibility WHERE id=?',input.continuation).toArray()[0];
    if(!held||held.asking_relay!==original.by||held.relay!==selected())throw fail('The moderation continuation belongs to another original reader.',403);
    if(held.labels_identity!==labelsIdentity){sql.exec('DELETE FROM native_moderation_visibility WHERE id=?',held.id);throw fail('Current moderation labels changed; restart this visibility query.');}
   }
   const result=await trust.matching({candidates:reported,after:held?.after_id??null,revision:held?.trust_revision??null},original.actor);
   if(!Array.isArray(result?.matches)||result.matches.some(value=>!reported.includes(value))||typeof result.complete!=='boolean'
    ||!Number.isSafeInteger(result.revision)||!result.complete&&(!result.next||typeof result.next.after!=='string'||result.next.revision!==result.revision))throw fail('The independent current trust owner returned no exact bounded result.',503);
   const latest=await authorize('network-moderation:hidden',input);ready();
   if(latest.identity!==original.identity||revision()!==beforeRevision||identityOf(reporters())!==labelsIdentity)throw fail('Current moderation changed during its trust query.');
   if(result.matches.length||result.complete){if(held)sql.exec('DELETE FROM native_moderation_visibility WHERE id=?',held.id);return {hidden:result.matches.length>0};}
   // One bounded session per reader/target. A new ordinary query reuses its
   // retained slot rather than accumulating abandoned continuation rows.
   const id=held?.id??`moderation-visibility:${identityOf([original.by,selected()])}`;
   sql.exec('INSERT INTO native_moderation_visibility VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET after_id=excluded.after_id,trust_revision=excluded.trust_revision',id,original.by,selected(),JSON.stringify(reported),labelsIdentity,result.next.after,result.revision);
   return {pending:true,continuation:id};
  }
  if(typeof neighbours!=='function')throw fail('The current independent trust-neighbour owner is unavailable.',503);
  const adjacent=await neighbours(original.by,original.actor);
  if(!(adjacent instanceof Set))throw fail('The current trust owner did not supply an exact neighbour set.',503);
  const latest=await authorize('network-moderation:hidden',input);ready();
  if(latest.identity!==original.identity)throw fail('The moderation reader changed during trust lookup.',403);
  // Count distinct reporters rather than label rows. A threshold query returns
  // at most the configured threshold; the neighbour query returns at most one.
  const global=reportersOf(sql,selected());
  const local=global.length>=rules.hide_after_labelers?false:Boolean(sql.exec(`SELECT 1 FROM labels INDEXED BY ${nativeModerationReporterIndex} WHERE relay=? AND ${hidingPredicate} AND by_relay IN(SELECT value FROM json_each(?)) LIMIT 1`,selected(),JSON.stringify([...adjacent])).toArray().length);
  return {hidden:global.length>=rules.hide_after_labelers||local};
 };
 const ownHistory=async({after=0,limit=16}={})=>{
  const {by}=await authorize('network-moderation:history',{after,limit});ready();
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>16)throw fail('Read up to sixteen moderation changes from a valid cursor.',400);
  const rows=sql.exec('SELECT sequence,relay,label,at,action FROM native_moderation_history WHERE by_relay=? AND sequence>? ORDER BY sequence LIMIT ?',by,after,limit+1).toArray();
  return {changes:rows.slice(0,limit),next_after:rows.length>limit?rows[limit-1].sequence:null};
 };
 const retract=async input=>{
  const {by}=await authorize('network-moderation:retract',input);ready();
  if(input.relay!==selected()||!labelIds.has(input.label))throw fail('Choose a declared label on this target.',400);
  return transaction(()=>{principal();const found=sql.exec('SELECT 1 FROM labels WHERE relay=? AND label=? AND by_relay=?',selected(),input.label,by).toArray().length;
   if(found){sql.exec('DELETE FROM labels WHERE relay=? AND label=? AND by_relay=?',selected(),input.label,by);change(input.label,by,'retract');}
   return {retracted:selected(),label:input.label};});
 };
 return Object.freeze({carry,carryProof,label,hidden,ownHistory,retract,status:()=>state()??null});
}
