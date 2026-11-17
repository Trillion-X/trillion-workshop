// src/record_indexes.rs
//
// Purpose: Interpret declared record-index DATA and maintain/query its compact kept-run keys.
// Non-Negotiable Invariants:
// - No hardcoded record kinds, implicit whole-type scan or undeclared-index fallback.
// - Preserve source JSON-text/UTF-16 ordering, current-key updates, tombstones and complete bounded continuation.
// - Shared/sealed values and erasable carried fields cross the supplied existing field/key owner.
// - The log host owns durability, fresh rights, ready/backfill proof and rollback/replay of this projection.
// Key Concepts: paths, excluded scalar predicates, carried fields/existence, f-NUL-type-NUL-index-NUL keys.
// Security Considerations: no network/credentials or original-file adoption; never put carried plaintext into key text.
// AI Assistant Directive: Preserve this contract and distinguish this boundary from complete record-store parity.

//! Declared-index/field-query foundation from canonical record-log-store.mjs and
//! eeaf-field-reads.mjs. The host supplies original JSON value text and field/key
//! access. Ordinary local JSON is not assumed byte-identical to JSON.stringify.
pub mod installed;
pub mod current;
use crate::{kept_runs::{self, KeptRuns, Lookup, ReadBudget, Work},record_stamps::Fields};
use content_crypto::advanced::blake3;
use rusqlite::Connection;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{collections::{BTreeMap,BTreeSet},fmt,time::Instant};
const SEP:char='\0';
pub const MAX_DECLARATIONS:usize=1024;
pub const MAX_DEFINITION_BYTES:usize=2*1024*1024;
pub const MAX_PATHS:usize=128;
pub const MAX_PAGE_ITEMS:usize=256;
pub const MAX_PLAN_BYTES:usize=8*1024*1024;
pub const MAX_PLAN_CHANGES:usize=16_384;

#[derive(Debug)]
pub enum Error{Kept(kept_runs::Error, crate::refusal_cause::Cause),Json(serde_json::Error, crate::refusal_cause::Cause),Invalid(&'static str, crate::refusal_cause::Cause),Bounds(crate::refusal_cause::Cause),CurrentIndexBound(crate::legacy_records::current_indexes::IndexBoundDiagnostic, crate::refusal_cause::Cause),CheckpointRange{reason:&'static str,budget_exhausted:bool,checkpoint_work:crate::legacy_kept::Work,record_log_statements:usize,record_log_rows:usize,record_log_source_bytes:usize, cause: crate::refusal_cause::Cause},Undeclared(crate::refusal_cause::Cause),NotReady(crate::refusal_cause::Cause),FieldAccess(crate::refusal_cause::Cause),Corrupt(crate::refusal_cause::Cause),WrongCursor(crate::refusal_cause::Cause)}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Bounds(cause) => cause,
        Self::Undeclared(cause) => cause,
        Self::NotReady(cause) => cause,
        Self::FieldAccess(cause) => cause,
        Self::Corrupt(cause) => cause,
        Self::WrongCursor(cause) => cause,
        Self::Kept(_, cause) => cause,
        Self::Json(_, cause) => cause,
        Self::Invalid(_, cause) => cause,
        Self::CurrentIndexBound(_, cause) => cause,
        Self::CheckpointRange{ cause, .. } => cause,
    } }
}
crate::impl_caused!(Error);


