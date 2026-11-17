//! Content-free source identity, preserved through conversions and durable replies.
//! Local construction uses compiler-provided static source text. A decoded
//! identity owns validated source coordinates, so replay retains the original
//! condition without leaking memory or inventing a new local origin.
use std::borrow::Cow;

#[derive(Clone)]
pub struct Cause { inner: CauseInner }
#[derive(Clone)]
enum CauseInner { Static(&'static Site), Owned(std::sync::Arc<OwnedSite>) }

/// Compiler-owned site data. Construction is confined to this module's macros.
#[doc(hidden)]
pub struct Site {
    module: &'static str,
    file: &'static str,
    line: u32,
    column: u32,
    condition: &'static str,
    release: &'static str,
    normalized_file: std::sync::OnceLock<Cow<'static, str>>,
}
const fn release_label() -> &'static str {
    match option_env!("TRILLION_RELEASE_COMMIT") {
        Some(value) => { let bytes = value.as_bytes(); if bytes.len() == 7 && bytes[0] == b'u' && bytes[1] == b'n' && bytes[2] == b'k' && bytes[3] == b'n' && bytes[4] == b'o' && bytes[5] == b'w' && bytes[6] == b'n' { "" } else { value } },
        None => "",
    }
}
impl Site {
    #[doc(hidden)]
    pub const fn __site(module: &'static str, file: &'static str, line: u32, column: u32, condition: &'static str) -> Self {
        Self { module, file, line, column, condition,
            release: release_label(),
            normalized_file: std::sync::OnceLock::new() }
    }
    fn file(&self) -> &str { self.normalized_file.get_or_init(|| source_file(self.file)).as_ref() }
}
struct OwnedSite {
    module: Cow<'static, str>, file: Cow<'static, str>, line: u32, column: u32,
    condition: Cow<'static, str>, release: Cow<'static, str>, retry: Retry,
}
/// The named values of one refusal occurrence, for the log only. A `Cause` holds source coordinates and compile-time tokens;
/// what a run found out (a tool id, a file, an OS error) is a fact of that one occurrence, so it lives in a `Facts` beside
/// the cause, in the value of the refusal that made it, and is never part of the cause's identity, its wire form or any
/// answer. Each refusal code declares its fact names in its words file (`facts`), and the cause gate (`cause_gate.rs`)
/// refuses a `facts!` site that fills a name its code did not declare.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts { entries: Vec<(&'static str, String)> }
impl Facts {
    #[doc(hidden)]
    pub fn __given<const N: usize>(entries: [(&'static str, String); N]) -> Self { Self { entries: entries.into() } }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
    /// The value filled under `name`.
    pub fn get(&self, name: &str) -> Option<&str> { self.entries.iter().find(|(known, _)| *known == name).map(|(_, value)| value.as_str()) }
}
/// `name=value` for each fact in the order given; a value with a space, a quote or nothing in it is quoted.
impl std::fmt::Display for Facts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (at, (name, value)) in self.entries.iter().enumerate() {
            if at > 0 { f.write_str(" ")?; }
            if value.is_empty() || value.contains(|c: char| c.is_whitespace() || c == '"') { write!(f, "{name}={value:?}")?; } else { write!(f, "{name}={value}")?; }
        }
        Ok(())
    }
}
/// The facts of one refusal occurrence: `facts!(Failure::DuplicateTool; tool = id)`. The path names the refusal variant whose
/// code declares the names; the gate reads it, and the values are anything `Display`.
#[macro_export]
macro_rules! facts {
    ($variant:path; $($name:ident = $value:expr),+ $(,)?) => {
        $crate::refusal_cause::Facts::__given([$((stringify!($name), ($value).to_string())),+])
    };
}

/// How a failure may be retried, carried with its cause through every conversion (`carry_cause!`): `Busy` is a lock another
/// connection held, so the operation did not start and a retry is safe; `Other` is everything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry { Other, Busy }
impl Cause {
    #[doc(hidden)]
    pub fn __site(module: &'static str, file: &'static str, line: u32, column: u32, condition: &'static str) -> Self {
        Self { inner: CauseInner::Owned(std::sync::Arc::new(OwnedSite { retry: Retry::Other,
            module: Cow::Borrowed(module), file: source_file(file), line, column, condition: Cow::Borrowed(condition),
            release: Cow::Borrowed(option_env!("TRILLION_RELEASE_COMMIT").filter(|release| *release != "unknown").unwrap_or("")) })) }
    }
    #[doc(hidden)]
    pub const fn __from_site(site: &'static Site) -> Self { Self { inner: CauseInner::Static(site) } }
    #[doc(hidden)]
    /// A cause at the caller's site whose condition is `detail` (text made at run time, e.g. a foreign error's message).
    #[doc(hidden)]
    #[track_caller]
    pub fn __caller_detail(module: &'static str, detail: String) -> Self {
        let site = std::panic::Location::caller();
        Self { inner: CauseInner::Owned(std::sync::Arc::new(OwnedSite { retry: Retry::Other,
            module: Cow::Borrowed(module), file: source_file(site.file()), line: site.line(), column: site.column(),
            condition: Cow::Owned(detail),
            release: Cow::Borrowed(option_env!("TRILLION_RELEASE_COMMIT").filter(|release| *release != "unknown").unwrap_or("")) })) }
    }
    #[doc(hidden)]
    #[track_caller]
    pub fn __caller(module: &'static str, condition: &'static str) -> Self {
        let site = std::panic::Location::caller();
        Self::__site(module, site.file(), site.line(), site.column(), condition)
    }
    #[track_caller]
    pub fn from_caller() -> Self { Self::__caller("caller", "refusal") }
    pub fn id(&self) -> String { self.to_string() }
    /// This failure's retry class: `Busy` only when it was made by `with_retry(Retry::Busy)` at its source.
    pub fn retry(&self) -> Retry { match &self.inner { CauseInner::Static(_) => Retry::Other, CauseInner::Owned(site) => site.retry } }
    /// This cause with retry class `retry`; its identity (`id`, equality) is unchanged.
    pub fn with_retry(&self, retry: Retry) -> Self {
        Self { inner: CauseInner::Owned(std::sync::Arc::new(OwnedSite {
            module: Cow::Owned(self.module().to_owned()), file: Cow::Owned(self.file().to_owned()), line: self.line(), column: self.column(),
            condition: Cow::Owned(self.condition().to_owned()), release: Cow::Owned(self.release().to_owned()), retry })) }
    }
    fn module(&self) -> &str { match &self.inner { CauseInner::Static(site) => site.module, CauseInner::Owned(site) => &site.module } }
    pub fn file(&self) -> &str { match &self.inner { CauseInner::Static(site) => site.file(), CauseInner::Owned(site) => &site.file } }
    pub fn line(&self) -> u32 { match &self.inner { CauseInner::Static(site) => site.line, CauseInner::Owned(site) => site.line } }
    pub fn column(&self) -> u32 { match &self.inner { CauseInner::Static(site) => site.column, CauseInner::Owned(site) => site.column } }
    pub fn condition(&self) -> &str { match &self.inner { CauseInner::Static(site) => site.condition, CauseInner::Owned(site) => &site.condition } }
    pub fn release(&self) -> &str { match &self.inner { CauseInner::Static(site) => site.release, CauseInner::Owned(site) => &site.release } }

    /// Accept source coordinates, never arbitrary messages, field values, paths,
    /// URLs, or Debug text. The authenticated engine sender constructs these
    /// only from compiler source tokens; the gate bars direct fabrication.
    pub fn from_wire(text: &str) -> Option<Self> {
        if text.len() > wire_bytes() || !text.is_ascii() || text.bytes().any(|b| b.is_ascii_control()) { return None; }
        let (text, release) = text.rsplit_once('#').unwrap_or((text, ""));
        if !release.is_empty() && release != "unknown" && (release.len() != 40 || !release.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) { return None; }
        let (module, rest) = text.split_once('@')?;
        if module.is_empty() || !module.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b':') { return None; }
        let mut fields = rest.splitn(4, ':');
        let file = fields.next()?;
        if !["src/", "tests/", "examples/", "crates/"].iter().any(|prefix| file.starts_with(prefix))
            || file.contains("..") || !file.ends_with(".rs")
            || !file.bytes().all(|b| b.is_ascii_alphanumeric() || b"_/.-".contains(&b)) { return None; }
        let line = fields.next()?.parse::<u32>().ok()?;
        let column = fields.next()?.parse::<u32>().ok()?;
        if line == 0 || column == 0 { return None; }
        let condition = fields.next()?;
        if condition.is_empty() || !condition.bytes().all(|b| b.is_ascii_alphanumeric() || b"_: ".contains(&b)) { return None; }
        Some(Self { inner: CauseInner::Owned(std::sync::Arc::new(OwnedSite { retry: Retry::Other, module: Cow::Owned(module.into()), file: Cow::Owned(file.into()), line, column, condition: Cow::Owned(condition.into()), release: Cow::Owned(if release == "unknown" { String::new() } else { release.into() }) })) })
    }
}
impl std::fmt::Debug for Cause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_tuple("Cause").field(&self.id()).finish() }
}
impl PartialEq for Cause {
    fn eq(&self, other: &Self) -> bool {
        self.module()==other.module() && self.file()==other.file() && self.line()==other.line() && self.column()==other.column()
            && self.condition()==other.condition() && self.release()==other.release()
    }
}
impl Eq for Cause {}
impl std::hash::Hash for Cause {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::hash::Hash::hash(&(self.module(), self.file(), self.line(), self.column(), self.condition(), self.release()), state)
    }
}
impl std::fmt::Display for Cause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}:{}:{}:{}", self.module(), self.file(), self.line(), self.column(), self.condition())?;
        if !self.release().is_empty() { write!(f, "#{}", self.release())?; }
        Ok(())
    }
}
// Standard wrappers expose this source-only marker through Error::source().
// It contains coordinates itself; it is not another engine failure needing a
// recursive origin. This lets arbitrary CodedError<C> payloads retain identity.
impl std::error::Error for Cause {}

