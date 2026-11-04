// Installation metadata owner, never an executable work dispatcher. Every
// returned resource is subsequently admitted/metred at its own command owner.
export const originalWorkCatalogueName=owner=>`original-work-catalogue:${owner}`;
import heldRule from '../../original-work-collection-held/src/original-work-collection-held.json' with {type:'json'};
const fail=message=>Object.assign(new Error(message),{status:409});
export function originalWorkResourceCatalogue(sql,transaction,owner){
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_catalogue_resources (generation TEXT NOT NULL,resource_key TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL DEFAULT \'installed\',PRIMARY KEY(generation,resource_key),UNIQUE(generation,resource))');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_catalogue_carry (generation TEXT PRIMARY KEY,after_key TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0)');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_state (generation TEXT NOT NULL,resource TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(generation,resource))');
 sql.exec('CREATE INDEX IF NOT EXISTS original_work_collection_pending ON original_work_collection_state(generation,ready,pending,resource)');
 sql.exec('CREATE INDEX IF NOT EXISTS original_work_collection_unready ON original_work_collection_state(generation,ready,resource)');
 sql.exec('CREATE INDEX IF NOT EXISTS original_work_collection_inflight ON original_work_collection_state(generation,pending,resource)');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_refs (generation TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,resource TEXT NOT NULL,source_id TEXT NOT NULL,sort_at TEXT NOT NULL,filters TEXT NOT NULL,PRIMARY KEY(generation,kind,id))');
 sql.exec('CREATE INDEX IF NOT EXISTS original_work_collection_order ON original_work_collection_refs(generation,kind,sort_at DESC,id DESC)');
 for(const key of ['app','speaker','conversation_id','tool_id'])sql.exec(`CREATE INDEX IF NOT EXISTS original_work_collection_filter_${key} ON original_work_collection_refs(generation,kind,json_extract(filters,'$.${key}'),sort_at DESC,id DESC)`);
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_revision (generation TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0)');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_tokens (generation TEXT NOT NULL,resource TEXT NOT NULL,token TEXT NOT NULL,initialization INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(generation,resource,token))');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_versions (generation TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,resource TEXT NOT NULL,source_id TEXT NOT NULL,sort_at TEXT NOT NULL,filters TEXT NOT NULL,from_revision INTEGER NOT NULL,to_revision INTEGER,PRIMARY KEY(generation,kind,id,from_revision))');
 sql.exec('CREATE INDEX IF NOT EXISTS original_work_collection_snapshot_order ON original_work_collection_versions(generation,kind,sort_at DESC,id DESC,from_revision,to_revision)');
 // The reference kinds a resource has carried and published whole (src/native-own-collection-carry.json): reads of only
 // those kinds are answered from it before the rest of its first carry is done.
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_kinds (generation TEXT NOT NULL,resource TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(generation,resource,kind))');
 // A resource a list read could not publish, passed over by reads until `until` (original-work-collection-held.json).
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_held (generation TEXT NOT NULL,resource TEXT NOT NULL,until INTEGER NOT NULL,failures INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(generation,resource))');
 // A copy of a list id another resource holds in this index (a list is the account's by its id): set aside, kept with why,
 // so its later pages pass that id over instead of being refused (src/original-work-list-owner.mjs decides who holds it).
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_set_aside (generation TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,resource TEXT NOT NULL,held_by TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(generation,kind,id,resource))');
 sql.exec('CREATE TABLE IF NOT EXISTS original_work_collection_registration (generation TEXT NOT NULL,resource TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(generation,resource))');
 const revision=generation=>sql.exec('SELECT revision FROM original_work_collection_revision WHERE generation=? LIMIT 1',generation).toArray()[0]?.revision??0;
 const bump=generation=>sql.exec('INSERT INTO original_work_collection_revision VALUES(?,1) ON CONFLICT(generation) DO UPDATE SET revision=revision+1',generation);
 return {
  installed(generation,resource){return sql.exec("SELECT 1 FROM original_work_catalogue_resources WHERE generation=? AND resource=? AND state='installed' LIMIT 1",generation,resource).toArray().length===1;},
  install({generation,resource_key,resource}){if(!generation||!resource_key||!resource)throw fail('Actual installed resource identity is required.');return transaction(()=>{
    const atKey=sql.exec('SELECT resource FROM original_work_catalogue_resources WHERE generation=? AND resource_key=? LIMIT 1',generation,resource_key).toArray()[0];
    if(atKey&&atKey.resource!==resource)throw fail('A different original resource owns this catalogue key.');
    const atResource=sql.exec('SELECT resource_key FROM original_work_catalogue_resources WHERE generation=? AND resource=? LIMIT 1',generation,resource).toArray()[0];
    if(atResource)sql.exec("UPDATE original_work_catalogue_resources SET state='installed' WHERE generation=? AND resource=?",generation,resource);
    else sql.exec("INSERT INTO original_work_catalogue_resources VALUES(?,?,?,'installed')",generation,resource_key,resource);
    if(!sql.exec('SELECT 1 FROM original_work_collection_registration WHERE generation=? AND resource=? LIMIT 1',generation,resource).toArray().length){bump(generation);sql.exec('INSERT INTO original_work_collection_registration VALUES(?,?,?)',generation,resource,revision(generation));}
    sql.exec('INSERT OR IGNORE INTO original_work_collection_state(generation,resource) VALUES(?,?)',generation,resource);
    return {installed:true,resource_key:atResource?.resource_key??resource_key,repeated:Boolean(atResource)};
  });},
  fence(generation,resource,token,initialization=false){return transaction(()=>{if(typeof token!=='string'||!token)throw fail('Discovery invalidation needs its original command identity.');sql.exec('INSERT OR IGNORE INTO original_work_collection_tokens VALUES(?,?,?,?)',generation,resource,token,initialization?1:0);sql.exec('INSERT INTO original_work_collection_state VALUES(?,?,0,1) ON CONFLICT(generation,resource) DO UPDATE SET pending=1',generation,resource);bump(generation);return {generation};});},
  // The references of a page whose id another resource already holds here: [{kind,id,held_by}], at most the page's 200.
  conflicts(generation,resource,references){
   if(!Array.isArray(references)||references.length>200)throw fail('Publish at most100 source roots of bounded discovery changes.');
   const found=[];for(const row of references){const prior=sql.exec('SELECT resource FROM original_work_collection_refs WHERE generation=? AND kind=? AND id=? LIMIT 1',generation,row?.kind,row?.id).toArray()[0];if(prior&&prior.resource!==resource)found.push({kind:row.kind,id:row.id,held_by:prior.resource});}
   return found;
  },
  // `owners` ({ "<kind>:<id>": { holder, reason } }) decides a conflict the caller settled: the named resource holds the id. The
  // publisher taking it over closes the other's open version and sets that copy aside; a publisher set aside passes the id over.
  publish(generation,resource,{references,removed,complete,token,asynchronous=false,owners={},complete_kinds=[]}){if(!Array.isArray(references)||references.length>200||!Array.isArray(removed)||removed.length>300)throw fail('Publish at most100 source roots of bounded discovery changes.');if(!Array.isArray(complete_kinds)||complete_kinds.length>20||complete_kinds.some(kind=>typeof kind!=='string'||!kind||kind.length>40))throw fail('Name at most 20 completed discovery kinds.');return transaction(()=>{
   for(const kind of complete_kinds)sql.exec('INSERT OR IGNORE INTO original_work_collection_kinds VALUES(?,?,?)',generation,resource,kind);
   bump(generation);const head=revision(generation);
   const replacements=new Set(references.map(row=>JSON.stringify([row.kind,row.id])));
   for(const row of removed){
    // A source refresh removes and replaces its pointer in the same page.
    // Keep its previous ordering version; only actual withdrawal erases it.
    if(replacements.has(JSON.stringify([row.kind,row.id])))continue;
    const owns=sql.exec('SELECT 1 FROM original_work_collection_refs WHERE generation=? AND kind=? AND id=? AND resource=? LIMIT 1',generation,row.kind,row.id,resource).toArray().length;
    if(!owns)continue;
    sql.exec('DELETE FROM original_work_collection_refs WHERE generation=? AND kind=? AND id=? AND resource=?',generation,row.kind,row.id,resource);
    // Erasure withdraws old discovery too; historical cursors never keep an
    // erased private identity reachable through this derived index.
    sql.exec('DELETE FROM original_work_collection_versions WHERE generation=? AND kind=? AND id=? AND resource=?',generation,row.kind,row.id,resource);
   }
   for(const row of references){
    if(row.resource!==resource||typeof row.id!=='string'||typeof row.source_id!=='string'||typeof row.kind!=='string'||typeof row.sort_at!=='string')throw fail('A discovery reference must retain its original resource.');
    let prior=sql.exec('SELECT * FROM original_work_collection_refs WHERE generation=? AND kind=? AND id=? LIMIT 1',generation,row.kind,row.id).toArray()[0];
    if(prior&&prior.resource!==resource){
     const {holder,reason='decided by its owner'}=owners[`${row.kind}:${row.id}`]??{};
     const setAside=(copy,heldBy)=>sql.exec('INSERT INTO original_work_collection_set_aside VALUES(?,?,?,?,?,?) ON CONFLICT(generation,kind,id,resource) DO UPDATE SET held_by=excluded.held_by,reason=excluded.reason',generation,row.kind,row.id,copy,heldBy,String(reason).slice(0,300));
     if(holder===prior.resource){setAside(resource,prior.resource);continue;}
     if(holder!==resource)throw fail('A collection identity belongs to conflicting resources; canonical affinity is required.');
     if(!sql.exec('SELECT 1 FROM original_work_collection_versions WHERE generation=? AND kind=? AND id=? LIMIT 1',generation,row.kind,row.id).toArray().length)sql.exec('INSERT INTO original_work_collection_versions VALUES(?,?,?,?,?,?,?,0,?)',generation,row.kind,row.id,prior.resource,prior.source_id,prior.sort_at,prior.filters,head);
     sql.exec('UPDATE original_work_collection_versions SET to_revision=? WHERE generation=? AND kind=? AND id=? AND to_revision IS NULL',head,generation,row.kind,row.id);
     sql.exec('DELETE FROM original_work_collection_refs WHERE generation=? AND kind=? AND id=?',generation,row.kind,row.id);
     setAside(prior.resource,resource);prior=null;
    }
    if(prior&&!sql.exec('SELECT 1 FROM original_work_collection_versions WHERE generation=? AND kind=? AND id=? LIMIT 1',generation,row.kind,row.id).toArray().length)sql.exec('INSERT INTO original_work_collection_versions VALUES(?,?,?,?,?,?,?,0,?)',generation,row.kind,row.id,prior.resource,prior.source_id,prior.sort_at,prior.filters,head);
    sql.exec('UPDATE original_work_collection_versions SET to_revision=? WHERE generation=? AND kind=? AND id=? AND to_revision IS NULL',head,generation,row.kind,row.id);
    const filters=JSON.stringify(row.filters??{});
    sql.exec('INSERT INTO original_work_collection_refs VALUES(?,?,?,?,?,?,?) ON CONFLICT(generation,kind,id) DO UPDATE SET source_id=excluded.source_id,sort_at=excluded.sort_at,filters=excluded.filters',generation,row.kind,row.id,resource,row.source_id,row.sort_at,filters);
    sql.exec('INSERT INTO original_work_collection_versions VALUES(?,?,?,?,?,?,?,?,NULL)',generation,row.kind,row.id,resource,row.source_id,row.sort_at,filters,head);
   }
   sql.exec('DELETE FROM original_work_collection_held WHERE generation=? AND resource=?',generation,resource);
   if(complete&&asynchronous)sql.exec('DELETE FROM original_work_collection_tokens WHERE generation=? AND resource=?',generation,resource);
   else if(complete&&token)sql.exec('DELETE FROM original_work_collection_tokens WHERE generation=? AND resource=? AND token=?',generation,resource,token);
   const pending=sql.exec('SELECT 1 FROM original_work_collection_tokens WHERE generation=? AND resource=? LIMIT 1',generation,resource).toArray().length>0;
   sql.exec('INSERT INTO original_work_collection_state VALUES(?,?,?,?) ON CONFLICT(generation,resource) DO UPDATE SET ready=MAX(ready,excluded.ready),pending=excluded.pending',generation,resource,complete?1:0,pending?1:0);
   return {generation,revision:head,complete,projection_consistency:'asynchronous'};
  });},
  collectionPage(generation,{kinds,after=null,limit=100,filters={},revision:snapshot}={}){
   if(!Array.isArray(kinds)||!kinds.length||kinds.length>9||kinds.some(kind=>typeof kind!=='string')||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Read one bounded discovery page.');
   const head=revision(generation),at=snapshot??head;
   if(!Number.isSafeInteger(at)||at<0||at>head)throw fail('The published reference snapshot is invalid.');
   const now=Date.now(),missing=sql.exec('SELECT s.resource,s.pending FROM original_work_collection_state s LEFT JOIN original_work_collection_registration r ON r.generation=s.generation AND r.resource=s.resource WHERE s.generation=? AND s.ready=0 AND COALESCE(r.revision,0)<=? AND NOT EXISTS(SELECT 1 FROM original_work_collection_held h WHERE h.generation=s.generation AND h.resource=s.resource AND h.until>?) AND (SELECT count(*) FROM original_work_collection_kinds k WHERE k.generation=s.generation AND k.resource=s.resource AND k.kind IN (SELECT value FROM json_each(?)))<? ORDER BY s.resource LIMIT 10',generation,at,now,JSON.stringify([...new Set(kinds)]),new Set(kinds).size).toArray();
   const held=sql.exec('SELECT resource,until,failures,reason FROM original_work_collection_held WHERE generation=? AND until>? ORDER BY resource LIMIT 10',generation,now).toArray().map(row=>({...row}));
   if(missing.length)return {generation,revision:at,head_revision:head,references:[],next:null,needs_projection:missing,held,projection_consistency:'asynchronous'};
   const clauses=['generation=?',`kind IN (${kinds.map(()=>'?').join(',')})`],args=[generation,...kinds];
   const ascending=kinds.length===1&&kinds[0]==='lists';
   if(after){clauses.push(ascending?'id>?':'(kind>? OR (kind=? AND (sort_at<? OR (sort_at=? AND id<?))))');if(ascending)args.push(after.id);else args.push(after.kind,after.kind,after.sort_at,after.sort_at,after.id);}
   for(const key of ['app','speaker','conversation_id','tool_id'])if(filters[key]){clauses.push(`json_extract(filters,'$.${key}')=?`);args.push(filters[key]);}
   const where=clauses.join(' AND '),order=ascending?'id ASC':'kind ASC,sort_at DESC,id DESC';
   const selected=sql.exec(`SELECT kind,id,resource,source_id,sort_at,filters FROM original_work_collection_versions WHERE ${where} AND from_revision<=? AND (to_revision IS NULL OR to_revision>?) ORDER BY ${order} LIMIT ?`,...args,at,at,limit+1).toArray();
   // Pre-index installations migrate lazily by their original bounded publish
   // pages; an untouched existing reference remains valid from revision zero.
   const legacy=sql.exec(`SELECT kind,id,resource,source_id,sort_at,filters FROM original_work_collection_refs c WHERE ${where} AND NOT EXISTS(SELECT 1 FROM original_work_collection_versions v WHERE v.generation=c.generation AND v.kind=c.kind AND v.id=c.id) ORDER BY ${order} LIMIT ?`,...args,limit+1).toArray();
   const rows=[...selected,...legacy].sort((a,b)=>ascending?a.id.localeCompare(b.id):a.kind.localeCompare(b.kind)||b.sort_at.localeCompare(a.sort_at)||b.id.localeCompare(a.id));
   const page=rows.slice(0,limit).map(row=>({...row,filters:JSON.parse(row.filters)})),last=page.at(-1);
   return {generation,revision:at,head_revision:head,references:page,next:rows.length>limit?{kind:last.kind,sort_at:last.sort_at,id:last.id}:null,needs_projection:[],held,projection_consistency:'asynchronous',current_membership_complete:false};
  },
  // A read that could not publish `resource` passes it over for held_ms (busy_held_ms when it answered busy), keeping the
  // reason; a page it publishes clears it.
  hold(generation,resource,reason,{busy=false}={}){return transaction(()=>{const until=Date.now()+(busy?heldRule.busy_held_ms:heldRule.held_ms);sql.exec('INSERT INTO original_work_collection_held VALUES(?,?,?,1,?) ON CONFLICT(generation,resource) DO UPDATE SET until=excluded.until,failures=failures+1,reason=excluded.reason',generation,resource,until,String(reason??'unknown').slice(0,heldRule.reason_chars));return {held:true,until};});},
  carryState(generation){return sql.exec('SELECT after_key,complete FROM original_work_catalogue_carry WHERE generation=? LIMIT 1',generation).toArray()[0]??{after_key:'',complete:0};},
  carryPage({generation,resources,after}){if(!Array.isArray(resources)||resources.length>1000)throw fail('Carry at most1000 resource addresses.');return transaction(()=>{for(const row of resources)this.install({...row,generation});sql.exec('INSERT INTO original_work_catalogue_carry VALUES(?,?,?) ON CONFLICT(generation) DO UPDATE SET after_key=excluded.after_key,complete=excluded.complete',generation,after??'',after===null?1:0);return this.carryState(generation);});},
  page(generation,{after='',limit=20}={}){if(!Number.isInteger(limit)||limit<1||limit>100)throw fail('Query at most100 installed resource addresses per page.');const rows=sql.exec("SELECT resource_key,resource FROM original_work_catalogue_resources WHERE generation=? AND resource_key>? AND state='installed' ORDER BY resource_key LIMIT ?",generation,after,limit+1).toArray();return {generation,resources:rows.slice(0,limit).map(row=>({...row,owner})),after:rows.length>limit?rows[limit-1].resource_key:null};},
  sourceEntry(generation,atOrAfter=''){
   if(typeof atOrAfter!=='string')throw fail('An original resource cursor is required.');
   const rows=sql.exec("SELECT resource_key,resource FROM original_work_catalogue_resources WHERE generation=? AND resource_key>=? AND state='installed' ORDER BY resource_key LIMIT 2",generation,atOrAfter).toArray();
   return {entry:rows[0]??null,following:rows[1]?.resource_key??null};
  },
 };
}