impl From<kept_runs::Error>for Error{fn from(e:kept_runs::Error)->Self{let cause=e.cause();Self::Kept(e,cause)}}
impl From<serde_json::Error>for Error{#[track_caller] fn from(e:serde_json::Error)->Self{let cause=match crate::refusal_cause::Caused::stored_cause(&e) { Some(cause) => cause, None => crate::cause!(caller_site: Self::Json) };Self::Json(e,cause)}}
impl fmt::Display for Error{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.write_str(match self{Self::Kept(_, _)=>"index keyspace operation failed",Self::Json(_, _)=>"index JSON refused",Self::Invalid(s, _)=>s,Self::Bounds(_)=>"index operation exceeds bounds",Self::CurrentIndexBound(_, _)=>"current index read refused at a bounded phase",Self::CheckpointRange{..}=>"index checkpoint range read failed",Self::Undeclared(_)=>"record index is not declared",Self::NotReady(_)=>"record index is not ready",Self::FieldAccess(_)=>"field/shared/key owner required",Self::Corrupt(_)=>"index projection is inconsistent",Self::WrongCursor(_)=>"index cursor belongs to another query"})}}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T>=std::result::Result<T,Error>;
pub type Path=Vec<String>;
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Exclusion{pub path:Path,pub not:Vec<Value>}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Declaration{
    #[serde(rename="type")]pub record_type:String,pub name:String,pub paths:Vec<Path>,
    #[serde(default)]pub r#where:Vec<Exclusion>,#[serde(default)]pub carry:Vec<Path>,
    #[serde(rename="carry_presence")]pub carry_exists:Option<Vec<Path>>,pub backfill:Option<String>,#[serde(default)]pub retired:bool,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Data{pub indexes:Vec<Declaration>}
#[derive(Debug,Clone)]
pub struct Indexes{data:Data,by_type:BTreeMap<String,Vec<usize>>,by_name:BTreeMap<String,BTreeMap<String,usize>>}
#[derive(Clone,Copy)]
pub struct Record<'a>{pub id:&'a str,pub record_type:&'a str,pub fields:&'a Fields}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum PathMode{Index,Carry,Attested,Exists}
/// Use the existing shared/erasable/key owner for real protected records. This
/// callback owns its own source-work charging; no hidden unlimited I/O is valid.
pub trait FieldAccess{
    fn at_path(&mut self,record:Record<'_>,path:&[String],mode:PathMode)->Result<Option<Value>>;
    fn keep_carried(&mut self,record:Record<'_>,path:&[String],value:Option<&Value>)->Result<Value>;
    fn open_carried(&mut self,id:&str,path:&[String],value:&Value)->Result<Value>;
}
/// Host's existing readiness owner must bind the declaration and current durable
/// backfill state. A signature alone is not proof that old records were indexed.
pub trait Readiness{fn assert_ready(&self,index:&Declaration,signature:&str)->bool;}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct Change{pub key:String,pub value:Option<Value>}
#[derive(Debug,Default,Clone,Serialize,Deserialize)]
pub struct Plan{pub changes:Vec<Change>,pub serialized_bytes:usize}
#[derive(Debug,Clone,Default,Serialize,Deserialize)]
pub struct Query{
    #[serde(default)]pub equal:Vec<Value>,pub from:Option<Value>,pub to:Option<Value>,pub after:Option<Value>,pub before:Option<Value>,pub after_id:Option<String>,pub starts_with:Option<String>,pub id_from:Option<String>,pub id_to:Option<String>,
    #[serde(default)]pub reverse:bool,pub limit:usize,#[serde(default)]pub carried:bool,pub cursor:Option<Cursor>,
}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq,Eq)]
pub struct Cursor{pub key:String,pub query_identity:String}
#[derive(Debug,Clone,Serialize)]
pub struct Entry{pub id:String,pub values:Vec<Value>,#[serde(skip_serializing_if="Option::is_none")]pub carried:Option<BTreeMap<String,Value>>,#[serde(skip_serializing_if="Option::is_none")]pub carried_defined:Option<BTreeMap<String,bool>>,#[serde(skip_serializing_if="Option::is_none")]pub carried_exists:Option<BTreeMap<String,bool>>}
#[derive(Debug,Serialize)]
pub struct Page{pub entries:Vec<Entry>,pub next:Option<Cursor>,pub complete:bool,pub serialized_bytes:usize,pub work:Work}
#[derive(Debug,Clone,Serialize)]
pub struct Projection{pub id:String,pub fields:Fields,#[serde(rename="presence")]pub exists:Vec<bool>}
#[derive(Debug,Serialize)]
pub struct FieldPage{pub records:Vec<Projection>,pub next:Option<usize>,pub complete:bool,pub serialized_bytes:usize,pub work:Work}

impl Indexes{
    pub fn from_json(bytes:&[u8])->Result<Self>{if bytes.len()>MAX_DEFINITION_BYTES{return Err(crate::cause!(Error::Bounds));}Self::new(serde_json::from_slice(bytes)?)}
    pub fn new(data:Data)->Result<Self>{
        if data.indexes.len()>MAX_DECLARATIONS||serialized_len(&data)?>MAX_DEFINITION_BYTES{return Err(crate::cause!(Error::Bounds));}
        let mut by_type:BTreeMap<String,Vec<usize>>=BTreeMap::new();let mut by_name:BTreeMap<String,BTreeMap<String,usize>>=BTreeMap::new();let mut names=BTreeSet::new();
        for(at,index)in data.indexes.iter().enumerate(){valid_name(&index.record_type)?;valid_name(&index.name)?;if !names.insert((&index.record_type,&index.name)){return Err(Error::Invalid("index declaration name is duplicated", crate::cause!()));}
            if index.paths.is_empty()||index.paths.len()>MAX_PATHS||index.carry.len()>MAX_PATHS||index.r#where.len()>MAX_PATHS{return Err(crate::cause!(Error::Bounds));}
            for path in index.paths.iter().chain(&index.carry).chain(index.r#where.iter().map(|r|&r.path)){valid_path(path)?;}
            for rule in &index.r#where{if rule.not.len()>MAX_PATHS{return Err(crate::cause!(Error::Bounds));}}
            if let Some(paths)=&index.carry_exists{if index.carry.is_empty()||paths.len()>MAX_PATHS{return Err(Error::Invalid("carried existence requires carried paths", crate::cause!()));}for path in paths{valid_path(path)?;}}
            if let Some(backfill)=&index.backfill{valid_name(backfill)?;}
            by_type.entry(index.record_type.clone()).or_default().push(at);by_name.entry(index.record_type.clone()).or_default().insert(index.name.clone(),at);
        }Ok(Self{data,by_type,by_name})
    }
    pub fn declarations(&self)->&[Declaration]{&self.data.indexes}
    pub fn declared(&self,kind:&str,name:&str)->Result<&Declaration>{let at=self.by_name.get(kind).and_then(|names|names.get(name)).ok_or(crate::cause!(Error::Undeclared))?;let index=&self.data.indexes[*at];if index.retired{Err(crate::cause!(Error::Undeclared))}else{Ok(index)}}
    pub fn signature(&self,kind:&str,name:&str)->Result<String>{let index=self.declared(kind,name)?;Ok(format!("1f:{}",blake3::hash(&serde_json::to_vec(index)?).to_hex()))}
    /// Build before/after keys once from supplied current records. No reads of
    /// unrelated records or all history; carried-only changes update one key.
    pub fn plan(&self,id:&str,before:Option<Record<'_>>,after:Option<Record<'_>>,epoch:Option<&str>,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess)->Result<Plan>{
        valid_name(id)?;if before.is_some_and(|r|r.id!=id)||after.is_some_and(|r|r.id!=id){return Err(Error::Invalid("index record identity mismatch", crate::cause!()));}
        let old=before.map(|r|self.entries(r,epoch,text,fields,true)).transpose()?.unwrap_or_default();
        let new=after.map(|r|self.entries(r,epoch,text,fields,false)).transpose()?.unwrap_or_default();
        let mut changes=Vec::new();for key in old.keys(){if !new.contains_key(key){changes.push(Change{key:key.clone(),value:None});}}
        for(key,value)in new{if old.get(&key).map(|v|text(v)).transpose()?.as_deref()!=Some(text(&value)?.as_str()){changes.push(Change{key,value:Some(value)});}}
        let serialized_bytes=serialized_len(&changes)?;if serialized_bytes>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}Ok(Plan{changes,serialized_bytes})
    }
    /// Plan one declared index for a current-index read. Query-only reads do
    /// not materialize carried values, so malformed fields used only by a
    /// different declaration or by this declaration's carry metadata cannot
    /// block rebuilding its keys. The original declaration remains the owner
    /// of the key paths and predicates; carried reads keep the full planner.
    pub fn plan_selected_index(&self,kind:&str,name:&str,id:&str,before:Option<Record<'_>>,after:Option<Record<'_>>,epoch:Option<&str>,include_carried:bool,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess)->Result<Plan>{
        let mut declaration=self.declared(kind,name)?.clone();
        if !include_carried {
            declaration.carry.clear();
            declaration.carry_exists=None;
        }
        let selected=Indexes::new(Data{indexes:vec![declaration]})?;
        selected.plan(id,before,after,epoch,text,fields)
    }
    /// Apply under the real log transaction; any failure requires the caller's
    /// existing projection reset/replay. This is not a second journal or CAS.
    pub fn apply(&self,keys:&mut KeptRuns,plan:&Plan)->Result<usize>{
        if plan.changes.len()>MAX_PLAN_CHANGES||serialized_len(&plan.changes)?>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}
        for change in &plan.changes{let mut parts=change.key.split(SEP);if parts.next()!=Some("f"){return Err(Error::Invalid("projection plan contains a non-index key", crate::cause!()));}let kind=parts.next().ok_or(crate::cause!(Error::Corrupt))?;let name=parts.next().ok_or(crate::cause!(Error::Corrupt))?;let at=self.by_name.get(kind).and_then(|names|names.get(name)).ok_or(crate::cause!(Error::Undeclared))?;let values=parts.collect::<Vec<_>>();if values.len()!=self.data.indexes[*at].paths.len()+1{return Err(crate::cause!(Error::Corrupt));}valid_name(values.last().ok_or(crate::cause!(Error::Corrupt))?)?;for value in &values[..values.len()-1]{let _:serde::de::IgnoredAny=serde_json::from_str(value)?;}}
        for change in &plan.changes{if let Some(value)=&change.value{keys.put(&change.key,value.clone())?;}else{keys.remove(&change.key)?;}}Ok(plan.changes.len())
    }
    fn entries(&self,record:Record<'_>,epoch:Option<&str>,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess,old:bool)->Result<BTreeMap<String,Value>>{
        valid_name(record.record_type)?;let mut result=BTreeMap::new();let mut held_bytes=0usize;
        for at in self.by_type.get(record.record_type).into_iter().flatten(){let index=&self.data.indexes[*at];if index.retired&&!old{continue;}
            let mut included=true;for rule in &index.r#where{let Some(value)=fields.at_path(record,&rule.path,PathMode::Index)?else{included=false;break;};let encoded=checked_text(&value,text)?;let mut excluded_here=false;for excluded in &rule.not{if checked_text(excluded,text)?==encoded{excluded_here=true;break;}}if excluded_here{included=false;break;}}
            if !included{continue;}let mut parts=Vec::new();for path in &index.paths{let Some(value)=fields.at_path(record,path,PathMode::Index)?else{break;};if !scalar_field(&value){break;}parts.push(checked_text(&value,text)?);}
            if parts.len()!=index.paths.len(){continue;}let key=format!("{}{}\0{}",prefix(&index.record_type,&index.name),parts.join("\0"),record.id);if key.len()>64*1024{return Err(crate::cause!(Error::Bounds));}
            let value=if index.retired{json!(1)}else{self.carried(record,index,epoch,fields)?};held_bytes=held_bytes.checked_add(serialized_len(&(&key,&value))?).ok_or(crate::cause!(Error::Bounds))?;if held_bytes>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}result.insert(key,value);
        }Ok(result)
    }
    fn carried(&self,record:Record<'_>,index:&Declaration,epoch:Option<&str>,fields:&mut dyn FieldAccess)->Result<Value>{
        if index.carry.is_empty(){return Ok(json!(1));}
        let mode=if index.carry_exists.is_some(){PathMode::Attested}else{PathMode::Carry};let mut own=Vec::new();let mut held_bytes=0usize;for path in &index.carry{let value=fields.at_path(record,path,mode)?;held_bytes=held_bytes.checked_add(serialized_len(&value)?).ok_or(crate::cause!(Error::Bounds))?;if held_bytes>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}own.push(value);}
        if index.carry_exists.is_some()&&own.iter().flatten().any(|v|!v.is_null()&&!v.is_boolean()&&!v.is_number()&&!v.is_string()){return Ok(json!({"carry":[],"carry_schema":null}));}
        let mut carried=Vec::new();for(path,value)in index.carry.iter().zip(&own){carried.push(fields.keep_carried(record,path,value.as_ref())?);}
        let mut out=json!({"carry":carried});if let Some(paths)=&index.carry_exists{
            let epoch=epoch.ok_or(crate::cause!(Error::NotReady))?;valid_name(epoch)?;
            let mut exists=Vec::new();for path in paths{exists.push(fields.at_path(record,path,PathMode::Exists)?.is_some());}
            out["carry_schema"]=Value::String(carry_schema(index)?);out["carry_epoch"]=Value::String(epoch.into());out["defined"]=json!(own.iter().map(Option::is_some).collect::<Vec<_>>());out["presence"]=json!(exists);
        }Ok(out)
    }
    pub fn scan(&self,db:&Connection,keys:&mut KeptRuns,kind:&str,name:&str,query:&Query,epoch:Option<&str>,ready:&dyn Readiness,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess,budget:ReadBudget)->Result<Page>{
        let index=self.declared(kind,name)?;let signature=self.signature(kind,name)?;if !ready.assert_ready(index,&signature){return Err(crate::cause!(Error::NotReady));}
        let (lo,hi)=self.bounds(index,query,text)?;let identity=query_identity(index,query,&lo,&hi,epoch)?;
        if let Some(cursor)=&query.cursor{if cursor.query_identity!=identity||cmp(&cursor.key,&lo).is_lt()||!cmp(&cursor.key,&hi).is_lt(){return Err(crate::cause!(Error::WrongCursor));}}
        if !cmp(&lo,&hi).is_lt(){return Ok(Page{entries:Vec::new(),next:None,complete:true,serialized_bytes:2,work:Work::default()});}
        let output_limit=budget.output_bytes;let start=Instant::now();let elapsed=budget.elapsed;
        let page=keys.range(db,kept_runs::Range{lo:&lo,hi:&hi,after:query.cursor.as_ref().map(|c|c.key.as_str()),reverse:query.reverse,limit:query.limit},budget)?;
        let mut entries=Vec::new();let mut bytes=2usize;let mut last=query.cursor.as_ref().map(|c|c.key.clone());let mut truncated=false;
        for(key,value)in page.entries{
            if start.elapsed()>elapsed{return Err(crate::cause!(Error::Bounds));}let entry=decode_entry(index,&key,&value,query.carried,epoch,fields)?;
            let size=serde_json::to_vec(&entry)?.len()+usize::from(!entries.is_empty());if size>output_limit.saturating_sub(bytes){if entries.is_empty(){return Err(crate::cause!(Error::Bounds));}truncated=true;break;}
            bytes+=size;entries.push(entry);last=Some(key);
        }
        let complete=page.complete&&!truncated;
        let next=if complete{None}else{let key=if truncated{last}else{page.next.or(last)};Some(Cursor{key:key.ok_or(crate::cause!(Error::Corrupt))?,query_identity:identity})};
        Ok(Page{entries,next,complete,serialized_bytes:bytes,work:page.work})
    }
    pub(crate) fn bounds(&self,index:&Declaration,query:&Query,text:&impl Fn(&Value)->Result<String>)->Result<(String,String)>{
        if query.limit==0||query.limit>MAX_PAGE_ITEMS||query.equal.len()>index.paths.len(){return Err(crate::cause!(Error::Bounds));}
        let mut base=prefix(&index.record_type,&index.name);for value in &query.equal{base.push_str(&checked_text(value,text)?);base.push(SEP);}
        let mut lo=base.clone();let mut hi=format!("{}\u{1}",&base[..base.len()-1]);
        if query.equal.len()==index.paths.len(){
            if query.from.is_some()||query.to.is_some()||query.after.is_some()||query.before.is_some()||query.starts_with.is_some()||query.after_id.is_some(){return Err(Error::Invalid("full equality uses only ID bounds", crate::cause!()));}
            if let Some(id)=&query.id_from{valid_name(id)?;lo=format!("{base}{id}");}if let Some(id)=&query.id_to{valid_name(id)?;hi=format!("{base}{id}");}
        }else{
            if query.id_from.is_some()||query.id_to.is_some(){return Err(Error::Invalid("ID bounds require every index value", crate::cause!()));}
            if let Some(value)=&query.from{lo=format!("{base}{}",checked_text(value,text)?);}
            if let Some(value)=&query.after{lo=if let Some(id)=&query.after_id{valid_name(id)?;if index.paths.len()!=query.equal.len()+1||query.from.is_some()||query.starts_with.is_some(){return Err(Error::Invalid("after_id requires the final ordered field", crate::cause!()));}format!("{base}{}\0{id}\0",checked_text(value,text)?)}else{format!("{base}{}\u{1}",checked_text(value,text)?)};}
            else if query.after_id.is_some(){return Err(Error::Invalid("after_id requires after", crate::cause!()));}
            if let Some(value)=&query.to{hi=format!("{base}{}\u{1}",checked_text(value,text)?);}
            if let Some(value)=&query.before{hi=format!("{base}{}\0",checked_text(value,text)?);}
            if let Some(start)=&query.starts_with{let encoded=checked_text(&Value::String(start.clone()),text)?;lo=format!("{base}{}",encoded.strip_suffix('"').ok_or(crate::cause!(Error::Corrupt))?);hi=prefix_end(&lo)?;}
        }
        if lo.len()>64*1024||hi.len()>64*1024{return Err(crate::cause!(Error::Bounds));}Ok((lo,hi))
    }
    pub fn index_on_paths(&self,kind:&str,paths:&[Path])->Result<&Declaration>{self.by_type.get(kind).into_iter().flatten().map(|at|&self.data.indexes[*at]).find(|i|!i.retired&&i.r#where.is_empty()&&i.paths==paths).ok_or(crate::cause!(Error::Undeclared))}
    /// Same strict (JSON field text, ID) continuation as canonical fields.after.
    pub fn after_query(&self,kind:&str,field:&str,after:Value,after_id:Option<String>,limit:usize)->Result<(String,Query)>{valid_name(field)?;let index=self.index_on_paths(kind,&[vec![field.into()]])?;Ok((index.name.clone(),Query{after:Some(after),after_id,limit,..Query::default()}))}
    pub fn ids_where_query(&self,kind:&str,field:&str,value:Value,limit:usize)->Result<(String,Query)>{valid_name(field)?;let index=self.index_on_paths(kind,&[vec![field.into()]])?;Ok((index.name.clone(),Query{equal:vec![value],limit,..Query::default()}))}
}

/// Direct plaintext JSON adapter. It refuses shared/sealed representations;
/// callers with those values must supply their actual field/key owner. This
/// adapter does not declare a protected field safe to publish or carry.
pub struct PlainFields;
impl FieldAccess for PlainFields{
    fn at_path(&mut self,record:Record<'_>,path:&[String],mode:PathMode)->Result<Option<Value>>{
        if path.is_empty(){return Err(Error::Invalid("field path is empty", crate::cause!()));}
        let Some(mut at)=record.fields.get(&path[0])else{return Ok(None)};
        for part in &path[1..]{reject_link(at)?;match at{Value::Object(map)=>{let Some(next)=map.get(part)else{return Ok(None)};at=next;},Value::Array(array)if matches!(mode,PathMode::Attested|PathMode::Exists)=>{let Ok(index)=part.parse::<usize>()else{return Ok(None)};if index.to_string()!=*part{return Ok(None);}let Some(next)=array.get(index)else{return Ok(None)};at=next;},_=>return Ok(None)}}
        if mode==PathMode::Exists{return Ok(Some(Value::Null));}if matches!(mode,PathMode::Index)&&!scalar_field(at){return Ok(None);}reject_opaque(at)?;if serialized_len(at)?>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}Ok(Some(at.clone()))
    }
    fn keep_carried(&mut self,_:Record<'_>,_:&[String],value:Option<&Value>)->Result<Value>{if let Some(value)=value{reject_opaque(value)?;if serialized_len(value)?>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}Ok(value.clone())}else{Ok(Value::Null)}}
    fn open_carried(&mut self,_:&str,_:&[String],value:&Value)->Result<Value>{reject_opaque(value)?;if serialized_len(value)?>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}Ok(value.clone())}
}
fn reject_link(value:&Value)->Result<()>{if value.as_object().is_some_and(|object|object.contains_key("\0shared")||object.contains_key("\0sealed")){return Err(crate::cause!(Error::FieldAccess));}Ok(())}
fn reject_opaque(value:&Value)->Result<()>{fn walk(value:&Value,depth:usize)->Result<()>{if depth>128{return Err(crate::cause!(Error::Bounds));}match value{Value::Object(object)=>{if object.contains_key("\0shared")||object.contains_key("\0sealed"){return Err(crate::cause!(Error::FieldAccess));}for value in object.values(){walk(value,depth+1)?;}},Value::Array(array)=>{for value in array{walk(value,depth+1)?;}},_=>{}}Ok(())}walk(value,0)}
fn scalar_field(value:&Value)->bool{!value.is_object()&&!value.as_array().is_some_and(|a|!a.is_empty()&&a.iter().all(Value::is_object))}
fn valid_name(name:&str)->Result<()>{if name.is_empty()||name.len()>4096||name.contains(SEP){return Err(Error::Invalid("index type/name/ID must be bounded and NUL-free", crate::cause!()));}Ok(())}
fn valid_path(path:&[String])->Result<()>{if path.is_empty()||path.len()>128{return Err(crate::cause!(Error::Bounds));}for field in path{valid_name(field)?;}Ok(())}
fn checked_text(value:&Value,text:&impl Fn(&Value)->Result<String>)->Result<String>{let encoded=text(value)?;if encoded.len()>64*1024||encoded.contains(SEP){return Err(crate::cause!(Error::Bounds));}let _:serde::de::IgnoredAny=serde_json::from_str(&encoded)?;Ok(encoded)}
pub(crate) fn prefix(kind:&str,name:&str)->String{format!("f\0{kind}\0{name}\0")}
pub(crate) fn cmp(a:&str,b:&str)->std::cmp::Ordering{a.encode_utf16().cmp(b.encode_utf16())}
pub(crate) fn prefix_end(value:&str)->Result<String>{let mut units=value.encode_utf16().collect::<Vec<_>>();while let Some(last)=units.pop(){if last<u16::MAX{units.push(last+1);return String::from_utf16(&units).map_err(|_|Error::Invalid("prefix bound needs lossless UTF-16 adapter", crate::cause!()));}}Err(Error::Invalid("index prefix has no finite upper bound", crate::cause!()))}
fn carry_schema(index:&Declaration)->Result<String>{Ok(serde_json::to_string(&(&index.carry,&index.carry_exists))?)}
pub(crate) fn query_identity(index:&Declaration,query:&Query,lo:&str,hi:&str,epoch:Option<&str>)->Result<String>{Ok(format!("1f:{}",blake3::hash(&serde_json::to_vec(&(index,lo,hi,query.reverse,query.carried,epoch))?).to_hex()))}
pub(crate) fn decode_entry(index:&Declaration,key:&str,value:&Value,carried:bool,epoch:Option<&str>,fields:&mut dyn FieldAccess)->Result<Entry>{
    let root=prefix(&index.record_type,&index.name);let suffix=key.strip_prefix(&root).ok_or(crate::cause!(Error::Corrupt))?;let mut parts=suffix.split(SEP).collect::<Vec<_>>();if parts.len()!=index.paths.len()+1{return Err(crate::cause!(Error::Corrupt));}let id=parts.pop().unwrap();valid_name(id)?;
    let values=parts.into_iter().map(serde_json::from_str).collect::<std::result::Result<Vec<Value>,_>>()?;
    let(mut own,mut defined,mut exists)=(None,None,None);
    if carried&&!index.carry.is_empty(){let held=value.get("carry").and_then(Value::as_array);let mut out=BTreeMap::new();for(at,path)in index.carry.iter().enumerate(){let value=held.and_then(|h|h.get(at)).unwrap_or(&Value::Null);out.insert(path.join("."),fields.open_carried(id,path,value)?);}own=Some(out);
        if let Some(paths)=&index.carry_exists{
            let valid=value.get("carry_schema").and_then(Value::as_str)==Some(carry_schema(index)?.as_str())&&epoch.is_some()&&value.get("carry_epoch").and_then(Value::as_str)==epoch&&held.is_some_and(|h|h.len()==index.carry.len());
            let defs=value.get("defined").and_then(Value::as_array);let pres=value.get("presence").and_then(Value::as_array);
            if valid&&defs.is_some_and(|a|a.len()==index.carry.len()&&a.iter().all(Value::is_boolean))&&pres.is_some_and(|a|a.len()==paths.len()&&a.iter().all(Value::is_boolean)){
                defined=Some(index.carry.iter().zip(defs.unwrap()).map(|(p,v)|(p.join("."),v.as_bool().unwrap())).collect());exists=Some(paths.iter().zip(pres.unwrap()).map(|(p,v)|Ok((serde_json::to_string(p)?,v.as_bool().unwrap()))).collect::<Result<_>>()?);
            }
        }
    }
    Ok(Entry{id:id.into(),values,carried:own,carried_defined:defined,carried_exists:exists})
}
struct Count(usize);
impl std::io::Write for Count{fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{self.0=crate::io_operation!((self.0.checked_add(bytes.len()).ok_or_else(||std::io::Error::other(crate::refusal_cause::CodedError::new("index byte counter overflow")))).map_err(std::io::Error::from))?;Ok(bytes.len())}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
fn serialized_len(value:&impl Serialize)->Result<usize>{let mut count=Count(0);serde_json::to_writer(&mut count,value)?;Ok(count.0)}

impl Indexes{
    /// Selected IDs only, in caller order. This reads bounded stored roots, not
    /// every record of a type. Complete logical shared/sealed field expansion
    /// is supplied by FieldAccess; no plaintext bypass is inferred here.
    pub fn fields_of(&self,db:&Connection,keys:&mut KeptRuns,kind:&str,ids:&[String],after:usize,names:&[String],exists:&[Path],scalar_only:bool,fields:&mut dyn FieldAccess,budget:ReadBudget)->Result<FieldPage>{
        valid_name(kind)?;if ids.len()>MAX_PAGE_ITEMS||after>ids.len()||names.len()>MAX_PATHS||exists.len()>MAX_PATHS||budget.output_bytes<2{return Err(crate::cause!(Error::Bounds));}for name in names{valid_name(name)?;}for path in exists{valid_path(path)?;}for id in ids{valid_name(id)?;}
        let start=Instant::now();let mut work=Work::default();let mut records=Vec::new();let mut bytes=2usize;let mut next=None;let mut seen=ids[..after].iter().collect::<BTreeSet<_>>();
        for(at,id)in ids.iter().enumerate().skip(after){
            if !seen.insert(id){continue;}if start.elapsed()>budget.elapsed{return Err(crate::cause!(Error::Bounds));}
            let mut left=remaining(&budget,&work,start)?;
            // The source record is an input bound. Output budget applies only
            // to selected fields, not an unrequested large logical subtree.
            left.output_bytes=left.source_bytes.min(32*1024*1024);
            let root=keys.get(db,&format!("i\0{id}"),left)?;add_work(&mut work,&root.work);
            let Some(root)=root_value(db,keys,id,kind,root.result,&budget,&mut work,start)?else{continue;};
            let record=Record{id,record_type:kind,fields:&root};let mut picked=Fields::new();picked.insert("id",Value::String(id.clone()));
            for name in names{let path=vec![name.clone()];if let Some(value)=fields.at_path(record,&path,if scalar_only{PathMode::Index}else{PathMode::Attested})?{if !scalar_only||scalar_field(&value){let opened=fields.open_carried(id,&path,&value)?;picked.insert(name.clone(),opened);}}}
            let mut held=Vec::new();for path in exists{held.push(fields.at_path(record,path,PathMode::Exists)?.is_some());}
            let projection=Projection{id:id.clone(),fields:picked,exists:held};let size=serialized_len(&projection)?+usize::from(!records.is_empty());
            if size>budget.output_bytes.saturating_sub(bytes){if records.is_empty(){return Err(crate::cause!(Error::Bounds));}next=Some(at);break;}
            bytes+=size;records.push(projection);
        }
        Ok(FieldPage{records,next,complete:next.is_none(),serialized_bytes:bytes,work})
    }
}
fn remaining(budget:&ReadBudget,work:&Work,start:Instant)->Result<ReadBudget>{
    let elapsed=budget.elapsed.checked_sub(start.elapsed()).ok_or(crate::cause!(Error::Bounds))?;
    let rows=budget.rows.checked_sub(work.rows_fetched as usize).ok_or(crate::cause!(Error::Bounds))?;let source_bytes=budget.source_bytes.checked_sub(work.source_bytes as usize).ok_or(crate::cause!(Error::Bounds))?;let entries=budget.entries.checked_sub(work.entries_examined as usize).ok_or(crate::cause!(Error::Bounds))?;
    Ok(ReadBudget{rows,source_bytes,entries,output_bytes:budget.output_bytes,elapsed})
}
fn add_work(total:&mut Work,part:&Work){total.sql_statements+=part.sql_statements;total.rows_fetched+=part.rows_fetched;total.source_bytes+=part.source_bytes;total.page_bodies+=part.page_bodies;total.selected_values+=part.selected_values;total.entries_examined+=part.entries_examined;total.cache_hits+=part.cache_hits;}
fn root_value(db:&Connection,keys:&mut KeptRuns,id:&str,kind:&str,root:Lookup,budget:&ReadBudget,work:&mut Work,start:Instant)->Result<Option<Fields>>{
    let Lookup::Value(root)=root else{return Ok(None)};
    if let Some(parts)=root.as_array(){if parts.len()<2{return Err(crate::cause!(Error::Corrupt));}if parts[0].is_null(){return Ok(None);}if parts[0].as_str()!=Some(kind){return Ok(None);}
        let value=if let Some(value)=parts.get(2){value.clone()}else{let sequence=parts[1].as_str().ok_or(crate::cause!(Error::Corrupt))?;let mut left=remaining(budget,work,start)?;left.output_bytes=left.source_bytes.min(32*1024*1024);let read=keys.get(db,&format!("r\0{kind}\0{sequence}\0{id}"),left)?;add_work(work,&read.work);match read.result{Lookup::Value(value)=>value,_=>return Err(crate::cause!(Error::Corrupt))}};
        return Ok(Some(object_fields(value)?));
    }
    // Rust compact journal currently keeps explicit ordered field pairs. This
    // narrow adapter does not pretend that representation is a legacy array.
    if let Some(object)=root.as_object(){let current=object.get("kind").ok_or(crate::cause!(Error::Corrupt))?;if current.is_null(){return Ok(None);}if current.as_str()!=Some(kind){return Ok(None);}let pairs=object.get("fields").and_then(Value::as_array).ok_or(crate::cause!(Error::Corrupt))?;let mut fields=Fields::new();for pair in pairs{let pair=pair.as_array().ok_or(crate::cause!(Error::Corrupt))?;if pair.len()!=2{return Err(crate::cause!(Error::Corrupt));}fields.insert(pair[0].as_str().ok_or(crate::cause!(Error::Corrupt))?.to_string(),pair[1].clone());}return Ok(Some(fields));}
    Err(crate::cause!(Error::Corrupt))
}
fn object_fields(value:Value)->Result<Fields>{let Value::Object(object)=value else{return Err(crate::cause!(Error::Corrupt))};Ok(object.into_iter().collect())}

#[derive(Debug,Serialize)]
pub struct Retirement{pub plan:Plan,pub next:Option<String>,pub complete:bool,pub work:Work}
impl Indexes{
    /// The host selects a bounded current type page using its real record owner,
    /// then commits these keys and its existing readiness cursor atomically.
    pub fn backfill_plan(&self,records:&[Record<'_>],epoch:Option<&str>,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess)->Result<Plan>{
        if records.len()>MAX_PAGE_ITEMS{return Err(crate::cause!(Error::Bounds));}let mut plan=Plan::default();let mut seen=BTreeSet::new();
        for record in records{if !seen.insert((record.record_type,record.id)){return Err(Error::Invalid("backfill record is duplicated", crate::cause!()));}let fresh=self.plan(record.id,None,Some(*record),epoch,text,fields)?;if fresh.changes.len()>MAX_PLAN_CHANGES.saturating_sub(plan.changes.len())||fresh.serialized_bytes>MAX_PLAN_BYTES.saturating_sub(plan.serialized_bytes){return Err(crate::cause!(Error::Bounds));}plan.serialized_bytes+=fresh.serialized_bytes;plan.changes.extend(fresh.changes);}
        plan.serialized_bytes=serialized_len(&plan.changes)?;Ok(plan)
    }
    /// Explicit named retired-index drain. This creates projection tombstones,
    /// never erases original/history/key bytes or grants erasure authority.
    pub fn retire_page(&self,db:&Connection,keys:&mut KeptRuns,kind:&str,name:&str,after:Option<&str>,limit:usize,budget:ReadBudget)->Result<Retirement>{
        let index=self.by_type.get(kind).into_iter().flatten().map(|at|&self.data.indexes[*at]).find(|i|i.name==name&&i.retired&&i.backfill.is_some()).ok_or(crate::cause!(Error::Undeclared))?;
        if limit==0||limit>MAX_PAGE_ITEMS{return Err(crate::cause!(Error::Bounds));}let lo=prefix(&index.record_type,&index.name);let hi=prefix_end(&lo)?;if after.is_some_and(|a|cmp(a,&lo).is_lt()||!cmp(a,&hi).is_lt()){return Err(crate::cause!(Error::WrongCursor));}
        let page=keys.range(db,kept_runs::Range{lo:&lo,hi:&hi,after,reverse:false,limit},budget)?;let changes=page.entries.into_iter().map(|(key,_)|Change{key,value:None}).collect::<Vec<_>>();let serialized_bytes=serialized_len(&changes)?;if serialized_bytes>MAX_PLAN_BYTES{return Err(crate::cause!(Error::Bounds));}
        Ok(Retirement{plan:Plan{changes,serialized_bytes},next:page.next,complete:page.complete,work:page.work})
    }
}

#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct GroupCursor{pub index_identity:String,pub after_group:Option<Value>,pub head_cursor:Option<Cursor>,pub pending_group:Option<Value>,pub winner_cursor:Option<Cursor>}
#[derive(Debug,Serialize)]
pub struct GroupPage{pub entries:Vec<Entry>,pub next:Option<GroupCursor>,pub complete:bool,pub serialized_bytes:usize,pub work:Work}
impl Indexes{
    /// One newest (JSON order text, ID) winner per group, with direct seeks over
    /// prior groups. This does not walk every historical entry in each group.
    pub fn newest_per_group(&self,db:&Connection,keys:&mut KeptRuns,kind:&str,group:&str,order:&str,limit:usize,cursor:Option<&GroupCursor>,ready:&dyn Readiness,text:&impl Fn(&Value)->Result<String>,fields:&mut dyn FieldAccess,budget:ReadBudget)->Result<GroupPage>{
        valid_name(group)?;valid_name(order)?;if limit==0||limit>MAX_PAGE_ITEMS||budget.output_bytes<2{return Err(crate::cause!(Error::Bounds));}let index=self.index_on_paths(kind,&[vec![group.into()],vec![order.into()]])?;let identity=format!("1f:{}",blake3::hash(&serde_json::to_vec(&(self.signature(kind,&index.name)?,"newest-per-group"))?).to_hex());
        if cursor.is_some_and(|c|c.index_identity!=identity){return Err(crate::cause!(Error::WrongCursor));}let mut after=cursor.and_then(|c|c.after_group.clone());let mut head_cursor=cursor.and_then(|c|c.head_cursor.clone());let mut pending=cursor.and_then(|c|c.pending_group.clone());let mut winner_cursor=cursor.and_then(|c|c.winner_cursor.clone());let mut entries=Vec::new();let mut bytes=2usize;let mut work=Work::default();let start=Instant::now();let mut complete=false;
        loop{
            if entries.len()>=limit{break;}
            if pending.is_none(){
                let query=Query{after:after.clone(),cursor:head_cursor.clone(),limit:1,..Query::default()};
                let first=self.scan(db,keys,kind,&index.name,&query,None,ready,text,fields,remaining(&budget,&work,start)?)?;add_work(&mut work,&first.work);
                let Some(head)=first.entries.first()else{if first.complete{complete=true;}else{head_cursor=first.next;}break;};
                pending=Some(head.values.first().ok_or(crate::cause!(Error::Corrupt))?.clone());winner_cursor=None;
                if work.entries_examined as usize>=budget.entries||work.rows_fetched as usize>=budget.rows||work.source_bytes as usize>=budget.source_bytes{break;}
            }
            let group_value=pending.clone().ok_or(crate::cause!(Error::Corrupt))?;
            let newest=Query{equal:vec![group_value.clone()],reverse:true,limit:1,cursor:winner_cursor.clone(),..Query::default()};
            let winner=self.scan(db,keys,kind,&index.name,&newest,None,ready,text,fields,remaining(&budget,&work,start)?)?;add_work(&mut work,&winner.work);
            let Some(entry)=winner.entries.into_iter().next()else{if winner.complete{after=Some(group_value);head_cursor=None;pending=None;winner_cursor=None;continue;}winner_cursor=winner.next;break;};
            let size=serialized_len(&entry)?+usize::from(!entries.is_empty());
            if size>budget.output_bytes.saturating_sub(bytes){if entries.is_empty(){return Err(crate::cause!(Error::Bounds));}break;}
            bytes+=size;entries.push(entry);after=Some(group_value);head_cursor=None;pending=None;winner_cursor=None;
        }
        Ok(GroupPage{entries,next:if complete{None}else{Some(GroupCursor{index_identity:identity,after_group:after,head_cursor,pending_group:pending,winner_cursor})},complete,serialized_bytes:bytes,work})
    }
}

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;
    use crate::refusal_cause::Caused;

    #[test]
    fn serialization_keeps_an_engine_writer_cause_through_io_and_serde() {
        let mut counter = Count(usize::MAX);
        let source = serde_json::to_writer(&mut counter, &Value::Null).unwrap_err();
        let cause = source.stored_cause().expect("the writer's engine cause survives serde's I/O adapter");
        let refused = Error::from(source);
        assert!(matches!(refused, Error::Json(_, _)));
        assert_eq!(refused.cause(), cause);
        let source = include_str!("record_indexes.rs");
        let line = (source.lines().position(|line| line.contains("index byte counter overflow")).unwrap() + 1) as u32;
        assert_eq!(cause.line(), line);
        assert_eq!(cause.file(), "src/record_indexes.rs");
    }
}