/// Normalize compiler paths lexically; neither account files nor the file
/// system are read. Absolute include! paths lose the checkout prefix before
/// any source identity can leave the process.
fn source_file(file: &'static str) -> Cow<'static, str> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    if file.contains('\\') || manifest.contains('\\') {
        return Cow::Owned(normalized_source_file(&file.replace('\\', "/"), &manifest.replace('\\', "/")));
    }
    let root = manifest.split("/src/").next().unwrap_or(manifest);
    let relative = file.strip_prefix(root).and_then(|value| value.strip_prefix('/'));
    if let Some(relative) = relative {
        if !relative.split('/').any(|part| part == "." || part == "..") { return Cow::Borrowed(relative); }
    } else if manifest == root && !file.starts_with('/') && !file.split('/').any(|part| part == "." || part == "..") {
        return Cow::Borrowed(file);
    }
    let combined = if let Some(relative) = relative { relative.to_owned() }
        else { format!("{}/{}", manifest.strip_prefix(root).unwrap_or_default().trim_start_matches('/'), file) };
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part { "" | "." => {}, ".." => { parts.pop(); }, part => parts.push(part) }
    }
    Cow::Owned(parts.join("/"))
}
fn normalized_source_file(file: &str, manifest: &str) -> String {
    let root = manifest.split("/src/").next().unwrap_or(manifest);
    let relative = file.strip_prefix(root).and_then(|value| value.strip_prefix('/'));
    let combined = relative.map(str::to_owned).unwrap_or_else(|| {
        format!("{}/{}", manifest.strip_prefix(root).unwrap_or_default().trim_start_matches('/'), file)
    });
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part { "" | "." => {}, ".." => { parts.pop(); }, part => parts.push(part) }
    }
    parts.join("/")
}
pub fn wire_bytes() -> usize {
    #[derive(serde::Deserialize)]
    struct Bounds { cause_bytes: usize }
    static BOUNDS: std::sync::OnceLock<Bounds> = std::sync::OnceLock::new();
    BOUNDS.get_or_init(|| serde_json::from_slice(include_bytes!("settings.json")).expect("mcp/settings.json is valid")).cause_bytes
}
fn invalid_cause_words() -> &'static str {
    #[derive(serde::Deserialize)]
    struct Words { invalid_cause: String }
    static WORDS: std::sync::OnceLock<Words> = std::sync::OnceLock::new();
    &WORDS.get_or_init(|| serde_json::from_slice(include_bytes!("words.json")).expect("mcp/words.json is valid")).invalid_cause
}
impl serde::Serialize for Cause {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_str(&self.id()) }
}
impl<'de> serde::Deserialize<'de> for Cause {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <String as serde::Deserialize>::deserialize(deserializer)?;
        Self::from_wire(&text).ok_or_else(|| serde::de::Error::custom(invalid_cause_words()))
    }
}
/// The wire and in-process forms share the same mandatory identity. Ownership
/// differs only in whether the source text was compiled here or decoded.
pub type ReportedCause = Cause;

