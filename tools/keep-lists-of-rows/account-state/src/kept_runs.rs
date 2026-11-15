// src/kept_runs.rs
//
// Purpose: Persist the compact record-log's ordered key projection as immutable packed runs.
// Non-Negotiable Invariants:
// - The caller's append-only log is authoritative; volatile puts require caller replay after rollback/restart.
// - Choose the newest key and tombstone before opening a selected value; never parse superseded bodies.
// - Bound memtable, catalogue, cache, pages, read work and output bytes. No eager whole-store merge.
// - Flush/merge publication and covered-log position share the caller's real transaction.
// - Merges run only as bounded steps inside a caller's write (maintain): no timer, no alarm, no idle wake.
//   A write's step is paced by the bytes it added, so merging keeps up with what writing creates and the
//   run count, and with it every range's cursor workspace, stays bounded however long the store is written.
// Key Concepts: UTF-16 key order, 64KiB pages, immutable run age, deferred values, bounded continuation.
// Security Considerations: validated code-owned prefix; bound values as SQL parameters; no credentials/network.
// AI Assistant Directive: Preserve and extend this contract; do not replace it with a whole-product parity claim.

//! Rust storage foundation sourced from `parts/record-log/do-work/kept-runs.mjs`.
//! Existing packed layouts 1/2 and legacy list pages are decoded without parsing
//! unselected JSON values. Sparse-format runs require a supplied migration and
//! refuse explicitly. No original files are opened or rewritten automatically.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, fmt, ops::Bound, sync::Arc, time::{Duration, Instant}};

#[derive(Debug)]
pub enum Error { Sql(rusqlite::Error, crate::refusal_cause::Cause), Json(serde_json::Error, crate::refusal_cause::Cause), Bounds(&'static str, crate::refusal_cause::Cause), Corrupt(&'static str, crate::refusal_cause::Cause), Unsupported(&'static str, crate::refusal_cause::Cause), Stale(crate::refusal_cause::Cause), TransactionRequired(crate::refusal_cause::Cause) }
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Stale(cause) => cause,
        Self::TransactionRequired(cause) => cause,
        Self::Sql(_, cause) => cause,
        Self::Json(_, cause) => cause,
        Self::Bounds(_, cause) => cause,
        Self::Corrupt(_, cause) => cause,
        Self::Unsupported(_, cause) => cause,
    } }
}
crate::impl_caused!(Error);


impl From<rusqlite::Error> for Error { #[track_caller] fn from(e:rusqlite::Error)->Self { Self::Sql(e, crate::cause!(caller_site: Self::Sql)) } }
impl From<serde_json::Error> for Error { #[track_caller] fn from(e:serde_json::Error)->Self { let cause=match crate::refusal_cause::Caused::stored_cause(&e) { Some(cause) => cause, None => crate::cause!(caller_site: Self::Json) }; Self::Json(e,cause) } }
impl fmt::Display for Error { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { f.write_str(match self { Self::Sql(_, _)=>"kept storage failure; reload projection before retry", Self::Json(_, _)=>"invalid kept JSON",Self::Bounds(s, _)|Self::Corrupt(s, _)|Self::Unsupported(s, _)=>s,Self::Stale(_)=>"kept catalogue changed; reload and replay",Self::TransactionRequired(_)=>"kept publication requires the caller transaction" }) } }
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T,Error>;

#[derive(Debug, Clone)]
pub struct Settings {
    pub page_bytes:usize, pub memtable_bytes:usize, pub memtable_hold:usize,
    pub cache_bytes:usize, pub filter_bytes:usize, pub catalog_bytes:usize,
    pub max_runs:usize, pub max_key_bytes:usize, pub max_value_bytes:usize,
    pub big_part_bytes:usize,
    /// Merge policy, the original kept-runs rules (parts/record-log/do-work/kept-runs.mjs settings):
    /// a size-tier merge waits for `fan_in` age-adjacent runs of about one size (an older run joins
    /// while it holds no more than `size_ratio` times the pages before it in the group, or
    /// `tier_spread` times their average); more than `merge_backlog_runs` runs merge the cheapest
    /// `fan_in` adjacent runs first, beside (pausing) a long size-tier merge.
    pub fan_in:usize, pub size_ratio:f64, pub tier_spread:f64, pub merge_backlog_runs:usize,
    /// Output pages a write's merge step may write per page of bytes that write added (1..=64 pages a step).
    pub merge_pace:usize,
    /// A complete fold of every run is due once overwritten values (charged by `put_replacing`) make up this share
    /// of the bytes the runs hold, and at least `compaction_debt_min_bytes` (old kept-runs.mjs:129-132).
    pub compaction_debt_ratio:f64, pub compaction_debt_min_bytes:usize,
}
impl Default for Settings { fn default()->Self { Self {page_bytes:64*1024,memtable_bytes:2*1024*1024,memtable_hold:4,cache_bytes:2*1024*1024,filter_bytes:8*1024*1024,catalog_bytes:2*1024*1024,max_runs:4096,max_key_bytes:16*1024,max_value_bytes:32*1024*1024,big_part_bytes:64*1024,fan_in:4,size_ratio:1.0,tier_spread:1.5,merge_backlog_runs:24,merge_pace:16,compaction_debt_ratio:0.25,compaction_debt_min_bytes:1024*1024} } }
impl Settings { fn valid(&self)->Result<()> { if !(2..=MAX_MERGE_INPUTS).contains(&self.fan_in) || !self.size_ratio.is_finite() || self.size_ratio<=0.0 || !self.tier_spread.is_finite() || self.tier_spread<=0.0 || self.merge_backlog_runs<self.fan_in || self.merge_backlog_runs>=self.max_runs || !(1..=MAX_STEP_PAGES).contains(&self.merge_pace) || !self.compaction_debt_ratio.is_finite() || self.compaction_debt_ratio<0.0 { return Err(Error::Bounds("invalid kept merge settings", crate::cause!())); }
if self.page_bytes<1024 || self.page_bytes>1024*1024 || self.memtable_bytes==0 || self.memtable_bytes>128*1024*1024 || self.memtable_hold==0 || self.memtable_hold>16 || self.max_runs==0 || self.max_runs>65536 || self.cache_bytes>128*1024*1024 || self.filter_bytes>128*1024*1024 || self.catalog_bytes>128*1024*1024 || self.max_key_bytes==0 || self.max_key_bytes>self.page_bytes/2 || self.max_value_bytes==0 || self.max_value_bytes>128*1024*1024 || self.big_part_bytes==0 || self.big_part_bytes>1024*1024 || self.memtable_bytes.checked_mul(self.memtable_hold).is_none() { return Err(Error::Bounds("invalid kept settings", crate::cause!())); } Ok(()) } }
#[derive(Debug,Default,Clone,Serialize)]
pub struct Work { pub sql_statements:u64,pub rows_fetched:u64,pub source_bytes:u64,pub page_bodies:u64,pub selected_values:u64,pub entries_examined:u64,pub cache_hits:u64,
    /// Ordered cursors a walk opened over a span of a run's pages (old `SELECT page, body ... WHERE page >= ? AND page <= ?`).
    pub streams:u64,
    /// Statements that read one page's whole body by its number (old `SELECT body ... WHERE page = ?`).
    pub point_pages:u64,
    /// Statements that read a big value's parts (old `SELECT body FROM ${prefix}_big WHERE ref = ? ORDER BY part`).
    pub big_values:u64,
    /// Statements that read several pages' bodies by number at once (old `SELECT page, body ... WHERE page IN (...)`).
    pub grouped:u64 }
impl Work {
    /// Adds another read's work to this one.
    pub fn add(&mut self,other:&Work){self.streams+=other.streams;self.point_pages+=other.point_pages;self.big_values+=other.big_values;self.grouped+=other.grouped;self.sql_statements+=other.sql_statements;self.rows_fetched+=other.rows_fetched;self.source_bytes+=other.source_bytes;self.page_bodies+=other.page_bodies;self.selected_values+=other.selected_values;self.entries_examined+=other.entries_examined;self.cache_hits+=other.cache_hits;}
}
/// Per-call limits are independent of retained-data size; exhaustion is explicit.
#[derive(Debug,Clone)]
pub struct ReadBudget { pub rows:usize,pub source_bytes:usize,pub entries:usize,pub output_bytes:usize,pub elapsed:Duration }
impl Default for ReadBudget { fn default()->Self { Self{rows:16_384,source_bytes:64*1024*1024,entries:4096,output_bytes:32*1024*1024,elapsed:Duration::from_secs(2)} } }
struct Meter { limits:ReadBudget,work:Work,start:Instant }
impl Meter {
    fn new(limits:ReadBudget)->Self {Self{limits,work:Work::default(),start:Instant::now()}}
    fn check(&self)->Result<()> { if self.start.elapsed()>self.limits.elapsed {Err(Error::Bounds("kept read deadline exhausted", crate::cause!()))}else{Ok(())} }
    fn row(&mut self,bytes:usize)->Result<()> { self.check()?; if self.work.rows_fetched as usize>=self.limits.rows || bytes>self.limits.source_bytes.saturating_sub(self.work.source_bytes as usize) {return Err(Error::Bounds("kept source read budget exhausted", crate::cause!()));} self.work.rows_fetched+=1; self.work.source_bytes+=bytes as u64; Ok(()) }
    fn entry(&mut self)->Result<()> { self.check()?; if self.work.entries_examined as usize>=self.limits.entries {return Err(Error::Bounds("kept entry budget exhausted", crate::cause!()));} self.work.entries_examined+=1; Ok(()) }
}
#[derive(Debug,Clone,PartialEq)]
pub enum Lookup { Absent,Tombstone,Value(Value) }
/// Pure original-page lookup. JSON text remains byte-for-byte selected text;
/// opening files, resolving multipart references and admission belong to callers.
#[derive(Debug,Clone,PartialEq)]
pub enum PackedText { Absent,Tombstone,Json(String),Big{reference:String,parts:usize} }
pub fn packed_page_text(raw:&str,settings:&Settings)->Result<PackedPage>{
    settings.valid()?;
    if raw.len()>settings.page_bytes{return Err(Error::Bounds("packed original page or key exceeds bound", crate::cause!()));}
    // Original compressed prefixes may expand far beyond input bytes. Qualify
    // expansion before the shared decoder allocates a full key per entry.
    if !raw.starts_with('['){
        let end=raw.find('\n').ok_or(Error::Corrupt("kept packed page has no header newline", crate::cause!()))?;
        let(head,sizes):(Value,Vec<usize>)=if let Some(rest)=raw[..end].strip_prefix('~'){
            let at=rest.find('\u{2}').ok_or(Error::Corrupt("kept layout2 lacks suffix separator", crate::cause!()))?;
            let sizes=if at+1==rest.len(){Vec::new()}else{rest[at+1..].split('\u{3}').map(|s|unescape_suffix(s).map(|s|s.encode_utf16().count())).collect::<Result<Vec<_>>>()?};
            (serde_json::from_str(&rest[..at])?,sizes)
        }else{
            let head:Value=serde_json::from_str(&raw[..end])?;
            let sizes=head.get("s").and_then(Value::as_array).ok_or(Error::Corrupt("kept layout1 suffix array missing", crate::cause!()))?.iter().map(|v|v.as_str().map(|s|s.encode_utf16().count()).ok_or(Error::Corrupt("kept suffix must be text", crate::cause!()))).collect::<Result<Vec<_>>>()?;
            (head,sizes)
        };
        if sizes.len()>65_536{return Err(Error::Bounds("packed original head count exceeds bound", crate::cause!()));}
        let shares=prefixes(&head,sizes.len())?;let mut previous=0usize;let mut total=0usize;
        for(shared,suffix)in shares.into_iter().zip(sizes){
            if shared>previous{return Err(Error::Corrupt("kept prefix exceeds preceding key", crate::cause!()));}
            previous=shared.checked_add(suffix).ok_or(Error::Bounds("packed original key expansion overflow", crate::cause!()))?;
            total=total.checked_add(previous.checked_mul(2).ok_or(Error::Bounds("packed original key expansion overflow", crate::cause!()))?).ok_or(Error::Bounds("packed original key expansion overflow", crate::cause!()))?;
            if total>8*1024*1024{return Err(Error::Bounds("packed original expanded keys exceed memory bound", crate::cause!()));}
        }
    }
    Ok(PackedPage(decode_page(raw,settings)?))
}
/// Opaque pure decoded page, using the same preflight/decoder as point reads.
/// No source handle or authority is retained. Values are opened only by index
/// after the caller selects its newest winner; key-only callers skip JSON.
pub struct PackedPage(Page);
impl std::fmt::Debug for PackedPage {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.write_str("PackedOriginalPage([redacted])") }
}
impl PackedPage {
    pub fn len(&self)->usize {self.0.heads.len()}
    pub fn is_empty(&self)->bool {self.0.heads.is_empty()}
    pub fn resident_bytes(&self)->usize {
        // Page::bytes already counts raw body, common prefix, expanded keys
        // and head entries. Add separately owned BIG IDs and the one shared
        // uniform value allocation omitted by that legacy cache estimate.
        let extra=self.0.heads.iter().map(|h|match &h.entry{Location::Big{reference,..}=>reference.len(),_=>0}).sum::<usize>();
        let uniform=self.0.heads.iter().find_map(|h|if let Location::Uniform(text)=&h.entry{Some(text.len())}else{None}).unwrap_or(0);
        self.0.bytes().saturating_add(extra).saturating_add(uniform)
    }
    pub fn key(&self,index:usize)->Result<String> {
        self.0.heads.get(index).ok_or(Error::Corrupt("kept selected head missing", crate::cause!()))?.key.text()
    }
    pub fn is_tombstone(&self,index:usize)->Result<bool> {
        Ok(matches!(self.0.heads.get(index).ok_or(Error::Corrupt("kept selected head missing", crate::cause!()))?.entry,Location::Tomb))
    }
    pub fn selected(&self,index:usize,settings:&Settings)->Result<PackedText> {
        settings.valid()?;
        let entry=&self.0.heads.get(index).ok_or(Error::Corrupt("kept selected head missing", crate::cause!()))?.entry;
        let text=match entry {
            Location::Tomb=>return Ok(PackedText::Tombstone),
            Location::Big{reference,parts}=>return Ok(PackedText::Big{reference:reference.clone(),parts:*parts}),
            Location::Uniform(text)=>text.to_string(),
            Location::Inline{start,end}=>self.0.text(*start,*end)?,
        };
        if text.len()>settings.max_value_bytes{return Err(Error::Bounds("packed selected JSON exceeds bound", crate::cause!()));}
        let mut decoder=serde_json::Deserializer::from_str(&text);
        <serde::de::IgnoredAny as Deserialize>::deserialize(&mut decoder)?;decoder.end()?;
        Ok(PackedText::Json(text))
    }
    /// Find one exact key in an already decoded page. This keeps the same
    /// UTF-16 ordering and selected-value validation as packed_point_text.
    pub fn find_text(&self,key:&str,settings:&Settings)->Result<PackedText> {
        settings.valid()?;
        if key.len()>settings.max_key_bytes{return Err(Error::Bounds("packed original page or key exceeds bound", crate::cause!()));}
        let wanted=Key::new(key);
        let Ok(index)=self.0.heads.binary_search_by(|head|head.key.cmp(&wanted))else{return Ok(PackedText::Absent)};
        self.selected(index,settings)
    }
}
impl Drop for PackedPage {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        // The opaque wrapper is not Clone. Its decoded payload is private and
        // newly allocated here; shared internal uniform references are drained
        // until their final unique Arc can be wiped too.
        for mut head in self.0.heads.drain(..) {
            head.key.0.zeroize();
            match &mut head.entry {
                Location::Uniform(text)=>{if let Some(text)=Arc::get_mut(text){text.zeroize();}},
                Location::Big{reference,..}=>reference.zeroize(),
                _=>{},
            }
        }
        if let Some(body)=Arc::get_mut(&mut self.0.body){body.zeroize();}
        if let Some(common)=Arc::get_mut(&mut self.0.common){common.zeroize();}
    }
}
pub fn packed_point_text(raw:&str,key:&str,settings:&Settings)->Result<PackedText>{
    settings.valid()?;
    if key.len()>settings.max_key_bytes{return Err(Error::Bounds("packed original page or key exceeds bound", crate::cause!()));}
    let page=packed_page_text(raw,settings)?;
    page.find_text(key,settings)
}
#[cfg(test)]
mod packed_page_reuse_controls {
    use super::{packed_page_text, packed_point_text, PackedText, Settings};

