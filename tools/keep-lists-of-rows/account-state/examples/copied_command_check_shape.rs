//! Metadata-only physical diagnostic on disposable APFS clones. System SQLite
//! is deliberately identified: this is not a product or copied-HTTP pass.
use std::{ffi::{CStr, CString, c_char, c_int, c_void}, fs, os::unix::{ffi::OsStrExt, fs::{MetadataExt, PermissionsExt}}, path::{Path, PathBuf}, time::{Duration, Instant}};
use serde_json::{json, Value};
#[cfg(feature="meter")]
#[path="../src/scan.rs"] mod scan;
#[cfg(feature="meter")]
#[path="../src/sqlite_work.rs"] mod sqlite_work;
#[cfg_attr(not(feature="bundled"), link(name="sqlite3"))]
unsafe extern "C" {
    fn sqlite3_open_v2(p:*const c_char, db:*mut *mut c_void, flags:c_int, vfs:*const c_char)->c_int;
    fn sqlite3_close(db:*mut c_void)->c_int;
    fn sqlite3_prepare_v2(db:*mut c_void, sql:*const c_char, n:c_int, s:*mut *mut c_void, tail:*mut *const c_char)->c_int;
    fn sqlite3_step(s:*mut c_void)->c_int;
    fn sqlite3_finalize(s:*mut c_void)->c_int;
    fn sqlite3_column_text(s:*mut c_void, col:c_int)->*const u8;
    fn sqlite3_column_int64(s:*mut c_void, col:c_int)->i64;
    fn sqlite3_bind_text(s:*mut c_void, col:c_int, text:*const c_char, len:c_int, destructor:*const c_void)->c_int;
    fn sqlite3_bind_int64(s:*mut c_void, col:c_int, value:i64)->c_int;
    fn sqlite3_progress_handler(db:*mut c_void, n:c_int, cb:Option<unsafe extern "C" fn(*mut c_void)->c_int>, data:*mut c_void);
    fn sqlite3_libversion()->*const c_char;
    #[cfg(feature="no-close-checkpoint")]
    fn sqlite3_db_config(db:*mut c_void, option:c_int, ...) -> c_int;
}
#[cfg(target_os = "macos")]
unsafe extern "C" { fn clonefile(a:*const c_char,b:*const c_char,flags:c_int)->c_int; }
struct Budget { end:Instant, steps:u64, cause:&'static str }
unsafe extern "C" fn progress(p:*mut c_void)->c_int {
    let b=unsafe { &mut *(p as *mut Budget) }; b.steps+=1000;
    if b.steps>=2_000_000 { b.cause="work"; 1 }
    else if Instant::now()>=b.end { b.cause="deadline"; 1 } else { 0 }
}
fn pin(p:&Path)->Option<(u64,u64,u64,i64,i64)> { fs::metadata(p).ok().map(|m|(m.dev(),m.ino(),m.len(),m.mtime(),m.mtime_nsec())) }
#[cfg(target_os = "macos")]
fn clone_one(a:&Path,b:&Path)->Result<(),()> {
    let a=CString::new(a.as_os_str().as_bytes()).map_err(|_|())?;
    let b=CString::new(b.as_os_str().as_bytes()).map_err(|_|())?;
    if unsafe {clonefile(a.as_ptr(),b.as_ptr(),0)}!=0 {return Err(())} Ok(())
}
#[cfg(not(target_os = "macos"))]
fn clone_one(_: &Path, _: &Path) -> Result<(), ()> {
    eprintln!("the APFS copy-on-write diagnostic requires macOS");
    Err(())
}
fn query(db:*mut c_void, sql:&str, explain:bool, state:Option<&str>)->(i32,Option<i64>,Value) {
    let sql=CString::new(sql).unwrap(); let mut s=std::ptr::null_mut();
    let mut rc=unsafe {sqlite3_prepare_v2(db,sql.as_ptr(),-1,&mut s,std::ptr::null_mut())};
    let mut scalar=None; let(mut scan,mut search,mut temp)=(false,false,false);
    let binding=state.map(|v|CString::new(v).unwrap());
    if rc==0 {if let Some(v)=&binding {unsafe{sqlite3_bind_text(s,1,v.as_ptr(),-1,std::ptr::null());sqlite3_bind_text(s,2,v.as_ptr(),-1,std::ptr::null());sqlite3_bind_int64(s,3,1);}}}
    if rc==0 { loop { rc=unsafe {sqlite3_step(s)};
        if rc!=100 {break}
        if explain {let p=unsafe {sqlite3_column_text(s,3)}; if !p.is_null() {
            let text=unsafe {CStr::from_ptr(p as *const c_char)}.to_string_lossy();
            scan|=text.contains("SCAN resource_behavior_commands"); search|=text.contains("SEARCH resource_behavior_commands"); temp|=text.contains("TEMP B-TREE");
        }} else {scalar=Some(unsafe {sqlite3_column_int64(s,0)});}
    }}
    if !s.is_null() {unsafe {sqlite3_finalize(s)};}
    (rc,scalar,json!({"journal_scan":scan,"journal_search":search,"temp_btree":temp}))
}
struct SourceGuard { source:PathBuf, wal:PathBuf, before:Option<(u64,u64,u64,i64,i64)>, before_wal:Option<(u64,u64,u64,i64,i64)> }
impl Drop for SourceGuard { fn drop(&mut self) {println!("check-physical-source {}",json!({"database_metadata_unchanged":pin(&self.source)==self.before,"wal_metadata_unchanged":pin(&self.wal)==self.before_wal,"contents_hashed":false}));} }
fn run()->Result<(),()> {
    let descriptor=PathBuf::from(std::env::var_os("TRILLION_HEAD_LIFECYCLE_INPUT").ok_or(())?);
    if fs::metadata(&descriptor).map_err(|_|())?.permissions().mode()&0o777!=0o600 {return Err(())}
    let config:Value=serde_json::from_slice(&fs::read(descriptor).map_err(|_|())?).map_err(|_|())?;
    let source=fs::canonicalize(config["database"].as_str().ok_or(())?).map_err(|_|())?;
    let wal=PathBuf::from(format!("{}-wal",source.display()));
    let _guard=SourceGuard{before:pin(&source),before_wal:pin(&wal),source:source.clone(),wal:wal.clone()};
    println!("check-physical-provider {}",json!({"provider":if cfg!(feature="bundled"){"cached-bundled-sqlite"}else{"system-sqlite"},"version":unsafe{CStr::from_ptr(sqlite3_libversion())}.to_string_lossy(),"product_pass":false,"wall_seconds":5,"vm_steps":2_000_000}));
    let shapes=[("original_exists",vec![("SELECT EXISTS(SELECT 1 FROM resource_behavior_commands WHERE state IN ('working','unknown') AND result IS NOT NULL LIMIT 1)".to_owned(),None)]),
        ("typed_two_counts",["working","unknown"].iter().map(|state|("SELECT count(*) FROM (SELECT 1 FROM \"resource_behavior_commands\" WHERE (\"resource_behavior_commands\".\"state\")>= (?1) AND (\"resource_behavior_commands\".\"state\")<=(?2) AND \"resource_behavior_commands\".\"result\" IS NOT NULL LIMIT ?3)".to_owned(),Some(*state))).collect())];
    for (shape,queries) in shapes {
        let root=PathBuf::from(format!(".local/copied-decisions-full-router-20261028/physical-fence-{}-{shape}",std::process::id()));
        fs::create_dir(&root).map_err(|_|())?;fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).map_err(|_|())?;
        let target=root.join("records.sqlite"); let target_wal=root.join("records.sqlite-wal");
        clone_one(&source,&target)?; if wal.exists(){clone_one(&wal,&target_wal)?;}
        let start=Instant::now(); let mut db=std::ptr::null_mut(); let c=CString::new(target.as_os_str().as_bytes()).map_err(|_|())?;
        let rc=unsafe{sqlite3_open_v2(c.as_ptr(),&mut db,2|0x8000|0x1000000,std::ptr::null())};
        println!("check-physical-stage {}",json!({"shape":shape,"stage":"open","rc":rc,"elapsed_us":start.elapsed().as_micros()}));
        if rc!=0{return Err(())}
        #[cfg(feature="no-close-checkpoint")]
        {
            // Cached SQLite 3.46 header documents 1006 as NO_CKPT_ON_CLOSE.
            // This disposable-copy comparison changes no production policy.
            let mut enabled=0;
            let rc=unsafe{sqlite3_db_config(db,1006,1,&mut enabled as *mut c_int)};
            println!("check-physical-close-policy {}",json!({"shape":shape,"rc":rc,"skip_close_checkpoint":enabled==1,"production_changed":false}));
            if rc!=0||enabled!=1{return Err(())}
        }
        #[cfg(feature="meter")]
        let meter=sqlite_work::WorkMeter::default();
        #[cfg(feature="meter")]
        let observed=unsafe {sqlite_work::ObservedConnection::attach_untraced(rusqlite::Connection::from_handle_owned(db.cast()).map_err(|_|())?,meter.clone()).map_err(|_|())?};
        let mut budget=Budget{end:start+Duration::from_secs(5),steps:0,cause:"none"};
        unsafe{sqlite3_progress_handler(db,1000,Some(progress),&mut budget as *mut _ as *mut c_void)};
        for (stage,sql) in [("begin","BEGIN IMMEDIATE"),("schema_presence","SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='resource_behavior_commands')")] {
            let t=Instant::now(); let (rc,_,_)=query(db,sql,false,None);
            println!("check-physical-stage {}",json!({"shape":shape,"stage":stage,"rc":rc,"stage_us":t.elapsed().as_micros(),"elapsed_us":start.elapsed().as_micros(),"steps":budget.steps,"interrupt":budget.cause}));
            if rc!=101{break}
        }
        for (i,(sql,state)) in queries.iter().enumerate(){let(rc,_,plan)=query(db,&format!("EXPLAIN QUERY PLAN {sql}"),true,*state);println!("check-physical-plan {}",json!({"shape":shape,"query":i,"rc":rc,"plan":plan}));}
        for (i,(sql,state)) in queries.iter().enumerate() {
            let t=Instant::now();let(rc,value,_)=query(db,sql,false,*state);
            println!("check-physical-stage {}",json!({"shape":shape,"stage":"query","query":i,"rc":rc,"pending":value.map(|v|v!=0),"stage_us":t.elapsed().as_micros(),"elapsed_us":start.elapsed().as_micros(),"steps":budget.steps,"interrupt":budget.cause}));
            if rc!=101||value.is_some_and(|v|v!=0){break}
        }
        let t=Instant::now();let(rc,_,_)=query(db,"ROLLBACK",false,None);
        println!("check-physical-stage {}",json!({"shape":shape,"stage":"rollback","rc":rc,"stage_us":t.elapsed().as_micros()}));
        #[cfg(feature="meter")]
        println!("check-physical-meter {}",json!({"shape":shape,"meter_attached":true,"snapshot_complete":meter.snapshot().is_ok()}));
        let t=Instant::now();
        #[cfg(not(feature="meter"))]
        let rc=unsafe{sqlite3_close(db)};
        #[cfg(feature="meter")]
        let rc={drop(observed);0};
        println!("check-physical-stage {}",json!({"shape":shape,"stage":"close","rc":rc,"stage_us":t.elapsed().as_micros(),"elapsed_us":start.elapsed().as_micros()}));
        fs::remove_dir_all(root).map_err(|_|())?;
    }
    Ok(())
}
fn main(){if run().is_err(){eprintln!("fence-physical-refused");std::process::exit(1)}}