/// A legacy primitive error keeps its existing public code or words separately
/// from the compiler identity of the condition that produced it.
#[derive(Clone)]
pub struct CodedError<C = String> {
    pub code: C,
    cause: Cause,
}
impl<C> std::fmt::Debug for CodedError<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_struct("CodedError").field("cause", &self.cause).finish_non_exhaustive() }
}
impl<C> CodedError<C> {
    #[track_caller]
    pub fn new(code: C) -> Self { Self { code, cause: Cause::from_caller() } }
    pub fn with_cause(code: C, cause: Cause) -> Self { Self { code, cause } }
    pub fn cause(&self) -> Cause { self.cause.clone() }
}
impl<C: AsRef<str>> CodedError<C> {
    pub fn as_str(&self) -> &str { self.code.as_ref() }
}
impl<C> std::ops::Deref for CodedError<C> {
    type Target = C;
    fn deref(&self) -> &C { &self.code }
}
impl<C: std::fmt::Display> std::fmt::Display for CodedError<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{} cause={}", self.code, self.cause) }
}
impl<C: std::fmt::Display + std::fmt::Debug> std::error::Error for CodedError<C> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&self.cause) }
}
impl<C: PartialEq> PartialEq for CodedError<C> { fn eq(&self, other: &Self) -> bool { self.code == other.code } }
impl<C: Eq> Eq for CodedError<C> {}
impl<C> Caused for CodedError<C> { fn cause(&self) -> Cause { self.cause.clone() } }
impl From<&'static str> for CodedError<&'static str> {
    #[track_caller]
    fn from(code: &'static str) -> Self { Self::new(code) }
}
impl From<String> for CodedError<String> {
    #[track_caller]
    fn from(code: String) -> Self { Self::new(code) }
}

/// Generic wrappers must preserve a producer's identity instead of converting
/// every error into one new refusal at the wrapping layer.
pub trait Caused {
    #[track_caller]
    fn cause(&self) -> Cause;
    fn stored_cause(&self) -> Option<Cause> { Some(self.cause()) }
}
impl<T: Caused + ?Sized> Caused for &T {
    #[track_caller]
    fn cause(&self) -> Cause { T::cause(*self) }
    fn stored_cause(&self) -> Option<Cause> { T::stored_cause(*self) }
}
impl<T: Caused + ?Sized> Caused for &mut T {
    #[track_caller]
    fn cause(&self) -> Cause { T::cause(*self) }
    fn stored_cause(&self) -> Option<Cause> { T::stored_cause(*self) }
}
impl Caused for std::io::Error {
    #[track_caller]
    fn cause(&self) -> Cause { match self.stored_cause() { Some(cause) => cause, None => Cause::from_caller() } }
    fn stored_cause(&self) -> Option<Cause> {
        stored_error_cause(self.get_ref()?)
    }
}
impl Caused for rusqlite::Error {
    /// A SQLite failure's code and extended code are the cause's condition (e.g. `CannotOpen (extended 14)`), so a carried
    /// failure keeps the code the caller mapped away. Its message is left out: it names local file paths.
    #[track_caller]
    fn cause(&self) -> Cause {
        let detail = match self {
            rusqlite::Error::SqliteFailure(error, _) => format!("{:?} (extended {})", error.code, error.extended_code),
            other => other.to_string(),
        };
        Cause::__caller_detail("rusqlite", detail)
    }
    #[track_caller]
    fn stored_cause(&self) -> Option<Cause> { Some(self.cause()) }
}

#[macro_export]
macro_rules! impl_foreign_caused {
    ($error:ty) => {
        impl $crate::refusal_cause::Caused for $error {
            #[track_caller]
            fn cause(&self) -> $crate::refusal_cause::Cause { $crate::refusal_cause::Cause::from_caller() }
            fn stored_cause(&self) -> Option<$crate::refusal_cause::Cause> { None }
        }
    };
}
#[doc(hidden)]
pub fn stored_error_cause(mut source: &(dyn std::error::Error + 'static)) -> Option<Cause> {
    let mut seen: Vec<&(dyn std::error::Error + 'static)> = Vec::new();
    loop {
        if seen.iter().any(|prior| std::ptr::eq(*prior, source)) { return None; }
        seen.push(source);
        if let Some(cause) = source.downcast_ref::<Cause>() { return Some(cause.clone()); }
        if let Some(error) = source.downcast_ref::<CodedError<std::io::Error>>() { return Some(error.cause()); }
        if let Some(error) = source.downcast_ref::<CodedError<&'static str>>() { return Some(error.cause()); }
        if let Some(error) = source.downcast_ref::<CodedError<String>>() { return Some(error.cause()); }
        source = source.source()?;
    }
}
impl Caused for serde_json::Error {
    #[track_caller]
    fn cause(&self) -> Cause { match self.stored_cause() { Some(cause) => cause, None => Cause::from_caller() } }
    fn stored_cause(&self) -> Option<Cause> { stored_error_cause(std::error::Error::source(self)?) }
}

/// Keep the standard I/O ABI and ErrorKind while attaching the first engine
/// operation that failed. A second adapter retains the already recorded site.
pub fn locate_io(error: std::io::Error, cause: Cause) -> std::io::Error {
    if error.stored_cause().is_some() { return error; }
    std::io::Error::new(error.kind(), CodedError::with_cause(error, cause))
}

/// Standard I/O's custom payload keeps the original OS error intact. Engine
/// retry decisions use this accessor so attaching metadata cannot change errno.
pub fn raw_os_error(error: &std::io::Error) -> Option<i32> {
    if let Some(code) = error.raw_os_error() { return Some(code); }
    let source = error.get_ref()?.downcast_ref::<CodedError<std::io::Error>>()?;
    raw_os_error(&source.code)
}

/// The platform I/O trait ABI returns std::io::Error. Store provenance inside
/// that error at the failing expression; do not wait for a reporting adapter.
#[macro_export]
macro_rules! io_operation {
    ($operation:expr) => {
        ($operation).map_err(|error| $crate::refusal_cause::locate_io(error,
            $crate::__refusal_site!("io_operation")))
    };
}

#[macro_export]
macro_rules! impl_chained_foreign_caused {
    ($error:ty) => {
        impl $crate::refusal_cause::Caused for $error {
            #[track_caller]
            fn cause(&self) -> $crate::refusal_cause::Cause {
                match $crate::refusal_cause::stored_error_cause(self) {
                    Some(cause) => cause,
                    None => $crate::refusal_cause::Cause::from_caller(),
                }
            }
            fn stored_cause(&self) -> Option<$crate::refusal_cause::Cause> { $crate::refusal_cause::stored_error_cause(self) }
        }
    };
}
crate::impl_foreign_caused!(std::str::Utf8Error);
crate::impl_foreign_caused!(std::string::FromUtf8Error);
crate::impl_foreign_caused!(std::string::FromUtf16Error);
crate::impl_foreign_caused!(std::num::ParseIntError);
crate::impl_foreign_caused!(std::num::TryFromIntError);
crate::impl_foreign_caused!(std::time::SystemTimeError);
crate::impl_foreign_caused!(std::fmt::Error);
crate::impl_foreign_caused!(std::cell::BorrowError);
crate::impl_foreign_caused!(std::cell::BorrowMutError);
crate::impl_foreign_caused!(std::num::ParseFloatError);
crate::impl_foreign_caused!(std::convert::Infallible);
crate::impl_foreign_caused!(std::array::TryFromSliceError);
crate::impl_foreign_caused!(std::char::DecodeUtf16Error);
crate::impl_foreign_caused!(std::path::StripPrefixError);
crate::impl_foreign_caused!(std::collections::TryReserveError);
crate::impl_foreign_caused!(std::net::AddrParseError);
crate::impl_foreign_caused!(std::ffi::OsString);
crate::impl_foreign_caused!(std::boxed::Box<dyn std::any::Any + Send>);
crate::impl_foreign_caused!(std::boxed::Box<dyn std::any::Any>);
// Library adapters may report an unlocated measurement, unit, or word. A new
// engine-owned refusal result must use CodedError; the push gate checks that
// signature boundary. These adapters record the first engine condition.
crate::impl_foreign_caused!(usize);
crate::impl_foreign_caused!(u64);
crate::impl_foreign_caused!(());
crate::impl_foreign_caused!(String);
crate::impl_foreign_caused!(str);
impl<T> Caused for std::sync::TryLockError<T> {
    #[track_caller]
    fn cause(&self) -> Cause { Cause::from_caller() }
    fn stored_cause(&self) -> Option<Cause> { None }
}
impl<T> Caused for std::sync::PoisonError<T> {
    #[track_caller]
    fn cause(&self) -> Cause { Cause::from_caller() }
    fn stored_cause(&self) -> Option<Cause> { None }
}

/// Reclassification retains a known producer's source. A foreign failure has
/// no stored engine source yet, so this first engine condition supplies it.
#[macro_export]
macro_rules! carry_cause {
    (caller: $variant:path, $error:expr) => {{
        let error = &$error;
        let cause = match $crate::refusal_cause::Caused::stored_cause(error) {
            Some(cause) => cause,
            None => $crate::refusal_cause::Cause::__caller(module_path!(), concat!(stringify!($variant), " via ", module_path!(), ":", line!(), ":", column!())),
        };
        $variant(cause.into())
    }};
    ($variant:path, $error:expr) => {{
        let error = &$error;
        let cause = $crate::refusal_cause::Caused::stored_cause(error)
            .unwrap_or_else(|| $crate::__refusal_site!(stringify!($variant)));
        $variant(cause.into())
    }};
}

#[macro_export]
macro_rules! impl_caused {
    ($error:ty) => {
        impl $crate::refusal_cause::Caused for $error {
            fn cause(&self) -> $crate::refusal_cause::Cause { <$error>::cause(self) }
        }
    };
}

/// A condition's identity is entirely compiler-provided source coordinates and
/// tokens. An argument is a constructor path or static condition tokens, never
/// an evaluated expression or a field value. Coordinates identify a condition
/// within the source release; a moved condition has its new source coordinates.
#[macro_export]
macro_rules! cause {
    (reported: $variant:path) => {
        $variant($crate::refusal_cause::ReportedCause::from($crate::__refusal_site!(stringify!($variant))))
    };
    (caller_site: $($condition:tt)+) => {
        $crate::refusal_cause::Cause::__caller(module_path!(), concat!(stringify!($($condition)+), " via ", module_path!(), ":", line!(), ":", column!()))
    };
    (caller: $variant:path) => {
        $variant($crate::refusal_cause::Cause::__caller(module_path!(), concat!(stringify!($variant), " via ", module_path!(), ":", line!(), ":", column!())).into())
    };
    ($variant:path) => {
        $variant($crate::__refusal_site!(stringify!($variant)).into())
    };
    () => {
        $crate::__refusal_site!("refusal")
    };
    ($($condition:tt)+) => {
        $crate::__refusal_site!(stringify!($($condition)+))
    };
}

/// Only public source macros call this implementation primitive. It cannot
/// evaluate request fields: a static site's initializer accepts constants.
#[doc(hidden)]
#[macro_export]
macro_rules! __refusal_site {
    ($condition:expr) => {{
        static SITE: $crate::refusal_cause::Site = $crate::refusal_cause::Site::__site(module_path!(), file!(), line!(), column!(), $condition);
        $crate::refusal_cause::Cause::__from_site(&SITE)
    }};
}

impl<T> Caused for std::sync::mpsc::SendError<T> {
    #[track_caller] fn cause(&self) -> Cause { Cause::from_caller() }
    fn stored_cause(&self) -> Option<Cause> { None }
}
crate::impl_foreign_caused!(std::sync::mpsc::RecvError);

#[cfg(test)]
mod tests {
    use super::*;
    use std::hash::{Hash, Hasher};

    #[test]
    fn static_cause_roundtrip_retains_coordinates_identity_and_hash() {
        let cause = crate::cause!(condition: static_roundtrip);
        let decoded: Cause = serde_json::from_str(&serde_json::to_string(&cause).unwrap()).unwrap();
        assert_eq!(cause, decoded);
        let hash = |value: &Cause| { let mut state = std::collections::hash_map::DefaultHasher::new(); value.hash(&mut state); state.finish() };
        assert_eq!(hash(&cause), hash(&decoded));
        assert_eq!(cause.file(), "src/cause_book/cause.rs");
        assert_eq!(cause.condition(), "condition: static_roundtrip");
    }

    #[test]
    fn caller_cause_retains_both_the_call_and_each_factory_condition() {
        #[track_caller]
        fn failure(branch: bool) -> Cause {
            if branch { crate::cause!(caller_site: same_public_condition) }
            else { crate::cause!(caller_site: same_public_condition) }
        }
        let same_caller = |branch| failure(branch);
        let first = same_caller(true);
        let second = same_caller(false);
        assert_eq!((first.file(), first.line(), first.column()), (second.file(), second.line(), second.column()));
        assert_ne!(first, second, "two factory conditions at one caller never collapse");
        assert_eq!(first, same_caller(true));
        assert_eq!(second, serde_json::from_str::<Cause>(&serde_json::to_string(&second).unwrap()).unwrap());
    }

    #[test]
    fn wire_cause_keeps_original_release_and_rejects_private_paths_or_values() {
        let wire = "original@src/owner.rs:9:4:Error::Refused#0123456789abcdef0123456789abcdef01234567";
        let cause = Cause::from_wire(wire).unwrap();
        assert_eq!(cause.id(), wire);
        assert_eq!(cause.release(), "0123456789abcdef0123456789abcdef01234567");
        let legacy = Cause::from_wire("original@src/owner.rs:9:4:Error::Refused#unknown").unwrap();
        assert_eq!(legacy.id(), "original@src/owner.rs:9:4:Error::Refused");
        for wire in ["original@/home/private/account.rs:9:4:Refused", "original@src/../private.rs:9:4:Refused", "original@src/owner.rs:9:4:field=value", "original@src/owner.rs:0:4:Refused"] {
            assert!(Cause::from_wire(wire).is_none());
        }
    }

    #[test]
    fn compiler_include_paths_are_repository_relative_on_all_separators() {
        assert_eq!(normalized_source_file("/repo/src/a/../owner.rs", "/repo"), "src/owner.rs");
        assert_eq!(normalized_source_file("../../mcp/cause.rs", "/repo/src/native_entry/module_computer"), "src/mcp/cause.rs");
        assert_eq!(normalized_source_file("src/postgres/mod.rs", "/repo/src/storage/supplies"), "src/storage/supplies/src/postgres/mod.rs");
    }
}