    #[test]
    fn repeated_exact_lookups_share_decoding_and_keep_point_answers() {
        let raw = r#"[["a",{"z":1.00}],["😀"],["\ue000",7]]"#;
        let settings = Settings::default();
        let page = packed_page_text(raw, &settings).unwrap();
        for key in ["a", "😀", "\u{e000}", "b"] {
            assert_eq!(page.find_text(key, &settings).unwrap(),
                packed_point_text(raw, key, &settings).unwrap(), "key={key}");
        }
        assert_eq!(page.find_text("a", &settings).unwrap(), PackedText::Json(r#"{"z":1.00}"#.into()));
        assert_eq!(page.find_text("😀", &settings).unwrap(), PackedText::Tombstone);
        assert_eq!(page.find_text("b", &settings).unwrap(), PackedText::Absent);
        let mut small = settings.clone();
        small.max_value_bytes = 1;
        assert!(page.find_text("a", &small).is_err());
    }
}
#[derive(Debug,Serialize)]
pub struct Read<T> { pub result:T,pub work:Work }
#[derive(Debug,Serialize)]
pub struct RangePage { pub entries:Vec<(String,Value)>,pub next:Option<String>,pub complete:bool,pub serialized_bytes:usize,pub work:Work }
#[derive(Debug,Clone,Copy)]
pub struct Range<'a> { pub lo:&'a str,pub hi:&'a str,pub after:Option<&'a str>,pub reverse:bool,pub limit:usize }
#[derive(Debug,Default,Serialize)]
pub struct Held { pub memtable_bytes:usize,pub memtable_keys:usize,pub cache_bytes:usize,pub filter_bytes:usize,pub runs:usize,
    /// Bytes of overwritten values not yet folded away: the kept count plus what the memtable will add when it is
    /// written out (old kept-runs.mjs held().compaction_debt).
    pub compaction_debt:usize,
    /// Each run, newest first (old kept-runs.mjs held().runs).
    pub run_list:Vec<HeldRun>,
    /// Statements that read host metadata since the store opened.
    pub meta_reads:u64 }
#[derive(Debug,Default,Clone,PartialEq,Eq,Serialize)]
pub struct HeldRun { pub run:i64,pub age:i64,pub pages:usize,pub keys:usize,pub bytes:usize,pub filter_resident:bool }
/// One bounded step of idle merging (old kept-runs.mjs step): `merged` when a merge finished in it, `more` while a
/// merge is under way or another is due, `pages` the output pages it wrote.
#[derive(Debug,Default,Clone,Serialize)]
pub struct Stepped { pub merged:bool,pub more:bool,pub pages:usize,pub entries:usize }
#[derive(Debug,Serialize)]
pub struct Flush { pub run:Option<i64>,pub pages:usize,pub keys:usize,pub bytes:usize }
#[derive(Debug,Serialize)]
pub struct MergeStep { pub complete:bool,pub pages:usize,pub entries:usize,pub after:Option<String> }
/// What one write's maintenance did: the merge step it took (none when nothing is due) and the runs left.
#[derive(Debug,Default,Clone,Serialize)]
pub struct Maintained { pub started:bool,pub paused:bool,pub completed:bool,pub pages:usize,pub entries:usize,pub runs:usize }
const MAX_MERGE_INPUTS:usize=32;
const MAX_STEP_PAGES:usize=64;

// JS strings sort by UTF-16 units, not Rust's UTF-8/code-point order.
#[derive(Debug,Clone,Eq,PartialEq,Ord,PartialOrd)]
struct Key(Vec<u16>);
impl Key { fn new(s:&str)->Self {Self(s.encode_utf16().collect())} fn text(&self)->Result<String> {String::from_utf16(&self.0).map_err(|_|Error::Unsupported("lone-surrogate key requires a lossless key adapter", crate::cause!()))} }
#[derive(Clone)]
enum Entry { Tomb,Text(Arc<str>),Big{reference:String,parts:usize} }
impl Entry { fn bytes(&self)->usize {match self{Self::Tomb=>0,Self::Text(s)=>s.len(),Self::Big{reference,..}=>reference.len()+32}} }
#[derive(Clone)]
struct Run { number:i64,age:i64,pages:usize,keys:usize,bytes:usize,first:Key,last:Key,filter_bits:i64,filter:Option<Arc<[u8]>> }
#[derive(Clone)]
struct HeadEntry { key:Key,entry:Location }
#[derive(Clone)]
enum Location { Tomb,Inline{start:usize,end:usize},Uniform(Arc<str>),Big{reference:String,parts:usize} }
#[derive(Clone)]
struct Page { heads:Vec<HeadEntry>,body:Arc<str>,common:Arc<str>,base:usize,legacy:bool }
impl Page { fn bytes(&self)->usize {self.body.len()+self.common.len()+self.heads.iter().map(|h|h.key.0.len()*2+64).sum::<usize>()+64} }
struct Cached {run:i64,page:usize,value:Arc<Page>,bytes:usize}

/// Membership filter of an unfinished merge's output, held in memory between steps. A rolled-back step leaves keys
/// the output will not hold, which only costs a page read; a merge resumed after a restart publishes without one.
struct Building { output:i64,inputs:Vec<i64>,filter:Vec<u8>,blocks:usize }
pub struct KeptRuns { prefix:String,settings:Settings,mem:BTreeMap<Key,Entry>,mem_bytes:usize,runs:Vec<Run>,cache:VecDeque<Cached>,cache_bytes:usize,revision:u64,building:Vec<Building>,
    /// Debt charged by puts held in the memtable, added to the kept `compaction_debt` when it is written out.
    mem_debt:usize,
    /// The kept `compaction_debt`, as last read or written by this store.
    debt:usize,
    /// The first key of the page after (run, page), as seeks carried it (old noteSuccessor, :1071): a forward range
    /// ending before it is done without reading that page. Dropped with the catalogue; at most 4096 kept.
    successors:BTreeMap<(i64,usize),Key>,
    /// The pages one `ranges` call read together, held for that call only beside the page cache, up to
    /// RANGES_WORKSPACE_BYTES (old cursorValues workspace_bytes, :1320): a small cache never makes the call read
    /// again what it just read.
    workspace:Option<(BTreeMap<(i64,usize),Arc<Page>>,usize)>,
    /// Statements reading host metadata since this store opened (a diagnostic: `Held.meta_reads`).
    meta_reads:std::cell::Cell<u64> }
const RANGES_WORKSPACE_BYTES:usize=1024*1024;
impl KeptRuns {
    /// Call only on a new/explicitly admitted target, never an automatic import.
    pub fn create(tx:&Connection,prefix:&str,settings:Settings)->Result<Self> {
        // Publication shares the caller's transaction (a transaction or a savepoint inside one), never autocommit.
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        validate_prefix(prefix)?; settings.valid()?;
        tx.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {prefix}_runs(run INTEGER PRIMARY KEY,age INTEGER NOT NULL,pages INTEGER NOT NULL,keys INTEGER NOT NULL,bytes INTEGER NOT NULL,last TEXT NOT NULL,filter_bits INTEGER NOT NULL,page_layout INTEGER); CREATE TABLE IF NOT EXISTS {prefix}_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS {prefix}_big(ref TEXT NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(ref,part)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS {prefix}_big_drops(ref TEXT PRIMARY KEY) WITHOUT ROWID;"))?;
        Self::open(tx,prefix,settings)
    }
    /// Reads catalogue descriptors and bounded optional filters, not every page.
    pub fn open(db:&Connection,prefix:&str,settings:Settings)->Result<Self> {
        validate_prefix(prefix)?;settings.valid()?;
        let mut this=Self{prefix:prefix.into(),settings,mem:BTreeMap::new(),mem_bytes:0,runs:Vec::new(),cache:VecDeque::new(),cache_bytes:0,revision:0,building:Vec::new(),mem_debt:0,debt:0,successors:BTreeMap::new(),workspace:None,meta_reads:std::cell::Cell::new(0)};
        this.reload_catalog(db)?;Ok(this)
    }
    pub fn held(&self)->Held { Held{memtable_bytes:self.mem_bytes,memtable_keys:self.mem.len(),cache_bytes:self.cache_bytes,filter_bytes:self.runs.iter().filter_map(|r|r.filter.as_ref()).map(|f|f.len()).sum(),runs:self.runs.len(),
        compaction_debt:self.debt.saturating_add(self.mem_debt),
        run_list:self.runs.iter().map(|r|HeldRun{run:r.number,age:r.age,pages:r.pages,keys:r.keys,bytes:r.bytes,filter_resident:r.filter.is_some()}).collect(),meta_reads:self.meta_reads.get()} }
    pub fn full(&self)->bool {self.mem_bytes>=self.settings.memtable_bytes}
    /// Past `memtable_hold` times `memtable_bytes`: a write must write the memtable out (old kept-runs.mjs overfull).
    pub fn overfull(&self)->bool {self.mem_bytes>=self.settings.memtable_bytes.saturating_mul(self.settings.memtable_hold)}
    pub fn clear_memtable(&mut self) {self.mem.clear();self.mem_bytes=0;self.mem_debt=0;self.revision=self.revision.wrapping_add(1);}
    /// After rollback: discard ALL page/filter identities, including reused run IDs;
    /// caller then replays only its committed log tail. No stale cached bytes survive.
    pub fn reset_after_rollback(&mut self,db:&Connection)->Result<()> {self.clear_memtable();self.reload_catalog(db)}
    pub fn covered(&self,db:&Connection)->Result<Option<Value>> {let text:Option<String>=db.query_row(&format!("SELECT value FROM {}_meta WHERE key='covered'",self.prefix),[],|r|r.get(0)).optional()?;text.map(|s|serde_json::from_str(&s).map_err(Error::from)).transpose()}
    pub fn put(&mut self,key:&str,value:Value)->Result<()> {self.put_json(key,Some(serde_json::to_string(&value)?))}
    pub fn remove(&mut self,key:&str)->Result<()> {self.put_json(key,None)}
    /// A put that replaces a value of `prior_bytes` already written out: its bytes are charged once as compaction
    /// debt, kept with the memtable's write-out (old kept-runs.mjs put's fourth argument, :582). A key already in the
    /// memtable was charged when it first arrived.
    pub fn put_replacing(&mut self,key:&str,value:Value,prior_bytes:usize)->Result<()> {
        let charged=!self.mem.contains_key(&Key::new(key));
        self.put(key,value)?;
        if charged{self.mem_debt=self.mem_debt.saturating_add(prior_bytes);}
        Ok(())
    }
    /// A removal of a value of `prior_bytes` already written out, charged as compaction debt as `put_replacing` is (old
    /// kept-runs.mjs remove's second argument).
    pub fn remove_replacing(&mut self,key:&str,prior_bytes:usize)->Result<()> {
        let charged=!self.mem.contains_key(&Key::new(key));
        self.remove(key)?;
        if charged{self.mem_debt=self.mem_debt.saturating_add(prior_bytes);}
        Ok(())
    }
    /// The host's own durable metadata beside the runs (old kept-runs.mjs `meta`), in the caller's transaction for
    /// writes. Host keys live under `host:` so they never meet the store's own (covered, last_run, merge, ...).
    pub fn meta_get(&self,db:&Connection,key:&str)->Result<Option<Value>> {
        self.meta_reads.set(self.meta_reads.get()+1);
        let text:Option<String>=db.query_row(&format!("SELECT value FROM {}_meta WHERE key=?",self.prefix),[format!("host:{key}")],|r|r.get(0)).optional()?;
        text.map(|s|serde_json::from_str(&s).map_err(Error::from)).transpose()
    }
    /// Several host metadata values in one statement (old meta.getMany).
    pub fn meta_get_many(&self,db:&Connection,keys:&[String])->Result<BTreeMap<String,Value>> {
        let mut out=BTreeMap::new();if keys.is_empty(){return Ok(out);}
        self.meta_reads.set(self.meta_reads.get()+1);
        let wanted=serde_json::to_string(&keys.iter().map(|k|format!("host:{k}")).collect::<Vec<_>>())?;
        let mut statement=db.prepare(&format!("SELECT key,value FROM {}_meta WHERE key IN (SELECT value FROM json_each(?))",self.prefix))?;
        let mut rows=statement.query([wanted])?;
        while let Some(row)=rows.next()?{let key:String=row.get(0)?;let value:String=row.get(1)?;out.insert(key.trim_start_matches("host:").to_string(),serde_json::from_str(&value)?);}
        Ok(out)
    }
    pub fn meta_set(&self,tx:&Connection,key:&str,value:&Value)->Result<()> {
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        let text=serde_json::to_string(value)?;if text.len()>4*1024*1024{return Err(Error::Bounds("kept host metadata exceeds bound", crate::cause!()));}
        set_meta(tx,&self.prefix,&format!("host:{key}"),&text)
    }
    pub fn meta_remove(&self,tx:&Connection,key:&str)->Result<()> {
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        tx.execute(&format!("DELETE FROM {}_meta WHERE key=?",self.prefix),[format!("host:{key}")])?;Ok(())
    }
    /// The settings this store was opened with.
    pub fn settings(&self)->&Settings {&self.settings}
    /// Whether any key in [lo, hi) is live (old kept-runs.mjs hasRange, :1608). Sources are read newest first and
    /// stop at the first live winner; only page heads are read, so a large or inline value is never opened.
    pub fn has_range(&mut self,db:&Connection,lo:&str,hi:&str,budget:ReadBudget)->Result<Read<bool>> {
        self.valid_key(lo)?;self.valid_key(hi)?;let mut meter=Meter::new(budget);
        let (lo,hi)=(Key::new(lo),Key::new(hi));
        if lo>=hi{return Ok(Read{result:false,work:meter.work});}
        let mut removed=std::collections::BTreeSet::new();
        for (key,entry) in self.mem.range((Bound::Included(lo.clone()),Bound::Excluded(hi.clone()))){
            meter.entry()?;
            if !matches!(entry,Entry::Tomb){return Ok(Read{result:true,work:meter.work});}
            removed.insert(key.clone());
        }
        for run in self.runs.clone(){
            if run.last<lo||run.first>=hi{continue;}
            let (mut page,mut head)=match self.floor_head(db,&run,&lo,&mut meter)?{Some(found)=>found,None=>(0,self.head_page(db,&run,0,&mut meter)?)};
            let mut index=head.heads.partition_point(|h|h.key<lo);
            loop{
                if index>=head.heads.len(){
                    page+=1;if page>=run.pages{break;}
                    head=self.head_page(db,&run,page,&mut meter)?;index=0;continue;
                }
                let entry=&head.heads[index];
                if entry.key>=hi{break;}
                meter.entry()?;
                if !removed.contains(&entry.key){
                    if !matches!(entry.entry,Location::Tomb){return Ok(Read{result:true,work:meter.work});}
                    removed.insert(entry.key.clone());
                }
                index+=1;
            }
        }
        Ok(Read{result:false,work:meter.work})
    }
    /// Values are JSON text from the canonical serializer supplied by the log host.
    /// The text is validated once here; flush and merge copy it without reparsing.
    pub fn put_json(&mut self,key:&str,text:Option<String>)->Result<()> {
        self.valid_key(key)?;
        let entry=match text{None=>Entry::Tomb,Some(s)=>{if s.len()>self.settings.max_value_bytes{return Err(Error::Bounds("kept value exceeds configured bound", crate::cause!()));} let _:serde::de::IgnoredAny=serde_json::from_str(&s)?;Entry::Text(Arc::from(s))}};
        let k=Key::new(key);let bytes=k.0.len()*2+entry.bytes()+96;let old=self.mem.get(&k).map(|e|k.0.len()*2+e.bytes()+96).unwrap_or(0);
        let total=self.mem_bytes.saturating_sub(old).checked_add(bytes).ok_or(Error::Bounds("kept memtable overflow", crate::cause!()))?;
        // No put is refused for size: the host writes the memtable out once it is overfull (old kept-runs.mjs memPut and
        // invariant 4: "a write only once overfull() at memtable_hold times that").
        self.mem.insert(k,entry);self.mem_bytes=total;self.revision=self.revision.wrapping_add(1);Ok(())
    }
    pub fn get(&mut self,db:&Connection,key:&str,budget:ReadBudget)->Result<Read<Lookup>> {
        self.valid_key(key)?;let k=Key::new(key);let mut meter=Meter::new(budget);
        if let Some(entry)=self.mem.get(&k).cloned(){let result=self.entry_value(db,&entry,&mut meter)?;return Ok(Read{result,work:meter.work});}
        for run in self.runs.clone(){meter.check()?;if k<run.first || k>run.last || !self.may_hold(db,&run,key,&mut meter)?{continue;}
            let Some(number)=self.floor_page(db,&run,&k,&mut meter)? else {continue};
            let head=self.head_page(db,&run,number,&mut meter)?;
            if let Ok(at)=head.heads.binary_search_by(|h|h.key.cmp(&k)){meter.entry()?;
                let result=match &head.heads[at].entry { Location::Tomb=>Lookup::Tombstone,Location::Big{reference,parts}=>self.big_value(db,reference,*parts,&mut meter)?,_=>{let page=self.page(db,&run,number,&mut meter)?;self.selected(db,&page,&page.heads[at].entry,&mut meter)?}};
                return Ok(Read{result,work:meter.work});}
        }
        Ok(Read{result:Lookup::Absent,work:meter.work})
    }
    fn valid_key(&self,key:&str)->Result<()> {if key.len()>self.settings.max_key_bytes{return Err(Error::Bounds("kept key exceeds configured bound", crate::cause!()));}Ok(())}
    fn table(&self,run:i64)->String {format!("{}_run_{run}",self.prefix)}
    pub fn reload_catalog(&mut self,db:&Connection)->Result<()> {
        self.cache.clear();self.cache_bytes=0;self.successors.clear();self.runs.clear();self.revision=self.revision.wrapping_add(1);
        let columns:Vec<String>={let mut q=db.prepare(&format!("PRAGMA table_info({}_runs)",self.prefix))?;let result=q.query_map([],|r|r.get(1))?.collect::<std::result::Result<_,_>>()?;result};
        let format=if columns.iter().any(|c|c=="page_format"){"COALESCE(page_format,0)"}else{"0"};
        let debt:Option<String>=db.query_row(&format!("SELECT value FROM {}_meta WHERE key='compaction_debt'",self.prefix),[],|r|r.get(0)).optional()?;
        self.debt=debt.map(|s|serde_json::from_str::<usize>(&s)).transpose()?.unwrap_or(0);
        let mut query=db.prepare(&format!("SELECT run,age,pages,last,filter_bits,{format},keys,bytes FROM {}_runs ORDER BY age DESC,run DESC LIMIT ?",self.prefix))?;
        let mut rows=query.query([self.settings.max_runs as i64+1])?;
        let mut bytes=0usize;let mut filter_bytes=0usize;
        while let Some(row)=rows.next()? {
            if self.runs.len()>=self.settings.max_runs{return Err(Error::Bounds("kept catalogue exceeds configured run bound; bounded maintenance required", crate::cause!()));}
            let last_raw=row.get_ref(3)?.as_str().map_err(|_|Error::Corrupt("kept last boundary key is not text", crate::cause!()))?;
            if last_raw.len()>self.settings.max_key_bytes*6+2{return Err(Error::Bounds("kept last boundary key exceeds bound", crate::cause!()));}
            let (number,age,pages,last,bits,format):(i64,i64,i64,&str,i64,i64)=(row.get(0)?,row.get(1)?,row.get(2)?,last_raw,row.get(4)?,row.get(5)?);
            if format!=0{return Err(Error::Unsupported("sparse kept page format requires supplied adapter", crate::cause!()));}
            let keys:i64=row.get(6)?;let run_bytes:i64=row.get(7)?;
            if number<0 || age<0 || pages<=0 || keys<0 || run_bytes<0 || bits==i64::MIN{return Err(Error::Corrupt("invalid kept run descriptor", crate::cause!()));}
            let last:String=serde_json::from_str(last)?;self.valid_key(&last)?;
            let mut first_query=db.prepare(&format!("SELECT first FROM {} WHERE page=0",self.table(number)))?;let mut first_rows=first_query.query([])?;let first_row=first_rows.next()?.ok_or(Error::Corrupt("kept first boundary key missing", crate::cause!()))?;let raw=first_row.get_ref(0)?.as_str().map_err(|_|Error::Corrupt("kept first boundary key is not text", crate::cause!()))?;
            if raw.len()>self.settings.max_key_bytes.saturating_mul(6)+2{return Err(Error::Bounds("kept first boundary key exceeds bound", crate::cause!()));}
            let first:String=serde_json::from_str(raw)?;self.valid_key(&first)?;
            bytes=bytes.checked_add((first.len()+last.len())*2+192).ok_or(Error::Bounds("kept catalogue overflow", crate::cause!()))?;
            if bytes>self.settings.catalog_bytes{return Err(Error::Bounds("kept catalogue byte bound exceeded", crate::cause!()));}
            let mut run=Run{number,age,pages:pages as usize,keys:keys as usize,bytes:run_bytes as usize,first:Key::new(&first),last:Key::new(&last),filter_bits:bits,filter:None};
            if run.first>run.last{return Err(Error::Corrupt("kept run boundary keys are reversed", crate::cause!()));}
            // Preserve persisted positive geometry. Large filters stay on disk;
            // no global reallocation or all-page filter rebuild occurs at open.
            if bits>0 && bits%8==0 && (bits as u64/8)<=self.settings.filter_bytes.saturating_sub(filter_bytes) as u64 {
                let wanted=bits as usize/8;let mut filter=Vec::with_capacity(wanted);
                let mut q=db.prepare(&format!("SELECT body FROM {} WHERE page<0 ORDER BY page DESC",self.table(number)))?;let mut rs=q.query([])?;
                while let Some(r)=rs.next()? {let part=filter_chunk(r.get_ref(0)?,wanted.saturating_sub(filter.len()))?;filter.extend_from_slice(&part);}
                if filter.len()!=wanted{return Err(Error::Corrupt("kept positive filter length mismatch", crate::cause!()));}
                filter_bytes+=filter.len();run.filter=Some(Arc::from(filter));
            } else if bits>0 && bits%8!=0 {return Err(Error::Corrupt("invalid kept positive filter geometry", crate::cause!()));}
            else if bits<0 && bits.unsigned_abs().saturating_mul(64)<=self.settings.filter_bytes.saturating_sub(filter_bytes) as u64 {
                let wanted=bits.unsigned_abs() as usize*64;let mut filter=Vec::with_capacity(wanted);
                let mut q=db.prepare(&format!("SELECT body FROM {} WHERE page<0 ORDER BY page DESC",self.table(number)))?;let mut rs=q.query([])?;
                while let Some(r)=rs.next()?{let part=filter_chunk(r.get_ref(0)?,wanted.saturating_sub(filter.len()))?;filter.extend_from_slice(&part);}
                if filter.len()!=wanted{return Err(Error::Corrupt("kept blocked filter length mismatch", crate::cause!()));}
                filter_bytes+=filter.len();run.filter=Some(Arc::from(filter));
            }
            self.runs.push(run);
        }
        Ok(())
    }
    fn floor_page(&self,db:&Connection,run:&Run,key:&Key,meter:&mut Meter)->Result<Option<usize>> {
        if key<&run.first{return Ok(None);}
        if run.pages==1||key>=&run.last{return Ok(Some(run.pages-1));}
        let(mut lo,mut hi,mut found)=(0usize,run.pages,None);
        let mut query=db.prepare(&format!("SELECT first FROM {} WHERE page=?",self.table(run.number)))?;
        while lo<hi {let mid=lo+(hi-lo)/2;meter.check()?;meter.work.sql_statements+=1;
            let mut rows=query.query([mid as i64])?;let row=rows.next()?.ok_or(Error::Corrupt("kept seek boundary key missing", crate::cause!()))?;let text=row.get_ref(0)?.as_str().map_err(|_|Error::Corrupt("kept seek boundary key is not text", crate::cause!()))?;meter.row(text.len())?;
            if text.len()>self.settings.max_key_bytes*6+2{return Err(Error::Bounds("kept boundary key byte bound exceeded", crate::cause!()));}
            let boundary_key:String=serde_json::from_str(text)?;self.valid_key(&boundary_key)?;
            if Key::new(&boundary_key)<=*key{found=Some(mid);lo=mid+1;}else{hi=mid;}
        }Ok(found)
    }
    /// The last page whose first key is <= `key`, and that page's head, in ONE statement however many pages the run
    /// holds (old kept-runs.mjs seekSql, :644-692: the halving as a recursive CTE whose result is MATERIALIZED once,
    /// then the found page's head joined in the same statement). SQLite compares the JSON fences by code point and
    /// this store by UTF-16 unit; they differ only past U+FFFF beside U+E000..U+FFFF, so each answer is checked here
    /// against the two fences the halving carried, and a disagreement is halved again in Rust (old :646-648).
    /// None when the key is before the run. A one-page run, or a key at or past its last key, needs no halving.
    fn floor_head(&mut self,db:&Connection,run:&Run,key:&Key,meter:&mut Meter)->Result<Option<(usize,Arc<Page>)>> {self.floor_seek(db,run,key,false,meter)}
    /// The floor page's number: none before the run, the last page at or past its last key (no statement for either),
    /// else one fused seek.
    fn floor_number(&mut self,db:&Connection,run:&Run,key:&Key,meter:&mut Meter)->Result<Option<usize>> {
        if key<&run.first{return Ok(None);}
        if run.pages==1||key>=&run.last{return Ok(Some(run.pages-1));}
        Ok(self.floor_head(db,run,key,meter)?.map(|(page,_)|page))
    }
    /// `full`: the statement carries the found page's whole body, decoded and kept in the page cache, so the range that
    /// reads its winner from that page needs no second statement (old seekSql with `body`, :690-691). Without it only
    /// the page head is read (old keysOnly projection, :684-689), as existence needs.
    fn floor_seek(&mut self,db:&Connection,run:&Run,key:&Key,full:bool,meter:&mut Meter)->Result<Option<(usize,Arc<Page>)>> {
        if key<&run.first{return Ok(None);}
        if run.pages==1||key>=&run.last{let page=run.pages-1;return Ok(Some((page,self.head_page(db,run,page,meter)?)));}
        if full{if let Some(found)=self.cached_floor(run,key){return Ok(Some(found));}}
        let text=key.text()?;let projection=if full{"kept.body"}else{"CASE WHEN kept.body IS NULL THEN NULL WHEN substr(kept.body,1,1)='[' OR instr(kept.body,char(10))=0 THEN kept.body ELSE substr(kept.body,1,instr(kept.body,char(10))) END"};let table=self.table(run.number);
        let below="json_extract(fence.first,'$') <= ?2";
        let query=format!("WITH RECURSIVE halving(lo,hi,found,here,next) AS (SELECT 0,CAST(?1 AS INTEGER)-1,-1,NULL,NULL UNION ALL \
            SELECT CASE WHEN {below} THEN (halving.lo+halving.hi)/2+1 ELSE halving.lo END,CASE WHEN {below} THEN halving.hi ELSE (halving.lo+halving.hi)/2-1 END,\
            CASE WHEN {below} THEN (halving.lo+halving.hi)/2 ELSE halving.found END,CASE WHEN {below} THEN fence.first ELSE halving.here END,\
            CASE WHEN {below} THEN halving.next ELSE fence.first END FROM halving JOIN {table} AS fence ON fence.page=(halving.lo+halving.hi)/2 WHERE halving.lo<=halving.hi),\
            sought_pages AS MATERIALIZED (SELECT found,here,next FROM halving WHERE lo>hi) \
            SELECT found,here,next,{projection} AS body \
            FROM sought_pages LEFT JOIN {table} AS kept ON kept.page=sought_pages.found");
        meter.check()?;meter.work.sql_statements+=1;
        let mut statement=db.prepare(&query)?;let mut rows=statement.query(params![run.pages as i64,text])?;
        let row=rows.next()?.ok_or(Error::Corrupt("kept seek found no answer", crate::cause!()))?;
        let found:i64=row.get(0)?;
        let fence=|at:usize|->Result<Option<Key>>{match row.get_ref(at)?{rusqlite::types::ValueRef::Null=>Ok(None),value=>{let raw=value.as_str().map_err(|_|Error::Corrupt("kept seek fence is not text", crate::cause!()))?;
            if raw.len()>self.settings.max_key_bytes*6+2{return Err(Error::Bounds("kept boundary key byte bound exceeded", crate::cause!()));}Ok(Some(Key::new(&serde_json::from_str::<String>(raw)?)))}}};
        let (here,next)=(fence(1)?,fence(2)?);
        if let (true,Some(n))=(found>=0,&next){self.note_successor(run.number,found as usize,n.clone());}
        let agrees=found>=0&&(found as usize)<run.pages&&here.as_ref().is_some_and(|h|h<=key)&&next.as_ref().is_none_or(|n|key<n);
        if !agrees{drop(rows);drop(statement);
            let Some(page)=self.floor_page(db,run,key,meter)? else{return Ok(None)};return Ok(Some((page,if full{self.page(db,run,page,meter)?}else{self.head_page(db,run,page,meter)?})));}
        let raw=row.get_ref(3)?.as_str().map_err(|_|Error::Corrupt("kept page head is not text", crate::cause!()))?;
        if raw.len()>self.settings.page_bytes*8{return Err(Error::Bounds("legacy kept head requires wider adapter", crate::cause!()));}meter.row(raw.len())?;
        let page=Arc::new(decode_page(raw,&self.settings)?);
        if full{meter.work.page_bodies+=1;self.keep_page(run.number,found as usize,&page);}
        Ok(Some((found as usize,page)))
    }
    /// Several ranges read together (old kept-runs.mjs ranges, :1873, and limitedRanges, :1670): for each run, the
    /// page where every range starts is found and read in ONE statement (old seekSql over `json_each` probes, :644-692,
    /// with `body`), and kept in the page cache; then each range is read as `range` reads it, from those pages. Each
    /// range answers at most `limit_per_range` live entries, its own list in the same order as the bounds. A read that
    /// would bring in more than `page_budget` pages that way refuses with "kept ranges exceed their page budget", so a
    /// caller can read the ranges one at a time instead (old KeptRangeBudgetExceeded).
    pub fn ranges(&mut self,db:&Connection,bounds:&[(String,String)],reverse:bool,limit_per_range:usize,page_budget:Option<usize>,budget:ReadBudget)->Result<(Vec<Vec<(String,Value)>>,Work)>{
        let work=Work::default();
        if bounds.is_empty(){return Ok((Vec::new(),work));}
        if limit_per_range==0{return Ok((bounds.iter().map(|_|Vec::new()).collect(),work));}
        for (lo,hi) in bounds{self.valid_key(lo)?;self.valid_key(hi)?;}
        self.workspace=Some((BTreeMap::new(),0));
        let answer=self.ranges_held(db,bounds,reverse,limit_per_range,page_budget,budget,work);
        self.workspace=None;
        answer
    }
    fn ranges_held(&mut self,db:&Connection,bounds:&[(String,String)],reverse:bool,limit_per_range:usize,page_budget:Option<usize>,budget:ReadBudget,mut work:Work)->Result<(Vec<Vec<(String,Value)>>,Work)>{
        let mut meter=Meter::new(budget.clone());let mut fetched=0usize;
        for run in self.runs.clone(){
            let seeks:Vec<(Key,Key)>=bounds.iter().map(|(lo,hi)|(Key::new(lo),Key::new(hi))).filter(|(lo,hi)|lo<hi&&!(run.last<*lo||run.first>=*hi)).collect();
            if seeks.is_empty(){continue;}
            fetched+=self.seek_many(db,&run,&seeks,page_budget.map(|b|b.saturating_sub(fetched)),&mut meter)?;
        }
        work.add(&meter.work);
        let mut out=Vec::with_capacity(bounds.len());
        for (lo,hi) in bounds{
            let mut entries=Vec::new();let mut after:Option<String>=None;
            if Key::new(lo)<Key::new(hi){loop{
                let want=(limit_per_range-entries.len()).min(4096);
                let page=self.range(db,Range{lo,hi,after:after.as_deref(),reverse,limit:want},budget.clone())?;work.add(&page.work);
                entries.extend(page.entries);
                if page.complete||entries.len()>=limit_per_range{break;}
                after=page.next;
            }}
            out.push(entries);
        }
        Ok((out,work))
    }
    /// The pages of many ranges in one run, read together and kept in the page cache; answers how many pages it brought
    /// in. One statement finds the floor page of each range's start and end (old seekSql over `json_each` probes,
    /// :644-692); a second reads every page those ranges cover, all at once (old lastPages's grouped
    /// `SELECT page, body ... WHERE page IN (...)`). Each page found keeps the first key of the page after it, so a range
    /// starting in the gap after a page is known to start on the next one without a statement (old noteSuccessor, :1071).
    fn seek_many(&mut self,db:&Connection,run:&Run,bounds:&[(Key,Key)],page_budget:Option<usize>,meter:&mut Meter)->Result<usize>{
        let mut probes:Vec<Key>=Vec::new();
        for (lo,hi) in bounds{for key in [lo,hi]{if *key>=run.first&&!probes.contains(key){probes.push(key.clone());}}}
        let mut floors:BTreeMap<usize,usize>=BTreeMap::new();
        if !probes.is_empty()&&run.pages>1{
            let text=serde_json::to_string(&probes.iter().map(|k|k.text()).collect::<Result<Vec<_>>>()?)?;
            let table=self.table(run.number);
            let below="json_extract(fence.first,'$') <= probe.value";
            let query=format!("SELECT probe.key AS at,(WITH RECURSIVE halving(lo,hi,found,here,next) AS (SELECT 0,CAST(?1 AS INTEGER)-1,-1,NULL,NULL UNION ALL \
                SELECT CASE WHEN {below} THEN (halving.lo+halving.hi)/2+1 ELSE halving.lo END,CASE WHEN {below} THEN halving.hi ELSE (halving.lo+halving.hi)/2-1 END,\
                CASE WHEN {below} THEN (halving.lo+halving.hi)/2 ELSE halving.found END,CASE WHEN {below} THEN fence.first ELSE halving.here END,\
                CASE WHEN {below} THEN halving.next ELSE fence.first END FROM halving JOIN {table} AS fence ON fence.page=(halving.lo+halving.hi)/2 WHERE halving.lo<=halving.hi) \
                SELECT json_array(found,here,next) FROM halving WHERE lo>hi) AS sought FROM json_each(?2) AS probe");
            meter.check()?;meter.work.sql_statements+=1;
            let mut statement=db.prepare(&query)?;let mut rows=statement.query(params![run.pages as i64,text])?;
            while let Some(row)=rows.next()?{
                let at:i64=row.get(0)?;let sought:String=row.get(1)?;
                let (found,here,next):(i64,Option<String>,Option<String>)=serde_json::from_str(&sought)?;
                let key=probes.get(at as usize).ok_or(Error::Corrupt("kept seek answered an unknown probe", crate::cause!()))?;
                let fence=|f:&Option<String>|->Result<Option<Key>>{f.as_deref().map(|raw|Ok(Key::new(&serde_json::from_str::<String>(raw)?))).transpose()};
                let (here,next)=(fence(&here)?,fence(&next)?);
                // A disagreement with UTF-16 order is left to the range's own seek.
                if found<0||(found as usize)>=run.pages||!here.as_ref().is_some_and(|h|h<=key)||!next.as_ref().is_none_or(|n|key<n){continue;}
                floors.insert(at as usize,found as usize);
                if let Some(next)=&next{self.note_successor(run.number,found as usize,next.clone());}
            }
        }else if !probes.is_empty(){
            for (at,key) in probes.iter().enumerate(){if *key>=run.first{floors.insert(at,0);}}
        }
        // Every page from each range's first page to its last, read in one statement.
        let mut wanted=std::collections::BTreeSet::new();
        for (lo,hi) in bounds{
            let at=|k:&Key|probes.iter().position(|p|p==k).and_then(|i|floors.get(&i).copied());
            let first=if *lo<run.first{Some(0)}else{at(lo)};
            let last=if *hi<run.first{None}else{at(hi).or(first)};
            if let (Some(first),Some(last))=(first,last){for page in first..=last{if self.resident(run.number,page).is_none(){wanted.insert(page);}}}
        }
        if wanted.is_empty(){return Ok(0);}
        if page_budget.is_some_and(|b|wanted.len()>b){return Err(Error::Bounds("kept ranges exceed their page budget", crate::cause!()));}
        meter.check()?;meter.work.sql_statements+=1;meter.work.grouped+=1;
        let list=serde_json::to_string(&wanted.iter().collect::<Vec<_>>())?;
        let mut statement=db.prepare(&format!("SELECT page, body FROM {} WHERE page IN (SELECT value FROM json_each(?)) ORDER BY page",self.table(run.number)))?;
        let mut rows=statement.query([list])?;let mut brought=0usize;
        while let Some(row)=rows.next()?{
            let number:i64=row.get(0)?;let raw=row.get_ref(1)?.as_str().map_err(|_|Error::Corrupt("kept page is not text", crate::cause!()))?;
            if raw.len()>self.settings.page_bytes.saturating_mul(8){return Err(Error::Bounds("legacy kept page requires a wider bounded adapter", crate::cause!()));}
            meter.row(raw.len())?;meter.work.page_bodies+=1;
            let page=Arc::new(decode_page(raw,&self.settings)?);self.keep_page(run.number,number as usize,&page);brought+=1;
        }
        Ok(brought)
    }
    /// Every live entry in [lo, hi) in key order, newest version winning (old kept-runs.mjs walk, :1630, and
    /// runWalkCursor, :1439). Each run is read through ordered SQL cursors over its pages, one cursor per span of
    /// pages not resident in the page cache, opened when the walk reaches the span; a resident page is used from the
    /// cache, and a page read is kept in it. `read_value(key)` runs after the newest winner is chosen and before any
    /// value is opened: a rejected live key is passed with None, a tombstone is never passed, and a rejected value
    /// (inline or big) is never opened. `each` returns false to stop; every open cursor is closed on return,
    /// early, at the end or on an error (Rust drops them; old :1658-1663 closed them in a `finally`).
    /// The old walk is a generator the caller pulls; here the caller is called, so the cursors live on this stack.
    pub fn walk(&mut self,db:&Connection,lo:&str,hi:&str,budget:ReadBudget,read_value:&mut dyn FnMut(&str)->bool,each:&mut dyn FnMut(String,Option<Value>)->Result<bool>)->Result<Work>{
        self.valid_key(lo)?;self.valid_key(hi)?;let mut meter=Meter::new(budget);
        let (lo,hi)=(Key::new(lo),Key::new(hi));if lo>=hi{return Ok(meter.work);}
        let mem:Vec<(Key,Entry)>=self.mem.range((Bound::Included(lo.clone()),Bound::Excluded(hi.clone()))).map(|(k,e)|(k.clone(),e.clone())).collect();
        // Each run's pages [first, last] and the spans of them not resident now. A span's statement is prepared here
        // and executed when the walk reaches it.
        let mut plans=Vec::new();let mut spans=0usize;
        for run in self.runs.clone(){
            if run.last<lo||run.first>=hi{continue;}
            let first=self.floor_number(db,&run,&lo,&mut meter)?.unwrap_or(0);
            let last=self.floor_number(db,&run,&hi,&mut meter)?.unwrap_or(0).max(first);
            let mut cold=Vec::new();let mut at=first;
            while at<=last{if self.cache.iter().any(|c|c.run==run.number&&c.page==at){at+=1;continue;}
                let from=at;while at<=last&&!self.cache.iter().any(|c|c.run==run.number&&c.page==at){at+=1;}cold.push((from,at-1));}
            spans+=cold.len();plans.push((run,first,last,cold));
        }
        let mut statements=Vec::with_capacity(spans);
        for (run,_,_,cold) in &plans{for _ in cold{statements.push(db.prepare(&format!("SELECT page, body FROM {} WHERE page >= ? AND page <= ? ORDER BY page",self.table(run.number)))?);}}
        let mut free=statements.iter_mut();
        let mut sources:Vec<WalkRun<'_,'_>>=Vec::with_capacity(plans.len());
        for (run,first,last,cold) in plans{let spans=cold.into_iter().map(|(from,to)|(from,to,free.next().expect("one statement per span"))).collect();
            sources.push(WalkRun{run,page:first,last,spans,rows:None,rows_through:None,current:None,index:0,first:true});}
        let mut mem_at=0usize;
        for source in &mut sources{self.walk_load(db,source,&lo,&mut meter)?;}
        loop{
            meter.check()?;
            for source in &mut sources{self.walk_settle(db,source,&lo,&mut meter)?;}
            let mut best:Option<(Key,Option<usize>)>=mem.get(mem_at).map(|(k,_)|(k.clone(),None));
            for (at,source) in sources.iter().enumerate(){if let Some(head)=source.head(){if head.key<hi&&best.as_ref().is_none_or(|(k,_)|head.key<*k){best=Some((head.key.clone(),Some(at)));}}}
            let Some((key,winner))=best else{break};
            if mem_at<mem.len()&&mem[mem_at].0==key&&winner.is_some(){unreachable!("the memtable wins ties");}
            for (at,source) in sources.iter_mut().enumerate(){if Some(at)!=winner&&source.head().is_some_and(|h|h.key==key){source.index+=1;}}
            let text=key.text()?;meter.entry()?;
            let value=match winner{
                None=>{let entry=mem[mem_at].1.clone();mem_at+=1;match entry{Entry::Tomb=>None,entry=>Some(if read_value(&text){match self.entry_value(db,&entry,&mut meter)?{Lookup::Value(v)=>Some(v),_=>None}}else{None})}}
                Some(at)=>{let source=&mut sources[at];let (page,index)=(source.current.clone().expect("a head has a page"),source.index);source.index+=1;
                    match page.heads[index].entry.clone(){Location::Tomb=>None,location=>Some(if read_value(&text){match self.selected(db,&page,&location,&mut meter)?{Lookup::Value(v)=>Some(v),_=>None}}else{None})}}
            };
            if let Some(value)=value{if !each(text,value)?{break;}}
        }
        Ok(meter.work)
    }
    fn walk_load<'s,'c>(&mut self,_db:&Connection,source:&mut WalkRun<'s,'c>,lo:&Key,meter:&mut Meter)->Result<()>{
        if source.page>source.last{source.current=None;source.rows=None;return Ok(());}
        let number=source.page;
        let page=if let Some(at)=self.cache.iter().position(|c|c.run==source.run.number&&c.page==number){meter.work.cache_hits+=1;let value=Arc::clone(&self.cache[at].value);source.rows=None;value}else{
            if source.rows.is_none()||source.rows_through.is_some_and(|t|number>t){
                source.rows=None;
                let at=source.spans.iter().position(|(from,to,_)|*from<=number&&number<=*to);
                match at{
                    Some(at)=>{let (from,to,statement)=source.spans.remove(at);if from!=number{return Err(Error::Corrupt("kept walk span starts elsewhere", crate::cause!()));}
                        meter.check()?;meter.work.sql_statements+=1;meter.work.streams+=1;source.rows=Some(statement.query(params![from as i64,to as i64])?);source.rows_through=Some(to);}
                    // A page resident when the walk started was let go since: read it on its own.
                    None=>{let run=source.run.clone();let page=self.page(_db,&run,number,meter)?;source.current=Some(page);source.index=if source.first{source.current.as_ref().unwrap().heads.partition_point(|h|h.key<*lo)}else{0};source.first=false;return Ok(());}
                }
            }
            let rows=source.rows.as_mut().expect("rows were opened");
            let row=rows.next()?.ok_or(Error::Corrupt("kept walk page is missing", crate::cause!()))?;
            let got:i64=row.get(0)?;if got!=number as i64{return Err(Error::Corrupt("kept walk page is missing", crate::cause!()));}
            let raw=row.get_ref(1)?.as_str().map_err(|_|Error::Corrupt("kept page is not text", crate::cause!()))?;
            if raw.len()>self.settings.page_bytes.saturating_mul(8){return Err(Error::Bounds("legacy kept page requires a wider bounded adapter", crate::cause!()));}
            meter.row(raw.len())?;meter.work.page_bodies+=1;
            let page=Arc::new(decode_page(raw,&self.settings)?);self.keep_page(source.run.number,number,&page);
            if source.rows_through==Some(number){source.rows=None;source.rows_through=None;}
            page
        };
        source.index=if source.first{page.heads.partition_point(|h|h.key<*lo)}else{0};source.first=false;source.current=Some(page);Ok(())
    }
    fn walk_settle(&mut self,db:&Connection,source:&mut WalkRun<'_,'_>,lo:&Key,meter:&mut Meter)->Result<()>{
        while source.current.as_ref().is_some_and(|p|source.index>=p.heads.len()){source.page+=1;self.walk_load(db,source,lo,meter)?;}Ok(())
    }
    /// A resident page of `run` that is the floor of `key`, found without a statement (old coveringPage, :975, and
    /// noteSuccessor, :1071): a resident page whose first key is <= key, and either key <= its last key, or it is the
    /// run's last page, or the next page is resident too and starts after key. Two resident adjacent pages prove the gap
    /// between them holds no key, with its strict upper fence.
    fn cached_floor(&mut self,run:&Run,key:&Key)->Option<(usize,Arc<Page>)>{
        let mut held:Vec<(usize,Arc<Page>)>=self.cache.iter().filter(|c|c.run==run.number).map(|c|(c.page,Arc::clone(&c.value))).collect();
        if let Some((pages,_))=&self.workspace{held.extend(pages.range((run.number,0)..=(run.number,usize::MAX)).map(|((_,p),v)|(*p,Arc::clone(v))));}
        held.into_iter().find(|(page,value)|value.heads.first().is_some_and(|h|h.key<=*key)
            &&(value.heads.last().is_some_and(|h|h.key>=*key)||page+1==run.pages
                ||self.successors.get(&(run.number,*page)).is_some_and(|n|n>key)
                ||self.resident(run.number,page+1).is_some_and(|next|next.heads.first().is_some_and(|h|h.key>*key))))
    }
    /// A page held now, in the page cache or the current `ranges` workspace.
    fn resident(&self,run:i64,page:usize)->Option<Arc<Page>>{
        self.cache.iter().find(|c|c.run==run&&c.page==page).map(|c|Arc::clone(&c.value))
            .or_else(||self.workspace.as_ref().and_then(|(w,_)|w.get(&(run,page)).cloned()))
    }
    fn note_successor(&mut self,run:i64,page:usize,next:Key){if self.successors.len()>=4096{self.successors.clear();}self.successors.insert((run,page),next);}
    /// Keep a page just read, least recently used let go first (the cache policy of `page`).
    fn keep_page(&mut self,run:i64,number:usize,page:&Arc<Page>){
        let bytes=page.bytes();
        if let Some((pages,held))=self.workspace.as_mut(){if *held+bytes<=RANGES_WORKSPACE_BYTES&&!pages.contains_key(&(run,number)){pages.insert((run,number),Arc::clone(page));*held+=bytes;}}
        if bytes>self.settings.cache_bytes{return;}
        while self.cache_bytes.saturating_add(bytes)>self.settings.cache_bytes{if let Some(old)=self.cache.pop_front(){self.cache_bytes-=old.bytes;}else{break;}}
        self.cache.push_back(Cached{run,page:number,value:Arc::clone(page),bytes});self.cache_bytes+=bytes;
    }
    fn page(&mut self,db:&Connection,run:&Run,number:usize,meter:&mut Meter)->Result<Arc<Page>> {
        if let Some(at)=self.cache.iter().position(|p|p.run==run.number&&p.page==number){let hit=self.cache.remove(at).unwrap();let result=Arc::clone(&hit.value);self.cache.push_back(hit);meter.work.cache_hits+=1;return Ok(result);}
        if let Some(page)=self.workspace.as_ref().and_then(|(w,_)|w.get(&(run.number,number)).cloned()){meter.work.cache_hits+=1;return Ok(page);}
        meter.check()?;meter.work.sql_statements+=1;meter.work.point_pages+=1;
        let mut query=db.prepare(&format!("SELECT body FROM {} WHERE page=?",self.table(run.number)))?;let mut rows=query.query([number as i64])?;
        let row=rows.next()?.ok_or(Error::Corrupt("kept page is missing", crate::cause!()))?;
        let raw=row.get_ref(0)?.as_str().map_err(|_|Error::Corrupt("kept page is not text", crate::cause!()))?;
        if raw.len()>self.settings.page_bytes.saturating_mul(8){return Err(Error::Bounds("legacy kept page requires a wider bounded adapter", crate::cause!()));}
        meter.row(raw.len())?;meter.work.page_bodies+=1;
        let page=Arc::new(decode_page(raw,&self.settings)?);let bytes=page.bytes();
        if bytes<=self.settings.cache_bytes {
            while self.cache_bytes.saturating_add(bytes)>self.settings.cache_bytes {if let Some(old)=self.cache.pop_front(){self.cache_bytes-=old.bytes;}else{break;}}
            self.cache.push_back(Cached{run:run.number,page:number,value:Arc::clone(&page),bytes});self.cache_bytes+=bytes;
        }Ok(page)
    }
    /// Whether `run` may hold `key`, answered from its boundary keys and resident filter only (no read): None when its
    /// filter stays on disk. Used to drop a tombstone that no older run can hold.
    fn resident_may_hold(run:&Run,key:&Key)->Result<Option<bool>> {
        if *key<run.first||*key>run.last{return Ok(Some(false));}
        if run.filter_bits==0{return Ok(Some(true));}
        let Some(filter)=&run.filter else{return Ok(None)};let(a,b)=hash(key.0.iter().copied());
        if run.filter_bits>0{let bits=run.filter_bits as u64;return Ok(Some((0..7u32).all(|k|{let bit=a.wrapping_add(k.wrapping_mul(b)) as u64%bits;filter[bit as usize/8]&(1<<(bit%8))!=0})));}
        blocked_has(filter,(a as u64%run.filter_bits.unsigned_abs())as usize*64,b).map(Some)
    }
    /// A tombstone is kept only while some run older than where it is written may hold its key.
    fn older_may_hold(older:&[Run],key:&Key)->Result<bool> {
        for run in older{if Self::resident_may_hold(run,key)?!=Some(false){return Ok(true);}}Ok(false)
    }
    fn may_hold(&self,db:&Connection,run:&Run,key:&str,meter:&mut Meter)->Result<bool> {
        if run.filter_bits==0{return Ok(true);}let(a,b)=hash(key.encode_utf16());
        if run.filter_bits>0 {
            let bits=run.filter_bits as u64;
            if let Some(filter)=&run.filter{return Ok((0..7u32).all(|k|{let bit=a.wrapping_add(k.wrapping_mul(b)) as u64%bits;filter[bit as usize/8]&(1<<(bit%8))!=0}));}
            // Read only selected bytes, grouped by stored 512KiB filter chunk.
            // Text/base64 chunks use the bounded legacy decoder, never silent
            // negatives from an unsupported representation.
            let mut chunks:BTreeMap<i64,Vec<(usize,u8)>>=BTreeMap::new();
            for k in 0..7u32{let bit=a.wrapping_add(k.wrapping_mul(b)) as u64%bits;let byte=bit as usize/8;chunks.entry(-1-(byte/(512*1024)) as i64).or_default().push((byte%(512*1024),1<<(bit%8)));}
            for (number,probes) in chunks {meter.check()?;meter.work.sql_statements+=1;
                let mut q=db.prepare(&format!("SELECT body FROM {} WHERE page=?",self.table(run.number)))?;let mut rows=q.query([number])?;let row=rows.next()?.ok_or(Error::Corrupt("kept positive filter chunk missing", crate::cause!()))?;
                let data=filter_chunk(row.get_ref(0)?,512*1024)?;meter.row(data.len())?;
                for (at,mask) in probes{if *data.get(at).ok_or(Error::Corrupt("short kept filter chunk", crate::cause!()))?&mask==0{return Ok(false);}}
            }return Ok(true);
        }
        let blocks=run.filter_bits.unsigned_abs();let block=a as u64%blocks;let number=-1-(block/64) as i64;
        if let Some(filter)=&run.filter{return blocked_has(filter,block as usize*64,b);}
        meter.check()?;meter.work.sql_statements+=1;
        let mut q=db.prepare(&format!("SELECT body FROM {} WHERE page=?",self.table(run.number)))?;let mut rows=q.query([number])?;let Some(row)=rows.next()?else{return Ok(true)};
        let data=filter_chunk(row.get_ref(0)?,4096)?;meter.row(data.len())?;let base=(block%64)as usize*64;let mut h=b;
        for _ in 0..7 {let at=(h>>23)as usize;let Some(byte)=data.get(base+at/8)else{return Ok(true)};if byte&(1<<(at&7))==0{return Ok(false);}h=(h^(h>>16)).wrapping_mul(0x85ebca6b);}
        Ok(true)
    }
    fn entry_value(&self,db:&Connection,entry:&Entry,meter:&mut Meter)->Result<Lookup>{match entry{Entry::Tomb=>Ok(Lookup::Tombstone),Entry::Text(text)=>self.parse_selected(text,meter),Entry::Big{reference,parts}=>self.big_value(db,reference,*parts,meter)}}
    fn selected(&self,db:&Connection,page:&Page,location:&Location,meter:&mut Meter)->Result<Lookup>{match location{Location::Tomb=>Ok(Lookup::Tombstone),Location::Uniform(text)=>self.parse_selected(text,meter),Location::Big{reference,parts}=>self.big_value(db,reference,*parts,meter),Location::Inline{start,end}=>{
        let text=page.text(*start,*end)?;self.parse_selected(&text,meter)
    }}}
    fn parse_selected(&self,text:&str,meter:&mut Meter)->Result<Lookup>{meter.check()?;if text.len()>self.settings.max_value_bytes||text.len()>meter.limits.output_bytes{return Err(Error::Bounds("selected kept value exceeds byte budget", crate::cause!()));}meter.work.selected_values+=1;Ok(Lookup::Value(serde_json::from_str(text)?))}
    fn big_value(&self,db:&Connection,reference:&str,parts:usize,meter:&mut Meter)->Result<Lookup>{
        if parts==0||parts>self.settings.max_value_bytes{return Err(Error::Corrupt("invalid kept multipart count", crate::cause!()));}
        meter.check()?;meter.work.sql_statements+=1;meter.work.big_values+=1;
        let mut q=db.prepare(&format!("SELECT part,body FROM {}_big WHERE ref=? ORDER BY part LIMIT ?",self.prefix))?;let mut rows=q.query(params![reference,parts as i64+1])?;let mut text=String::new();let mut seen=0;
        while let Some(row)=rows.next()? {let part:i64=row.get(0)?;if part!=seen as i64||seen>=parts{return Err(Error::Corrupt("kept multipart sequence mismatch", crate::cause!()));}let bytes=row.get_ref(1)?.as_str().map_err(|_|Error::Corrupt("kept multipart body is not text", crate::cause!()))?;meter.row(bytes.len())?;
            if bytes.len()>self.settings.max_value_bytes.saturating_sub(text.len())||bytes.len()>meter.limits.output_bytes.saturating_sub(text.len()){return Err(Error::Bounds("kept multipart selected value exceeds byte budget", crate::cause!()));}text.push_str(bytes);seen+=1;}
        if seen!=parts{return Err(Error::Corrupt("kept multipart value missing", crate::cause!()));}self.parse_selected(&text,meter)
    }
    /// Bounded ordered winners. `next` is the last fully examined key, including
    /// tombstones: an empty partial page never masquerades as end-of-range.
    pub fn range(&mut self,db:&Connection,request:Range<'_>,budget:ReadBudget)->Result<RangePage>{
        self.valid_key(request.lo)?;self.valid_key(request.hi)?;if let Some(after)=request.after{self.valid_key(after)?;}
        if request.limit==0||request.limit>4096||budget.entries==0||budget.output_bytes<2{return Err(Error::Bounds("kept result/entry/output limits must allow progress", crate::cause!()));}
        let lo=Key::new(request.lo);let hi=Key::new(request.hi);if lo>=hi{return Err(Error::Bounds("kept range must have increasing bounds", crate::cause!()));}
        let after=request.after.map(Key::new);let mut meter=Meter::new(budget);
        let mem:Vec<(Key,Entry)>=self.mem.range((Bound::Included(lo.clone()),Bound::Excluded(hi.clone()))).filter(|(k,_)|after.as_ref().is_none_or(|a|if request.reverse{*k<a}else{*k>a})).map(|(k,e)|(k.clone(),e.clone())).collect();
        let mut mem_at=if request.reverse{mem.len().checked_sub(1)}else if mem.is_empty(){None}else{Some(0)};
        let mut cursors=Vec::new();let mut held=0;
        for run in self.runs.clone(){if run.last<lo||run.first>=hi{continue;}
            let seek=if request.reverse{after.as_ref().unwrap_or(&hi)}else{after.as_ref().unwrap_or(&lo)};
            let (page,head)=match self.floor_seek(db,&run,seek,true,&mut meter)?{Some(found)=>found,None=>if request.reverse{continue}else{(0,self.head_page(db,&run,0,&mut meter)?)}};held+=head.bytes();
            // One head page a run (old invariant 4): a decoded page is held in about four times its bytes.
            if held>self.settings.cache_bytes.max(self.settings.page_bytes.saturating_mul(4).saturating_mul(cursors.len()+1)){return Err(Error::Bounds("kept range cursor workspace exhausted; maintenance or narrower range required", crate::cause!()));}
            let index=if request.reverse{head.heads.partition_point(|h|h.key<hi&&after.as_ref().is_none_or(|a|h.key<*a))as isize-1}else{head.heads.partition_point(|h|h.key<lo||after.as_ref().is_some_and(|a|h.key<=*a))as isize};
            cursors.push(Cursor{run,page,index,head,reverse:request.reverse});
        }
        let mut entries=Vec::new();let mut bytes=2usize;let mut last=None;let mut complete=false;
        loop{
            meter.check()?;
            for cursor in &mut cursors{self.settle(db,cursor,&lo,&hi,&mut meter)?;}
            if cursors.iter().map(|c|c.head.bytes()).sum::<usize>()>self.settings.cache_bytes.max(self.settings.page_bytes.saturating_mul(4).saturating_mul(cursors.len().max(1))){return Err(Error::Bounds("kept range cursor workspace exhausted", crate::cause!()));}
            let mut winner=mem_at.map(|n|(mem[n].0.clone(),None));
            for (at,cursor) in cursors.iter().enumerate(){if let Some(head)=cursor.current(){if winner.as_ref().is_none_or(|(k,_)|if request.reverse{head.key>*k}else{head.key<*k}){winner=Some((head.key.clone(),Some(at)));}}}
            let Some((key,source))=winner else{complete=true;break;};
            if entries.len()>=request.limit||meter.work.entries_examined as usize>=meter.limits.entries{break;}
            // All cursors are newest-first. Equal keys never replace the first
            // chosen winner; discard their heads WITHOUT opening their values.
            let entry=if let Some(at)=source{let c=&cursors[at];let location=c.current().unwrap().entry.clone();
                match location{Location::Tomb=>Entry::Tomb,Location::Big{reference,parts}=>Entry::Big{reference,parts},_=>{
                    let page=self.page(db,&c.run,c.page,&mut meter)?;let at=page.heads.binary_search_by(|h|h.key.cmp(&key)).map_err(|_|Error::Corrupt("kept head/value identity mismatch", crate::cause!()))?;
                    match &page.heads[at].entry{Location::Uniform(s)=>Entry::Text(Arc::clone(s)),Location::Inline{start,end}=>Entry::Text(Arc::from(page.text(*start,*end)?)),_=>return Err(Error::Corrupt("kept head/value kind mismatch", crate::cause!()))}
                }}
            }else{mem[mem_at.unwrap()].1.clone()};
            let text=key.text()?;
            // Output byte accounting is exact after serialization, with no
            // truncation. An oversized first winner refuses explicitly.
            let original_output_limit=meter.limits.output_bytes;
            let value_room=original_output_limit.saturating_sub(bytes+usize::from(!entries.is_empty())+serde_json::to_string(&text)?.len()+3);
            if matches!(&entry,Entry::Text(text) if text.len()>value_room)&&!entries.is_empty(){break;}
            meter.limits.output_bytes=value_room;
            let selected=self.entry_value(db,&entry,&mut meter);
            meter.limits.output_bytes=original_output_limit;
            let selected=match selected{Err(Error::Bounds("kept multipart selected value exceeds byte budget", _))|Err(Error::Bounds("selected kept value exceeds byte budget", _)) if !entries.is_empty()=>break,other=>other?};
            let value=match selected{Lookup::Value(value)=>Some(value),Lookup::Tombstone=>None,Lookup::Absent=>return Err(Error::Corrupt("selected key became absent", crate::cause!()))};
            if let Some(value)=value{
                let size=serde_json::to_vec(&(&text,&value))?.len()+usize::from(!entries.is_empty());
                if size>meter.limits.output_bytes.saturating_sub(bytes){if entries.is_empty(){return Err(Error::Bounds("one complete kept range value exceeds output budget", crate::cause!()));}break;}
                bytes+=size;entries.push((text.clone(),value));
            }
            meter.entry()?;last=Some(text);
            if mem_at.is_some_and(|n|mem[n].0==key){mem_at=if request.reverse{mem_at.unwrap().checked_sub(1)}else{let n=mem_at.unwrap()+1;if n<mem.len(){Some(n)}else{None}};}
            for cursor in &mut cursors{if cursor.current().is_some_and(|h|h.key==key){cursor.index+=if request.reverse{-1}else{1};}}
        }
        // If a selected value does not fit after earlier winners, continuation
        // stays BEFORE it. Every returned next therefore denotes real progress.
        Ok(RangePage{entries,next:if complete{None}else{last},complete,serialized_bytes:bytes,work:meter.work})
    }
    fn settle(&mut self,db:&Connection,cursor:&mut Cursor,lo:&Key,hi:&Key,meter:&mut Meter)->Result<()> {
        loop{
            if cursor.index>=0&&(cursor.index as usize)<cursor.head.heads.len(){let key=&cursor.head.heads[cursor.index as usize].key;if key>=lo&&key<hi{return Ok(());}
            if cursor.reverse&&key<lo||!cursor.reverse&&key>=hi{cursor.index= -1;cursor.page=cursor.run.pages;return Ok(());}}
            if cursor.page>=cursor.run.pages{return Ok(());}
            // Walking down past a page whose first key is at or below lo: every earlier page holds only smaller keys,
            // so the range is done without reading one (old runCursor knows the found page's fence the same way).
            if cursor.reverse&&cursor.index<0&&cursor.head.heads.first().is_some_and(|h|h.key<=*lo){cursor.index= -1;cursor.page=cursor.run.pages;return Ok(());}
            // Walking up past a page whose successor starts at or after hi: done without reading it.
            if !cursor.reverse&&self.successors.get(&(cursor.run.number,cursor.page)).is_some_and(|n|n>=hi){cursor.index= -1;cursor.page=cursor.run.pages;return Ok(());}
            let next=if cursor.reverse{cursor.page.checked_sub(1)}else{let n=cursor.page+1;if n<cursor.run.pages{Some(n)}else{None}};
            let Some(next)=next else{cursor.page=cursor.run.pages;cursor.index= -1;return Ok(());};
            cursor.page=next;cursor.head=self.head_page(db,&cursor.run,next,meter)?;cursor.index=if cursor.reverse{cursor.head.heads.len()as isize-1}else{0};
        }
    }
    fn head_page(&mut self,db:&Connection,run:&Run,number:usize,meter:&mut Meter)->Result<Arc<Page>>{
        if let Some(page)=self.resident(run.number,number){meter.work.cache_hits+=1;return Ok(page);}
        meter.check()?;meter.work.sql_statements+=1;
        let query=format!("SELECT CASE WHEN substr(body,1,1)='[' OR instr(body,char(10))=0 THEN body ELSE substr(body,1,instr(body,char(10))) END FROM {} WHERE page=?",self.table(run.number));
        let mut q=db.prepare(&query)?;let mut rows=q.query([number as i64])?;let row=rows.next()?.ok_or(Error::Corrupt("kept page head missing", crate::cause!()))?;
        let raw=row.get_ref(0)?.as_str().map_err(|_|Error::Corrupt("kept page head is not text", crate::cause!()))?;if raw.len()>self.settings.page_bytes*8{return Err(Error::Bounds("legacy kept head requires wider adapter", crate::cause!()));}meter.row(raw.len())?;
        Ok(Arc::new(decode_page(raw,&self.settings)?))
    }

    /// Publishes a bounded memtable and covered-log marker in the caller's
    /// transaction. Do not use this in autocommit. If the outer transaction
    /// rolls back, reset_after_rollback + committed-log replay is mandatory.
    pub fn flush(&mut self,tx:&Connection,covered:&Value)->Result<Flush>{
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        let marker=serde_json::to_string(covered)?;if marker.len()>64*1024{return Err(Error::Bounds("kept covered marker exceeds bound", crate::cause!()));}
        // A tombstone whose key no run may hold removes nothing; a key saved and removed between two flushes
        // (the request window's keys) never reaches a page.
        let mut entries=Vec::with_capacity(self.mem.len());
        for(key,entry)in &self.mem{if !matches!(entry,Entry::Tomb)||Self::older_may_hold(&self.runs,key)?{entries.push((key.clone(),entry.clone()));}}
        self.keep_mem_debt(tx)?;
        if entries.is_empty(){set_meta(tx,&self.prefix,"covered",&marker)?;self.clear_memtable();return Ok(Flush{run:None,pages:0,keys:0,bytes:0});}
        let number=self.next_run(tx)?;let age=self.runs.iter().map(|r|r.age).max().unwrap_or(0).checked_add(1).ok_or(Error::Bounds("kept age exhausted", crate::cause!()))?;
        let table=self.table(number);tx.execute_batch(&format!("CREATE TABLE {table}(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)"))?;
        let mut writer=Writer::new(number,age,entries.len(),self.settings.filter_bytes);
        for (key,entry) in entries{let entry=self.persist_entry(tx,entry)?;self.write_entry(tx,&mut writer,key,entry)?;}
        self.finish_page(tx,&mut writer)?;self.publish_run(tx,&writer)?;set_meta(tx,&self.prefix,"last_run",&number.to_string())?;set_meta(tx,&self.prefix,"covered",&marker)?;
        let result=Flush{run:Some(number),pages:writer.pages,keys:writer.keys,bytes:writer.bytes};self.clear_memtable();self.reload_catalog(tx)?;Ok(result)
    }
    fn next_run(&self,db:&Connection)->Result<i64>{let kept:Option<String>=db.query_row(&format!("SELECT value FROM {}_meta WHERE key='last_run'",self.prefix),[],|r|r.get(0)).optional()?;let n=kept.map(|s|serde_json::from_str::<i64>(&s)).transpose()?.unwrap_or(0).max(self.runs.iter().map(|r|r.number).max().unwrap_or(0));n.checked_add(1).ok_or(Error::Bounds("kept run identity exhausted", crate::cause!()))}
    fn persist_entry(&self,tx:&Connection,entry:Entry)->Result<Entry>{
        let Entry::Text(text)=entry else{return Ok(entry)};
        if text.len()<=self.settings.page_bytes/2{return Ok(Entry::Text(text));}
        // Each big value written gets a ref of its own (old kept-runs.mjs bigRef, :2172: `b<n>` from `big_next`), so a
        // merge that lets its version go can delete it. Refs written before as content identities (`1f:`) may be
        // shared by several versions and are never deleted.
        let next=db_meta_number(tx,&self.prefix,"big_next")?.saturating_add(1);set_meta(tx,&self.prefix,"big_next",&next.to_string())?;
        let reference=format!("b{next}");let mut at=0;let mut part=0;
        while at<text.len(){let mut end=(at+self.settings.big_part_bytes).min(text.len());while !text.is_char_boundary(end){end-=1;}if end==at{return Err(Error::Bounds("kept big part too narrow for UTF-8", crate::cause!()));}
            tx.execute(&format!("INSERT INTO {}_big(ref,part,body) VALUES(?,?,?) ON CONFLICT(ref,part) DO NOTHING",self.prefix),params![reference,part,&text[at..end]])?;
            let same:bool=tx.query_row(&format!("SELECT body=? FROM {}_big WHERE ref=? AND part=?",self.prefix),params![&text[at..end],reference,part],|r|r.get(0))?;if !same{return Err(Error::Corrupt("kept large-value identity conflict", crate::cause!()));}part+=1;at=end;}
        Ok(Entry::Big{reference,parts:part as usize})
    }
    fn write_entry(&self,tx:&Connection,writer:&mut Writer,key:Key,entry:Entry)->Result<()>{
        let cost=escape_suffix(&key.text()?).len()+entry.bytes()+128;
        if !writer.pending.is_empty()&&writer.pending_bytes+cost>self.settings.page_bytes{self.finish_page(tx,writer)?;}
        if cost>self.settings.page_bytes{return Err(Error::Bounds("kept key/value cannot fit complete page", crate::cause!()));}
        writer.pending_bytes+=cost;writer.first.get_or_insert_with(||key.clone());writer.last=Some(key.clone());if let Some(filter)=writer.filter.as_mut(){block_add(filter,writer.blocks,&key.text()?);}
        writer.pending.push((key,entry));writer.keys+=1;Ok(())
    }
    fn finish_page(&self,tx:&Connection,writer:&mut Writer)->Result<()>{
        if writer.pending.is_empty(){return Ok(());}let body=encode_page(&writer.pending)?;if body.len()>self.settings.page_bytes{return Err(Error::Bounds("encoded kept page exceeds configured page size", crate::cause!()));}
        let first=writer.pending[0].0.text()?;tx.execute(&format!("INSERT INTO {}(page,first,body) VALUES(?,?,?)",self.table(writer.number)),params![writer.pages as i64,serde_json::to_string(&first)?,body])?;
        writer.pages+=1;writer.bytes+=body.len();writer.pending.clear();writer.pending_bytes=0;Ok(())
    }
    fn publish_run(&self,tx:&Connection,writer:&Writer)->Result<()>{
        if writer.pages==0{return Ok(());}
        if let Some(filter)=&writer.filter{for (chunk,body)in filter.chunks(4096).enumerate(){tx.execute(&format!("INSERT INTO {}(page,first,body) VALUES(?,NULL,?)",self.table(writer.number)),params![-1-chunk as i64,body])?;}}
        tx.execute(&format!("INSERT INTO {}_runs(run,age,pages,keys,bytes,last,filter_bits,page_layout) VALUES(?,?,?,?,?,?,?,2)",self.prefix),params![writer.number,writer.age,writer.pages as i64,writer.keys as i64,writer.bytes as i64,serde_json::to_string(&writer.last.as_ref().unwrap().text()?)?,-(writer.blocks as i64)])?;Ok(())
    }
}
struct Cursor{run:Run,page:usize,index:isize,head:Arc<Page>,reverse:bool}
/// One run's walk: the page it is on, the spans of cold pages still to open (each with its prepared statement), the
/// open span's rows, and the page and entry it is at.
struct WalkRun<'s,'c>{run:Run,page:usize,last:usize,spans:Vec<(usize,usize,&'s mut rusqlite::Statement<'c>)>,rows:Option<rusqlite::Rows<'s>>,rows_through:Option<usize>,current:Option<Arc<Page>>,index:usize,first:bool}
impl WalkRun<'_,'_>{fn head(&self)->Option<&HeadEntry>{self.current.as_ref().and_then(|p|p.heads.get(self.index))}}
impl Cursor{fn current(&self)->Option<&HeadEntry>{if self.page>=self.run.pages||self.index<0{None}else{self.head.heads.get(self.index as usize)}}}
struct Writer{number:i64,age:i64,pages:usize,keys:usize,bytes:usize,first:Option<Key>,last:Option<Key>,pending:Vec<(Key,Entry)>,pending_bytes:usize,filter:Option<Vec<u8>>,blocks:usize}
impl Writer{fn new(number:i64,age:i64,keys:usize,filter_budget:usize)->Self{let blocks=keys.saturating_mul(10).div_ceil(512).max(1);let (filter,blocks)=if keys>0&&blocks.saturating_mul(64)<=filter_budget{(Some(vec![0;blocks*64]),blocks)}else{(None,0)};Self{number,age,pages:0,keys:0,bytes:0,first:None,last:None,pending:Vec::new(),pending_bytes:0,filter,blocks}}}
fn db_meta_number(db:&Connection,prefix:&str,key:&str)->Result<i64>{let kept:Option<String>=db.query_row(&format!("SELECT value FROM {prefix}_meta WHERE key=?"),[key],|r|r.get(0)).optional()?;Ok(kept.map(|s|serde_json::from_str::<i64>(&s)).transpose()?.unwrap_or(0))}
fn set_meta(db:&Connection,prefix:&str,key:&str,value:&str)->Result<()>{db.execute(&format!("INSERT INTO {prefix}_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),params![key,value])?;Ok(())}
fn validate_prefix(prefix:&str)->Result<()>{if prefix.is_empty()||prefix.len()>64||!prefix.as_bytes()[0].is_ascii_alphabetic()||!prefix.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'){return Err(Error::Corrupt("kept prefix must be a bounded code-owned SQL identifier", crate::cause!()));}Ok(())}
fn filter_chunk(value:rusqlite::types::ValueRef<'_>,limit:usize)->Result<Vec<u8>>{use rusqlite::types::ValueRef;match value{ValueRef::Blob(b)=>{if b.len()>limit{return Err(Error::Bounds("kept filter chunk exceeds byte bound", crate::cause!()));}Ok(b.to_vec())},ValueRef::Text(b)=>{if b.len()>limit.saturating_mul(4)/3+4{return Err(Error::Bounds("kept base64 filter exceeds bound", crate::cause!()));}let data=STANDARD.decode(b).map_err(|_|Error::Corrupt("invalid base64 kept filter", crate::cause!()))?;if data.len()>limit{return Err(Error::Bounds("decoded kept filter exceeds bound", crate::cause!()));}Ok(data)},_=>Err(Error::Corrupt("invalid kept filter body", crate::cause!()))}}
/// Canonical persisted membership geometry. Unknown descriptors admit the run.
/// Each tuple is (negative page, byte within page, mask, exact decoded row bytes).
/// Consumers read these facts through their own source/cancellation boundary.
pub(crate) fn filter_probes(key: &str, bits: i64) -> Option<Vec<(i64, usize, u8, usize)>> {
    if bits == 0 || bits == i64::MIN || (bits > 0 && bits % 8 != 0) { return None; }
    let (a, b) = hash(key.encode_utf16());
    let mut probes = Vec::with_capacity(7);
    if bits > 0 {
        let bytes = bits as u64 / 8;
        for k in 0..7u32 {
            let bit = a.wrapping_add(k.wrapping_mul(b)) as u64 % bits as u64;
            let byte = bit / 8;
            let chunk = byte / (512 * 1024);
            probes.push((-1 - chunk as i64, (byte % (512 * 1024)) as usize,
                1 << (bit % 8), (bytes - chunk * (512 * 1024)).min(512 * 1024) as usize));
        }
    } else {
        let blocks = bits.unsigned_abs();
        let block = a as u64 % blocks;
        let chunk = block / 64;
        let bytes = ((blocks - chunk * 64).min(64) * 64) as usize;
        let mut h = b;
        for _ in 0..7 {
            let at = (h >> 23) as usize;
            probes.push((-1 - chunk as i64, (block % 64) as usize * 64 + at / 8,
                1 << (at & 7), bytes));
            h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
        }
    }
    Some(probes)
}
fn hash(units:impl IntoIterator<Item=u16>)->(u32,u32){let(mut a,mut b)=(0x811c9dc5u32,0x01000193u32^0x5bd1e995);for unit in units{a=(a^unit as u32).wrapping_mul(0x01000193);b=(b^unit as u32).wrapping_mul(0x5bd1e995);b^=b>>15;}(a,b|1)}

// Persisted marker matches the canonical ordinary merge fields. A big value a
// merge lets go is queued in `big_drops` and deleted between merges (old step).
#[derive(Debug,Clone,Serialize,Deserialize)]
struct MergeState{inputs:Vec<i64>,output:i64,age:i64,drop_tombstones:bool,after:Option<String>,pages:usize,keys:usize,bytes:usize,last:Option<String>,
    /// Set when a paused merge resumes: it takes one step before a backlog group may pause it again, so steady
    /// arrivals never starve it (the original's `backlog_yielded`).
    #[serde(default,skip_serializing_if="std::ops::Not::not")] backlog_yielded:bool,
    /// A complete fold: the debt kept when it started, let go of when it finishes (a write-out during the fold keeps
    /// its own). Old kept-runs.mjs startMerge `compaction_debt_snapshot`.
    #[serde(default,skip_serializing_if="Option::is_none")] compaction_debt_snapshot:Option<usize>,
    /// A partial merge started while a fold is due: the bytes its inputs held. What its output is smaller by is the
    /// overwritten values it dropped, let go of from the debt. Old kept-runs.mjs startMerge `input_bytes`.
    #[serde(default,skip_serializing_if="Option::is_none")] input_bytes:Option<usize>}
impl KeptRuns{
    /// One write's share of merging, inside that write's transaction: resume a paused merge, let a run backlog
    /// pause a long merge, or start the merge the policy says is due, then take one step of `merge_pace` output
    /// pages per page of `debt_bytes` (the bytes the write added), times one more for each run past
    /// `merge_backlog_runs`, at most 64. Nothing due costs the meta reads of the two merge entries. Opening,
    /// flushing and reading never merge.
    pub fn maintain(&mut self,tx:&Connection,debt_bytes:usize,budget:ReadBudget)->Result<Maintained>{
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        // A write's share of upkeep also deletes up to 16 big values finished merges let go.
        self.cleanup_big_drops(tx)?;
        let mut done=Maintained::default();
        let mut state=merge_state(tx,&self.prefix,"merge")?;
        if state.is_none(){
            if let Some(mut paused)=merge_state(tx,&self.prefix,"merge_paused")?{
                paused.backlog_yielded=true;save_merge(tx,&self.prefix,"merge",&paused)?;
                tx.execute(&format!("DELETE FROM {}_meta WHERE key='merge_paused'",self.prefix),[])?;state=Some(paused);
            }
        }
        match state{
            Some(mut running)=>if running.backlog_yielded{running.backlog_yielded=false;save_merge(tx,&self.prefix,"merge",&running)?;}
                else if merge_state(tx,&self.prefix,"merge_paused")?.is_none(){
                    if let Some(group)=self.backlog_group(&running.inputs){
                        save_merge(tx,&self.prefix,"merge_paused",&running)?;
                        tx.execute(&format!("DELETE FROM {}_meta WHERE key='merge'",self.prefix),[])?;
                        self.start_merge(tx,&group)?;done.paused=true;done.started=true;
                    }
                },
            None=>{
                let Some(group)=self.next_merge()else{done.runs=self.runs.len();return Ok(done)};
                self.start_merge(tx,&group)?;done.started=true;
            }
        }
        // Pace by the write's own bytes, and by each run past the backlog bound: a store behind on merging
        // (a burst, or a pace below what the merges in flight need) takes larger steps until it is caught up.
        let behind=self.runs.len().saturating_sub(self.settings.merge_backlog_runs);
        let pages=debt_bytes.saturating_mul(self.settings.merge_pace).div_ceil(self.settings.page_bytes).max(1).saturating_mul(1+behind).min(MAX_STEP_PAGES);
        let step=self.merge_step(tx,pages,100_000,budget)?;
        done.completed=step.complete;done.pages=step.pages;done.entries=step.entries;done.runs=self.runs.len();Ok(done)
    }
    /// The merge to start next (old kept-runs.mjs nextMerge/planMerge, :2355-2441): a backlog's cheapest group first,
    /// then a complete fold when overwritten values are due, then a size-tier merge. The old space admission is not
    /// ported: this store has no database size limit to answer to.
    fn next_merge(&self)->Option<Vec<i64>>{
        self.backlog_group(&[]).or_else(||self.compaction_due().then(||self.runs.iter().map(|r|r.number).collect())).or_else(||self.tier_group())
    }
    /// Old kept-runs.mjs compactionDue (:2336).
    fn compaction_due(&self)->bool{
        let held=self.runs.iter().map(|r|r.bytes).sum::<usize>() as f64*self.settings.compaction_debt_ratio;
        (2..=MAX_MERGE_INPUTS).contains(&self.runs.len())&&self.debt>0&&self.debt as f64>=held.max(self.settings.compaction_debt_min_bytes as f64)
    }
    fn keep_mem_debt(&mut self,tx:&Connection)->Result<()>{
        if self.mem_debt==0{return Ok(());}
        let debt:Option<String>=tx.query_row(&format!("SELECT value FROM {}_meta WHERE key='compaction_debt'",self.prefix),[],|r|r.get(0)).optional()?;
        self.debt=debt.map(|s|serde_json::from_str::<usize>(&s)).transpose()?.unwrap_or(0).saturating_add(self.mem_debt);
        set_meta(tx,&self.prefix,"compaction_debt",&self.debt.to_string())?;self.mem_debt=0;Ok(())
    }
    fn set_debt(&mut self,tx:&Connection,debt:usize)->Result<()>{self.debt=debt;set_meta(tx,&self.prefix,"compaction_debt",&debt.to_string())}
    /// Whether idle work is due: a merge under way or paused, or one the policy would start (old kept-runs.mjs
    /// mergeDue, :2847; the big-value cleanup queue is not ported, see `step`).
    pub fn merge_due(&self,db:&Connection)->Result<bool>{
        Ok(merge_state(db,&self.prefix,"merge")?.is_some()||merge_state(db,&self.prefix,"merge_paused")?.is_some()||self.next_merge().is_some()||self.cleanup_pending(db)?)
    }
    /// Big values let go by finished merges, still to delete (old cleanupPending, :2624).
    fn cleanup_pending(&self,db:&Connection)->Result<bool>{
        Ok(db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {}_big_drops)",self.prefix),[],|r|r.get(0))?)
    }
    /// Deletes up to 16 queued big values (old cleanupBigDrops, :2629, BIG_CLEANUP_REFS). Only while no merge runs or
    /// waits: an unfinished merge's inputs, which still hold the versions it let go, stay readable until it finishes.
    fn cleanup_big_drops(&mut self,tx:&Connection)->Result<usize>{
        if merge_state(tx,&self.prefix,"merge")?.is_some()||merge_state(tx,&self.prefix,"merge_paused")?.is_some(){return Ok(0);}
        let refs:Vec<String>={let mut q=tx.prepare(&format!("SELECT ref FROM {}_big_drops ORDER BY ref LIMIT 16",self.prefix))?;let r=q.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;r};
        for reference in &refs{
            tx.execute(&format!("DELETE FROM {}_big WHERE ref=?",self.prefix),[reference])?;
            tx.execute(&format!("DELETE FROM {}_big_drops WHERE ref=?",self.prefix),[reference])?;
        }
        Ok(refs.len())
    }
    /// One bounded step of idle merging, at most `max_pages` output pages, in the caller's transaction (old
    /// kept-runs.mjs step, :2453). A paused merge resumes; a running one yields once to a backlog group; else the
    /// next merge starts. Between merges a step first deletes up to 16 big values finished merges let go (old
    /// cleanupBigDrops); a step that deleted some writes no page.
    pub fn step(&mut self,tx:&Connection,max_pages:usize,budget:ReadBudget)->Result<Stepped>{
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        if max_pages==0{return Err(Error::Bounds("invalid kept merge step bounds", crate::cause!()));}
        // Between merges, a step first deletes big values finished merges let go.
        if self.cleanup_big_drops(tx)?>0{return Ok(Stepped{merged:false,more:self.merge_due(tx)?,pages:0,entries:0});}
        let mut state=merge_state(tx,&self.prefix,"merge")?;
        if state.is_none(){
            if let Some(mut paused)=merge_state(tx,&self.prefix,"merge_paused")?{
                paused.backlog_yielded=true;save_merge(tx,&self.prefix,"merge",&paused)?;
                tx.execute(&format!("DELETE FROM {}_meta WHERE key='merge_paused'",self.prefix),[])?;state=Some(paused);
            }
        }
        match state{
            Some(mut running)=>if running.backlog_yielded{running.backlog_yielded=false;save_merge(tx,&self.prefix,"merge",&running)?;}
                else if merge_state(tx,&self.prefix,"merge_paused")?.is_none(){
                    if let Some(group)=self.backlog_group(&running.inputs){
                        save_merge(tx,&self.prefix,"merge_paused",&running)?;
                        tx.execute(&format!("DELETE FROM {}_meta WHERE key='merge'",self.prefix),[])?;
                        self.start_merge(tx,&group)?;
                    }
                },
            None=>{
                let Some(group)=self.next_merge()else{return Ok(Stepped::default())};
                self.start_merge(tx,&group)?;
            }
        }
        let (mut pages,mut entries)=(0usize,0usize);
        let merged=loop{
            let step=self.merge_step(tx,(max_pages-pages).min(MAX_STEP_PAGES),100_000,budget.clone())?;
            pages+=step.pages;entries+=step.entries;
            if step.complete{break true;}
            if pages>=max_pages||step.entries==0{break false;}
        };
        Ok(Stepped{merged,more:!merged||self.merge_due(tx)?,pages,entries})
    }
    /// More runs than `merge_backlog_runs`: the `fan_in` age-adjacent runs holding the fewest pages, none of them
    /// an input of `busy` (a paused merge's inputs stay adjacent to each other, so both outputs keep age order).
    fn backlog_group(&self,busy:&[i64])->Option<Vec<i64>>{
        let fan_in=self.settings.fan_in;
        if self.runs.len()<=self.settings.merge_backlog_runs.max(fan_in){return None;}
        self.runs.windows(fan_in).filter(|group|!group.iter().any(|run|busy.contains(&run.number)))
            .min_by_key(|group|group.iter().map(|run|run.pages).sum::<usize>())
            .map(|group|group.iter().map(|run|run.number).collect())
    }
    /// From the youngest run that starts one, at least `fan_in` adjacent runs of about one size: each older run holds no
    /// more than `size_ratio` times the pages of the group before it, or `tier_spread` times their average. A
    /// small write-out younger than a large run never makes the large run ride along, so a value is copied about
    /// log_fan_in(store / write-out) times in its life and merge work grows with what changed, not what is held.
    fn tier_group(&self)->Option<Vec<i64>>{
        let fan_in=self.settings.fan_in;
        (0..self.runs.len().saturating_sub(1)).find_map(|start|{
            let mut pages=self.runs[start].pages;let mut end=start+1;
            // Every adjacent run that fits the tier joins, not only the first `fan_in` (old planMerge, :2378-2382: the
            // group is returned once it holds at least max(2, fan_in)); a merge takes at most MAX_MERGE_INPUTS inputs.
            while end<self.runs.len()&&end-start<MAX_MERGE_INPUTS&&self.runs[end].pages as f64<=(self.settings.size_ratio*pages as f64).max(self.settings.tier_spread*pages as f64/(end-start) as f64){pages+=self.runs[end].pages;end+=1;}
            (end-start>=fan_in.max(2)).then(||self.runs[start..end].iter().map(|run|run.number).collect())
        })
    }
    /// Inputs must be adjacent in age. `maintain` chooses the bounded plan;
    /// opening/flushing never performs an implicit backlog merge.
    pub fn start_merge(&mut self,tx:&Connection,inputs:&[i64])->Result<()> {
        // Publication shares the caller's transaction (a transaction or a savepoint inside one), never autocommit.
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        if inputs.len()<2||inputs.len()>MAX_MERGE_INPUTS{return Err(Error::Bounds("kept merge requires 2..32 adjacent inputs", crate::cause!()));}
        if merge_state(tx,&self.prefix,"merge")?.is_some(){return Err(Error::Bounds("a kept merge is already in progress", crate::cause!()));}
        let positions:Vec<_>=inputs.iter().map(|number|self.runs.iter().position(|r|r.number==*number).ok_or(crate::cause!(Error::Stale))).collect::<Result<_>>()?;
        if positions.windows(2).any(|p|p[1]!=p[0]+1){return Err(Error::Corrupt("kept merge inputs must be newest-first and age-adjacent", crate::cause!()));}
        let output=self.next_run(tx)?;
        let input_bytes=positions.iter().map(|at|self.runs[*at].bytes).sum::<usize>();
        let (compaction_debt_snapshot,input_bytes)=if inputs.len()==self.runs.len(){(Some(self.debt),None)}else if self.compaction_due(){(None,Some(input_bytes))}else{(None,None)};
        let state=MergeState{inputs:inputs.into(),output,age:self.runs[positions[0]].age,drop_tombstones:*positions.last().unwrap()==self.runs.len()-1,after:None,pages:0,keys:0,bytes:0,last:None,backlog_yielded:false,compaction_debt_snapshot,input_bytes};
        tx.execute_batch(&format!("CREATE TABLE {}(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)",self.table(output)))?;
        set_meta(tx,&self.prefix,"last_run",&output.to_string())?;save_merge(tx,&self.prefix,"merge",&state)?;Ok(())
    }
    pub fn run_numbers(&self)->impl Iterator<Item=i64>+'_ {self.runs.iter().map(|r|r.number)}
    pub fn merge_step(&mut self,tx:&Connection,max_pages:usize,max_entries:usize,budget:ReadBudget)->Result<MergeStep>{
        // Publication shares the caller's transaction (a transaction or a savepoint inside one), never autocommit.
        if tx.is_autocommit(){return Err(crate::cause!(Error::TransactionRequired));}
        if max_pages==0||max_pages>MAX_STEP_PAGES||max_entries==0||max_entries>100_000{return Err(Error::Bounds("invalid kept merge step bounds", crate::cause!()));}
        let Some(mut state)=merge_state(tx,&self.prefix,"merge")?else{return Ok(MergeStep{complete:true,pages:0,entries:0,after:None})};
        let mut meter=Meter::new(budget);let mut cursors=Vec::new();let after=state.after.as_deref().map(Key::new);
        let oldest_input=state.inputs.iter().filter_map(|n|self.runs.iter().position(|r|r.number==*n)).max().ok_or(crate::cause!(Error::Stale))?;
        let older=self.runs[oldest_input+1..].to_vec();
        for number in &state.inputs{let run=self.runs.iter().find(|r|r.number==*number).cloned().ok_or(crate::cause!(Error::Stale))?;
            let n=if let Some(after)=&after{self.floor_page(tx,&run,after,&mut meter)?.unwrap_or(0)}else{0};let head=self.head_page(tx,&run,n,&mut meter)?;
            let index=after.as_ref().map(|a|head.heads.partition_point(|h|h.key<=*a)).unwrap_or(0)as isize;
            cursors.push(Cursor{run,page:n,index,head,reverse:false});
        }
        let mut writer=Writer::new(state.output,state.age,0,0);writer.pages=state.pages;writer.keys=state.keys;writer.bytes=state.bytes;writer.last=state.last.as_deref().map(Key::new);
        if let Some(building)=self.building_filter(&state){writer.filter=Some(building.filter);writer.blocks=building.blocks;}
        let initial_pages=state.pages;let mut examined=0;let mut complete=false;
        loop{
            for cursor in &mut cursors{self.settle_merge(tx,cursor,&mut meter)?;}
            // A merge holds one page of each run it combines (old invariant 4); a decoded page is held in about four
            // times its bytes, so the workspace is that per input, or the cache, whichever is larger.
            if cursors.iter().map(|c|c.head.bytes()).sum::<usize>()>self.settings.cache_bytes.max(self.settings.page_bytes.saturating_mul(4).saturating_mul(cursors.len().max(1))){return Err(Error::Bounds("kept merge cursor workspace exhausted", crate::cause!()));}
            let mut winner=None;
            for(at,cursor)in cursors.iter().enumerate(){if let Some(head)=cursor.current(){if winner.as_ref().is_none_or(|(_,k):&(usize,Key)|head.key<*k){winner=Some((at,head.key.clone()));}}}
            let Some((at,key))=winner else{complete=true;break;};
            if examined>=max_entries||meter.work.entries_examined as usize>=meter.limits.entries{break;}
            let cursor=&cursors[at];let location=cursor.current().unwrap().entry.clone();
            let entry=match location{Location::Tomb=>Entry::Tomb,Location::Big{reference,parts}=>Entry::Big{reference,parts},_=>{let page=self.page(tx,&cursor.run,cursor.page,&mut meter)?;let h=&page.heads[page.heads.binary_search_by(|h|h.key.cmp(&key)).map_err(|_|Error::Corrupt("kept merge head mismatch", crate::cause!()))?];match &h.entry{Location::Inline{start,end}=>Entry::Text(Arc::from(page.text(*start,*end)?)),Location::Uniform(text)=>Entry::Text(Arc::clone(text)),_=>return Err(Error::Corrupt("kept merge head/value kind changed", crate::cause!()))}}};
            // A value written inline under a larger page size moves to the big table, so every output page keeps to
            // this store's page size (old kept-runs.mjs step `spill`).
            let entry=self.persist_entry(tx,entry)?;
            if !matches!(entry,Entry::Tomb)||!state.drop_tombstones&&Self::older_may_hold(&older,&key)?{
                let cost=escape_suffix(&key.text()?).len()+entry.bytes()+128;
                if !writer.pending.is_empty()&&writer.pending_bytes+cost>self.settings.page_bytes{self.finish_page(tx,&mut writer)?;}
                if writer.pages-initial_pages>=max_pages{break;}
                self.write_entry(tx,&mut writer,key.clone(),entry)?;
            }
            meter.entry()?;examined+=1;state.after=Some(key.text()?);
            // An older version this merge lets go: its own big value is queued to leave once no merge can still read
            // it (old kept-runs.mjs step, big_drops, :2577-2600).
            for (index,cursor) in cursors.iter_mut().enumerate(){if let Some(head)=cursor.current().filter(|h|h.key==key){
                if index!=at{if let Location::Big{reference,..}=&head.entry{if !reference.starts_with("1f:"){tx.execute(&format!("INSERT OR IGNORE INTO {}_big_drops(ref) VALUES(?)",self.prefix),[reference])?;}}}
                cursor.index+=1;}}
        }
        self.finish_page(tx,&mut writer)?;
        state.pages=writer.pages;state.keys=writer.keys;state.bytes=writer.bytes;state.last=writer.last.as_ref().map(Key::text).transpose()?;
        if complete{
            // Publish new catalogue before retiring input TABLES in the same
            // transaction. No per-record delete; the big values this merge let go wait in `big_drops`.
            self.publish_run(tx,&writer)?;
            for number in &state.inputs{tx.execute(&format!("DELETE FROM {}_runs WHERE run=?",self.prefix),[number])?;tx.execute_batch(&format!("DROP TABLE {}",self.table(*number)))?;}
            if writer.pages==0{tx.execute_batch(&format!("DROP TABLE {}",self.table(state.output)))?;}
            tx.execute(&format!("DELETE FROM {}_meta WHERE key='merge'",self.prefix),[])?;
            // Old kept-runs.mjs finishMerge (:2677-2679): a complete fold lets go of the debt it started with; a merge
            // started while a fold was due lets go of what its output is smaller than its inputs.
            let debt=merge_debt_after(self.debt,&state);
            if debt!=self.debt{self.set_debt(tx,debt)?;}
            self.reload_catalog(tx)?;
        }else{
            save_merge(tx,&self.prefix,"merge",&state)?;
            // At most one running and one paused merge exist, so the two newest filters are all that can be used.
            if let Some(filter)=writer.filter.take(){if self.building.len()>=2{self.building.remove(0);}self.building.push(Building{output:state.output,inputs:state.inputs.clone(),filter,blocks:writer.blocks});}
        }
        Ok(MergeStep{complete,pages:writer.pages-initial_pages,entries:examined,after:state.after})
    }
    /// The output filter for this merge's next step: the one its earlier steps filled, or a new one when the merge
    /// has written nothing yet and its inputs' keys fit the filter bytes left.
    fn building_filter(&mut self,state:&MergeState)->Option<Building>{
        let at=self.building.iter().position(|b|b.output==state.output&&b.inputs==state.inputs);
        if let Some(at)=at{return Some(self.building.swap_remove(at));}
        if state.pages!=0||state.after.is_some(){return None;}
        let keys=self.runs.iter().filter(|r|state.inputs.contains(&r.number)).map(|r|r.keys).sum::<usize>();
        let resident=self.runs.iter().filter_map(|r|r.filter.as_ref()).map(|f|f.len()).sum::<usize>()+self.building.iter().map(|b|b.filter.len()).sum::<usize>();
        let writer=Writer::new(state.output,state.age,keys,self.settings.filter_bytes.saturating_sub(resident));
        writer.filter.map(|filter|Building{output:state.output,inputs:state.inputs.clone(),filter,blocks:writer.blocks})
    }
    fn settle_merge(&mut self,db:&Connection,cursor:&mut Cursor,meter:&mut Meter)->Result<()>{
        while cursor.page<cursor.run.pages&&(cursor.index<0||cursor.index as usize>=cursor.head.heads.len()){
            cursor.page+=1;if cursor.page>=cursor.run.pages{cursor.index= -1;break;}
            cursor.head=self.head_page(db,&cursor.run,cursor.page,meter)?;cursor.index=0;
        }Ok(())
    }
}
fn merge_state(db:&Connection,prefix:&str,slot:&str)->Result<Option<MergeState>>{let raw:Option<String>=db.query_row(&format!("SELECT value FROM {prefix}_meta WHERE key=?"),[slot],|r|r.get(0)).optional()?;raw.map(|s|{if s.len()>128*1024{return Err(Error::Bounds("kept merge marker exceeds bound", crate::cause!()));}let state:MergeState=serde_json::from_str(&s)?;if state.inputs.len()<2||state.inputs.len()>32||state.output<0||state.age<0{return Err(Error::Corrupt("invalid kept merge marker", crate::cause!()));}Ok(state)}).transpose()}
fn save_merge(db:&Connection,prefix:&str,slot:&str,state:&MergeState)->Result<()>{set_meta(db,prefix,slot,&serde_json::to_string(state)?)}
fn merge_debt_after(debt:usize,state:&MergeState)->usize{
    match(state.compaction_debt_snapshot,state.input_bytes){(Some(snapshot),_) if snapshot>0=>debt.saturating_sub(snapshot),(_,Some(input))=>debt.saturating_sub(input.saturating_sub(state.bytes)),_=>debt}
}

impl Page{
    fn text(&self,start:usize,end:usize)->Result<String>{
        if self.legacy{return self.body.get(start..end).map(String::from).ok_or(Error::Corrupt("invalid legacy kept value span", crate::cause!()));}
        let tail=self.body.get(self.base..).ok_or(Error::Corrupt("invalid kept body base", crate::cause!()))?;
        let mut units=0usize;let mut from=None;let mut through=None;
        for(at,ch)in tail.char_indices(){if units==start{from=Some(at);}
        if units==end{through=Some(at);break;}units+=ch.len_utf16();}
        if units==start&&from.is_none(){from=Some(tail.len());}
        if units==end&&through.is_none(){through=Some(tail.len());}
        let(from,through)=(from.ok_or(Error::Corrupt("kept UTF-16 start splits a character", crate::cause!()))?,through.ok_or(Error::Corrupt("kept UTF-16 end splits a character", crate::cause!()))?);
        let mut text=String::with_capacity(self.common.len()+through.saturating_sub(from));text.push_str(&self.common);text.push_str(&tail[from..through]);Ok(text)
    }
}
fn decode_page(raw:&str,settings:&Settings)->Result<Page>{
    if raw.starts_with('['){return decode_legacy(raw,settings);}
    let end=raw.find('\n').ok_or(Error::Corrupt("kept packed page has no header newline", crate::cause!()))?;
    let(head,suffixes):(Value,Vec<String>)=if let Some(rest)=raw[..end].strip_prefix('~'){
        let at=rest.find('\u{2}').ok_or(Error::Corrupt("kept layout2 lacks suffix separator", crate::cause!()))?;
        let suffix=if at+1==rest.len(){Vec::new()}else{rest[at+1..].split('\u{3}').map(unescape_suffix).collect::<Result<Vec<_>>>()?};(serde_json::from_str(&rest[..at])?,suffix)
    }else{let head:Value=serde_json::from_str(&raw[..end])?;let suffix=head.get("s").and_then(Value::as_array).ok_or(Error::Corrupt("kept layout1 suffix array missing", crate::cause!()))?.iter().map(|v|v.as_str().map(String::from).ok_or(Error::Corrupt("kept suffix must be text", crate::cause!()))).collect::<Result<Vec<_>>>()?;(head,suffix)};
    if suffixes.len()>settings.page_bytes{return Err(Error::Bounds("kept page entry count exceeds bound", crate::cause!()));}
    let prefixes=prefixes(&head,suffixes.len())?;
    let mut keys=Vec::with_capacity(suffixes.len());let mut previous=Vec::<u16>::new();
    for(index,suffix)in suffixes.iter().enumerate(){let shared=prefixes[index];if shared>previous.len(){return Err(Error::Corrupt("kept prefix exceeds preceding key", crate::cause!()));}let mut key=previous[..shared].to_vec();key.extend(suffix.encode_utf16());if key.len()*2>settings.max_key_bytes*2{return Err(Error::Bounds("decoded kept key exceeds bound", crate::cause!()));}
    if keys.last().is_some_and(|k:&Key|k.0>=key){return Err(Error::Corrupt("kept page keys are not strictly sorted", crate::cause!()));}previous=key.clone();keys.push(Key(key));}
    let uniform=head.get("v").map(|v|v.as_str().map(Arc::<str>::from).ok_or(Error::Corrupt("uniform kept JSON text missing", crate::cause!()))).transpose()?;
    let common:Arc<str>=Arc::from(head.get("c").and_then(Value::as_str).unwrap_or(""));
    let mut offsets=Vec::with_capacity(keys.len()+1);
    if uniform.is_none(){
        if let Some(array)=head.get("o").and_then(Value::as_array){for v in array{offsets.push(number(v)?);}}
        else if let Some(array)=head.get("d").and_then(Value::as_array){offsets.push(0usize);for v in array{offsets.push(offsets.last().unwrap().checked_add(number(v)?).ok_or(Error::Corrupt("kept offsets overflow", crate::cause!()))?);}}
        else{return Err(Error::Corrupt("kept value offsets missing", crate::cause!()));}
        if offsets.len()!=keys.len()+1||offsets.first()!=Some(&0)||offsets.windows(2).any(|w|w[0]>w[1]){return Err(Error::Corrupt("invalid kept value offsets", crate::cause!()));}
        // Header-only range cursors deliberately omit the value tail. A full
        // page validates exact UTF-16 extent before exposing a selected slice.
        if raw.len()>end+1&&offsets.last().copied()!=Some(raw[end+1..].encode_utf16().count()){return Err(Error::Corrupt("kept body/offset extent mismatch", crate::cause!()));}
    }
    let bigs=head.get("b").and_then(Value::as_object);let mut heads=Vec::with_capacity(keys.len());
    for(index,key)in keys.into_iter().enumerate(){let entry=if let Some(text)=&uniform{Location::Uniform(Arc::clone(text))}else if let Some(big)=bigs.and_then(|b|b.get(&index.to_string())){
        let pair=big.as_array().ok_or(Error::Corrupt("invalid kept big reference", crate::cause!()))?;if pair.len()!=2{return Err(Error::Corrupt("invalid kept big reference", crate::cause!()));}let reference=pair[0].as_str().ok_or(Error::Corrupt("invalid kept big reference ID", crate::cause!()))?;if reference.len()>4096{return Err(Error::Bounds("kept big reference ID exceeds bound", crate::cause!()));}Location::Big{reference:reference.into(),parts:number(&pair[1])?}
    }else if offsets[index]==offsets[index+1]{Location::Tomb}else{Location::Inline{start:offsets[index],end:offsets[index+1]}};heads.push(HeadEntry{key,entry});}
    Ok(Page{heads,body:Arc::from(raw),common,base:end+1,legacy:false})
}
fn number(v:&Value)->Result<usize>{let n=v.as_u64().ok_or(Error::Corrupt("kept header integer is invalid", crate::cause!()))?;usize::try_from(n).map_err(|_|Error::Corrupt("kept integer is out of range", crate::cause!()))}
fn prefixes(head:&Value,count:usize)->Result<Vec<usize>>{
    let result=if let Some(text)=head.get("ps").and_then(Value::as_str){text.chars().map(|c|(c as usize).checked_sub(0x23).ok_or(Error::Corrupt("invalid packed kept prefix", crate::cause!()))).collect::<Result<Vec<_>>>()?}
    else if let Some(array)=head.get("p").and_then(Value::as_array){array.iter().map(number).collect::<Result<Vec<_>>>()?}
    else if let Some(array)=head.get("q").and_then(Value::as_array){let mut result=Vec::with_capacity(count);for row in array{let pair=row.as_array().ok_or(Error::Corrupt("invalid repeated kept prefix", crate::cause!()))?;if pair.len()!=2{return Err(Error::Corrupt("invalid repeated kept prefix", crate::cause!()));}let length=number(&pair[0])?;let times=number(&pair[1])?;if times>count.saturating_sub(result.len()){return Err(Error::Bounds("kept prefix expansion exceeds entry count", crate::cause!()));}result.extend(std::iter::repeat_n(length,times));}result}
    else{return Err(Error::Corrupt("kept prefixes missing", crate::cause!()));};if result.len()!=count{return Err(Error::Corrupt("kept prefix count mismatch", crate::cause!()));}Ok(result)
}
fn unescape_suffix(text:&str)->Result<String>{let mut out=String::new();let mut chars=text.chars();while let Some(c)=chars.next(){if c!='\u{1}'{out.push(c);continue;}match chars.next(){Some('0')=>out.push('\0'),Some('1')=>out.push('\u{1}'),Some('2')=>out.push('\u{2}'),Some('3')=>out.push('\u{3}'),Some('n')=>out.push('\n'),Some('u')=>{let hex:String=chars.by_ref().take(4).collect();if hex.len()!=4{return Err(Error::Corrupt("short kept suffix Unicode escape", crate::cause!()));}let unit=u16::from_str_radix(&hex,16).map_err(|_|Error::Corrupt("invalid kept suffix Unicode escape", crate::cause!()))?;let ch=char::from_u32(unit as u32).ok_or(Error::Unsupported("lone-surrogate kept suffix requires lossless adapter", crate::cause!()))?;out.push(ch);},_=>return Err(Error::Corrupt("invalid kept suffix escape", crate::cause!()))}}Ok(out)}
fn escape_suffix(text:&str)->String{let mut out=String::new();for c in text.chars(){match c{'\0'=>out.push_str("\u{1}0"),'\u{1}'=>out.push_str("\u{1}1"),'\u{2}'=>out.push_str("\u{1}2"),'\u{3}'=>out.push_str("\u{1}3"),'\n'=>out.push_str("\u{1}n"),_=>out.push(c)}}out}
fn encode_page(entries:&[(Key,Entry)])->Result<String>{
    let mut prefixes=Vec::with_capacity(entries.len());let mut suffixes=Vec::with_capacity(entries.len());let mut lengths=Vec::with_capacity(entries.len());let mut bigs=serde_json::Map::new();let mut values=String::new();let mut previous:Vec<u16>=Vec::new();
    for(index,(key,entry))in entries.iter().enumerate(){let mut shared=previous.iter().zip(&key.0).take_while(|(a,b)|a==b).count();if shared>0&&shared<key.0.len()&&(key.0[shared]&0xfc00)==0xdc00{shared-=1;}let suffix=String::from_utf16(&key.0[shared..]).map_err(|_|Error::Unsupported("lone-surrogate key requires lossless adapter", crate::cause!()))?;prefixes.push(shared);suffixes.push(escape_suffix(&suffix));previous=key.0.clone();
        match entry{Entry::Tomb=>lengths.push(0),Entry::Text(text)=>{lengths.push(text.encode_utf16().count());values.push_str(text);},Entry::Big{reference,parts}=>{lengths.push(0);bigs.insert(index.to_string(),json!([reference,parts]));}}
    }
    Ok(format!("~{}\u{2}{}\n{}",serde_json::to_string(&json!({"p":prefixes,"d":lengths,"b":bigs}))?,suffixes.join("\u{3}"),values))
}
// Legacy list pages lack a metadata/value split. Scan JSON spans but parse only
// keys and BIG references; unselected inline JSON is never deserialized.
fn decode_legacy(raw:&str,settings:&Settings)->Result<Page>{
    let bytes=raw.as_bytes();let mut at=1;let mut heads=Vec::new();skip_ws(bytes,&mut at);
    while bytes.get(at)!=Some(&b']'){
        if heads.len()>settings.page_bytes{return Err(Error::Bounds("legacy kept entry count exceeds bound", crate::cause!()));}
        expect(bytes,&mut at,b'[')?;skip_ws(bytes,&mut at);let from=at;skip_json(bytes,&mut at)?;let key:String=serde_json::from_str(&raw[from..at])?;if key.len()>settings.max_key_bytes{return Err(Error::Bounds("legacy kept key exceeds bound", crate::cause!()));}skip_ws(bytes,&mut at);
        let entry=if bytes.get(at)==Some(&b']'){at+=1;Location::Tomb}else{expect(bytes,&mut at,b',')?;skip_ws(bytes,&mut at);let start=at;skip_json(bytes,&mut at)?;let end=at;skip_ws(bytes,&mut at);
            if bytes.get(at)==Some(&b','){at+=1;skip_ws(bytes,&mut at);let part_from=at;skip_json(bytes,&mut at)?;let parts=number(&serde_json::from_str::<Value>(&raw[part_from..at])?)?;let reference:String=serde_json::from_str(&raw[start..end])?;if reference.len()>4096{return Err(Error::Bounds("legacy kept big reference too long", crate::cause!()));}skip_ws(bytes,&mut at);expect(bytes,&mut at,b']')?;Location::Big{reference,parts}}
            else{expect(bytes,&mut at,b']')?;Location::Inline{start,end}}
        };
        let key=Key::new(&key);if heads.last().is_some_and(|h:&HeadEntry|h.key>=key){return Err(Error::Corrupt("legacy kept keys are not ordered", crate::cause!()));}heads.push(HeadEntry{key,entry});skip_ws(bytes,&mut at);
        if bytes.get(at)==Some(&b','){at+=1;skip_ws(bytes,&mut at);}else if bytes.get(at)!=Some(&b']'){return Err(Error::Corrupt("legacy kept entry separator invalid", crate::cause!()));}
    }
    at+=1;skip_ws(bytes,&mut at);if at!=bytes.len(){return Err(Error::Corrupt("legacy kept trailing bytes", crate::cause!()));}
    Ok(Page{heads,body:Arc::from(raw),common:Arc::from(""),base:0,legacy:true})
}
fn skip_ws(bytes:&[u8],at:&mut usize){while bytes.get(*at).is_some_and(u8::is_ascii_whitespace){*at+=1;}}
fn expect(bytes:&[u8],at:&mut usize,wanted:u8)->Result<()>{if bytes.get(*at)!=Some(&wanted){return Err(Error::Corrupt("invalid legacy kept JSON structure", crate::cause!()));}*at+=1;Ok(())}
fn skip_json(bytes:&[u8],at:&mut usize)->Result<()>{
    let start=*at;if bytes.get(start).is_none_or(|b|matches!(b,b','|b']'|b'}')){return Err(Error::Corrupt("legacy kept value is missing", crate::cause!()));}let mut stack=Vec::new();let mut string=false;let mut escape=false;
    while let Some(&c)=bytes.get(*at){if string{*at+=1;if escape{escape=false;}else if c==b'\\'{escape=true;}else if c==b'"'{string=false;if stack.is_empty(){return Ok(());}}continue;}
        if stack.is_empty()&&*at>start&&matches!(c,b','|b']'|b'}'|b' '|b'\n'|b'\r'|b'\t'){return Ok(());}
        match c{b'"'=>string=true,b'['|b'{'=>{if stack.len()>=128{return Err(Error::Bounds("legacy kept JSON nesting exceeds bound", crate::cause!()));}stack.push(c);},b']'|b'}'=>{let wanted=if c==b']'{b'['}else{b'{'};if stack.pop()!=Some(wanted){return Err(Error::Corrupt("legacy kept nesting mismatch", crate::cause!()));}*at+=1;if stack.is_empty(){return Ok(());}continue;},_=>{}}
        *at+=1;
    }if string||!stack.is_empty()||*at==start{return Err(Error::Corrupt("legacy kept value is incomplete", crate::cause!()));}Ok(())
}

fn block_add(filter:&mut[u8],blocks:usize,key:&str){let(a,mut b)=hash(key.encode_utf16());let base=(a as usize%blocks)*64;for _ in 0..7{let bit=(b>>23)as usize;filter[base+bit/8]|=1<<(bit&7);b=(b^(b>>16)).wrapping_mul(0x85ebca6b);}}

fn blocked_has(data:&[u8],base:usize,mut h:u32)->Result<bool>{for _ in 0..7{let at=(h>>23)as usize;let byte=data.get(base+at/8).ok_or(Error::Corrupt("short resident kept block filter", crate::cause!()))?;if byte&(1<<(at&7))==0{return Ok(false);}h=(h^(h>>16)).wrapping_mul(0x85ebca6b);}Ok(true)}

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;

    fn failed_execute(db: &Connection) -> Result<()> {
        db.execute("SELECT * FROM absent_refusal_fixture", [])?;
        Ok(())
    }
    fn failed_prepare(db: &Connection) -> Result<()> {
        db.prepare("SELECT * FROM another_absent_refusal_fixture")?;
        Ok(())
    }
    fn failed_json() -> Result<()> {
        let _: Value = serde_json::from_str("?")?;
        Ok(())
    }

    #[test]
    fn automatic_sql_and_json_conversion_capture_the_question_mark_site() {
        let db = Connection::open_in_memory().unwrap();
        let execute = failed_execute(&db).unwrap_err();
        let prepare = failed_prepare(&db).unwrap_err();
        let json = failed_json().unwrap_err();
        assert!(matches!(execute, Error::Sql(_, _)));
        assert!(matches!(prepare, Error::Sql(_, _)));
        assert!(matches!(json, Error::Json(_, _)));
        assert_ne!(execute.cause(), prepare.cause());
        assert_ne!(execute.cause(), json.cause());
        assert_eq!(execute.cause(), failed_execute(&db).unwrap_err().cause());
        let source = include_str!("kept_runs.rs");
        let line = |text: &str| (source.lines().position(|line| line.contains(text)).unwrap() + 1) as u32;
        assert_eq!(execute.cause().line(), line("db.execute(\"SELECT * FROM absent_refusal_fixture\", [])?;"));
        assert_eq!(prepare.cause().line(), line("db.prepare(\"SELECT * FROM another_absent_refusal_fixture\")?;"));
        assert_eq!(json.cause().line(), line("let _: Value = serde_json::from_str(\"?\")?;"));
        assert_eq!(execute.cause().file(), "src/kept_runs.rs");
        let factory = source.find(concat!("crate::cause!(", "caller_site: Self::Sql)")).unwrap();
        let prefix = &source[..factory];
        let factory_line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let factory_column = prefix.rsplit('\n').next().unwrap().chars().count() + 1;
        assert_eq!(execute.cause().condition(), format!("Self::Sql via {}:{factory_line}:{factory_column}",
            module_path!().strip_suffix("::refusal_cause_tests").unwrap()));
        assert!(!execute.cause().id().contains("absent_refusal_fixture"));
    }
}
